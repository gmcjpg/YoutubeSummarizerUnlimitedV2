/**
 * generate_icons.js
 * Run once with:  node generate_icons.js
 *
 * Creates icons/icon16.png, icon48.png, icon128.png
 * Uses only Node.js built-ins (no npm dependencies).
 *
 * Design: red circle background (#DC2626) with a white "play + lines" icon.
 */

'use strict';
const zlib = require('zlib');
const fs   = require('fs');
const path = require('path');

// ── CRC32 ──────────────────────────────────────────────────────────────────
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = (c >>> 8) ^ CRC_TABLE[(c ^ buf[i]) & 0xff];
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const tb  = Buffer.from(type, 'ascii');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crcSrc = Buffer.concat([tb, data]);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(crcSrc), 0);
  return Buffer.concat([len, tb, data, crcBuf]);
}

// ── Draw icon into an RGBA pixel buffer ─────────────────────────────────────
function drawIcon(size) {
  // RGBA flat array [R, G, B, A, ...]
  const px = new Uint8Array(size * size * 4);

  function set(x, y, r, g, b, a) {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    const i = (y * size + x) * 4;
    // Alpha-blend over existing pixel (for anti-aliasing)
    const sa = a / 255;
    const da = px[i + 3] / 255;
    const oa = sa + da * (1 - sa);
    if (oa < 0.001) return;
    px[i]     = Math.round((r * sa + px[i]     * da * (1 - sa)) / oa);
    px[i + 1] = Math.round((g * sa + px[i + 1] * da * (1 - sa)) / oa);
    px[i + 2] = Math.round((b * sa + px[i + 2] * da * (1 - sa)) / oa);
    px[i + 3] = Math.round(oa * 255);
  }

  const cx = (size - 1) / 2;
  const cy = (size - 1) / 2;
  const r  = cx - 0.5;

  // ── Red circle (anti-aliased) ──────────────────────────────────────────
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx   = x - cx;
      const dy   = y - cy;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const aa   = Math.max(0, Math.min(1, r - dist + 0.7));
      if (aa > 0) set(x, y, 0xdc, 0x26, 0x26, Math.round(aa * 255));
    }
  }

  // ── White shapes (scale to icon size) ─────────────────────────────────
  // We'll draw a simple "document with lines" icon using sub-pixel blocks.
  const u  = size / 16;  // 1 unit = 1/16 of icon size

  // Helper: fill a rectangle (fractional coords in units of u)
  function rect(lx, ly, lw, lh, alpha = 255) {
    const x0 = Math.round(lx * u);
    const y0 = Math.round(ly * u);
    const x1 = Math.round((lx + lw) * u);
    const y1 = Math.round((ly + lh) * u);
    for (let y = y0; y < y1; y++)
      for (let x = x0; x < x1; x++)
        set(x, y, 255, 255, 255, alpha);
  }

  if (size >= 32) {
    // Play triangle (right-pointing) centered in left portion
    // Triangle vertices in units: (4,5) → (4,11) → (9,8)
    const tx0 = 4 * u, ty0 = 5 * u;
    const tx1 = 4 * u, ty1 = 11 * u;
    const tx2 = 9 * u, ty2 = 8 * u;

    for (let y = Math.round(ty0); y <= Math.round(ty1); y++) {
      // Left edge: x = tx0 (vertical)
      // Right edge interpolated between top-left and tip, and bottom-left and tip
      const progress = (y - ty0) / (ty2 - ty0 + 0.001);
      const inv      = (y - ty2) / (ty1 - ty2 + 0.001);
      let xR;
      if (y <= ty2) {
        xR = tx0 + (tx2 - tx0) * Math.max(0, Math.min(1, progress));
      } else {
        xR = tx2 + (tx1 - tx2) * Math.max(0, Math.min(1, inv));
      }
      for (let x = Math.round(tx0); x <= Math.round(xR); x++) set(x, y, 255, 255, 255, 220);
    }

    // Three lines to the right of the triangle (like text lines)
    const lineH = Math.max(1, Math.round(0.8 * u));
    const lx = 10.5, lw = 4;
    rect(lx, 5.5,  lw, lineH);
    rect(lx, 7.5,  lw, lineH);
    rect(lx, 9.5,  lw, lineH);
  } else {
    // For 16px: just a simple right-arrow
    const mid = 8 * u;
    const hw  = Math.round(3.5 * u);
    for (let i = 0; i < hw; i++) {
      const spread = Math.round(i * 0.55);
      for (let j = -spread; j <= spread; j++) {
        set(Math.round(mid) - hw + i, Math.round(mid) + j, 255, 255, 255, 210);
      }
    }
  }

  return px;
}

// ── Encode RGBA pixels to PNG ────────────────────────────────────────────────
function encodePNG(size, pixels) {
  // Build raw image data: filter_byte (0) + RGBA row × size
  const rowBytes = 1 + size * 4;
  const raw      = Buffer.alloc(rowBytes * size);
  for (let y = 0; y < size; y++) {
    raw[y * rowBytes] = 0; // filter: None
    for (let x = 0; x < size; x++) {
      const src = (y * size + x) * 4;
      const dst = y * rowBytes + 1 + x * 4;
      raw[dst]     = pixels[src];
      raw[dst + 1] = pixels[src + 1];
      raw[dst + 2] = pixels[src + 2];
      raw[dst + 3] = pixels[src + 3];
    }
  }

  const compressed = zlib.deflateSync(raw, { level: 9 });

  // IHDR: width, height, bitDepth=8, colorType=6 (RGBA), rest=0
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;

  const PNG_SIG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([
    PNG_SIG,
    chunk('IHDR', ihdr),
    chunk('IDAT', compressed),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

// ── Main ─────────────────────────────────────────────────────────────────────
const iconsDir = path.join(__dirname, 'icons');
if (!fs.existsSync(iconsDir)) fs.mkdirSync(iconsDir);

for (const size of [16, 48, 128]) {
  const pixels = drawIcon(size);
  const png    = encodePNG(size, pixels);
  const dest   = path.join(iconsDir, `icon${size}.png`);
  fs.writeFileSync(dest, png);
  console.log(`Created ${dest}  (${png.length} bytes)`);
}

console.log('\nAll icons created. You can now load the extension in Chrome.');

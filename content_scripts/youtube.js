'use strict';

// ─────────────────────────────────────────────
// State
// ─────────────────────────────────────────────
// Must be declared before the bootstrap block below runs: init() reads
// initInFlight synchronously (before any await), and that first call to
// init() happens as part of this same top-level script execution — a `let`
// read before its own declaration line has run throws a ReferenceError
// (temporal dead zone), which would otherwise kill the whole content script.
let panel = null;
let cachedTranscript = null;
let cachedVideoId = null;
let panelVideoId = null;   // which video the panel/bridge cache was last set up for
let initInFlight = false;  // guards against a concurrent init() injecting a duplicate panel
let navigationEpoch = 0;   // invalidates async work started for an earlier video

// Avoid double-injection on fast SPA navigations
if (window.__ytAISummarizerLoaded) {
  reinit();
} else {
  window.__ytAISummarizerLoaded = true;
  init();
  // YouTube is a SPA — re-run when the user navigates to a different video
  document.addEventListener('yt-navigate-finish', reinit);
  document.addEventListener('yt-page-data-updated', reinit);
  window.addEventListener('popstate', reinit);
  // YouTube does not emit its navigation events consistently for every way a
  // watch URL can change. This lightweight guard catches those missed cases.
  setInterval(() => {
    if (getVideoId() !== panelVideoId) reinit();
  }, 500);
}

// ─────────────────────────────────────────────
// Entry points
// ─────────────────────────────────────────────
function reinit() {
  if (!isWatchPage()) {
    // Navigated away from a video (e.g. to the homepage) — remove the panel
    // so it doesn't linger with stale data if YouTube's SPA re-render leaves
    // the old #secondary DOM in place.
    if (panel && document.contains(panel)) panel.remove();
    if (panelVideoId !== null) navigationEpoch += 1;
    panel = null;
    panelVideoId = null;
    cachedTranscript = null;
    cachedVideoId = null;
    _bridgeCache = null;
    _bridgeCacheVid = null;
    return;
  }
  const vid = getVideoId();
  const videoChanged = vid !== panelVideoId;
  if (videoChanged) {
    navigationEpoch += 1;
    // Clear all data and visible UI belonging to the previous video. Async
    // work from the old epoch is ignored when it eventually completes.
    _bridgeCache = null;
    _bridgeCacheVid = null;
    cachedTranscript = null;
    cachedVideoId = null;
    resetPanelForVideo();
  }
  if (!panel || !document.contains(panel)) {
    panel = null;
    init();
  } else if (videoChanged) {
    // The panel survived the SPA navigation and belongs to a different
    // video than the one we last set it up for — re-warm the bridge cache
    // and the transcript-language dropdown proactively, instead of leaving
    // them cold until the user's first click (which would then hit a cold,
    // single-shot bridge request right as the page is still busy
    // re-initializing the player, e.g. ads).
    //
    // This compares against panelVideoId rather than cachedVideoId
    // deliberately: YouTube fires its own yt-navigate-finish once even on
    // the *initial* page load (confirmed: ~6-7s after navigation start),
    // and cachedVideoId is still null at that point (it's only set after a
    // successful transcript fetch) — comparing against it would misread
    // that first, harmless event as a real video change and redo work that
    // init() already just did.
    panelVideoId = vid;
    prefetchLanguages(vid, navigationEpoch);
  }
}

function resetPanelForVideo() {
  if (!panel || !document.contains(panel)) return;
  const select = panel.querySelector('#yts-transcript-lang');
  if (select) {
    [...select.options].forEach((option) => { if (option.value) option.remove(); });
    select.value = '';
  }
  const wrap = panel.querySelector('#yts-transcript-wrap');
  const list = panel.querySelector('#yts-transcript-list');
  const toggle = panel.querySelector('#yts-toggle-transcript');
  const goBtn = panel.querySelector('#yts-go-btn');
  const copyBtn = panel.querySelector('#yts-copy-btn');
  if (wrap) wrap.style.display = 'none';
  if (list) {
    list.innerHTML = '';
    list.style.display = 'none';
  }
  if (toggle) toggle.textContent = 'Show';
  if (goBtn) goBtn.disabled = false;
  if (copyBtn) copyBtn.disabled = false;
  setStatus('');
}

async function init() {
  if (!isWatchPage() || initInFlight) return;
  // YouTube can fire yt-navigate-finish once even for the page's *initial*
  // load (not just later SPA navigations). If that happens while this
  // call is still awaiting #secondary, reinit() would otherwise see
  // panel still null and start a second, concurrent init() — injecting a
  // duplicate panel and leaving the module-level `panel` reference (which
  // doAction()/setStatus() etc. all read) pointing at whichever one
  // finished last, so clicks on the other, orphaned copy silently do
  // nothing. Reserve the slot synchronously, before the first await.
  initInFlight = true;
  try {
    const secondary = await waitForElement('#secondary, #secondary-inner', 8000);
    if (document.getElementById('yt-ai-summarizer')) return; // already injected
    panel = buildPanel();
    secondary.prepend(panel);
    attachEvents(panel);
    loadSettings();
    panelVideoId = getVideoId();
    prefetchLanguages(panelVideoId, navigationEpoch); // populate dropdown in background
  } catch (_) {
    // secondary not found — unusual layout, skip silently
  } finally {
    initInFlight = false;
  }
}

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────
function isWatchPage() {
  return location.pathname === '/watch' && !!getVideoId();
}

function getVideoId() {
  return new URL(location.href).searchParams.get('v');
}

function getVideoTitle() {
  return (
    document.querySelector('h1.ytd-video-primary-info-renderer yt-formatted-string') ||
    document.querySelector('h1.title') ||
    document.querySelector('h1[class*="title"]')
  )?.textContent?.trim() || document.title.replace(' - YouTube', '');
}

function waitForElement(selector, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const el = document.querySelector(selector);
    if (el) return resolve(el);

    const observer = new MutationObserver(() => {
      const found = document.querySelector(selector);
      if (found) { observer.disconnect(); resolve(found); }
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });

    setTimeout(() => {
      observer.disconnect();
      reject(new Error(`Element "${selector}" not found`));
    }, timeoutMs);
  });
}

// ─────────────────────────────────────────────
// Transcript — bridge to youtube_bridge.js (MAIN world)
// No inline scripts; communicates via window.postMessage.
// ─────────────────────────────────────────────
// Cache the full bridge payload (playerResponse + initialData + ytConfig)
// so we don't call the bridge multiple times per video.
let _bridgeCache = null;
let _bridgeCacheVid = null;

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// Generic helper: send a message to the MAIN-world bridge and wait for response.
function bridgeRequest(msg, responseType, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const requestId = `yts_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const fullMsg = { ...msg, requestId };

    const onMessage = (evt) => {
      if (evt.source !== window) return;
      if (evt.data?.type !== responseType) return;
      if (evt.data?.requestId !== requestId) return;
      window.removeEventListener('message', onMessage);
      if (evt.data.error) reject(new Error(evt.data.error));
      else resolve(evt.data);
    };
    window.addEventListener('message', onMessage);
    window.postMessage(fullMsg, '*');

    setTimeout(() => {
      window.removeEventListener('message', onMessage);
      reject(new Error(`Bridge timeout (${responseType}). Try reloading.`));
    }, timeoutMs);
  });
}

async function getBridgePayload() {
  const data = await bridgeRequest(
    { type: 'YTS_REQUEST_PLAYER_RESPONSE' },
    'YTS_PLAYER_RESPONSE',
    5000
  );
  return data.payload;
}

async function getBridgeCached(vid = getVideoId()) {
  if (_bridgeCache && _bridgeCacheVid === vid) return _bridgeCache;

  // Right after an SPA navigation, YouTube can still be busy re-initializing
  // the player (ads, etc.), so ytInitialPlayerResponse may not be populated
  // yet, or the postMessage round-trip itself can be delayed by main-thread
  // contention and miss the 5s bridgeRequest timeout. Retry with backoff
  // (same schedule as prefetchLanguages) instead of failing on one attempt.
  const delays = [0, 1500, 3000];
  let payload = null;
  for (let i = 0; i < delays.length; i++) {
    if (delays[i] > 0) await sleep(delays[i]);
    try {
      payload = await getBridgePayload();
      if (payload?.playerResponse) break;
    } catch (err) {
      if (i === delays.length - 1) throw err;
    }
  }

  // Only cache when we got real player data; if null, next call will retry.
  if (payload?.playerResponse) {
    _bridgeCache = payload;
    _bridgeCacheVid = vid;
  }
  return payload;
}

// window.ytInitialPlayerResponse only ever describes the video the page was
// first loaded with — YouTube's SPA router never reassigns it on a
// client-side video change. So a cached bridge payload whose videoDetails
// don't match the current video is stale data for the WRONG video, not
// just "old data for the right one" — using it (captions tracks, transcript
// params) would silently target the previous video.
function playerResponseMatchesVideo(payload, vid) {
  return !!vid && payload?.playerResponse?.videoDetails?.videoId === vid;
}

// Fetches an up-to-date player response for a specific video via YouTube's
// own Innertube /player endpoint (the same way YouTube's own player fetches
// it internally on SPA navigation) and returns just its caption tracks.
// Returns undefined if the fetch itself couldn't be completed (network
// error, no API key, bad response) and the real (possibly empty) tracks array
// otherwise. A WEB response with no tracks is cross-checked with Android:
// after SPA navigation WEB can report the video unavailable even when its
// public captions exist, while Android still returns the correct tracks.
async function fetchFreshCaptionTracks(videoId, ytConfig) {
  return fetchCaptionTracksForContext(videoId, ytConfig?.apiKey, ytConfig?.context);
}

async function fetchCaptionTracksForContext(videoId, apiKey, context) {
  if (!apiKey || !context) return undefined;
  try {
    const r = await bridgeRequest(
      { type: 'YTS_FETCH_PLAYER_DATA', apiKey, context, videoId },
      'YTS_PLAYER_DATA_RESULT'
    );
    if (!r?.text) return undefined;
    const data = JSON.parse(r.text);
    return data?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
  } catch (_) {
    return undefined;
  }
}

async function getAvailableTracks(vid = getVideoId()) {
  const payload = await getBridgeCached(vid);
  let tracks = payload?.playerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks;

  if (!playerResponseMatchesVideo(payload, vid)) {
    const ytConfig = payload?.ytConfig || {};
    const freshWeb = await fetchFreshCaptionTracks(vid, ytConfig);
    tracks = freshWeb || [];

    // The WEB player can return zero tracks because it considers the SPA
    // target unavailable, not because captions are absent. Cross-check the
    // Android player before declaring a real no-captions result.
    if (tracks.length === 0 && ytConfig.apiKey) {
      const freshAndroid = await fetchCaptionTracksForContext(
        vid,
        ytConfig.apiKey,
        { client: { clientName: 'ANDROID', clientVersion: '20.10.38' } }
      );
      if (freshAndroid !== undefined) tracks = freshAndroid;
    }
  }

  if (!tracks || tracks.length === 0) return [];
  return tracks.map((t) => ({
    code: t.languageCode,
    name: t.name?.simpleText || t.languageCode,
    baseUrl: t.baseUrl,
    isAsr: t.kind === 'asr'
  }));
}

// Build Innertube get_transcript params from video ID alone (protobuf encoding).
// This avoids dependence on engagementPanels inside ytInitialData.
function buildTranscriptParams(videoId) {
  const vidBytes = new TextEncoder().encode(videoId);
  const buf = new Uint8Array(2 + vidBytes.length + 2);
  buf[0] = 0x0a;                      // field 1, wire-type 2 (length-delimited)
  buf[1] = vidBytes.length;
  buf.set(vidBytes, 2);
  buf[2 + vidBytes.length] = 0x12;    // field 2, wire-type 2
  buf[3 + vidBytes.length] = 0x00;    // empty options (auto language)
  return btoa(String.fromCharCode(...buf));
}

// Parse timedtext XML / TTML format (what the URL returns without fmt=json3)
function parseTimedtextXml(text) {
  if (!text?.trim()) return [];
  const doc = new DOMParser().parseFromString(text, 'text/xml');
  const entries = [];

  // YouTube srv3 format: <p t="1000" d="2000"><s>text</s></p>
  // `t` and `d` are milliseconds (unlike TTML's clock-formatted `begin`).
  doc.querySelectorAll('p[t]').forEach((p) => {
    const ms = parseInt(p.getAttribute('t') || '0', 10);
    const txt = p.textContent.replace(/\s+/g, ' ').trim();
    if (txt) entries.push({ startMs: ms, start: ms / 1000, text: txt });
  });
  if (entries.length > 0) return entries;

  // TTML / srv3 format: <p begin="00:00:01.000" ...>text</p>
  doc.querySelectorAll('p[begin]').forEach((p) => {
    const raw = p.getAttribute('begin') || '0';
    const parts = raw.split(':').map(Number);
    let s = parts.length === 3 ? parts[0]*3600 + parts[1]*60 + parts[2]
          : parts.length === 2 ? parts[0]*60   + parts[1]
          : parts[0];
    const txt = p.textContent.replace(/\s+/g, ' ').trim();
    if (txt) entries.push({ startMs: Math.round(s * 1000), start: s, text: txt });
  });
  if (entries.length > 0) return entries;

  // Plain timedtext format: <text start="1.0" dur="2.0">text</text>
  doc.querySelectorAll('text[start]').forEach((el) => {
    const s = parseFloat(el.getAttribute('start') || '0');
    const txt = el.textContent.replace(/\s+/g, ' ').trim();
    if (txt) entries.push({ startMs: Math.round(s * 1000), start: s, text: txt });
  });
  return entries;
}

// Parse the events array from a json3 response body
function parseJson3(text) {
  let data;
  try { data = JSON.parse(text); } catch (e) {
    throw new Error(`Unexpected transcript format (${e.message}).`);
  }
  return (data.events || [])
    .filter((e) => e.segs?.some((s) => s.utf8?.trim()))
    .map((e) => ({
      startMs: e.tStartMs,
      start:   e.tStartMs / 1000,
      text:    e.segs.map((s) => s.utf8 || '').join('').replace(/\n/g, ' ').trim()
    }))
    .filter((e) => e.text);
}

// Parse Innertube get_transcript response
function parseInnertube(text) {
  let data;
  try { data = JSON.parse(text); } catch (e) {
    throw new Error(`Unexpected Innertube format (${e.message}).`);
  }
  const segs = data?.actions?.[0]
    ?.updateEngagementPanelAction?.content
    ?.transcriptRenderer?.content
    ?.transcriptSearchPanelRenderer?.body
    ?.transcriptSegmentListRenderer?.initialSegments || [];

  return segs
    .map((s) => {
      const r = s.transcriptSegmentRenderer;
      if (!r) return null;
      const ms = parseInt(r.startMs || '0', 10);
      const text = r.snippet?.runs?.map((x) => x.text).join('') || '';
      return text ? { startMs: ms, start: ms / 1000, text } : null;
    })
    .filter(Boolean);
}

// ── POT (Proof Of origin Token) extraction ────────────────────────────────
// YouTube's timedtext API returns an empty 200 response unless the request
// includes a valid `pot` token.  YouTube itself puts that token in the URL
// when it fetches captions after the CC button is clicked.  We grab it from
// the Performance Resource Timing API, which records every network request
// the browser makes for this page (including YouTube's own captions fetch).
// Check whether YouTube has already fetched captions on this page load
// (e.g. user had CC enabled) and extract the pot token from that request.
// We do NOT click the CC button here — that would change UI state and is
// reserved for the DOM scraping fallback.  If no pot is in the performance
// timeline yet, return null and let later strategies handle it.
function getPotToken() {
  try {
    const entries = performance.getEntriesByType('resource')
      .filter((e) => e.name.includes('/api/timedtext?') && e.name.includes('pot='));
    if (!entries.length) return null;
    return new URL(entries[entries.length - 1].name).searchParams.get('pot') || null;
  } catch (_) {
    return null;
  }
}

// ── Active pot harvesting via CC button ───────────────────────────────────
// Called when the passive getPotToken() found nothing.  Clicks YouTube's CC
// (subtitles) button so YouTube fires a timedtext network request that
// contains the pot token.  Returns the pot, or null on failure.
async function harvestPotViaCCButton() {
  const ccBtn = document.querySelector('#movie_player button.ytp-subtitles-button.ytp-button');
  if (!ccBtn) return null;

  const wasActive = ccBtn.getAttribute('aria-pressed') === 'true';

  // Clear stale entries so we only see fresh requests
  try { performance.clearResourceTimings(); } catch (_) {}
  ccBtn.click();

  let pot = null;
  for (let i = 0; i < 10 && !pot; i++) {  // up to 1 s
    await sleep(100);
    try {
      const entries = performance.getEntriesByType('resource')
        .filter((e) => e.name.includes('/api/timedtext?') && e.name.includes('pot='));
      if (entries.length) pot = new URL(entries[entries.length - 1].name).searchParams.get('pot') || null;
    } catch (_) {}
  }

  // Restore CC state
  const nowActive = ccBtn.getAttribute('aria-pressed') === 'true';
  if (wasActive !== nowActive) ccBtn.click();

  return pot;
}

// ── DOM-based transcript scraping ─────────────────────────────────────────
// Clicks YouTube's native "Show transcript" button, waits for the panel to
// render, then reads the segments from the DOM.  No API calls needed.
async function scrapeTranscriptFromDOM() {
  const isVisible = (el) => !!el && el.getClientRects().length > 0;

  // Step 1: open the transcript panel via the "..." (overflow) menu
  // YouTube puts the transcript option in different places depending on layout.
  const openTranscriptPanel = async () => {
    // Try the engagement panel button that YouTube sometimes renders directly
    const directBtn = [...document.querySelectorAll(
      'button[aria-label*="transcript" i], ' +
      'yt-button-shape[aria-label*="transcript" i] button, ' +
      'ytd-button-renderer[aria-label*="transcript" i] button'
    )].find((el) => isVisible(el) && !/close/i.test(el.getAttribute('aria-label') || ''));
    if (directBtn) { directBtn.click(); return true; }

    // Otherwise open the "..." overflow menu first
    const moreBtn = document.querySelector(
      '#description-inner button[aria-label*="more" i], ' +
      'tp-yt-paper-button#expand, ' +
      'ytd-text-inline-expander #expand'
    );
    if (moreBtn) { moreBtn.click(); await sleep(600); }

    // Now look for "Show transcript" in the expanded description / menu
    const links = [...document.querySelectorAll(
      'ytd-structured-description-content-renderer button, ' +
      '#items button, ' +
      'yt-button-shape button'
    )];
    const transcriptBtn = links.find(
      (el) => el.textContent?.toLowerCase().includes('transcript')
    );
    if (transcriptBtn) { transcriptBtn.click(); return true; }
    return false;
  };

  const opened = await openTranscriptPanel();
  if (!opened) throw new Error('No transcript button found in DOM');

  // Step 2: wait for the transcript segments to render
  const segContainer = await new Promise((resolve) => {
    let settled = false;
    let obs = null;
    let timer = null;

    const finish = (value) => {
      if (settled) return;
      settled = true;
      obs?.disconnect();
      if (timer) clearTimeout(timer);
      resolve(value);
    };
    const check = () => {
      const el = document.querySelector(
        'transcript-segment-view-model, ' +
        'ytd-transcript-segment-renderer, ' +
        '#segments-container ytd-transcript-segment-renderer'
      );
      if (el) {
        finish(
          el.closest('ytd-engagement-panel-section-list-renderer') ||
          document.querySelector('#segments-container, ytd-transcript-search-panel-renderer') ||
          el.parentElement
        );
      }
    };
    obs = new MutationObserver(check);
    obs.observe(document.documentElement, { childList: true, subtree: true });
    timer = setTimeout(() => finish(null), 8000);
    check();
  });

  if (!segContainer) throw new Error('Transcript panel did not render');

  // Step 3: read all segment rows
  const segs = segContainer.querySelectorAll(
    'transcript-segment-view-model, ytd-transcript-segment-renderer'
  );
  if (segs.length === 0) throw new Error('No segments in transcript panel');

  const entries = [];
  segs.forEach((seg) => {
    const tsEl = seg.querySelector(
      '.ytwTranscriptSegmentViewModelTimestamp, .segment-timestamp, [class*="timestamp"]'
    );
    const textEl = seg.querySelector(
      '[role="text"], .segment-text, yt-formatted-string'
    );
    if (!tsEl || !textEl) return;
    const parts = tsEl.textContent.trim().split(':').map(Number);
    const s = parts.length === 3 ? parts[0]*3600 + parts[1]*60 + parts[2]
            : parts.length === 2 ? parts[0]*60   + parts[1]
            : parts[0];
    const text = textEl.textContent.replace(/\s+/g, ' ').trim();
    if (text) entries.push({ startMs: Math.round(s * 1000), start: s, text });
  });
  return entries;
}

async function fetchTranscript(langCode, videoId = getVideoId()) {
  const tracks = await getAvailableTracks(videoId);
  if (tracks.length === 0) throw new Error('No captions available for this video.');

  // Prefer: requested lang → English ASR → English manual → first track
  const track =
    (langCode ? tracks.find((t) => t.code === langCode) : null) ||
    tracks.find((t) => t.code === 'en' && t.isAsr)             ||
    tracks.find((t) => t.code === 'en')                        ||
    tracks[0];

  const payload  = await getBridgeCached(videoId);
  const ytConfig = payload?.ytConfig || {};
  // initialData.engagementPanels describes whichever video the page first
  // loaded (see playerResponseMatchesVideo) — only trust it when it's
  // actually for the current video, otherwise skip straight to building
  // params from the video ID.
  const panels   = playerResponseMatchesVideo(payload, videoId)
    ? (payload?.initialData?.engagementPanels || [])
    : [];

  // Build Innertube params — prefer from engagementPanels, fall back to
  // constructing them directly from the video ID (no ytInitialData needed).
  let transcriptParams = null;
  for (const p of panels) {
    const ep = p
      ?.engagementPanelSectionListRenderer
      ?.content?.continuationItemRenderer
      ?.continuationEndpoint?.getTranscriptEndpoint?.params;
    if (ep) { transcriptParams = ep; break; }
  }
  if (!transcriptParams) transcriptParams = buildTranscriptParams(videoId);

  // ── Strategy 1: pot-authenticated timedtext URL ──────────────────────────
  // YouTube's timedtext API requires a `pot` (Proof Of origin Token) to return
  // content. Without it the server sends 200 OK with an empty body. The token
  // is obtained by watching YouTube's own captions network request via the
  // Performance Resource Timing API (same technique used by the reference ext).
  const pot = getPotToken();
  if (pot) {
    const potUrl = `${track.baseUrl}&pot=${encodeURIComponent(pot)}&c=WEB`;
    try {
      const r1 = await bridgeRequest(
        { type: 'YTS_FETCH_TRANSCRIPT', url: potUrl },
        'YTS_TRANSCRIPT_RESULT'
      );
      if (r1?.text && r1.text.trim()) {
        try {
          const entries = parseJson3(r1.text);
          if (entries.length > 0) return entries;
        } catch (_) {}
        const entries = parseTimedtextXml(r1.text);
        if (entries.length > 0) return entries;
      }
    } catch (_) { /* fall through */ }
  }

  // ── Strategy 2: Simple unsigned timedtext URL ─────────────────────────────
  // Skip the signed baseUrl params entirely — many public videos respond to
  // the minimal form without needing pot or signed params.
  const simpleUrl = `https://www.youtube.com/api/timedtext?v=${videoId}&lang=${track.code}&fmt=json3`;
  try {
    const r2 = await bridgeRequest(
      { type: 'YTS_FETCH_TRANSCRIPT', url: simpleUrl },
      'YTS_TRANSCRIPT_RESULT'
    );
    if (r2?.text && r2.text.trim()) {
      const entries = parseJson3(r2.text);
      if (entries.length > 0) return entries;
    }
  } catch (_) { /* fall through */ }

  // Also try with explicit track name (needed when lang code is ambiguous)
  if (track.name) {
    const namedUrl = `https://www.youtube.com/api/timedtext?v=${videoId}&lang=${track.code}&name=${encodeURIComponent(track.name)}&fmt=json3`;
    try {
      const r2b = await bridgeRequest(
        { type: 'YTS_FETCH_TRANSCRIPT', url: namedUrl },
        'YTS_TRANSCRIPT_RESULT'
      );
      if (r2b?.text && r2b.text.trim()) {
        const entries = parseJson3(r2b.text);
        if (entries.length > 0) return entries;
      }
    } catch (_) { /* fall through */ }
  }

  // ── Strategy 3: Innertube get_transcript with Android client ─────────────
  if (ytConfig.apiKey) {
    const androidContext = {
      client: { clientName: 'ANDROID', clientVersion: '20.10.38' }
    };
    try {
      const r3 = await bridgeRequest(
        { type: 'YTS_FETCH_INNERTUBE', apiKey: ytConfig.apiKey,
          context: androidContext, params: transcriptParams },
        'YTS_INNERTUBE_RESULT'
      );
      if (r3?.text) {
        const entries = parseInnertube(r3.text);
        if (entries.length > 0) return entries;
      }
    } catch (_) { /* fall through */ }
  }

  // ── Strategy 4: Innertube get_transcript with WEB client ─────────────────
  if (ytConfig.apiKey) {
    const webContext = ytConfig.context || {
      client: { clientName: 'WEB', clientVersion: ytConfig.clientVersion || '2.20240101.00.00' }
    };
    try {
      const r4 = await bridgeRequest(
        { type: 'YTS_FETCH_INNERTUBE', apiKey: ytConfig.apiKey,
          context: webContext, params: transcriptParams },
        'YTS_INNERTUBE_RESULT'
      );
      if (r4?.text) {
        const entries = parseInnertube(r4.text);
        if (entries.length > 0) return entries;
      }
    } catch (_) { /* fall through */ }
  }

  // ── Strategy 5: timedtext signed URL, native XML format ──────────────────
  try {
    const r5 = await bridgeRequest(
      { type: 'YTS_FETCH_TRANSCRIPT', url: track.baseUrl },
      'YTS_TRANSCRIPT_RESULT'
    );
    if (r5?.text && r5.text.trim()) {
      const entries = parseTimedtextXml(r5.text);
      if (entries.length > 0) return entries;
    }
  } catch (_) { /* fall through */ }

  // ── Strategy 6: active pot harvest via CC button ──────────────────────────
  // If the passive performance-API check found no pot, click the CC button now
  // to make YouTube fire a real timedtext request, then retry with that pot.
  if (!pot) {
    const harvestedPot = await harvestPotViaCCButton();
    if (harvestedPot) {
      const potUrl = `${track.baseUrl}&pot=${encodeURIComponent(harvestedPot)}&c=WEB`;
      try {
        const r6 = await bridgeRequest(
          { type: 'YTS_FETCH_TRANSCRIPT', url: potUrl },
          'YTS_TRANSCRIPT_RESULT'
        );
        if (r6?.text && r6.text.trim()) {
          try {
            const entries = parseJson3(r6.text);
            if (entries.length > 0) return entries;
          } catch (_) {}
          const entries = parseTimedtextXml(r6.text);
          if (entries.length > 0) return entries;
        }
      } catch (_) { /* fall through */ }
    }
  }

  // ── Strategy 7: Android player caption URL ───────────────────────────────
  // The WEB player frequently returns caption URLs that require a valid pot,
  // while the Android player can return usable signed caption URLs for the
  // same public video. Fetch its tracks and retry the selected language.
  if (ytConfig.apiKey) {
    const androidContext = {
      client: { clientName: 'ANDROID', clientVersion: '20.10.38' }
    };
    const androidRawTracks = await fetchCaptionTracksForContext(
      videoId, ytConfig.apiKey, androidContext
    );
    if (androidRawTracks?.length) {
      const androidTracks = androidRawTracks.map((t) => ({
        code: t.languageCode,
        name: t.name?.simpleText || t.languageCode,
        baseUrl: t.baseUrl,
        isAsr: t.kind === 'asr'
      }));
      const androidTrack =
        (langCode ? androidTracks.find((t) => t.code === langCode) : null) ||
        androidTracks.find((t) => t.code === track.code && t.isAsr === track.isAsr) ||
        androidTracks.find((t) => t.code === track.code) ||
        androidTracks.find((t) => t.code === 'en' && t.isAsr) ||
        androidTracks.find((t) => t.code === 'en') ||
        androidTracks[0];

      if (androidTrack?.baseUrl) {
        try {
          const r7 = await bridgeRequest(
            { type: 'YTS_FETCH_TRANSCRIPT', url: androidTrack.baseUrl },
            'YTS_TRANSCRIPT_RESULT'
          );
          if (r7?.text && r7.text.trim()) {
            try {
              const entries = parseJson3(r7.text);
              if (entries.length > 0) return entries;
            } catch (_) {}
            const entries = parseTimedtextXml(r7.text);
            if (entries.length > 0) return entries;
          }
        } catch (_) { /* fall through */ }
      }
    }
  }

  // ── Strategy 8: DOM scraping — click YouTube's own transcript panel ───────
  try {
    const domEntries = await scrapeTranscriptFromDOM();
    if (domEntries.length > 0) return domEntries;
  } catch (_) { /* fall through */ }

  // ── All strategies failed ─────────────────────────────────────────────────
  throw new Error(
    'Could not load transcript. The video may have captions disabled, ' +
    'or try reloading the page.'
  );
}

async function prefetchLanguages(targetVideoId = getVideoId(), targetEpoch = navigationEpoch) {
  // YouTube sometimes updates ytInitialPlayerResponse asynchronously after
  // document_idle fires (especially on hard refresh). Retry with backoff so
  // the transcript language dropdown populates reliably.
  const delays = [0, 1500, 3000];
  for (let i = 0; i < delays.length; i++) {
    if (delays[i] > 0) {
      await sleep(delays[i]);
      if (targetEpoch !== navigationEpoch || getVideoId() !== targetVideoId) return;
      // Clear the bridge cache so we re-read the now-populated playerResponse
      if (_bridgeCacheVid === targetVideoId) { _bridgeCache = null; _bridgeCacheVid = null; }
    }
    try {
      const tracks = await getAvailableTracks(targetVideoId);
      if (targetEpoch !== navigationEpoch || getVideoId() !== targetVideoId) return;
      const select = panel?.querySelector('#yts-transcript-lang');
      if (!select) return;
      // Remove any options added by a previous (failed) attempt
      [...select.options].forEach((o) => { if (o.value) o.remove(); });
      if (tracks.length === 0 && i < delays.length - 1) continue; // retry
      tracks.forEach((t) => {
        const opt = document.createElement('option');
        opt.value = t.code;
        opt.textContent = t.name + (t.isAsr ? ' (auto)' : '');
        select.appendChild(opt);
      });
      return; // success
    } catch (_) {
      if (i === delays.length - 1) return; // give up silently
    }
  }
}

// ─────────────────────────────────────────────
// Prompt builder
// ─────────────────────────────────────────────
const LANG_NAMES = {
  en:'English', es:'Spanish', fr:'French', de:'German', it:'Italian',
  pt:'Portuguese', ru:'Russian', ja:'Japanese', ko:'Korean', zh:'Chinese',
  ar:'Arabic', hi:'Hindi', nl:'Dutch', pl:'Polish', tr:'Turkish',
  vi:'Vietnamese', id:'Indonesian', th:'Thai', sv:'Swedish', da:'Danish'
};

function formatTs(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return h > 0
    ? `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`
    : `${m}:${String(s).padStart(2,'0')}`;
}

function buildPrompt({ transcript, mode, responseLang, customQuestion }) {
  const videoTitle = getVideoTitle();
  const videoUrl   = location.href;

  const formatted = transcript
    .map((t) => `[${formatTs(t.start)}] ${t.text}`)
    .join('\n');

  const langLine = responseLang && responseLang !== 'en'
    ? `\n\nPlease respond in ${LANG_NAMES[responseLang] || responseLang}.`
    : '';

  if (mode === 'qa') {
    const question = customQuestion?.trim() ||
      'Provide a comprehensive analysis of this video.';
    return `I have a YouTube video transcript I'd like to discuss.

Video: ${videoTitle}
URL: ${videoUrl}

Transcript:
${formatted}

Question: ${question}

Reference specific timestamps (e.g. [2:30]) in your answer when relevant.${langLine}`;
  }

  // Summary mode
  return `Task: Summarize the following YouTube video transcript in 5–10 bullet points with timestamps for each key point.

Video: ${videoTitle}
URL: ${videoUrl}

Transcript:
${formatted}

Format each bullet as:
• [timestamp] Key point description
${langLine}`.trim();
}

// ─────────────────────────────────────────────
// Panel HTML
// ─────────────────────────────────────────────
function buildPanel() {
  const el = document.createElement('div');
  el.id = 'yt-ai-summarizer';
  el.innerHTML = `
    <div class="yts-header">
      <span class="yts-logo">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
          <polyline points="14 2 14 8 20 8"/>
          <line x1="16" y1="13" x2="8" y2="13"/>
          <line x1="16" y1="17" x2="8" y2="17"/>
          <polyline points="10 9 9 9 8 9"/>
        </svg>
      </span>
      <span class="yts-title">AI Summarizer</span>
      <button class="yts-collapse-btn" title="Collapse" aria-label="Collapse panel">▲</button>
    </div>

    <div class="yts-body">

      <!-- Mode -->
      <div class="yts-row">
        <button class="yts-tab active" data-mode="summary">Summary</button>
        <button class="yts-tab" data-mode="qa">Q&amp;A</button>
      </div>

      <!-- Q&A question -->
      <div class="yts-qa-section" style="display:none">
        <textarea class="yts-textarea" id="yts-question"
          placeholder="Ask anything about this video…" rows="2"></textarea>
      </div>

      <!-- Response language -->
      <div class="yts-row yts-spaced">
        <label class="yts-label" for="yts-response-lang">Reply language</label>
        <select class="yts-select" id="yts-response-lang">
          <option value="en">English</option>
          <option value="es">Spanish</option>
          <option value="fr">French</option>
          <option value="de">German</option>
          <option value="it">Italian</option>
          <option value="pt">Portuguese</option>
          <option value="ru">Russian</option>
          <option value="ja">Japanese</option>
          <option value="ko">Korean</option>
          <option value="zh">Chinese</option>
          <option value="ar">Arabic</option>
          <option value="hi">Hindi</option>
          <option value="nl">Dutch</option>
          <option value="pl">Polish</option>
          <option value="tr">Turkish</option>
          <option value="vi">Vietnamese</option>
          <option value="id">Indonesian</option>
          <option value="th">Thai</option>
          <option value="sv">Swedish</option>
          <option value="da">Danish</option>
        </select>
      </div>

      <!-- Transcript language -->
      <div class="yts-row yts-spaced">
        <label class="yts-label" for="yts-transcript-lang">Transcript lang</label>
        <select class="yts-select" id="yts-transcript-lang">
          <option value="">Auto (default)</option>
        </select>
      </div>

      <!-- AI provider -->
      <div class="yts-providers">
        <button class="yts-provider active" data-provider="claude">
          <span class="yts-provider-dot" style="background:#d97706"></span>Claude
        </button>
        <button class="yts-provider" data-provider="chatgpt">
          <span class="yts-provider-dot" style="background:#10a37f"></span>ChatGPT
        </button>
        <button class="yts-provider" data-provider="gemini">
          <span class="yts-provider-dot" style="background:#4285f4"></span>Gemini
        </button>
      </div>

      <!-- Main action -->
      <button class="yts-btn-primary" id="yts-go-btn">Open in AI</button>

      <!-- Copy fallback -->
      <button class="yts-btn-secondary" id="yts-copy-btn">Copy prompt</button>

      <!-- Status -->
      <div class="yts-status" id="yts-status" style="display:none"></div>

      <!-- Transcript viewer -->
      <div class="yts-transcript-wrap" id="yts-transcript-wrap" style="display:none">
        <div class="yts-row yts-spaced">
          <span class="yts-label">Transcript</span>
          <button class="yts-text-btn" id="yts-toggle-transcript">Show</button>
        </div>
        <div class="yts-transcript-list" id="yts-transcript-list" style="display:none"></div>
      </div>

    </div>
  `;
  return el;
}

// ─────────────────────────────────────────────
// Events
// ─────────────────────────────────────────────
// Reads the currently-selected mode/provider directly from the panel's DOM
// (the .active class) rather than from separately-tracked variables. Two
// things can change which provider is "active" — clicking a provider button,
// or loadSettings() applying the user's saved default — so the DOM is the
// only state that's guaranteed to reflect both. A parallel `let provider`
// closure variable previously only got updated by the click handler, not by
// loadSettings(), so choosing a default provider in the popup would visibly
// highlight it but "Open in AI" would still use the stale hardcoded default.
function getActiveSelections(panel) {
  const mode = panel.querySelector('.yts-tab.active')?.dataset.mode || 'summary';
  const provider = panel.querySelector('.yts-provider.active')?.dataset.provider || 'claude';
  return { mode, provider };
}

function attachEvents(panel) {
  let collapsed = false;

  // Collapse
  panel.querySelector('.yts-collapse-btn').addEventListener('click', () => {
    collapsed = !collapsed;
    panel.querySelector('.yts-body').style.display = collapsed ? 'none' : '';
    panel.querySelector('.yts-collapse-btn').textContent = collapsed ? '▼' : '▲';
  });

  // Mode tabs
  panel.querySelectorAll('.yts-tab').forEach((btn) => {
    btn.addEventListener('click', () => {
      panel.querySelectorAll('.yts-tab').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      panel.querySelector('.yts-qa-section').style.display =
        btn.dataset.mode === 'qa' ? 'block' : 'none';
    });
  });

  // Provider buttons
  panel.querySelectorAll('.yts-provider').forEach((btn) => {
    btn.addEventListener('click', () => {
      panel.querySelectorAll('.yts-provider').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      saveSettings();
    });
  });

  // Go button
  panel.querySelector('#yts-go-btn').addEventListener('click', async () => {
    await doAction('open', getActiveSelections(panel));
  });

  // Copy button
  panel.querySelector('#yts-copy-btn').addEventListener('click', async () => {
    await doAction('copy', getActiveSelections(panel));
  });

  // Transcript toggle
  panel.querySelector('#yts-toggle-transcript').addEventListener('click', () => {
    const list = panel.querySelector('#yts-transcript-list');
    const btn  = panel.querySelector('#yts-toggle-transcript');
    const visible = list.style.display !== 'none';
    list.style.display = visible ? 'none' : 'block';
    btn.textContent = visible ? 'Show' : 'Hide';
  });

  // Settings persistence
  panel.querySelector('#yts-response-lang').addEventListener('change', saveSettings);
}

// Clipboard writes must happen from this content script (a real, focused
// document) rather than the background service worker — MV3 service workers
// have no Document, so navigator.clipboard.writeText() there silently no-ops
// instead of touching the system clipboard.
async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    return;
  } catch (_) { /* fall through to legacy fallback */ }

  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.focus();
  ta.select();
  try {
    const ok = document.execCommand('copy');
    if (!ok) throw new Error('execCommand copy failed');
  } finally {
    ta.remove();
  }
}

async function doAction(type, { mode, provider }) {
  const actionPanel = panel;
  const goBtn   = actionPanel.querySelector('#yts-go-btn');
  const copyBtn = actionPanel.querySelector('#yts-copy-btn');
  const vid = getVideoId();
  const actionEpoch = navigationEpoch;
  const stillCurrent = () => (
    actionEpoch === navigationEpoch &&
    getVideoId() === vid &&
    panel === actionPanel &&
    document.contains(actionPanel)
  );

  setStatus('Fetching transcript…', 'info');
  goBtn.disabled = true;
  copyBtn.disabled = true;

  try {
    const langCode = actionPanel.querySelector('#yts-transcript-lang').value || null;
    const responseLang = actionPanel.querySelector('#yts-response-lang').value;
    const customQuestion = actionPanel.querySelector('#yts-question').value;

    // Use cache if same video
    if (!cachedTranscript || cachedVideoId !== vid) {
      const transcript = await fetchTranscript(langCode, vid);
      if (!stillCurrent()) return;
      cachedTranscript = transcript;
      cachedVideoId = vid;
      renderTranscript(cachedTranscript);
    }
    if (!stillCurrent()) return;

    const prompt = buildPrompt({
      transcript: cachedTranscript,
      mode,
      responseLang,
      customQuestion
    });

    if (type === 'copy') {
      await copyToClipboard(prompt);
      if (!stillCurrent()) return;
      setStatus('Prompt copied! Paste it into any AI chat.', 'ok');
    } else {
      await chrome.runtime.sendMessage({ action: 'openAITab', provider, prompt });
      if (!stillCurrent()) return;
      setStatus(`Opening ${capitalize(provider)}…`, 'ok');
    }
  } catch (err) {
    if (stillCurrent()) setStatus(err.message, 'error');
  } finally {
    goBtn.disabled = false;
    copyBtn.disabled = false;
  }
}

function renderTranscript(transcript) {
  const wrap = panel.querySelector('#yts-transcript-wrap');
  const list = panel.querySelector('#yts-transcript-list');
  wrap.style.display = 'block';
  list.innerHTML = '';

  transcript.forEach((entry) => {
    const row = document.createElement('div');
    row.className = 'yts-ts-row';

    const tsBtn = document.createElement('button');
    tsBtn.className = 'yts-ts-time';
    tsBtn.textContent = formatTs(entry.start);
    tsBtn.title = 'Jump to this point';
    tsBtn.addEventListener('click', () => {
      const video = document.querySelector('video');
      if (video) video.currentTime = entry.start;
    });

    const text = document.createElement('span');
    text.className = 'yts-ts-text';
    text.textContent = entry.text;

    row.appendChild(tsBtn);
    row.appendChild(text);
    list.appendChild(row);
  });
}

// ─────────────────────────────────────────────
// Settings persistence
// ─────────────────────────────────────────────
function saveSettings() {
  if (!panel) return;
  const provider = panel.querySelector('.yts-provider.active')?.dataset.provider || 'claude';
  const responseLang = panel.querySelector('#yts-response-lang')?.value || 'en';
  chrome.storage.local.set({ yts_provider: provider, yts_response_lang: responseLang });
}

function loadSettings() {
  chrome.storage.local.get(['yts_provider', 'yts_response_lang'], (data) => {
    if (!panel) return;
    if (data.yts_provider) {
      panel.querySelectorAll('.yts-provider').forEach((b) => {
        b.classList.toggle('active', b.dataset.provider === data.yts_provider);
      });
    }
    if (data.yts_response_lang) {
      const sel = panel.querySelector('#yts-response-lang');
      if (sel) sel.value = data.yts_response_lang;
    }
  });
}

// ─────────────────────────────────────────────
// Status helper
// ─────────────────────────────────────────────
function setStatus(msg, type = '') {
  if (!panel) return;
  const el = panel.querySelector('#yts-status');
  if (!el) return;
  el.textContent = msg;
  el.className = 'yts-status' + (type ? ` yts-status--${type}` : '');
  el.style.display = msg ? 'block' : 'none';
}

function capitalize(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

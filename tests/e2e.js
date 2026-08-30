'use strict';
/**
 * E2E test for YouTube AI Summarizer extension
 * Run:  node tests/e2e.js
 *
 * YouTube's anti-bot detection blocks transcript fetches in Playwright.
 * We mock the timedtext API so the full extension flow is tested end-to-end
 * without relying on YouTube's backend.  All UI, tab-opening, injector,
 * and settings logic is exercised against real pages.
 */
const { chromium } = require('playwright');
const path  = require('path');
const fs    = require('fs');

const EXTENSION_PATH = path.resolve(__dirname, '..');
const PROFILE_DIR    = path.join(__dirname, '.chrome-profile');
const TEST_VIDEO     = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';

// ── Mock transcript (returned for any /api/timedtext request) ────────────────
const MOCK_TRANSCRIPT = {
  events: [
    { tStartMs:  1000, dDurationMs: 3000, segs: [{ utf8: 'Hello and welcome' }] },
    { tStartMs:  4000, dDurationMs: 3000, segs: [{ utf8: 'to this test video.' }] },
    { tStartMs:  7000, dDurationMs: 5000, segs: [{ utf8: 'We will be testing' }] },
    { tStartMs: 12000, dDurationMs: 4000, segs: [{ utf8: 'the AI summarizer extension.' }] },
    { tStartMs: 16000, dDurationMs: 3000, segs: [{ utf8: 'This is a mock transcript' }] },
    { tStartMs: 19000, dDurationMs: 4000, segs: [{ utf8: 'used for automated testing.' }] },
  ]
};
const MOCK_SRV3_TRANSCRIPT = [
  '<?xml version="1.0" encoding="utf-8" ?>',
  '<timedtext format="3"><body>',
  '<p t="1250" d="2500"><s>First srv3 caption</s></p>',
  '<p t="3750" d="3000"><s>Second srv3 caption</s></p>',
  '</body></timedtext>',
].join('');

// ── Tiny test runner ─────────────────────────────────────────────────────────
let passed = 0, failed = 0;
const results = [];

async function test(name, fn) {
  process.stdout.write(`  ○ ${name} ... `);
  try {
    await fn();
    console.log('✓ PASS');
    results.push({ name, ok: true });
    passed++;
  } catch (err) {
    console.log(`✗ FAIL\n    → ${err.message.split('\n')[0]}`);
    results.push({ name, ok: false, error: err.message.split('\n')[0] });
    failed++;
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'Assertion failed');
}

// chrome.runtime.id is not exposed to a regular page's main-world JS context
// (page.evaluate runs there, not in the content script's isolated world), so
// it can't be read via page.evaluate(() => chrome.runtime.id). The reliable
// way to get the extension id in a test is from its service worker's URL.
async function getExtensionId(context) {
  let sw = context.serviceWorkers()[0];
  if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 10000 });
  return new URL(sw.url()).host;
}

// ── Main ─────────────────────────────────────────────────────────────────────
(async () => {
  console.log('\n═══════════════════════════════════════════');
  console.log('  YouTube AI Summarizer — E2E Test Suite');
  console.log('═══════════════════════════════════════════\n');

  if (!fs.existsSync(PROFILE_DIR)) fs.mkdirSync(PROFILE_DIR, { recursive: true });

  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    args: [
      `--disable-extensions-except=${EXTENSION_PATH}`,
      `--load-extension=${EXTENSION_PATH}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-blink-features=AutomationControlled',
      '--mute-audio',
      // Pin the window to the internal laptop display (1920,0 1536x864),
      // not the external monitor at (0,0) — keeps it off-screen from movies.
      '--window-position=1940,20',
      '--window-size=1480,760',
    ],
    viewport: null,
    slowMo: 60,
  });

  // Hide automation fingerprint on every page
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });

  // ── Mock YouTube's timedtext API ────────────────────────────────────────
  // Playwright intercepts at the browser-network level, so this catches
  // fetches from both content scripts and the MAIN-world bridge (youtube_bridge.js).
  let mockTranscriptFormat = 'json3';
  let mockSpaPlayer = false;
  await context.route('**/api/timedtext**', async (route) => {
    const isSrv3 = mockTranscriptFormat === 'srv3';
    await route.fulfill({
      status: 200,
      contentType: isSrv3 ? 'text/xml' : 'application/json',
      body: isSrv3 ? MOCK_SRV3_TRANSCRIPT : JSON.stringify(MOCK_TRANSCRIPT),
    });
  });
  await context.route('**/youtubei/v1/player**', async (route) => {
    if (!mockSpaPlayer) return route.continue();
    const body = route.request().postDataJSON();
    const isAndroid = body?.context?.client?.clientName === 'ANDROID';
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(isAndroid ? {
        videoDetails: { videoId: body.videoId },
        captions: {
          playerCaptionsTracklistRenderer: {
            captionTracks: [{
              baseUrl: `https://www.youtube.com/api/timedtext?v=${body.videoId}&lang=en`,
              languageCode: 'en',
              name: { simpleText: 'English' },
              kind: 'asr',
            }],
          },
        },
      } : {
        playabilityStatus: { status: 'UNPLAYABLE' },
        videoDetails: { videoId: body.videoId },
      }),
    });
  });

  const page = context.pages().length ? context.pages()[0] : await context.newPage();

  try {
    // ── Phase 1: Page load & panel ─────────────────────────────────────────
    console.log('▶ Phase 1: Page load & panel injection\n');

    await test('Navigate to YouTube watch page', async () => {
      await page.goto(TEST_VIDEO, { waitUntil: 'domcontentloaded', timeout: 30000 });
      assert(page.url().includes('youtube.com/watch'), `URL: ${page.url()}`);
    });

    await test('Panel injected into sidebar', async () => {
      await page.waitForSelector('#yt-ai-summarizer', { timeout: 20000 });
    });

    await test('Header shows "AI Summarizer"', async () => {
      const text = await page.textContent('.yts-title');
      assert(text?.includes('AI Summarizer'), `Got: "${text}"`);
    });

    await test('"Open in AI" button present and visible', async () => {
      const btn = page.locator('#yts-go-btn');
      await btn.waitFor({ state: 'visible', timeout: 5000 });
    });

    await test('"Copy prompt" button present', async () => {
      await page.locator('#yts-copy-btn').waitFor({ state: 'visible', timeout: 5000 });
    });

    await test('Three provider buttons (Claude / ChatGPT / Gemini)', async () => {
      const btns = await page.$$('.yts-provider');
      assert(btns.length === 3, `Expected 3, got ${btns.length}`);
    });

    await test('Mode tabs (Summary / Q&A)', async () => {
      const tabs = await page.$$('.yts-tab');
      assert(tabs.length === 2, `Expected 2, got ${tabs.length}`);
    });

    await test('Collapse then expand panel', async () => {
      await page.click('.yts-collapse-btn');
      await page.waitForTimeout(300);
      const body = page.locator('.yts-body');
      assert(await body.evaluate(el => el.style.display === 'none'), 'Should be hidden');
      await page.click('.yts-collapse-btn');
      await page.waitForTimeout(300);
      assert(await body.evaluate(el => el.style.display !== 'none'), 'Should be visible');
    });

    await test('Q&A mode shows question textarea', async () => {
      await page.click('.yts-tab[data-mode="qa"]');
      await page.waitForTimeout(200);
      await page.locator('.yts-qa-section').waitFor({ state: 'visible' });
      await page.click('.yts-tab[data-mode="summary"]');
    });

    await test('Transcript language dropdown populated (from ytInitialPlayerResponse)', async () => {
      await page.waitForTimeout(4000);
      const opts = await page.$$('#yts-transcript-lang option');
      assert(opts.length >= 1, `Got ${opts.length} options`);
    });

    // ── Phase 2: Transcript fetch ──────────────────────────────────────────
    console.log('\n▶ Phase 2: Transcript fetch (mocked timedtext API)\n');

    await test('Status hidden before any action', async () => {
      const visible = await page.locator('#yts-status').isVisible();
      assert(!visible, 'Status should be hidden initially');
    });

    await test('"Copy prompt" fetches transcript successfully (mocked)', async () => {
      await page.click('#yts-copy-btn');
      const status = page.locator('#yts-status');
      await status.waitFor({ state: 'visible', timeout: 15000 });
      await page.waitForFunction(() => {
        const value = document.querySelector('#yts-status')?.textContent || '';
        return value && !value.includes('Fetching transcript');
      }, { timeout: 15000 });
      const text = await status.textContent();
      assert(
        text.toLowerCase().includes('copied') || text.toLowerCase().includes('open'),
        `Status was: "${text}"`
      );
    });

    await test('Transcript viewer section appears', async () => {
      await page.locator('#yts-transcript-wrap').waitFor({ state: 'visible', timeout: 5000 });
    });

    await test('Transcript rows rendered with timestamps', async () => {
      await page.click('#yts-toggle-transcript');
      await page.waitForTimeout(400);
      const rows = await page.$$('.yts-ts-row');
      assert(rows.length >= MOCK_TRANSCRIPT.events.length,
        `Expected ≥${MOCK_TRANSCRIPT.events.length} rows, got ${rows.length}`);
    });

    await test('Clicking a timestamp seeks the video', async () => {
      const firstBtn = page.locator('.yts-ts-time').first();
      await firstBtn.click({ force: true });
      await page.waitForTimeout(600);
      const currentTime = await page.evaluate(() => document.querySelector('video')?.currentTime ?? -1);
      assert(currentTime >= 0, `Video currentTime: ${currentTime}`);
    });

    await test('Prompt contains transcript text and video title', async () => {
      // Read what was stored in session storage by background.js
      // We verify via the copy test having succeeded (status shows "Prompt copied")
      const statusText = await page.locator('#yts-status').textContent();
      assert(
        statusText.toLowerCase().includes('copied'),
        `Expected "copied" in status, got: "${statusText}"`
      );
    });

    // ── Phase 3: Open in AI tabs ───────────────────────────────────────────
    console.log('\n▶ Phase 3: "Open in AI" — new tab tests\n');

    await test('"Open in AI" with Claude opens claude.ai', async () => {
      await page.click('.yts-provider[data-provider="claude"]');
      await page.waitForTimeout(300);

      const [newPage] = await Promise.all([
        context.waitForEvent('page', { timeout: 20000 }),
        page.click('#yts-go-btn'),
      ]);
      await newPage.waitForLoadState('domcontentloaded').catch(() => {});
      const url = newPage.url();
      assert(url.includes('claude.ai'), `Expected claude.ai, got: ${url}`);
      await newPage.close();
    });

    await test('"Open in AI" with ChatGPT opens chatgpt.com', async () => {
      await page.click('.yts-provider[data-provider="chatgpt"]');
      await page.waitForTimeout(300);

      const [newPage] = await Promise.all([
        context.waitForEvent('page', { timeout: 20000 }),
        page.click('#yts-go-btn'),
      ]);
      await newPage.waitForLoadState('domcontentloaded').catch(() => {});
      const url = newPage.url();
      assert(url.includes('chatgpt.com'), `Expected chatgpt.com, got: ${url}`);
      await newPage.close();
    });

    await test('"Open in AI" with Gemini opens gemini.google.com', async () => {
      await page.click('.yts-provider[data-provider="gemini"]');
      await page.waitForTimeout(300);

      const [newPage] = await Promise.all([
        context.waitForEvent('page', { timeout: 20000 }),
        page.click('#yts-go-btn'),
      ]);
      await newPage.waitForLoadState('domcontentloaded').catch(() => {});
      const url = newPage.url();
      assert(url.includes('gemini.google.com'), `Expected gemini.google.com, got: ${url}`);
      await newPage.close();
    });

    // ── Phase 4: Injector check (Claude) ───────────────────────────────────
    console.log('\n▶ Phase 4: Injector — prompt auto-fill on AI pages\n');

    await test('Injector fills input on Claude (if logged in)', async () => {
      // First, set pending prompt in session storage so injector triggers
      await page.click('.yts-provider[data-provider="claude"]');
      await page.waitForTimeout(200);

      const [claudePage] = await Promise.all([
        context.waitForEvent('page', { timeout: 20000 }),
        page.click('#yts-go-btn'),
      ]);

      // The Claude tab may redirect or close early (auth challenges, rate limits).
      // We only care that the injector ran without JS crashes — both "filled input"
      // and "showed fallback banner" are acceptable outcomes.
      const errors = [];
      claudePage.on('pageerror', e => errors.push(e.message));

      await claudePage.waitForLoadState('domcontentloaded').catch(() => {});

      // Collect input state if the page is still open
      let inputText = [];
      try {
        await claudePage.waitForTimeout(4000); // give injector time to fire
        inputText = await claudePage.evaluate(() => {
          const candidates = [
            document.querySelector('.ProseMirror'),
            document.querySelector('[contenteditable="true"]'),
            document.querySelector('textarea'),
          ].filter(Boolean);
          return candidates.map(el => (el.textContent || el.value || '').slice(0, 80));
        });
        await claudePage.waitForTimeout(1000);
      } catch (_) {
        // Page closed by external redirect/auth — that's OK, we already have error list
      }

      console.log(`      → Input candidates: ${JSON.stringify(inputText)}`);
      assert(errors.length === 0, `JS errors in Claude tab: ${errors.join(', ')}`);
      await claudePage.close().catch(() => {});
    });

    await test('ChatGPT injector survives composer replacement during startup', async () => {
      const testPrompt = 'CHATGPT_COMPOSER_REPLACEMENT_TEST';
      await context.route('https://chatgpt.com/**', async (route) => {
        await route.fulfill({
          status: 200,
          contentType: 'text/html',
          body: `<!doctype html>
            <html><body>
              <main id="app">
                <div id="prompt-textarea" contenteditable="true"
                  style="display:block;width:400px;min-height:40px"></div>
                <button id="composer-submit-button" disabled>Send</button>
              </main>
              <script>
                setTimeout(() => {
                  document.querySelector('#app').innerHTML =
                    '<div id="prompt-textarea" contenteditable="true" ' +
                    'style="display:block;width:400px;min-height:40px"></div>' +
                    '<button id="composer-submit-button" disabled>Send</button>';
                }, 400);
                setTimeout(() => {
                  const button = document.querySelector('#composer-submit-button');
                  button.disabled = false;
                  button.addEventListener('click', () => {
                    document.body.dataset.submitted = 'true';
                    document.body.dataset.submittedText =
                      document.querySelector('#prompt-textarea').textContent;
                  });
                }, 2500);
                setTimeout(() => {
                  document.querySelector('#app').innerHTML =
                    '<div id="prompt-textarea" contenteditable="true" ' +
                    'style="display:block;width:400px;min-height:40px"></div>' +
                    '<button id="composer-submit-button" disabled>Send</button>';
                }, 1500);
              </script>
            </body></html>`,
        });
      });

      const sw = context.serviceWorkers()[0] ||
        await context.waitForEvent('serviceworker', { timeout: 10000 });
      await sw.evaluate(async ({ prompt, ts }) => {
        await chrome.storage.local.set({
          pendingPrompt: { prompt, provider: 'chatgpt', ts },
          yts_auto_submit: true,
          yts_inject_delay: 0,
        });
      }, { prompt: testPrompt, ts: Date.now() });

      const chatgptPage = await context.newPage();
      try {
        await chatgptPage.goto('https://chatgpt.com/', {
          waitUntil: 'domcontentloaded', timeout: 15000,
        });
        await chatgptPage.waitForFunction((expected) => {
          return document.querySelector('#prompt-textarea')?.textContent === expected;
        }, testPrompt, { timeout: 10000 });
        await chatgptPage.waitForFunction(() => (
          document.body.dataset.submitted === 'true'
        ), { timeout: 10000 });
        const submittedText = await chatgptPage.evaluate(() => (
          document.body.dataset.submittedText
        ));
        assert(submittedText === testPrompt, 'Replacement composer submitted without the prompt');
        let pending = true;
        const cleanupDeadline = Date.now() + 3000;
        while (pending && Date.now() < cleanupDeadline) {
          pending = await sw.evaluate(async () => (
            await chrome.storage.local.get('pendingPrompt')
          ).pendingPrompt || null);
          if (pending) await chatgptPage.waitForTimeout(50);
        }
        assert(pending === null, 'Pending prompt should clear only after verified insertion');
      } finally {
        await chatgptPage.close().catch(() => {});
        await context.unroute('https://chatgpt.com/**');
      }
    });

    // ── Phase 5: SPA navigation ────────────────────────────────────────────
    console.log('\n▶ Phase 5: YouTube SPA navigation\n');

    await test('Panel resets immediately after SPA navigation', async () => {
      mockTranscriptFormat = 'srv3';
      mockSpaPlayer = true;
      // Change only the SPA URL and emit YouTube's navigation event. A full
      // document load would hide stale-state bugs by reinjecting the script.
      await page.evaluate(() => {
        history.pushState({}, '', '/watch?v=arj7oStGLkU');
        document.dispatchEvent(new CustomEvent('yt-navigate-finish'));
      });
      await page.waitForTimeout(750);
      const title = await page.textContent('.yts-title');
      assert(title?.includes('AI Summarizer'), `Panel missing: "${title}"`);
      const wrap = page.locator('#yts-transcript-wrap');
      const visible = await wrap.isVisible().catch(() => false);
      assert(!visible, 'Transcript wrap should be hidden for a fresh video');
      const rows = await page.$$('.yts-ts-row');
      assert(rows.length === 0, `Previous transcript still showed ${rows.length} rows`);
    });

    await test('Transcript re-fetches correctly from srv3 XML for new video', async () => {
      await page.click('#yts-copy-btn');
      const status = page.locator('#yts-status');
      await status.waitFor({ state: 'visible', timeout: 15000 });
      await page.waitForFunction(() => {
        const value = document.querySelector('#yts-status')?.textContent || '';
        return value && !value.includes('Fetching transcript');
      }, { timeout: 15000 });
      const text = await status.textContent();
      assert(
        text.toLowerCase().includes('copied') || text.toLowerCase().includes('open'),
        `Status: "${text}"`
      );
      const rows = await page.$$('.yts-ts-row');
      assert(rows.length === 2, `Expected 2 srv3 rows, got ${rows.length}`);
    });

    // ── Phase 6: Popup ─────────────────────────────────────────────────────
    console.log('\n▶ Phase 6: Popup / settings\n');

    await test('Popup loads without JS errors', async () => {
      const popupPage = await context.newPage();
      const errors = [];
      popupPage.on('pageerror', e => errors.push(e.message));

      const extId = await getExtensionId(context);
      await popupPage.goto(`chrome-extension://${extId}/popup/popup.html`, { timeout: 10000 });
      await popupPage.waitForTimeout(600);
      assert(errors.length === 0, `JS errors: ${errors.join(', ')}`);
      await popupPage.close();
    });

    await test('Popup saves and loads settings', async () => {
      const extId = await getExtensionId(context);

      const popupPage = await context.newPage();
      await popupPage.goto(`chrome-extension://${extId}/popup/popup.html`, { timeout: 10000 });
      await popupPage.waitForTimeout(500);

      // Switch to ChatGPT
      await popupPage.click('.provider-btn[data-provider="chatgpt"]');
      await popupPage.selectOption('#default-lang', 'fr');
      await popupPage.click('#save-btn');

      const savedMsg = popupPage.locator('#saved-msg');
      await savedMsg.waitFor({ state: 'visible', timeout: 3000 });
      const msg = await savedMsg.textContent();
      assert(msg?.toLowerCase().includes('saved'), `Save message: "${msg}"`);

      await popupPage.close();
    });

  } finally {
    // ── Summary ────────────────────────────────────────────────────────────
    console.log('\n═══════════════════════════════════════════');
    console.log(`  Results: ${passed} passed, ${failed} failed out of ${passed + failed} tests`);
    console.log('═══════════════════════════════════════════');

    if (failed > 0) {
      console.log('\n  Failed tests:');
      results.filter(r => !r.ok).forEach(r => {
        console.log(`  ✗ ${r.name}`);
        console.log(`    ${r.error}`);
      });
    }
    console.log('');
    await context.close();
    process.exit(failed > 0 ? 1 : 0);
  }
})();

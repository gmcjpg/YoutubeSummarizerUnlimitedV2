'use strict';

const path = require('path');
const { chromium } = require('playwright');

const videoUrl = process.argv[2] || 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
const extensionPath = path.resolve(__dirname, '..');
const profilePath = path.resolve(__dirname, '.real-playwright-profile');

(async () => {
  const context = await chromium.launchPersistentContext(profilePath, {
    headless: false,
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--mute-audio',
    ],
  });

  let page = context.pages().find((candidate) => candidate.url().includes('youtube.com/watch'));
  if (!page) page = await context.newPage();

  const calls = [];
  page.on('response', async (response) => {
    const url = new URL(response.url());
    if (!url.pathname.includes('/api/timedtext') &&
        !url.pathname.includes('/youtubei/v1/get_transcript') &&
        !url.pathname.includes('/youtubei/v1/player')) return;

    let bodyLength = null;
    try { bodyLength = (await response.body()).length; } catch (_) {}
    calls.push({
      method: response.request().method(),
      path: url.pathname,
      status: response.status(),
      bodyLength,
      hasPot: url.searchParams.has('pot'),
    });
  });

  await page.goto(videoUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForSelector('#yt-ai-summarizer', { timeout: 30_000 });
  await page.waitForTimeout(4_000);

  const languages = await page.locator('#yts-transcript-lang option').allTextContents();
  await page.locator('#yts-copy-btn').click();

  const status = page.locator('#yts-status');
  await status.waitFor({ state: 'visible', timeout: 30_000 });
  await page.waitForFunction(() => {
    const text = document.querySelector('#yts-status')?.textContent || '';
    return text && !text.includes('Fetching transcript');
  }, { timeout: 45_000 });

  const result = {
    videoId: new URL(page.url()).searchParams.get('v'),
    languages,
    status: await status.textContent(),
    statusClass: await status.getAttribute('class'),
    transcriptRows: await page.locator('.yts-ts-row').count(),
    calls,
  };

  console.log(JSON.stringify(result, null, 2));
  const passed = result.statusClass?.includes('yts-status--ok') && result.transcriptRows > 0;
  await context.close();
  process.exitCode = passed ? 0 : 1;
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

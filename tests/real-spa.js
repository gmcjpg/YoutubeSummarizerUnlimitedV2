'use strict';

const path = require('path');
const { chromium } = require('playwright');

const extensionPath = path.resolve(__dirname, '..');
const profilePath = path.resolve(__dirname, '.real-playwright-profile');
const firstVideo = process.argv[2] || 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
let context = null;

(async () => {
  context = await chromium.launchPersistentContext(profilePath, {
    headless: false,
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--mute-audio',
    ],
  });
  const page = context.pages()[0] || await context.newPage();
  await page.goto(firstVideo, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForSelector('#yt-ai-summarizer', { timeout: 30_000 });
  await page.waitForTimeout(4_000);

  const firstVideoId = new URL(page.url()).searchParams.get('v');
  const switches = [];
  for (let index = 0; index < 2; index++) {
    const previousVideoId = new URL(page.url()).searchParams.get('v');
    await page.waitForFunction((currentId) => {
      return [...document.querySelectorAll('a[href*="/watch?v="]')].some((anchor) => {
        const id = new URL(anchor.href, location.href).searchParams.get('v');
        return id && id !== currentId && anchor.getClientRects().length > 0;
      });
    }, previousVideoId, { timeout: 30_000 });
    const relatedHref = await page.evaluate((currentId) => {
      const anchor = [...document.querySelectorAll('a[href*="/watch?v="]')].find((candidate) => {
        const id = new URL(candidate.href, location.href).searchParams.get('v');
        return id && id !== currentId && candidate.getClientRects().length > 0;
      });
      if (!anchor) return null;
      anchor.click();
      return anchor.href;
    }, previousVideoId);
    await page.waitForFunction((previousId) => {
      return new URLSearchParams(location.search).get('v') !== previousId;
    }, previousVideoId, { timeout: 30_000 });
    await page.waitForSelector('#yt-ai-summarizer', { timeout: 30_000 });

    // The old transcript must disappear promptly, before the next fetch.
    await page.waitForFunction(() => {
      const wrap = document.querySelector('#yts-transcript-wrap');
      return wrap && getComputedStyle(wrap).display === 'none' &&
        document.querySelectorAll('.yts-ts-row').length === 0;
    }, { timeout: 5_000 });
    await page.waitForTimeout(4_000);

    await page.locator('#yts-copy-btn').click();
    await page.waitForFunction(() => {
      const value = document.querySelector('#yts-status')?.textContent || '';
      return value && !value.includes('Fetching transcript');
    }, { timeout: 60_000 });

    switches.push({
      relatedHref,
      videoId: new URL(page.url()).searchParams.get('v'),
      languages: await page.locator('#yts-transcript-lang option').allTextContents(),
      status: await page.locator('#yts-status').textContent(),
      statusClass: await page.locator('#yts-status').getAttribute('class'),
      transcriptRows: await page.locator('.yts-ts-row').count(),
    });
  }

  const result = { firstVideoId, switches };
  console.log(JSON.stringify(result, null, 2));
  await context.close();

  const passed = switches.every((item) => (
    item.statusClass?.includes('yts-status--ok') && item.transcriptRows > 0
  ));
  process.exitCode = passed ? 0 : 1;
})().catch(async (error) => {
  console.error(error);
  await context?.close().catch(() => {});
  process.exitCode = 1;
});

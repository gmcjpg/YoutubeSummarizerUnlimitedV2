'use strict';

const path = require('path');
const { chromium } = require('playwright');

const extensionPath = path.resolve(__dirname, '..');
const profilePath = path.resolve(__dirname, '.real-playwright-profile');
const startUrl = process.argv[2] || 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';

(async () => {
  const context = await chromium.launchPersistentContext(profilePath, {
    headless: false,
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--mute-audio',
      '--remote-debugging-address=127.0.0.1',
      '--remote-debugging-port=9222',
    ],
  });

  let page = context.pages()[0];
  if (!page) page = await context.newPage();
  await page.goto(startUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });

  console.log(`Persistent test profile: ${profilePath}`);
  console.log('Local Playwright/CDP endpoint: http://127.0.0.1:9222');
  console.log('Sign in to the services you want to test, then close Chrome when finished.');

  await new Promise((resolve) => context.on('close', resolve));
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

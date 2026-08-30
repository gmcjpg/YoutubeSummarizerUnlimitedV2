# YouTube AI Summarizer

A Chrome extension that fetches YouTube transcripts and sends them to your AI of choice — Claude, ChatGPT, or Gemini — with no API key and no free-plan limits.

## Features

- One-click summarization from any YouTube watch page
- Supports **Claude**, **ChatGPT**, and **Gemini** (uses your existing browser session — no login or API key needed)
- Transcript fetched directly from YouTube using an 8-strategy fallback chain, so it works even without CC enabled
- Choose transcript language from the panel
- Configurable: default AI provider, response language, auto-submit toggle, inject delay
- No data sent to any third-party server — everything runs locally in the browser

## How it works

A MAIN-world content script (`youtube_bridge.js`) runs with the same origin as the YouTube page. It exposes same-origin `fetch` and access to YouTube page globals (`ytInitialPlayerResponse`, `yt.config_`) via `postMessage`.

The ISOLATED-world content script (`youtube.js`) drives an 8-strategy transcript fetch cascade:

| # | Strategy |
|---|---|
| 1 | pot-authenticated timedtext URL (passive `performance` API harvest) |
| 2 | Unsigned timedtext URL (`?v=ID&lang=CODE&fmt=json3`) |
| 2b | Unsigned timedtext URL with track name parameter |
| 3 | Innertube `get_transcript` with Android client context |
| 4 | Innertube `get_transcript` with WEB client context |
| 5 | Signed baseUrl, native XML format |
| 6 | Active pot harvest via CC button click, then retry with pot |
| 7 | Android player caption URL fallback |
| 8 | DOM scraping — clicks "Show transcript" and reads rendered segments |

## Installation

1. Clone or download this repo.
2. Open Chrome and go to `chrome://extensions`.
3. Enable **Developer mode** (top-right toggle).
4. Click **Load unpacked** and select the repo folder.
5. Navigate to any YouTube video — a **Summarize** panel will appear below the player.

## Usage

1. Open a YouTube video.
2. Click the language dropdown in the panel to select transcript language (optional).
3. Click **Claude**, **ChatGPT**, or **Gemini** to open the AI in a new tab with the transcript pre-loaded.
4. The prompt is auto-submitted after a short delay (configurable in the extension popup).

## Configuration

Click the extension icon to open the popup:

| Setting | Description |
|---|---|
| Default AI Provider | Which AI tab opens when you click Summarize |
| Default Response Language | Language the AI should respond in |
| Auto-submit prompt | Automatically submits the prompt in the AI tab |
| Submit delay (ms) | How long to wait before submitting (give the AI page time to load) |

## Development

### Prerequisites

- Node.js (for running tests)
- Playwright (`npm install`)

### Running tests

```bash
node tests/e2e.js
```

Tests use a mocked network to intercept YouTube timedtext and Innertube API calls, so they run offline without a real YouTube session.

For manual testing with reusable sign-ins, launch the dedicated real-session profile:

```bash
npm run test:real:setup
```

Sign in once in that Chromium window. Future launches reuse `tests/.real-playwright-profile/`, which is kept separate from your everyday Chrome profile and excluded from Git.

Close that setup browser when sign-in is complete. Real tests then launch and close the same persistent profile automatically:

```bash
npm run test:real
```

To reproduce the YouTube single-page navigation path, this command loads a
video, clicks a visible related-video link, and verifies the second transcript
without refreshing:

```bash
npm run test:real:spa
```

### Project structure

```
manifest.json               Extension manifest (MV3)
background.js               Service worker — handles tab management
content_scripts/
  youtube_bridge.js         MAIN world bridge — same-origin fetch & page globals
  youtube.js                ISOLATED world — transcript fetch, panel UI
  injector.js               Injects transcript prompt into Claude/ChatGPT/Gemini
popup/
  popup.html / popup.js     Settings popup
styles/
  panel.css                 Transcript panel styles
icons/                      Extension icons
tests/
  e2e.js                    Playwright end-to-end tests
```

## Privacy

- No analytics, no telemetry, no external servers.
- Your AI session credentials never leave your browser — the extension opens a tab and types into the existing page.
- The only Chrome storage used is `chrome.storage.local` for your popup settings (provider preference, language, auto-submit toggle).

## License

MIT

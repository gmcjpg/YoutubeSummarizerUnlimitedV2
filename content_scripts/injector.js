'use strict';

// Runs on claude.ai, chatgpt.com, gemini.google.com
// Reads a pending prompt from session storage and fills it into the chat input.

const PROMPT_TTL_MS = 60_000; // ignore prompts older than 60 s

const PLATFORM = detectPlatform();
if (PLATFORM) run();

function detectPlatform() {
  const h = location.hostname;
  if (h.includes('claude.ai'))           return 'claude';
  if (h.includes('chatgpt.com'))         return 'chatgpt';
  if (h.includes('gemini.google.com'))   return 'gemini';
  return null;
}

// Per-platform configuration ─────────────────────────────────────────────────
// Multiple selectors listed in priority order; first match wins.
const CONFIG = {
  claude: {
    inputSelectors: [
      'div.ProseMirror[contenteditable="true"]',
      'div[contenteditable="true"][data-placeholder]',
      '[data-testid="chat-input"] [contenteditable]',
      'div[contenteditable="true"]'
    ],
    submitSelectors: [
      'button[aria-label="Send message"]',
      'button[aria-label="Send Message"]',
      'button[data-testid="send-button"]',
      'form button[type="submit"]'
    ]
  },
  chatgpt: {
    inputSelectors: [
      '#prompt-textarea',
      'div[id="prompt-textarea"][contenteditable]',
      'div[contenteditable="true"][data-id]',
      'textarea[data-id]',
      'textarea[placeholder]'
    ],
    submitSelectors: [
      'button[data-testid="send-button"]',
      'button[aria-label="Send prompt"]',
      'button[aria-label="Send message"]',
      '#composer-submit-button'
    ]
  },
  gemini: {
    inputSelectors: [
      '.ql-editor[contenteditable="true"]',
      'rich-textarea .ql-editor',
      'div[contenteditable="true"][aria-label]',
      'div[contenteditable="true"]'
    ],
    submitSelectors: [
      'button[aria-label="Send message"]',
      'button.send-button',
      'button[data-mat-icon-name="send"]',
      'button[jsname]'
    ]
  }
};

// ─────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────
async function run() {
  try {
    // Guard: after an extension reload the runtime context is invalidated.
    // Accessing chrome APIs in an orphaned content script throws errors.
    if (!chrome.runtime?.id) return;

    const data = await chrome.storage.local.get(['pendingPrompt', 'yts_auto_submit', 'yts_inject_delay']);
    const pending = data?.pendingPrompt;

    if (!pending) return;
    if (Date.now() - pending.ts > PROMPT_TTL_MS) return; // stale
    if (pending.provider !== PLATFORM) return; // wrong tab

    const { prompt } = pending;
    const cfg = CONFIG[PLATFORM];
    const autoSubmit = data.yts_auto_submit !== false; // default true
    const injectDelay = Number.isFinite(data.yts_inject_delay) ? data.yts_inject_delay : 1400;

    // Chat apps can replace their first composer node while hydrating. Resolve
    // the live node again after startup, fill it, and verify that the text
    // survived before consuming the pending prompt.
    const input = await fillLiveInput(cfg.inputSelectors, prompt, 15_000);
    if (!input) {
      console.warn('[YT AI Summarizer] Could not find chat input — copying to clipboard instead.');
      await fallbackCopy(prompt);
      await consumePendingPrompt(pending);
      return;
    }

    await consumePendingPrompt(pending);

    if (!autoSubmit) return; // user disabled auto-submit — leave prompt filled, don't send

    // Wait for the UI to process the text, then submit
    await sleep(injectDelay);
    const submitted = await submit(
      input, cfg.inputSelectors, cfg.submitSelectors, prompt, 12_000
    );
    if (!submitted) {
      showBanner('Prompt filled, but automatic send was not ready. Please click Send.');
    }

  } catch (err) {
    console.warn('[YT AI Summarizer] Injector error:', err.message);
  }
}

// ─────────────────────────────────────────────
// Input filling
// ─────────────────────────────────────────────
function fillInput(el, text) {
  el.focus();

  const tag = el.tagName.toLowerCase();

  if (tag === 'textarea' || tag === 'input') {
    // Standard form element — use React-compatible approach
    const nativeSetter = Object.getOwnPropertyDescriptor(
      tag === 'textarea' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype,
      'value'
    )?.set;

    if (nativeSetter) {
      nativeSetter.call(el, text);
    } else {
      el.value = text;
    }
    el.dispatchEvent(new Event('input',  { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));

  } else {
    // contenteditable (ProseMirror / Quill / plain)
    // Select all existing content
    document.execCommand('selectAll', false, null);
    // Insert our text — this triggers the editor's own input handlers
    const inserted = document.execCommand('insertText', false, text);

    if (!inserted) {
      // execCommand refused (some strict CSP environments) — use Selection API
      el.textContent = '';
      const range = document.createRange();
      const sel   = window.getSelection();
      range.setStart(el, 0);
      range.collapse(true);
      sel.removeAllRanges();
      sel.addRange(range);
      document.execCommand('insertText', false, text);
    }

    // Dispatch synthetic input events for framework reactivity
    el.dispatchEvent(new InputEvent('input', { bubbles: true, data: text }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }
}

function readInputText(el) {
  if (!el) return '';
  const tag = el.tagName?.toLowerCase();
  return tag === 'textarea' || tag === 'input'
    ? el.value || ''
    : el.innerText || el.textContent || '';
}

function normalizedText(value) {
  return String(value || '').replace(/\r\n/g, '\n').replace(/\u00a0/g, ' ').trim();
}

function inputContainsPrompt(el, prompt) {
  const actual = normalizedText(readInputText(el));
  const expected = normalizedText(prompt);
  if (!actual || !expected) return false;
  if (actual === expected) return true;
  // Rich editors can normalize whitespace between blocks. For long prompts,
  // verify both a substantial prefix and the approximate resulting length.
  const compactActual = actual.replace(/\s+/g, ' ');
  const compactExpected = expected.replace(/\s+/g, ' ');
  return compactExpected.length > 80 &&
    compactActual.startsWith(compactExpected.slice(0, 80)) &&
    compactActual.length >= compactExpected.length * 0.8;
}

async function fillLiveInput(selectors, prompt, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  const first = await waitForInput(selectors, timeoutMs);
  if (!first) return null;

  // Let hydration replace any temporary editor, then always query again.
  await sleep(800);
  while (Date.now() < deadline) {
    const input = findElement(selectors);
    if (!input) {
      await sleep(250);
      continue;
    }

    fillInput(input, prompt);
    await sleep(300);

    const current = findElement(selectors);
    if (current === input && inputContainsPrompt(current, prompt)) return current;
    await sleep(250);
  }
  return null;
}

async function consumePendingPrompt(pending) {
  // Do not delete a newer prompt if another provider was opened while this
  // page was still loading.
  const current = (await chrome.storage.local.get('pendingPrompt'))?.pendingPrompt;
  if (current?.ts === pending.ts && current?.provider === pending.provider) {
    await chrome.storage.local.remove('pendingPrompt');
  }
}

// ─────────────────────────────────────────────
// Submit
// ─────────────────────────────────────────────
async function submit(inputEl, inputSelectors, submitSelectors, prompt, timeoutMs) {
  // Large prompts can leave ChatGPT's Send button disabled for several
  // seconds while its editor processes the inserted content. Wait for the
  // real button instead of immediately falling back to an untrusted Enter
  // event, which modern chat editors commonly ignore.
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const currentInput = findElement(inputSelectors);
    if (currentInput && !inputContainsPrompt(currentInput, prompt)) {
      // ChatGPT sometimes performs another composer replacement after the
      // first verified fill but before its Send button becomes ready.
      fillInput(currentInput, prompt);
      inputEl = currentInput;
      await sleep(300);
      continue;
    }

    const btn = findAnyElement(submitSelectors);
    const enabled = btn && btn.isConnected && !btn.disabled &&
      btn.getAttribute('aria-disabled') !== 'true' &&
      btn.getClientRects().length > 0;
    if (enabled) {
      btn.click();
      return true;
    }
    await sleep(150);
  }

  // Last fallback for editors that never render a dedicated send button.
  const accepted = inputEl.dispatchEvent(new KeyboardEvent('keydown', {
    key: 'Enter', code: 'Enter', keyCode: 13,
    bubbles: true, cancelable: true
  }));
  return !accepted;
}

// ─────────────────────────────────────────────
// Utilities
// ─────────────────────────────────────────────
function findElement(selectors) {
  const el = findAnyElement(selectors);
  return el && el.isConnected && !el.disabled && el.getClientRects().length > 0
    ? el
    : null;
}

function findAnyElement(selectors) {
  for (const sel of selectors) {
    const el = document.querySelector(sel);
    if (el) return el;
  }
  return null;
}

function waitForInput(selectors, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    let observer = null;
    let timer = null;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      observer?.disconnect();
      if (timer) clearTimeout(timer);
      resolve(value);
    };
    const check = () => {
      const el = findElement(selectors);
      if (el) finish(el);
    };
    check();
    if (settled) return;

    observer = new MutationObserver(check);
    observer.observe(document.documentElement, { childList: true, subtree: true });

    timer = setTimeout(() => {
      finish(findElement(selectors) || null);
    }, timeoutMs);
  });
}

async function fallbackCopy(text) {
  try {
    await navigator.clipboard.writeText(text);
    showBanner('Prompt copied to clipboard — paste it into the chat.');
  } catch (_) {
    showBanner('Could not auto-fill. Please paste your prompt manually.');
  }
}

function showBanner(message) {
  const banner = document.createElement('div');
  Object.assign(banner.style, {
    position: 'fixed', top: '16px', left: '50%', transform: 'translateX(-50%)',
    background: '#1a1a1a', color: '#fff', padding: '12px 20px',
    borderRadius: '8px', fontSize: '14px', zIndex: '999999',
    boxShadow: '0 4px 12px rgba(0,0,0,0.3)', maxWidth: '400px',
    textAlign: 'center', lineHeight: '1.4'
  });
  banner.textContent = message;
  document.body.appendChild(banner);
  setTimeout(() => banner.remove(), 6000);
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

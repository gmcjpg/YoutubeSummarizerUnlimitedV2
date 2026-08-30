'use strict';

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.action === 'openAITab') {
    handleOpenAITab(message).then(sendResponse).catch(err => sendResponse({ error: err.message }));
    return true;
  }
});

// ── Open AI tab ───────────────────────────────────────────────────────────────
async function handleOpenAITab({ provider, prompt }) {
  const urls = {
    claude:  'https://claude.ai/new',
    chatgpt: 'https://chatgpt.com/',
    gemini:  'https://gemini.google.com/app'
  };
  const url = urls[provider];
  if (!url) throw new Error(`Unknown provider: ${provider}`);

  await chrome.storage.local.set({
    pendingPrompt: { prompt, provider, ts: Date.now() }
  });

  const tab = await chrome.tabs.create({ url });
  return { tabId: tab.id };
}

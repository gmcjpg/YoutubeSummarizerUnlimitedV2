'use strict';

const DEFAULTS = {
  yts_provider:     'claude',
  yts_response_lang: 'en',
  yts_auto_submit:  true,
  yts_inject_delay: 1400
};

// ── Load saved settings ───────────────────────────────────────────────────────
chrome.storage.local.get(Object.keys(DEFAULTS), (data) => {
  const s = { ...DEFAULTS, ...data };

  // Provider
  document.querySelectorAll('.provider-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.provider === s.yts_provider);
  });

  // Language
  document.getElementById('default-lang').value = s.yts_response_lang;

  // Auto-submit
  const autoSubmitEl = document.getElementById('auto-submit');
  autoSubmitEl.checked = s.yts_auto_submit;
  updateDelayVisibility(s.yts_auto_submit);

  // Delay
  document.getElementById('inject-delay').value = s.yts_inject_delay;
});

// ── Provider selection ────────────────────────────────────────────────────────
document.querySelectorAll('.provider-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.provider-btn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
  });
});

// ── Auto-submit toggle ────────────────────────────────────────────────────────
document.getElementById('auto-submit').addEventListener('change', (e) => {
  updateDelayVisibility(e.target.checked);
});

function updateDelayVisibility(show) {
  document.getElementById('delay-field').style.display = show ? 'flex' : 'none';
}

// ── Save ──────────────────────────────────────────────────────────────────────
document.getElementById('save-btn').addEventListener('click', () => {
  const provider = document.querySelector('.provider-btn.active')?.dataset.provider || 'claude';

  const settings = {
    yts_provider:      provider,
    yts_response_lang: document.getElementById('default-lang').value,
    yts_auto_submit:   document.getElementById('auto-submit').checked,
    yts_inject_delay:  parseInt(document.getElementById('inject-delay').value, 10) || 1400
  };

  chrome.storage.local.set(settings, () => {
    const msg = document.getElementById('saved-msg');
    msg.style.display = 'block';
    setTimeout(() => { msg.style.display = 'none'; }, 1800);
  });
});

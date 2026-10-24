'use strict';

// Watches one claude.ai or ChatGPT tab and tells the extension's background script whether a
// reply is being written in it and whether you're looking at it. It reads only the page's
// address, its title and whether the site's stop control is up, nothing of the conversation.
//
// A reply is being written while the site shows that control. WRITING lists what to look for on
// each site, the ones that don't depend on the page's language first; when a site changes its
// page and the pet stops noticing replies, this table is what to fix.

(() => {
  // ChatGPT has two pages (October 2026). The newer one marks its send button data-stop-generating
  // while it's a stop button, and the message being written data-message-streaming. The other,
  // which signed-in accounts may get, has nothing of the kind: only a stop button in the message
  // box, shown while a reply is written, labelled in the page's language. (A hidden twin of it is
  // always there, so only a shown one counts.)
  const STOP_LABELS = new Set([
    'Stop', 'Stop streaming', 'Stop generating', 'Stop response',
    '중지', '스트리밍 중지', '응답 중지', '생성 중지',
    '停止', '停止生成', '停止回應', '生成を停止',
    'Detener', 'Arrêter', 'Stopp', 'Stoppen', 'Parar', 'Interrompi', 'Остановить',
  ]);
  const shownStopButton = () => [...document.querySelectorAll('form button[aria-label]')].some((b) => {
    if (!STOP_LABELS.has(b.getAttribute('aria-label').trim())) return false;
    const r = b.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  });
  const WRITING = {
    'claude.ai': ['[data-is-streaming="true"]', 'button[aria-label="Stop response"]'],
    'chatgpt.com': ['[data-composer-submit][data-stop-generating]', '[data-message-streaming]', '[data-testid="stop-button"]', shownStopButton],
  };
  const SITE = { 'claude.ai': 'claude', 'chatgpt.com': 'chatgpt' };
  const SETTLE_MS = 150;         // lets a burst of page changes settle into one look
  const TICK_MS = 5000;          // looks again on a timer too, in case nothing on the page moves
  const RESEND_MS = 30_000;      // and says it again unchanged this often, for a restarted background script

  const writing = WRITING[location.hostname];
  if (!writing) return;

  let lastKey = '';
  let lastSentAt = 0;
  let timer = null;

  function state() {
    return {
      type: 'chat',
      site: SITE[location.hostname],
      url: location.origin + location.pathname,   // no query or fragment
      title: document.title.slice(0, 300),
      generating: writing.some((w) => (typeof w === 'function' ? w() : document.querySelector(w) !== null)),
      looking: document.visibilityState === 'visible' && document.hasFocus(),
    };
  }

  // The extension was reloaded or removed: this copy of the script can't reach it any more (a new
  // one is started in the tab, see background.js), so it stops.
  let observer = null;
  let ticker = null;
  function orphaned() {
    observer?.disconnect();
    clearInterval(ticker);
    clearTimeout(timer);
  }

  function send(msg) {
    if (!chrome.runtime?.id) {
      orphaned();
      return;
    }
    try {
      chrome.runtime.sendMessage(msg).catch(() => {});   // nobody listening yet: the next look sends it again
    } catch {
      orphaned();
    }
  }

  function look() {
    clearTimeout(timer);
    timer = null;
    const s = state();
    const key = JSON.stringify(s);
    if (key === lastKey && Date.now() - lastSentAt < RESEND_MS) return;
    lastKey = key;
    lastSentAt = Date.now();
    send(s);
  }

  function soon() {
    if (!timer) timer = setTimeout(look, SETTLE_MS);
  }

  observer = new MutationObserver(soon);
  observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true });
  window.addEventListener('focus', soon);
  window.addEventListener('blur', soon);
  document.addEventListener('visibilitychange', soon);
  window.addEventListener('pageshow', () => { lastKey = ''; look(); });
  window.addEventListener('pagehide', () => send({ type: 'gone' }));
  ticker = setInterval(look, TICK_MS);
  look();
})();

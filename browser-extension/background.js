'use strict';

// Hands what each chat tab reports (content.js) to Ttokttok Pet through its native messaging host,
// and brings a chat's tab and window forward when the pet asks. The host is a small program the
// pet registers with Chrome and Edge when you turn web chats on; it talks to the running pet over
// a local named pipe. While the pet isn't set up, connecting fails and is tried again later.

const HOST = 'com.hyukjunlim.ttokttok_pet';
const RETRY_MS = 30_000;

let port = null;
let retry = null;
const latest = new Map();        // tab id -> what its page said last, sent again on reconnecting

function connect() {
  clearTimeout(retry);
  retry = null;
  let p;
  try {
    p = chrome.runtime.connectNative(HOST);
  } catch {
    later();
    return;
  }
  port = p;
  p.onMessage.addListener(onPetMessage);
  p.onDisconnect.addListener(() => {
    void chrome.runtime.lastError;   // read, so it isn't reported as unchecked
    if (port === p) port = null;
    later();
  });
  for (const msg of latest.values()) post(msg);
}

function later() {
  if (!retry) retry = setTimeout(connect, RETRY_MS);
}

function post(msg) {
  if (!port) {
    later();
    return;
  }
  try {
    port.postMessage(msg);
  } catch {
    port = null;
    later();
  }
}

function forget(tabId) {
  if (latest.delete(tabId)) post({ type: 'closed', tabId });
}

chrome.runtime.onMessage.addListener((msg, sender) => {
  const tab = sender.tab;
  if (!tab || typeof tab.id !== 'number') return;
  if (msg?.type === 'gone') {
    forget(tab.id);
    return;
  }
  if (msg?.type !== 'chat') return;
  const report = {
    type: 'chat',
    tabId: tab.id,
    windowId: tab.windowId,
    site: msg.site,
    url: msg.url,
    title: msg.title,
    generating: msg.generating === true,
    looking: msg.looking === true,
  };
  latest.set(tab.id, report);
  if (port) post(report);
  else if (!retry) connect();
});

chrome.tabs.onRemoved.addListener(forget);

// Once the extension is installed, updated or reloaded, the chat tabs already open keep running the
// old copy of content.js, which can no longer reach this script. Each gets a fresh copy instead.
chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason !== 'install' && reason !== 'update') return;
  chrome.tabs.query({ url: ['https://claude.ai/*', 'https://chatgpt.com/*', 'https://gemini.google.com/*'] })
    .then((tabs) => Promise.all(tabs.map((t) => chrome.scripting
      .executeScript({ target: { tabId: t.id }, files: ['content.js'] })
      .catch(() => {}))))              // a tab that's loading or gone
    .catch(() => {});
});

function onPetMessage(msg) {
  if (msg?.type !== 'focus' || !Number.isInteger(msg.tabId)) return;
  chrome.tabs.update(msg.tabId, { active: true })
    .then((tab) => chrome.windows.update(tab.windowId, { focused: true }))
    .catch(() => {});                // the tab was closed meanwhile
}

connect();

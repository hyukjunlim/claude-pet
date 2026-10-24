'use strict';

// The browser extension's two scripts, run against stand-ins for the page and the browser's APIs.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const DIR = path.join(__dirname, '..', 'browser-extension');
const CONV = '0f8fad5b-d9cb-469f-a165-70867728950e';
// What the scripts make lives in their own realm; compare copies made here.
const plain = (v) => JSON.parse(JSON.stringify(v));

// content.js on a page at `href`, where the elements matching `present` exist, and where the
// message box has `buttons` ({ label, shown }).
function page(href, { title = 'Plan - Claude', present = [], buttons = [], focused = true } = {}) {
  const url = new URL(href);
  const sent = [];
  const timers = [];
  const listeners = {};
  let observer = null;
  let disconnected = false;
  const runtime = { id: 'habdcjjcoianlobddinmnmmcpgolmohh', sendMessage: (m) => { sent.push(m); return Promise.resolve(); } };
  const doc = {
    title,
    visibilityState: 'visible',
    hasFocus: () => focused,
    querySelector: (sel) => (present.includes(sel) ? {} : null),
    querySelectorAll: (sel) => (sel !== 'form button[aria-label]' ? [] : buttons.map((b) => ({
      getAttribute: (name) => (name === 'aria-label' ? b.label : null),
      getBoundingClientRect: () => (b.shown ? { width: 32, height: 32 } : { width: 0, height: 0 }),
    }))),
    addEventListener: (ev, fn) => { listeners[`doc:${ev}`] = fn; },
    documentElement: {},
  };
  const context = {
    location: { hostname: url.hostname, origin: url.origin, pathname: url.pathname },
    document: doc,
    window: { addEventListener: (ev, fn) => { listeners[ev] = fn; } },
    MutationObserver: class {
      constructor(fn) { observer = fn; }
      observe() {}
      disconnect() { disconnected = true; }
    },
    setTimeout: (fn) => { timers.push(fn); return timers.length; },
    clearTimeout: () => {},
    setInterval: () => 0,
    clearInterval: () => {},
    Date,
    JSON,
    chrome: { runtime },
  };
  vm.runInNewContext(fs.readFileSync(path.join(DIR, 'content.js'), 'utf8'), context, { filename: 'content.js' });
  return {
    sent,
    doc,
    mutate() {
      observer?.();
      while (timers.length) timers.shift()();
    },
    set present(list) { present = list; },
    set buttons(list) { buttons = list; },
    fire: (ev) => listeners[ev](),
    orphan() { delete runtime.id; },
    get disconnected() { return disconnected; },
  };
}

test('a claude.ai tab says whether a reply is being written, without the query or fragment of its address', () => {
  const p = page(`https://claude.ai/chat/${CONV}?x=1#y`, { present: ['[data-is-streaming="true"]'] });
  assert.deepEqual(plain(p.sent), [{
    type: 'chat', site: 'claude', url: `https://claude.ai/chat/${CONV}`, title: 'Plan - Claude', generating: true, looking: true,
  }]);
});

test("ChatGPT's send button turned stop button counts, and the tab speaks again only when something changes", () => {
  const p = page('https://chatgpt.com/', { title: 'ChatGPT' });
  assert.equal(p.sent[0].generating, false);
  assert.equal(p.sent[0].site, 'chatgpt');
  p.mutate();
  assert.equal(p.sent.length, 1);                 // nothing changed
  p.present = ['[data-composer-submit][data-stop-generating]'];
  p.mutate();
  assert.equal(p.sent.length, 2);
  assert.equal(p.sent[1].generating, true);
  p.present = ['[data-message-streaming]'];       // the message being written counts too
  p.mutate();
  assert.equal(p.sent.length, 2);
  p.present = [];
  p.mutate();
  assert.equal(p.sent[2].generating, false);
});

test("on ChatGPT's other page, only a stop button shown in the message box counts, in any of its languages", () => {
  const hiddenTwin = { label: '중지', shown: false };     // always there, never shown
  const p = page(`https://chatgpt.com/c/${CONV}`, { title: 'Essay', buttons: [hiddenTwin, { label: '음성 모드 시작', shown: true }] });
  assert.equal(p.sent.at(-1).generating, false);
  p.buttons = [hiddenTwin, { label: '중지', shown: true }];
  p.mutate();
  assert.equal(p.sent.at(-1).generating, true);
  p.buttons = [hiddenTwin];
  p.mutate();
  assert.equal(p.sent.at(-1).generating, false);
  p.buttons = [{ label: 'Stop streaming ', shown: true }];
  p.mutate();
  assert.equal(p.sent.at(-1).generating, true);
  assert.equal(page(`https://claude.ai/chat/${CONV}`, { buttons: [{ label: '중지', shown: true }] }).sent[0].generating, false);
});

test('leaving the page says so, and the script does nothing on other sites', () => {
  const p = page(`https://claude.ai/chat/${CONV}`);
  p.fire('pagehide');
  assert.deepEqual(plain(p.sent.at(-1)), { type: 'gone' });
  assert.deepEqual(page('https://claude.ai.evil.example/chat/1').sent, []);
  assert.deepEqual(page('https://example.com/').sent, []);
});

test('a copy of the script cut off by an extension reload stops instead of running on', () => {
  const p = page(`https://claude.ai/chat/${CONV}`);
  p.orphan();
  p.doc.title = 'Changed - Claude';
  p.mutate();
  assert.equal(p.sent.length, 1);
  assert.equal(p.disconnected, true);
});

test('looking needs the tab shown in a focused window', () => {
  const p = page(`https://claude.ai/chat/${CONV}`, { focused: false });
  assert.equal(p.sent[0].looking, false);
  p.doc.visibilityState = 'hidden';
  p.doc.hasFocus = () => true;
  p.mutate();
  assert.equal(p.sent.length, 1);                 // still not looking
  p.doc.visibilityState = 'visible';
  p.fire('focus');
  p.mutate();
  assert.equal(p.sent.at(-1).looking, true);
});

// background.js with a stand-in browser: ports, messages, tabs and windows.
function background() {
  const ports = [];
  const timers = [];
  const on = {};
  const calls = [];
  const event = (name) => ({ addListener: (fn) => { on[name] = fn; } });
  const chrome = {
    runtime: {
      lastError: undefined,
      connectNative: (name) => {
        const port = { name, posted: [], listeners: {} };
        port.postMessage = (m) => port.posted.push(m);
        port.onMessage = { addListener: (fn) => { port.listeners.message = fn; } };
        port.onDisconnect = { addListener: (fn) => { port.listeners.disconnect = fn; } };
        ports.push(port);
        return port;
      },
      onMessage: event('message'),
      onInstalled: event('installed'),
    },
    tabs: {
      onRemoved: event('removed'),
      update: async (id, props) => { calls.push(['tabs.update', id, props]); return { id, windowId: 5 }; },
      query: async (q) => { calls.push(['tabs.query', q]); return [{ id: 11 }, { id: 12 }]; },
    },
    windows: { update: async (id, props) => { calls.push(['windows.update', id, props]); } },
    scripting: { executeScript: async (opts) => { calls.push(['executeScript', opts]); } },
  };
  vm.runInNewContext(fs.readFileSync(path.join(DIR, 'background.js'), 'utf8'), {
    chrome, Map, Number, setTimeout: (fn) => { timers.push(fn); return timers.length; }, clearTimeout: () => {},
  }, { filename: 'background.js' });
  return { ports, timers, on, calls };
}

test('after an install or update, the chat tabs already open get a fresh copy of the content script', async () => {
  const b = background();
  b.on.installed({ reason: 'chrome_update' });     // the browser updated: their copies still work
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(b.calls, []);
  b.on.installed({ reason: 'update' });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(plain(b.calls), [
    ['tabs.query', { url: ['https://claude.ai/*', 'https://chatgpt.com/*'] }],
    ['executeScript', { target: { tabId: 11 }, files: ['content.js'] }],
    ['executeScript', { target: { tabId: 12 }, files: ['content.js'] }],
  ]);
});

const fromTab = (id) => ({ tab: { id, windowId: 3 } });
const report = { type: 'chat', site: 'claude', url: `https://claude.ai/chat/${CONV}`, title: 'Plan - Claude', generating: true, looking: false };

test("the background script adds the tab and window to each tab's report and passes it to the pet's host", () => {
  const b = background();
  assert.equal(b.ports[0].name, 'com.hyukjunlim.claude_pet');
  b.on.message(report, fromTab(7));
  b.on.message(report, {});                       // not from a tab
  b.on.message({ type: 'other' }, fromTab(7));
  assert.deepEqual(plain(b.ports[0].posted), [{ ...report, tabId: 7, windowId: 3 }]);
  b.on.message({ type: 'gone' }, fromTab(7));
  b.on.removed(7);                                // already forgotten: said once
  assert.deepEqual(plain(b.ports[0].posted.slice(1)), [{ type: 'closed', tabId: 7 }]);
});

test('without the pet it tries again later, and then sends every open tab again', () => {
  const b = background();
  b.on.message(report, fromTab(1));
  b.ports[0].listeners.disconnect();              // no host registered yet
  b.on.message({ ...report, generating: false }, fromTab(1));
  assert.equal(b.ports.length, 1);                // waits for the retry instead of hammering
  b.timers.shift()();
  assert.deepEqual(plain(b.ports[1].posted), [{ ...report, generating: false, tabId: 1, windowId: 3 }]);
});

test("the pet's request brings the tab forward and focuses its window", async () => {
  const b = background();
  b.ports[0].listeners.message({ type: 'focus', tabId: 7 });
  b.ports[0].listeners.message({ type: 'focus', tabId: 'x' });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(plain(b.calls), [['tabs.update', 7, { active: true }], ['windows.update', 5, { focused: true }]]);
});

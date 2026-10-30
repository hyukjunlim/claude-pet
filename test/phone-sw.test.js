'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const WWW = path.join(__dirname, '..', 'src', 'phone', 'www');
const ORIGIN = 'https://desktop-pc.tail1234.ts.net';
const ANDROID = 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36';
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const SESSION = { app: 'claude', url: 'https://claude.ai/code/session_01AbCdEfGhIjKlMn' };
const ANDROID_LINK = 'intent://claude.ai/code/session_01AbCdEfGhIjKlMn#Intent;scheme=https;package=com.anthropic.claude;'
  + `S.browser_fallback_url=${encodeURIComponent(SESSION.url)};end`;

// The page's service worker (sw.js, with the links.js it imports) on a phone with `userAgent`.
// `windows`: the pet's page, where it's open.
function worker(userAgent, { windows = [] } = {}) {
  const handlers = {};
  const opened = [];
  const shown = [];
  const self = {
    navigator: { userAgent },
    location: new URL(`${ORIGIN}/sw.js`),
    addEventListener: (type, fn) => { handlers[type] = fn; },
    skipWaiting() {},
    registration: { showNotification: async (title, options) => { shown.push({ title, silent: options.silent }); } },
    clients: {
      claim: async () => {},
      matchAll: async () => windows,
      openWindow: async (url) => { opened.push(url); },
    },
  };
  const context = vm.createContext({
    self, URL, URLSearchParams, Response, importScripts: (p) => vm.runInContext(fs.readFileSync(path.join(WWW, p), 'utf8'), context),
  });
  vm.runInContext(fs.readFileSync(path.join(WWW, 'sw.js'), 'utf8'), context);
  const click = async (data, { title = 'Ready · Fix the parser', body = 'Claude Code · Terminal · pet' } = {}) => {
    let work = null;
    handlers.notificationclick({ notification: { title, body, data, close() {} }, waitUntil: (p) => { work = p; } });
    await work;
    return opened;
  };
  // What the worker answers for a page the phone opens at `url` (relative to the pet's address).
  const visit = async (url) => {
    let answer = null;
    handlers.fetch({ request: { url: new URL(url, ORIGIN).href, mode: 'navigate' }, respondWith: (r) => { answer = r; } });
    return answer && { headers: answer.headers, html: await answer.text() };
  };
  // What the phone shows for a push of `data`.
  const push = async (data) => {
    let work = null;
    handlers.push({ data: { json: () => data, text: () => JSON.stringify(data) }, waitUntil: (p) => { work = p; } });
    await work;
    return shown.at(-1);
  };
  return { click, visit, push };
}

const hrefs = (html) => [...html.matchAll(/<a class="(\w+)" href="([^"]*)"/g)].map(([, cls, href]) => [cls, href.replace(/&#(\d+);/g, (_, n) => String.fromCharCode(n))]);

test('a tap opens a page about the notification, with a button into the app at that session', async () => {
  const w = worker(ANDROID);
  const [url] = await w.click({ id: 'cli:a', open: SESSION });
  assert.match(url, /^\/open\?/);
  const page = await w.visit(url);
  assert.match(page.html, /<h1>Ready · Fix the parser<\/h1>/);
  assert.match(page.html, /<p>Claude Code · Terminal · pet<\/p>/);
  assert.match(page.html, />Open in Claude</);
  assert.deepEqual(hrefs(page.html), [['open', ANDROID_LINK], ['list', '/#item=cli%3Aa']]);
  assert.match(page.headers.get('content-security-policy'), /default-src 'none'/, 'and no script runs on it');
});

test('an eTL notice\'s button opens LearningX on Android, and an iPhone\'s button is the web address', async () => {
  const etl = worker(ANDROID);
  const page = await etl.visit((await etl.click({ id: 'etl:ann:1', open: { app: 'learningx', url: 'https://myetl.snu.ac.kr/courses/1/discussion_topics/2' } }))[0]);
  assert.match(hrefs(page.html)[0][1], /^intent:\/\/myetl\.snu\.ac\.kr\/courses\/1\/discussion_topics\/2#Intent;scheme=canvas-courses;package=com\.instructure\.candroid\.xinics2\.production;/);
  assert.match(page.html, />Open in LearningX</);

  const iphone = worker(IPHONE);
  const html = (await iphone.visit((await iphone.click({ id: 'codex:c', open: { app: 'chatgpt', url: 'https://chatgpt.com/codex' } }))[0])).html;
  assert.deepEqual(hrefs(html)[0], ['open', 'https://chatgpt.com/codex']);
  assert.match(html, /target="_blank" rel="noopener noreferrer">Open in ChatGPT</);
});

test('the page shows text as text, and an address off the app\'s own site gets no button', async () => {
  const w = worker(ANDROID);
  const page = await w.visit(`/open?${new URLSearchParams({ id: 'x', title: '<img src=x onerror=alert(1)>', body: '"quoted"', app: 'claude', url: 'https://evil.example/' })}`);
  assert.ok(!page.html.includes('<img'));
  assert.match(page.html, /&#60;img src=x onerror=alert\(1\)&#62;/);
  assert.deepEqual(hrefs(page.html), [['list', '/#item=x']]);
  for (const url of ['javascript:alert(1)', 'http://claude.ai/code', 'https://claude.ai.evil.example/']) {
    assert.deepEqual(hrefs((await w.visit(`/open?${new URLSearchParams({ app: 'claude', url })}`)).html), [['list', '/']], url);
  }
});

test('a notification comes silently when the pet says so, else with the phone\'s sound', async () => {
  const w = worker(ANDROID);
  assert.deepEqual(await w.push({ title: 'Ready · A', tag: 'cli:a', silent: true }), { title: 'Ready · A', silent: true });
  assert.deepEqual(await w.push({ title: 'Ready · A', tag: 'cli:a', silent: false }), { title: 'Ready · A', silent: false });
  assert.deepEqual(await w.push({ title: 'Ready · A', tag: 'cli:a' }), { title: 'Ready · A', silent: false }, 'a push from an older pet');
});

test('the worker answers only for that page; the pet\'s own pages come from the PC', async () => {
  const w = worker(ANDROID);
  assert.equal(await w.visit('/'), null);
  assert.equal(await w.visit('/api/state'), null);
  assert.equal(await w.visit('https://claude.ai/open'), null);
});

test('a notification with nothing to open brings the pet\'s page forward at that row', async () => {
  const shown = [];
  const page = { focus: async () => {}, postMessage: (m) => shown.push({ ...m }) };   // out of the worker's realm
  assert.deepEqual(await worker(ANDROID, { windows: [page] }).click({ id: null, open: null }), []);
  assert.deepEqual(shown, [{ type: 'show', id: null }]);
  assert.deepEqual(await worker(ANDROID).click({ id: 'web:1', open: null }), ['/#item=web%3A1']);
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { END_GRACE_MS, WebChats, displayTitle, parseReport } = require('../src/webchats/chats');

const CONV = '0f8fad5b-d9cb-469f-a165-70867728950e';
const OTHER = '7c9e6679-7425-40de-944b-e07fc1f90ae7';

// A WebChats on a hand-driven clock, with one host (process 100) connected as source 'h1'.
function chats() {
  let t = 1_000_000;
  const timers = [];
  const c = new WebChats({
    now: () => t,
    setTimer: (fn, ms) => {
      const h = { fn, at: t + ms };
      timers.push(h);
      return h;
    },
    clearTimer: (h) => {
      const i = timers.indexOf(h);
      if (i !== -1) timers.splice(i, 1);
    },
  });
  c.addSource('h1', { hostPid: 100 });
  const advance = (ms) => {
    t += ms;
    for (const h of [...timers].sort((a, b) => a.at - b.at)) {
      if (h.at > t || !timers.includes(h)) continue;
      timers.splice(timers.indexOf(h), 1);
      h.fn();
    }
  };
  const tab = (patch = {}) => ({
    type: 'chat', tabId: 7, windowId: 1, site: 'claude', url: `https://claude.ai/chat/${CONV}`,
    title: 'Refactor plan - Claude', generating: false, looking: false, ...patch,
  });
  return { c, advance, tab, now: () => t };
}

const bubbles = (c) => c.items().map((it) => [it.status, it.title]);

test('a reply being written is Running, and Ready once it ends while you look elsewhere', () => {
  const { c, advance, tab } = chats();
  c.report('h1', tab({ generating: true, looking: true }));
  assert.deepEqual(bubbles(c), [['running', 'Refactor plan']]);
  c.report('h1', tab({ generating: true, looking: false }));
  c.report('h1', tab({ generating: false }));
  assert.deepEqual(bubbles(c), [['running', 'Refactor plan']]);   // not over until the grace period is
  advance(END_GRACE_MS);
  assert.deepEqual(bubbles(c), [['review', 'Refactor plan']]);
  const [item] = c.items();
  assert.equal(item.id, `web:claude:${CONV}`);
  assert.equal(item.kind, 'web');
  assert.equal(item.url, `https://claude.ai/chat/${CONV}`);
});

test('a reply that ends while you look at its tab leaves no bubble', () => {
  const { c, advance, tab } = chats();
  c.report('h1', tab({ generating: true, looking: true }));
  c.report('h1', tab({ generating: false, looking: true }));
  advance(END_GRACE_MS);
  assert.deepEqual(bubbles(c), []);
});

test('Ready goes away once you look at the chat', () => {
  const { c, advance, tab } = chats();
  c.report('h1', tab({ generating: true }));
  c.report('h1', tab({ generating: false }));
  advance(END_GRACE_MS);
  assert.equal(c.items().length, 1);
  c.report('h1', tab({ looking: true }));
  assert.deepEqual(bubbles(c), []);
});

test('a stop control that drops out for a moment is still the same reply', () => {
  const { c, advance, tab, now } = chats();
  c.report('h1', tab({ generating: true }));
  const since = now();
  advance(5000);
  c.report('h1', tab({ generating: false }));
  advance(END_GRACE_MS - 500);
  c.report('h1', tab({ generating: true }));
  advance(END_GRACE_MS);
  assert.deepEqual(bubbles(c), [['running', 'Refactor plan']]);
  assert.equal(c.items()[0].since, since);
});

test('a new chat carries on as its conversation once the site gives it an address', () => {
  const { c, advance, tab, now } = chats();
  c.report('h1', tab({ url: 'https://claude.ai/new', title: 'Claude', generating: true }));
  const since = now();
  assert.deepEqual(bubbles(c), [['running', 'New chat']]);
  advance(3000);
  c.report('h1', tab({ title: 'Trip ideas - Claude', generating: true }));
  assert.deepEqual(c.items().map((it) => [it.id, it.title, it.since]), [[`web:claude:${CONV}`, 'Trip ideas', since]]);
});

test('two tabs of one conversation make one bubble, and looking at either counts', () => {
  const { c, advance, tab } = chats();
  c.report('h1', tab({ tabId: 1, generating: true }));
  c.report('h1', tab({ tabId: 2 }));
  assert.equal(c.items().length, 1);
  c.report('h1', tab({ tabId: 1, generating: false }));
  advance(END_GRACE_MS);
  assert.deepEqual(bubbles(c), [['review', 'Refactor plan']]);
  c.report('h1', tab({ tabId: 2, looking: true }));
  assert.deepEqual(bubbles(c), []);
});

test('its × marks a Ready chat as seen; a reply still being written has none', () => {
  const { c, advance, tab } = chats();
  c.report('h1', tab({ generating: true }));
  c.dismiss(`web:claude:${CONV}`);
  assert.deepEqual(bubbles(c), [['running', 'Refactor plan']]);
  c.report('h1', tab({ generating: false }));
  advance(END_GRACE_MS);
  c.dismiss(`web:claude:${CONV}`);
  assert.deepEqual(bubbles(c), []);
});

test('closing the tab drops a reply in progress but keeps a Ready chat, which then opens by its address', () => {
  const { c, advance, tab } = chats();
  c.report('h1', tab({ generating: true }));
  c.closed('h1', 7);
  assert.deepEqual(bubbles(c), []);
  c.report('h1', tab({ tabId: 8, generating: true }));
  c.report('h1', tab({ tabId: 8, generating: false }));
  advance(END_GRACE_MS);
  assert.deepEqual([c.target(`web:claude:${CONV}`).tab.tabId, c.target(`web:claude:${CONV}`).tab.hostPid], [8, 100]);
  c.closed('h1', 8);
  assert.deepEqual(bubbles(c), [['review', 'Refactor plan']]);
  assert.deepEqual(c.target(`web:claude:${CONV}`), { url: `https://claude.ai/chat/${CONV}`, tab: null });
});

test('a host that goes away takes its tabs with it, and tab ids of two hosts never mix', () => {
  const { c, tab } = chats();
  c.addSource('h2', { hostPid: 200 });
  c.report('h1', tab({ generating: true }));
  c.report('h2', tab({ url: `https://chatgpt.com/c/${OTHER}`, site: 'chatgpt', title: 'Essay', generating: true }));
  assert.deepEqual(c.items().map((it) => it.title), ['Refactor plan', 'Essay']);
  assert.equal(c.target(`web:chatgpt:${OTHER}`).tab.hostPid, 200);
  assert.equal(c.connected(), 2);
  c.removeSource('h1');
  assert.deepEqual(bubbles(c), [['running', 'Essay']]);
  assert.equal(c.connected(), 1);
});

test("reports that aren't from the two sites, or aren't well formed, are left out", () => {
  const { c, tab } = chats();
  for (const bad of [
    tab({ url: 'https://claude.ai.evil.example/chat/x' }),
    tab({ url: `https://chatgpt.com/c/${OTHER}` }),            // a claude report for ChatGPT's site
    tab({ url: 'javascript:alert(1)' }),
    tab({ site: 'gemini' }),
    tab({ site: '__proto__' }),
    tab({ tabId: '7' }),
    tab({ tabId: -1 }),
    null,
    'chat',
  ]) c.report('h1', bad && typeof bad === 'object' ? { ...bad, generating: true } : bad);
  assert.deepEqual(c.items(), []);
  c.report('h9', tab({ generating: true }));                  // a host that never said hello
  assert.deepEqual(c.items(), []);
});

test('the address keeps no query or fragment, and a long title is cut short', () => {
  const r = parseReport({
    tabId: 1, site: 'chatgpt', url: `https://chatgpt.com/g/g-p-abc-project/c/${OTHER.toUpperCase()}?model=x#top`, title: 'x'.repeat(1000),
  });
  assert.equal(r.url, `https://chatgpt.com/g/g-p-abc-project/c/${OTHER.toUpperCase()}`);
  assert.equal(r.conversation, OTHER);
  assert.equal(r.rawTitle.length, 300);
  assert.ok(r.title.length <= 120);
});

test("titles lose the site's name, and a page with only the name is a new chat", () => {
  assert.equal(displayTitle('claude', 'Refactor plan - Claude'), 'Refactor plan');
  assert.equal(displayTitle('claude', 'Claude'), 'New chat');
  assert.equal(displayTitle('chatgpt', 'Essay outline'), 'Essay outline');
  assert.equal(displayTitle('chatgpt', 'ChatGPT'), 'New chat');
  assert.equal(displayTitle('chatgpt', 'ChatGPT - Essay outline'), 'Essay outline');
  assert.equal(displayTitle('chatgpt', '  '), 'New chat');
  assert.equal(displayTitle('gemini', '서울대 MICC 연구실 정보 - Google Gemini'), '서울대 MICC 연구실 정보');
  assert.equal(displayTitle('gemini', 'Google Gemini'), 'New chat');
});

test('a Gemini conversation is /app/ and its id; the start page is a chat of its own until it gets one', () => {
  const r = parseReport({ tabId: 3, site: 'gemini', url: 'https://gemini.google.com/app/671B3F7B87A71FC7?hl=ko', title: '서울대 MICC 연구실 정보 - Google Gemini' });
  assert.deepEqual([r.url, r.conversation, r.title], ['https://gemini.google.com/app/671B3F7B87A71FC7', '671b3f7b87a71fc7', '서울대 MICC 연구실 정보']);
  assert.equal(parseReport({ tabId: 3, site: 'gemini', url: 'https://gemini.google.com/app', title: 'Google Gemini' }).conversation, null);
  assert.equal(parseReport({ tabId: 3, site: 'gemini', url: 'https://gemini.google.com.evil.example/app/671b3f7b87a71fc7', title: 'x' }), null);
});

test('the full list has every conversation a tab shows, quiet ones too, newest first, for folder mode', () => {
  const { c, advance, tab } = chats();
  const lists = [];
  c.on('list', (l) => lists.push(l));
  c.report('h1', tab({ tabId: 7, title: 'Quiet one - Claude' }));
  advance(1000);
  c.report('h1', tab({ tabId: 8, site: 'chatgpt', url: `https://chatgpt.com/c/${OTHER}`, title: 'ChatGPT - Busy one', generating: true }));
  assert.deepEqual(c.items().map((it) => it.title), ['Busy one']);           // the bubbles: only what's going on
  const all = c.all();
  assert.deepEqual(all.map((it) => [it.site, it.title, it.status]), [['chatgpt', 'Busy one', 'running'], ['claude', 'Quiet one', 'idle']]);
  assert.equal(all[1].id, `web:claude:${CONV}`);
  assert.deepEqual(all.map((it) => it.lastPromptAt), [all[0].since, 0]);   // a reply starts when you send a message
  assert.deepEqual(lists.at(-1), all);
  c.closed('h1', 7);                                                          // its tab closed: a quiet one goes
  assert.deepEqual(c.all().map((it) => it.title), ['Busy one']);
});

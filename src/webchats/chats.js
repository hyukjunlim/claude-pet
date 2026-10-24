'use strict';

// What the pet makes of the browser extension's reports: a bubble for each claude.ai or ChatGPT
// conversation, the way it shows a Claude session. It's Running while a reply is being written in
// any of the conversation's tabs, and Ready once the reply is done, unless you were looking at one
// of those tabs when it finished. Ready stays until you look at the conversation, click its bubble
// or close it with its ×; it outlives its tab, and then a click opens the conversation's address.
//
// Each report is one tab's state, sent whenever it changes (content.js, through host.js):
// { tabId, windowId, site, url, title, generating, looking }. "Looking" means the tab is the one
// shown in a browser window that has the focus. Reports come from a source, one per running host
// (a browser profile); tab ids are only unique within it. A source knows its host's process id, from
// which a click finds the browser's window (raise.js). A tab whose address names no conversation
// yet (claude.ai/new, ChatGPT's home page) is a conversation of its own until the site gives it one.

const { EventEmitter } = require('node:events');

const UUID = '([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})';
const SITES = {
  claude: {
    origin: 'https://claude.ai',
    name: 'claude.ai',
    conversation: new RegExp(`^/chat/${UUID}(?:/|$)`, 'i'),
    suffix: /\s*[-–]\s*Claude$/,
    home: 'Claude',
  },
  chatgpt: {
    origin: 'https://chatgpt.com',
    name: 'ChatGPT',
    conversation: new RegExp(`/c/${UUID}(?:/|$)`, 'i'),   // also under /g/<gpt or project>/
    suffix: /^ChatGPT\s*[-–]\s*|\s*[-–]\s*ChatGPT$/,
    home: 'ChatGPT',
  },
};
const END_GRACE_MS = 2000;     // the stop control can drop out for a moment between steps of one reply
const MAX_RAW_TITLE = 300;
const MAX_TITLE = 120;
const MAX_TABS = 1000;

// A report as the pet keeps it, or null when it isn't one.
function parseReport(msg) {
  if (!msg || typeof msg !== 'object') return null;
  const site = Object.hasOwn(SITES, msg.site) ? SITES[msg.site] : null;
  if (!site || !Number.isSafeInteger(msg.tabId) || msg.tabId < 0 || typeof msg.url !== 'string') return null;
  let url;
  try {
    url = new URL(msg.url);
  } catch {
    return null;
  }
  if (url.origin !== site.origin) return null;
  const rawTitle = typeof msg.title === 'string' ? msg.title.slice(0, MAX_RAW_TITLE) : '';
  return {
    tabId: msg.tabId,
    windowId: Number.isSafeInteger(msg.windowId) ? msg.windowId : null,
    site: msg.site,
    url: url.origin + url.pathname,
    conversation: site.conversation.exec(url.pathname)?.[1].toLowerCase() ?? null,
    rawTitle,
    title: displayTitle(msg.site, rawTitle),
    generating: msg.generating === true,
    looking: msg.looking === true,
  };
}

// The tab's title without the site's name; a page that shows only the name is a new chat.
function displayTitle(siteKey, raw) {
  const site = SITES[siteKey];
  const title = raw.replace(/\s+/g, ' ').trim();
  if (!title || title === site.home) return 'New chat';
  const short = title.replace(site.suffix, '').trim() || 'New chat';
  return short.length > MAX_TITLE ? `${short.slice(0, MAX_TITLE - 1)}…` : short;
}

class WebChats extends EventEmitter {
  constructor({ now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
    super();
    this.now = now;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.sources = new Map();    // source id -> { hostPid }
    this.tabs = new Map();       // `${source} ${tabId}` -> { source, key, ...report }
    this.chats = new Map();      // conversation key -> its state (see #chat)
    this.lastEmitted = '';
    this.lastListed = '';
  }

  addSource(id, { hostPid = null } = {}) {
    this.sources.set(id, { hostPid: Number.isSafeInteger(hostPid) && hostPid > 0 ? hostPid : null });
  }

  // Its host went away (the browser closed, or the extension was turned off): its tabs are gone.
  removeSource(id) {
    if (!this.sources.delete(id)) return;
    const keys = new Set();
    for (const [tk, tab] of this.tabs) {
      if (tab.source !== id) continue;
      this.tabs.delete(tk);
      keys.add(tab.key);
    }
    for (const key of keys) this.#refresh(key);
    this.#emit();
  }

  report(source, msg) {
    if (!this.sources.has(source)) return;
    const r = parseReport(msg);
    if (!r) return;
    const tk = `${source} ${r.tabId}`;
    const before = this.tabs.get(tk);
    if (!before && this.tabs.size >= MAX_TABS) return;
    const key = r.conversation ? `${r.site}:${r.conversation}` : `tab:${source}:${r.tabId}`;
    // A new chat that the site just gave an address carries on as that conversation.
    if (before && before.key !== key && !this.chats.has(key) && !this.#hasOtherTab(before.key, tk)) {
      const chat = this.chats.get(before.key);
      if (chat) {
        this.chats.delete(before.key);
        chat.key = key;
        this.chats.set(key, chat);
      }
    }
    this.tabs.set(tk, { source, key, ...r });
    if (!this.chats.has(key)) this.chats.set(key, this.#chat(key, r));
    if (before && before.key !== key) this.#refresh(before.key);
    this.#refresh(key);
    this.#emit();
  }

  closed(source, tabId) {
    const tk = `${source} ${tabId}`;
    const tab = this.tabs.get(tk);
    if (!tab) return;
    this.tabs.delete(tk);
    this.#refresh(tab.key);
    this.#emit();
  }

  // Its × (or a click on it): a Ready bubble counts as seen. A reply still being written has no ×.
  dismiss(id) {
    const chat = this.chats.get(String(id).replace(/^web:/, ''));
    if (!chat || chat.status !== 'review') return;
    chat.status = null;
    this.#refresh(chat.key);
    this.#emit();
  }

  // Where a click on the bubble goes: the tab to bring forward (if one still shows it) and the
  // conversation's address.
  target(id) {
    const chat = this.chats.get(String(id).replace(/^web:/, ''));
    if (!chat) return null;
    const tab = this.#tabsOf(chat.key).find((t) => t.looking) || this.#tabsOf(chat.key)[0] || null;
    return {
      url: chat.url,
      tab: tab && {
        source: tab.source, tabId: tab.tabId, windowId: tab.windowId, rawTitle: tab.rawTitle,
        hostPid: this.sources.get(tab.source)?.hostPid ?? null,
      },
    };
  }

  // How many hosts (browser profiles with the extension) are connected now.
  connected() {
    return this.sources.size;
  }

  items() {
    const out = [];
    for (const chat of this.chats.values()) {
      if (!chat.status) continue;
      out.push({
        id: `web:${chat.key}`,
        kind: 'web',
        site: chat.site,
        status: chat.status,
        title: chat.title,
        detail: chat.status === 'running' ? 'Writing a reply' : 'Reply ready',
        url: chat.url,
        since: chat.since,
      });
    }
    return out;
  }

  // Every conversation the pet knows (a tab shows it, or it's Ready), quiet ones too, for folder
  // mode's list; one with nothing going on is idle.
  all() {
    return [...this.chats.values()].map((chat) => ({
      id: `web:${chat.key}`,
      kind: 'web',
      site: chat.site,
      status: chat.status || 'idle',
      title: chat.title,
      detail: chat.status === 'running' ? 'Writing a reply' : chat.status === 'review' ? 'Reply ready' : '',
      url: chat.url,
      since: chat.since,
      lastActivityAt: chat.activeAt,
    })).sort((a, b) => b.lastActivityAt - a.lastActivityAt);
  }

  clear() {
    for (const chat of this.chats.values()) this.clearTimer(chat.endTimer);
    this.sources.clear();
    this.tabs.clear();
    this.chats.clear();
    this.#emit();
  }

  #chat(key, r) {
    return {
      key, site: r.site, title: r.title, url: r.url, status: null, since: 0, looking: false, endTimer: null,
      activeAt: this.now(),      // when it turned up, or last had a reply going
    };
  }

  #tabsOf(key) {
    return [...this.tabs.values()].filter((t) => t.key === key);
  }

  #hasOtherTab(key, exceptTk) {
    for (const [tk, tab] of this.tabs) if (tk !== exceptTk && tab.key === key) return true;
    return false;
  }

  #refresh(key) {
    const chat = this.chats.get(key);
    if (!chat) return;
    const tabs = this.#tabsOf(key);
    if (!tabs.length) {
      // Nothing shows it any more. A reply being written can't be followed from here; a Ready
      // conversation stays, and its address still opens it.
      this.clearTimer(chat.endTimer);
      chat.endTimer = null;
      chat.looking = false;
      if (chat.status !== 'review') this.chats.delete(key);
      return;
    }
    const shown = tabs.find((t) => t.looking) || tabs.find((t) => t.generating) || tabs[0];
    Object.assign(chat, { site: shown.site, title: shown.title, url: shown.url });
    chat.looking = tabs.some((t) => t.looking);
    if (tabs.some((t) => t.generating)) {
      this.clearTimer(chat.endTimer);        // the same reply goes on
      chat.endTimer = null;
      if (chat.status !== 'running') {
        chat.status = 'running';
        chat.since = this.now();
        chat.activeAt = chat.since;
      }
    } else if (chat.status === 'running' && !chat.endTimer) {
      chat.endTimer = this.setTimer(() => this.#ended(chat), END_GRACE_MS);
    }
    if (chat.status === 'review' && chat.looking) chat.status = null;   // you've seen it
  }

  #ended(chat) {
    chat.endTimer = null;
    if (this.chats.get(chat.key) !== chat || chat.status !== 'running') return;
    chat.status = chat.looking ? null : 'review';
    chat.since = this.now();
    chat.activeAt = chat.since;
    this.#emit();
  }

  // 'change': the bubbles (items); 'list': every conversation (all), for folder mode.
  #emit() {
    const list = this.items();
    const key = JSON.stringify(list);
    if (key !== this.lastEmitted) {
      this.lastEmitted = key;
      this.emit('change', list);
    }
    const all = this.all();
    const allKey = JSON.stringify(all);
    if (allKey !== this.lastListed) {
      this.lastListed = allKey;
      this.emit('list', all);
    }
  }
}

module.exports = { END_GRACE_MS, SITES, WebChats, displayTitle, parseReport };

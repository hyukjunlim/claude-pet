'use strict';

// What the phone shows: the sidebar's machine › folder tree (folder-tree.js), eTL's notices and the
// weekly limits, cut down to what the page draws. Each session and notice says which app a tap
// opens and at which page (`open`); the page turns that into a link for the phone it runs on
// (src/phone/www/app.js). A tap opens the app, not a session in it (CONSTRAINTS.md): the apps
// offer no link to one Claude Code session or Codex thread on a phone. A web chat lives in the
// account, so it opens at its own conversation.

const ETL_HOME = 'https://myetl.snu.ac.kr/';
const ETL_LINK = /^https:\/\/myetl\.snu\.ac\.kr\//;
const CHAT_LINK = {
  'claude-web': /^https:\/\/claude\.ai\//,
  chatgpt: /^https:\/\/chatgpt\.com\//,
  gemini: /^https:\/\/gemini\.google\.com\//,
};

// app (folder-tree.js's itemOf) -> [the phone app, the page it opens at]
const OPEN = {
  claude: ['claude', 'https://claude.ai/code'],
  vscode: ['claude', 'https://claude.ai/code'],
  terminal: ['claude', 'https://claude.ai/code'],
  codex: ['chatgpt', 'https://chatgpt.com/codex'],
  'codex-vscode': ['chatgpt', 'https://chatgpt.com/codex'],
  'codex-terminal': ['chatgpt', 'https://chatgpt.com/codex'],
  'claude-web': ['claude', 'https://claude.ai/'],
  chatgpt: ['chatgpt', 'https://chatgpt.com/'],
  gemini: ['gemini', 'https://gemini.google.com/app'],
};

function openTarget(app, chatUrl = null) {
  const [phoneApp, url] = OPEN[app] || OPEN.claude;
  const own = CHAT_LINK[app]?.test(chatUrl || '') ? chatUrl : null;
  return { app: phoneApp, url: own || url };
}

function sessionOf(s, chatUrl) {
  return {
    id: s.id,
    app: s.app,
    title: s.title || '',
    status: s.status,
    detail: s.detail || '',
    since: s.since || 0,
    lastActivityAt: s.lastActivityAt || 0,
    ...(s.siteName && { siteName: s.siteName }),
    open: openTarget(s.app, chatUrl(s.id)),
  };
}

function folderOf(n, chatUrl) {
  return {
    key: n.key,
    label: n.label,
    path: n.path,
    open: n.open,
    attention: n.attention,
    busy: n.busy,
    sessions: n.sessions.map((s) => sessionOf(s, chatUrl)),
    children: n.children.map((c) => folderOf(c, chatUrl)),
  };
}

// `hosts`: buildTree's. `notices`: the eTL items (etl/feature.js). `usage`: usageView's.
// `chatUrl(id)`: a web chat's address, if a tab shows it.
function phoneView({ hosts = [], notices = [], usage = [], chatUrl = () => null } = {}) {
  return {
    hosts: hosts.map((h) => ({
      key: h.key,
      kind: h.kind,
      label: h.label,
      attention: h.attention,
      busy: h.busy,
      folders: h.folders.map((n) => folderOf(n, chatUrl)),
      loose: h.loose.map((s) => sessionOf(s, chatUrl)),
    })),
    // The eTL assistant opens a Codex chat on the PC; there's nothing for it on the phone.
    notices: notices.filter((s) => !s.assistant).map((s) => ({
      id: s.id,
      status: s.status,
      badge: s.badge || '',
      title: s.title || '',
      project: s.project || '',
      open: { app: 'learningx', url: ETL_LINK.test(s.url || '') ? s.url : ETL_HOME },
    })),
    usage: usage.map(({ app, name, percent, elapsed, resetsIn, age }) => ({ app, name, percent, elapsed, resetsIn, age })),
  };
}

module.exports = { phoneView, openTarget, ETL_HOME };

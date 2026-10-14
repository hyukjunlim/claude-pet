'use strict';

// The "eTL 비서" bubble: a bubble that stays while eTL is on and, when clicked, goes straight to
// the eTL chat in Codex. That's the newest Codex thread started in the chat folder, found from
// the first line of each rollout (~/.codex/sessions/<y>/<m>/<d>/rollout-*.jsonl, newest first);
// without one, Codex is asked to start a new chat there. Without Codex, the folder is opened.

const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const ASSISTANT_ID = 'etl:assistant';
const HEAD_BYTES = 16 * 1024;           // session_meta's id and cwd come early in its line
const MAX_DAYS = 60;                    // day folders looked through, newest first
const NEW_CHAT_PROMPT = '오늘 브리핑해 줘';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const listDir = (dir) => {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
};

const samePath = (a, b) => {
  const norm = (p) => path.resolve(p).replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? norm(a).toLowerCase() === norm(b).toLowerCase() : norm(a) === norm(b);
};

// The thread id and folder from a rollout's first line, or null. Threads Codex started on its
// own (subagents and the like) don't count.
function rolloutMeta(file) {
  let head;
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(HEAD_BYTES);
      head = buf.subarray(0, fs.readSync(fd, buf, 0, HEAD_BYTES, 0)).toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
  if (!/"type"\s*:\s*"session_meta"/.test(head)) return null;
  const field = (name) => {
    const m = new RegExp(`"${name}"\\s*:\\s*("(?:[^"\\\\]|\\\\.)*")`).exec(head);
    try {
      return m ? JSON.parse(m[1]) : null;
    } catch {
      return null;
    }
  };
  const id = field('id');
  const cwd = field('cwd');
  const source = field('thread_source');
  if (!id || !UUID_RE.test(id) || !cwd || (source && source !== 'user')) return null;
  return { id, cwd };
}

// The newest Codex thread whose folder is `dir`, or null.
function findCodexThread(dir, { sessionsRoot }) {
  const days = [];
  for (const y of listDir(sessionsRoot).filter((n) => /^\d{4}$/.test(n))) {
    for (const m of listDir(path.join(sessionsRoot, y)).filter((n) => /^\d{2}$/.test(n))) {
      for (const d of listDir(path.join(sessionsRoot, y, m)).filter((n) => /^\d{2}$/.test(n))) days.push(path.join(y, m, d));
    }
  }
  days.sort().reverse();
  for (const day of days.slice(0, MAX_DAYS)) {
    const folder = path.join(sessionsRoot, day);
    const files = listDir(folder).filter((n) => n.startsWith('rollout-') && n.endsWith('.jsonl'))
      .map((n) => {
        const file = path.join(folder, n);
        let mtime = 0;
        try { mtime = fs.statSync(file).mtimeMs; } catch { /* gone */ }
        return { file, mtime };
      })
      .sort((a, b) => b.mtime - a.mtime);
    for (const { file } of files) {
      const meta = rolloutMeta(file);
      if (meta && samePath(meta.cwd, dir)) return meta.id;
    }
  }
  return null;
}

// What clicking the bubble opens, in order. A thread link alone leaves Codex on whatever project
// was selected, so the folder's link goes first: it selects the folder's project (adding it if
// need be) on a new chat, and the newest eTL chat then opens in it. Without a chat yet, the new
// one starts with a prompt; without Codex, the folder opens.
function assistantLinks(dir, { codexInstalled, sessionsRoot }) {
  if (!codexInstalled) return [pathToFileURL(dir).href];
  const project = `codex://threads/new?path=${encodeURIComponent(dir)}`;
  const id = findCodexThread(dir, { sessionsRoot });
  if (id) return [project, `codex://threads/${id}`];
  return [`${project}&prompt=${encodeURIComponent(NEW_CHAT_PROMPT)}`];
}

function assistantItem({ since, codexInstalled }) {
  return {
    id: ASSISTANT_ID,
    kind: 'etl',
    assistant: true,
    status: 'background',             // last in line, nothing to dismiss, the pet stays idle
    badge: 'eTL 비서',
    title: '과제·공지·강의자료 물어보기',
    project: codexInstalled ? '눌러서 Codex에서 대화 열기' : '눌러서 채팅 폴더 열기',
    detail: '',
    url: null,
    since,
  };
}

module.exports = { ASSISTANT_ID, NEW_CHAT_PROMPT, assistantItem, assistantLinks, findCodexThread, rolloutMeta };

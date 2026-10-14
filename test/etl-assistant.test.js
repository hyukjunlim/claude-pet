'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { ASSISTANT_ID, assistantItem, assistantLinks, findCodexThread } = require('../src/etl/assistant');

const WS = path.join(os.tmpdir(), 'etl-assistant-ws');
const A = '01a1362e-cde9-7440-a9d5-d58b9ed6ea81';
const B = '01a1362f-0000-7000-8000-000000000002';
const C = '01a13630-0000-7000-8000-000000000003';

// A Codex sessions folder with rollouts whose first line is session_meta.
function sessions(rollouts) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'etl-codex-'));
  for (const { day, id, cwd, source = 'user', mtime } of rollouts) {
    const dir = path.join(root, ...day.split('/'));
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `rollout-${day.replace(/\//g, '-')}T00-00-00-${id}.jsonl`);
    const meta = { type: 'session_meta', payload: { id, cwd, thread_source: source, base_instructions: 'x'.repeat(500) } };
    fs.writeFileSync(file, `${JSON.stringify(meta)}\n{"type":"event_msg"}\n`);
    if (mtime) fs.utimesSync(file, mtime / 1000, mtime / 1000);
  }
  return root;
}

test('the newest thread started in the chat folder is the one the bubble opens', () => {
  const root = sessions([
    { day: '2026/10/13', id: A, cwd: WS },
    { day: '2026/10/14', id: B, cwd: WS, mtime: Date.parse('2026-10-14T01:00:00Z') },
    { day: '2026/10/14', id: C, cwd: path.join(os.tmpdir(), 'elsewhere'), mtime: Date.parse('2026-10-14T02:00:00Z') },
  ]);
  assert.equal(findCodexThread(WS, { sessionsRoot: root }), B);
  const [project, thread] = assistantLinks(WS, { codexInstalled: true, sessionsRoot: root });
  assert.equal(new URL(project).searchParams.get('path'), WS, 'the folder link selects the project first');
  assert.equal(new URL(project).searchParams.get('prompt'), null);
  assert.equal(thread, `codex://threads/${B}`);
});

test("threads Codex started on its own, or in another folder, don't count", () => {
  const root = sessions([
    { day: '2026/10/14', id: A, cwd: WS, source: 'subagent' },
    { day: '2026/10/14', id: B, cwd: path.join(WS, 'sub') },
  ]);
  assert.equal(findCodexThread(WS, { sessionsRoot: root }), null);
});

test('without a thread yet, Codex is asked for a new chat in the folder; without Codex, the folder opens', () => {
  const root = sessions([]);
  const links = assistantLinks(WS, { codexInstalled: true, sessionsRoot: root });
  assert.equal(links.length, 1);
  assert.ok(links[0].startsWith('codex://threads/new?path='));
  assert.equal(new URL(links[0]).searchParams.get('path'), WS);
  assert.ok(new URL(links[0]).searchParams.get('prompt'));
  assert.deepEqual(assistantLinks(WS, { codexInstalled: false, sessionsRoot: root }), [pathToFileURL(WS).href]);
  assert.equal(findCodexThread(WS, { sessionsRoot: path.join(root, 'missing') }), null);
});

test('the bubble stays at the end of the line with nothing to dismiss', () => {
  const it = assistantItem({ since: 5, codexInstalled: true });
  assert.equal(it.id, ASSISTANT_ID);
  assert.equal(it.kind, 'etl');
  assert.equal(it.assistant, true);
  assert.equal(it.status, 'background');
  assert.equal(it.badge, 'eTL 비서');
  assert.match(it.project, /Codex/);
  assert.match(assistantItem({ since: 5, codexInstalled: false }).project, /채팅 폴더/);
});

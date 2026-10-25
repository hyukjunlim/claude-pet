'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const {
  CODEX_LOCATOR, archiveCodexChat, archiveThrough, canDelete, claudeDeleteScript, deleteClaudeSession, isChat,
} = require('../src/chat-delete');
const { LOADER } = require('../src/ssh-watcher');

const ID = '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';
const NOW = Date.parse('2026-10-25T12:00:00Z');

// A child process whose stdin we read and whose stdout we write.
function fakeChild() {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.written = [];
  child.stdin.on('data', (b) => child.written.push(...String(b).split('\n').filter(Boolean).map((l) => JSON.parse(l))));
  child.killed = false;
  child.kill = () => { child.killed = true; };
  child.say = (m) => child.stdout.write(`${JSON.stringify(m)}\n`);
  return child;
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

test('only a quiet chat from VS Code or a terminal can be deleted', () => {
  const quiet = { status: 'idle', lastActivityAt: NOW - 3600_000 };
  assert.equal(canDelete({ ...quiet, kind: 'cli', client: 'terminal' }, NOW), true);
  assert.equal(canDelete({ ...quiet, kind: 'codex', client: 'vscode' }, NOW), true);
  assert.equal(canDelete({ ...quiet, kind: 'cli', client: 'vscode', status: 'review' }, NOW), true, 'Ready is fine');
  assert.equal(isChat({ ...quiet, kind: 'codex' }), false, "the Codex app's thread");
  assert.equal(isChat({ ...quiet, kind: 'desktop' }), false, "the Claude app's session");
  assert.equal(canDelete({ ...quiet, kind: 'cli', status: 'running' }, NOW), false, 'working');
  assert.equal(canDelete({ ...quiet, kind: 'cli', status: 'waiting' }, NOW), false, 'asking you something');
  assert.equal(canDelete({ ...quiet, kind: 'cli', lastActivityAt: NOW - 60_000 }, NOW), false, 'written a minute ago: it may still be open');
});

test('a session on this PC goes to the Recycle Bin with its folder; one in WSL is removed', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ttokttok-pet-delete-'));
  try {
    const project = path.join(dir, 'projects', 'C--proj');
    fs.mkdirSync(path.join(project, ID, 'subagents'), { recursive: true });
    const file = path.join(project, `${ID}.jsonl`);
    fs.writeFileSync(file, '{}\n');
    fs.writeFileSync(path.join(project, 'other.jsonl'), '{}\n');
    const trashed = [];
    await deleteClaudeSession({ sessionId: ID, place: 'local', file, trashItem: async (p) => trashed.push(p) });
    assert.deepEqual(trashed, [file, path.join(project, ID)]);

    await deleteClaudeSession({ sessionId: ID, place: 'wsl', file });
    assert.deepEqual(fs.readdirSync(project), ['other.jsonl'], 'the transcript and its folder, nothing else');
    await assert.rejects(deleteClaudeSession({ sessionId: ID, place: 'wsl', file: path.join(project, 'other.jsonl') }), /transcript/);
    await assert.rejects(deleteClaudeSession({ sessionId: 'x; rm -rf ~', place: 'wsl', file }), /session id/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
  }
});

test('on an SSH host one command removes it, and says when it was gone already', async () => {
  const runs = [];
  const spawnFn = (cmd, args) => {
    const child = fakeChild();
    child.stdin.on('finish', () => {
      child.stdout.end(runs.length === 1 ? '1\n' : '0\n');
      setImmediate(() => child.emit('close', 0));
    });
    runs.push({ cmd, args, child });
    return child;
  };
  const host = { target: 'lab', port: 2222, identity: null, name: 'lab' };
  await deleteClaudeSession({ sessionId: ID, place: 'ssh', host, spawnFn });
  const [{ cmd, args, child }] = runs;
  assert.equal(cmd, 'ssh');
  assert.deepEqual(args.slice(-4), ['-p', '2222', 'lab', `exec python3 -u -c '${LOADER}'`]);
  assert.deepEqual(child.written, [claudeDeleteScript(ID)], 'the script reaches the host on stdin');
  await assert.rejects(deleteClaudeSession({ sessionId: ID, place: 'ssh', host, spawnFn }), /no longer on lab/);
  assert.throws(() => claudeDeleteScript('../x'), /session id/);
});

// The script that runs on the host, here against a fake ~/.claude.
const python = ['python3', 'python'].find((cmd) => spawnSync(cmd, ['-c', 'import sys; sys.exit(sys.version_info[0] != 3)']).status === 0);

test('the SSH script removes just that session', { skip: !python && 'Python 3 is not installed' }, () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ttokttok-pet-claude-'));
  try {
    const project = path.join(home, 'projects', '-home-me-proj');
    fs.mkdirSync(path.join(project, ID), { recursive: true });
    fs.writeFileSync(path.join(project, `${ID}.jsonl`), '{}\n');
    fs.writeFileSync(path.join(project, `${ID.replace('a5b', 'a5c')}.jsonl`), '{}\n');
    const out = spawnSync(python, ['-c', LOADER], { input: `${JSON.stringify(claudeDeleteScript(ID))}\n`, env: { ...process.env, CLAUDE_CONFIG_DIR: home }, encoding: 'utf8' });
    assert.equal(out.stdout.trim(), '1');
    assert.deepEqual(fs.readdirSync(project), [`${ID.replace('a5b', 'a5c')}.jsonl`]);
  } finally {
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 5 });
  }
});

test("a Codex chat is archived by Codex's app-server: initialize, then thread/archive", async () => {
  const child = fakeChild();
  const done = archiveThrough(child, ID);
  await flush();
  assert.deepEqual(child.written.map((m) => m.method), ['initialize']);
  child.say({ id: 1, result: { userAgent: 'x' } });
  await flush();
  assert.deepEqual(child.written.slice(1), [
    { jsonrpc: '2.0', method: 'initialized' },
    { jsonrpc: '2.0', id: 2, method: 'thread/archive', params: { threadId: ID } },
  ]);
  child.say({ method: 'thread/archived', params: { threadId: ID } });   // a notification on the way
  child.say({ id: 2, result: {} });
  await done;
  assert.equal(child.stdin.writableEnded, true, 'its input ends, so it ends too');
});

test('in WSL or on an SSH host, the app-server is found first, and its refusal comes back', async () => {
  const child = fakeChild();
  const done = archiveThrough(child, ID, { locate: true });
  await flush();
  assert.deepEqual(child.written, [CODEX_LOCATOR], 'nothing else until it says Codex is there');
  child.say({ ready: '/home/me/.vscode-server/extensions/openai.chatgpt-1.0-linux-x64/bin/linux-x86_64/codex' });
  await flush();
  assert.equal(child.written[1].method, 'initialize');
  child.say({ id: 1, result: {} });
  child.say({ id: 2, error: { code: -32600, message: 'thread not found' } });
  await assert.rejects(done, /thread not found/);

  const missing = fakeChild();
  const nowhere = archiveThrough(missing, ID, { locate: true });
  missing.say({ error: 'Codex is not installed there' });
  await assert.rejects(nowhere, /not installed/);
});

test('each place starts its own app-server', async () => {
  const runs = [];
  const spawnFn = (cmd, args) => {
    const child = fakeChild();
    runs.push({ cmd, args, child });
    setImmediate(() => child.emit('close', 1));   // ends at once: what started is all we look at
    return child;
  };
  const tries = [
    archiveCodexChat({ threadId: ID, place: 'local', spawnFn, codexExe: () => 'C:\\codex.exe' }),
    archiveCodexChat({ threadId: ID, place: 'wsl', distro: 'Ubuntu', spawnFn }),
    archiveCodexChat({ threadId: ID, place: 'ssh', host: { target: 'lab' }, spawnFn }),
  ];
  for (const t of tries) await assert.rejects(t);
  assert.deepEqual(runs.map((r) => [r.cmd, r.args[0], r.args[1], r.args.at(-1)]), [
    ['C:\\codex.exe', 'app-server', undefined, 'app-server'],
    ['wsl.exe', '-d', 'Ubuntu', LOADER],
    ['ssh', '-o', 'BatchMode=yes', `exec python3 -u -c '${LOADER}'`],
  ]);
  await assert.rejects(archiveCodexChat({ threadId: ID, place: 'local', spawnFn, codexExe: () => null }), /Couldn't find Codex/);
  await assert.rejects(archiveCodexChat({ threadId: 'nope', place: 'local', spawnFn }), /thread id/);
});

test('the locator says when there is no Codex', { skip: !python && 'Python 3 is not installed' }, () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ttokttok-pet-nocodex-'));
  try {
    // Only Python's own folder on the PATH, so no codex there is found.
    const exe = spawnSync(python, ['-c', 'import sys; print(sys.executable)'], { encoding: 'utf8' }).stdout.trim();
    const env = { ...process.env, HOME: home, USERPROFILE: home, PATH: path.dirname(exe) };
    const out = spawnSync(exe, ['-c', LOADER], { input: `${JSON.stringify(CODEX_LOCATOR)}\n`, env, encoding: 'utf8' });
    assert.equal(out.error, undefined);
    assert.deepEqual(JSON.parse(out.stdout), { error: 'Codex is not installed there' });
  } finally {
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 5 });
  }
});

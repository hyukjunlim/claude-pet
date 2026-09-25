'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { CodexTracker, parseConnections, parseUnread, threadUrl } = require('../src/codex');
const { BOOTSTRAP, CodexRemote, LOADER, WATCHER } = require('../src/codex-remote');
const { applyRolloutEntry, createRolloutState, rateLimitsOf, rolloutStatus } = require('../src/rollout');

const T0 = Date.parse('2026-09-25T04:00:00.000Z');
const at = (s) => new Date(T0 + s * 1000).toISOString();
const THREAD = '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';

const meta = (extra = {}) => ({
  timestamp: at(0), type: 'session_meta',
  payload: { id: THREAD, cwd: '/mnt/c/Users/me/proj', originator: 'Codex Desktop', source: 'vscode', ...extra },
});
const started = (s) => ({ timestamp: at(s), type: 'event_msg', payload: { type: 'task_started', turn_id: 't1', started_at: (T0 / 1000) + s } });
const complete = (s, message = 'Added the parser.') => ({
  timestamp: at(s), type: 'event_msg', payload: { type: 'task_complete', turn_id: 't1', last_agent_message: message, completed_at: (T0 / 1000) + s },
});
const shell = (s, command) => ({
  timestamp: at(s), type: 'response_item', payload: { type: 'function_call', name: 'shell', arguments: JSON.stringify({ command }) },
});
const RESETS_AT = T0 / 1000 + 3 * 86_400;
const WEEK_MS = 7 * 86_400_000;
// A reply's token count, with the weekly limit `weekly`% used.
const tokenCount = (s, weekly) => ({
  timestamp: at(s), type: 'event_msg',
  payload: {
    type: 'token_count', info: null,
    rate_limits: { limit_id: 'codex', primary: { used_percent: weekly, window_minutes: 10080, resets_at: RESETS_AT }, secondary: null },
  },
});

function rollout(entries) {
  const state = createRolloutState();
  for (const e of entries) applyRolloutEntry(state, e);
  return state;
}

test('a Codex turn in progress is running, with the command it runs', () => {
  const s = rollout([meta(), started(1), shell(3, ['bash', '-lc', 'npm test'])]);
  assert.deepEqual(rolloutStatus(s, { now: T0 + 5000 }), { status: 'running', detail: 'npm test', since: T0 + 1000 });
});

test("a desktop thread is ready while Codex lists it as unread, and quiet once you've read it", () => {
  const s = rollout([meta(), started(1), complete(9)]);
  assert.deepEqual(rolloutStatus(s, { now: T0 + 20_000, unread: true }), { status: 'review', detail: 'Added the parser.', since: T0 + 9000 });
  assert.equal(rolloutStatus(s, { now: T0 + 20_000, unread: false }).status, 'idle');
});

test('a CLI thread is ready for a few minutes after it finishes, unless dismissed', () => {
  const s = rollout([meta({ originator: 'codex_cli_rs' }), started(1), complete(9)]);
  assert.equal(rolloutStatus(s, { now: T0 + 60_000 }).status, 'review');
  assert.equal(rolloutStatus(s, { now: T0 + 60_000, dismissedAt: T0 + 30_000 }).status, 'idle');
  assert.equal(rolloutStatus(s, { now: T0 + 20 * 60_000 }).status, 'idle');
});

test('stopped turns go quiet, errors fail, and approvals wait for you', () => {
  const cli = { originator: 'codex_cli_rs' };
  const aborted = rollout([meta(cli), started(1), { timestamp: at(4), type: 'event_msg', payload: { type: 'turn_aborted', reason: 'interrupted' } }]);
  assert.equal(rolloutStatus(aborted, { now: T0 + 5000 }).status, 'idle');
  const failed = rollout([meta(cli), started(1), { timestamp: at(4), type: 'event_msg', payload: { type: 'error', message: 'stream disconnected' } }]);
  assert.deepEqual(rolloutStatus(failed, { now: T0 + 5000 }), { status: 'failed', detail: 'stream disconnected', since: T0 + 4000 });
  const ask = rollout([meta(cli), started(1), { timestamp: at(2), type: 'event_msg', payload: { type: 'exec_approval_request', command: ['bash', '-lc', 'rm -rf build'] } }]);
  assert.deepEqual(rolloutStatus(ask, { now: T0 + 3000 }), { status: 'waiting', detail: 'Approve: rm -rf build', since: T0 + 2000 });
});

test('a turn is running even when the rollout is read from after its start', () => {
  const work = (s, turn, type = 'item_completed') => (type === 'token_usage_record'
    ? { timestamp: at(s), type, payload: { turn_id: turn } }
    : { timestamp: at(s), type: 'event_msg', payload: { type, turn_id: turn } });
  // A long rollout's tail: the current turn's task_started is further back.
  const midTurn = rollout([meta(), work(40, 't2'), work(41, 't2', 'token_usage_record')]);
  assert.equal(rolloutStatus(midTurn, { now: T0 + 45_000 }).status, 'running');
  // Work that trails a finished turn doesn't bring it back.
  const done = rollout([meta(), started(1), { ...complete(9), payload: { ...complete(9).payload, turn_id: 't1' } }, work(10, 't1')]);
  assert.equal(done.turnActive, false);
  // Older rollouts without turn ids: a tool call after the last turn ended means a new one.
  const old = rollout([meta(), started(1), complete(9), shell(20, ['ls'])]);
  assert.equal(old.turnActive, true);
});

test("each reply's token count carries the account's rate limits", () => {
  const noLimits = { timestamp: at(9), type: 'event_msg', payload: { type: 'token_count', info: null, rate_limits: null } };
  const s = rollout([meta(), started(1), tokenCount(5, 40), tokenCount(8, 41), noLimits]);
  assert.deepEqual(s.limits, { weekly: { percent: 41, resetsAt: RESETS_AT * 1000, windowMs: WEEK_MS }, fiveHour: null, at: T0 + 8000 });
  assert.equal(s.turnActive, true, "they don't change the turn");
});

test("Codex's own helper threads are recognized", () => {
  const s = rollout([meta({ source: { subagent: { other: 'guardian' } } })]);
  assert.equal(s.subagent, true);
});

test("the unread list maps each thread to its host, and skips ChatGPT chats", () => {
  const hash = 'a'.repeat(64);
  const unread = parseUnread({
    'electron-thread-read-state-v1': {
      version: 1,
      unreadByIdentity: {
        someone: {
          [`remote-ssh-discovered:lab-server:${hash}`]: [THREAD, 42],
          [`local:${hash}`]: ['local-thread'],
          [`chatgpt:org:user:${hash}`]: ['chat-thread'],
        },
      },
    },
  });
  assert.deepEqual([...unread], [[THREAD, 'remote-ssh-discovered:lab-server'], ['local-thread', 'local']]);
  assert.equal(parseUnread(null).size, 0);
});

test('links open the thread on its host', () => {
  assert.equal(threadUrl(THREAD, 'remote-ssh-discovered:lab-server'), `codex://threads/${THREAD}?hostId=remote-ssh-discovered%3Alab-server`);
  assert.equal(threadUrl(THREAD, 'local'), `codex://threads/${THREAD}`);
});

test('the tracker combines running threads here with unread threads on other hosts', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-pet-codex-'));
  try {
    const hash = 'b'.repeat(64);
    const remoteThread = '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a6c';
    fs.writeFileSync(path.join(home, '.codex-global-state.json'), JSON.stringify({
      'electron-thread-read-state-v1': { version: 1, unreadByIdentity: { me: { [`remote-ssh-discovered:lab-server:${hash}`]: [remoteThread] } } },
      'codex-managed-remote-connections': [{ hostId: 'remote-ssh-discovered:lab-server', displayName: 'lab-server' }],
    }));
    fs.mkdirSync(path.join(home, 'sqlite'));
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(path.join(home, 'sqlite', 'codex-dev.db'));
    db.exec('create table local_thread_catalog (host_id text, thread_id text, display_title text, source_updated_at real, cwd text)');
    db.prepare('insert into local_thread_catalog values (?, ?, ?, ?, ?)').run('remote-ssh-discovered:lab-server', remoteThread, 'Plan the migration', Date.now() / 1000 - 60, '/data/proj');
    db.prepare('insert into local_thread_catalog values (?, ?, ?, ?, ?)').run('chatgpt:org:user', 'chat-thread', 'A chat', Date.now() / 1000, null);
    db.close();
    const day = path.join(home, 'sessions', '2026', '09', '25');
    fs.mkdirSync(day, { recursive: true });
    const now = Date.now();
    const live = [
      { ...meta(), timestamp: new Date(now - 9000).toISOString() },
      { timestamp: new Date(now - 8000).toISOString(), type: 'event_msg', payload: { type: 'task_started', started_at: (now - 8000) / 1000 } },
      { ...shell(0, ['cargo', 'build']), timestamp: new Date(now - 2000).toISOString() },
    ];
    fs.writeFileSync(path.join(day, `rollout-2026-09-25T13-00-00-${THREAD}.jsonl`), live.map((e) => JSON.stringify(e)).join('\n') + '\n');

    const tracker = new CodexTracker({ ...pathsIn(home), watchHosts: false });
    await tracker.tick();
    const [ready, running] = tracker.sessions;   // most urgent first
    assert.equal(running.status, 'running');
    assert.equal(running.detail, 'cargo build');
    assert.equal(running.title, 'proj');
    assert.equal(running.url, `codex://threads/${THREAD}`);
    assert.equal(ready.status, 'review');
    assert.equal(ready.title, 'Plan the migration');
    assert.equal(ready.remote, 'lab-server');
    assert.equal(ready.project, 'proj');   // from the catalog's /data/proj
    assert.equal(ready.url, `codex://threads/${remoteThread}?hostId=remote-ssh-discovered%3Alab-server`);
    assert.equal(tracker.sessions.length, 2);

    tracker.dismiss(ready.id);
    assert.deepEqual(tracker.sessions.map((s) => s.status), ['running']);
  } finally {
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 5 });
  }
});

function pathsIn(home) {
  return {
    home,
    appState: path.join(home, '.codex-global-state.json'),
    catalog: path.join(home, 'sqlite', 'codex-dev.db'),
    sessionsRoot: path.join(home, 'sessions'),
    sessionIndex: path.join(home, 'session_index.jsonl'),
  };
}

// ------------------------------------------------------------------ SSH hosts

const SKEW = 345_000;   // this host's clock runs 5m45s ahead of ours

test("a rollout from a host whose clock is ahead is read on the host's clock", () => {
  const s = rollout([meta(), started(1 + SKEW / 1000), shell(3 + SKEW / 1000, ['make'])]);
  assert.deepEqual(rolloutStatus(s, { now: T0 + 5000, skew: SKEW }), { status: 'running', detail: 'make', since: T0 + 1000 });
});

test('the SSH hosts come from the connections the Codex app manages', () => {
  const hosts = parseConnections({
    'codex-managed-remote-connections': [
      { hostId: 'remote-ssh-discovered:lab-server', displayName: 'lab-server', alias: 'lab-server', hostname: null, sshPort: null },
      { hostId: 'remote-ssh:box', alias: null, hostname: 'box.example.org', sshPort: 2222, identity: '~/.ssh/box' },
      { hostId: 'broken' },
    ],
  });
  assert.deepEqual(hosts, [
    { hostId: 'remote-ssh-discovered:lab-server', name: 'lab-server', target: 'lab-server', port: null, identity: null },
    { hostId: 'remote-ssh:box', name: 'box.example.org', target: 'box.example.org', port: 2222, identity: '~/.ssh/box' },
  ]);
});

function fakeSsh() {
  const children = [];
  const spawnFn = (cmd, args) => {
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.script = '';
    child.stdin.on('data', (b) => { child.script += b; });
    child.kill = () => setImmediate(() => child.emit('exit', null));
    Object.assign(child, { cmd, args });
    children.push(child);
    return child;
  };
  return { spawnFn, children };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

test('the SSH watcher follows the rollouts the host reports', async () => {
  const { spawnFn, children } = fakeSsh();
  const remote = new CodexRemote({ hostId: 'remote-ssh-discovered:lab-server', target: 'lab-server', spawnFn });
  remote.on('error', () => {});
  remote.start();
  const [child] = children;
  assert.equal(child.cmd, 'ssh');
  assert.ok(child.args.includes('BatchMode=yes'));
  assert.deepEqual(child.args.slice(-2), ['lab-server', BOOTSTRAP]);
  await flush();
  assert.equal(JSON.parse(child.script), WATCHER);
  assert.equal(child.stdin.writableEnded, false, 'stdin stays open, so the watcher ends with the pet');

  const say = (m) => child.stdout.write(`${JSON.stringify(m)}\n`);
  say({ now: (Date.now() + SKEW) / 1000 });
  say({ open: 1, path: '/home/me/.codex/sessions/2026/09/25/rollout-x.jsonl' });
  say({ n: 1, l: JSON.stringify(meta()) });
  child.stdout.write(`${JSON.stringify({ n: 1, l: JSON.stringify(started(2)) })}`);   // a line split across reads
  child.stdout.write('\n');
  await flush();
  assert.ok(Math.abs(remote.skew - SKEW) < 1000);
  const [f] = remote.files.values();
  assert.equal(f.state.threadId, THREAD);
  assert.equal(f.state.turnActive, true);

  say({ close: 1 });
  await flush();
  assert.equal(remote.files.size, 0);
  remote.stop();
});

test('the SSH watcher keeps the newest rate limits it has seen on the host', async () => {
  const { spawnFn, children } = fakeSsh();
  const remote = new CodexRemote({ hostId: 'remote-ssh-discovered:lab-server', target: 'lab-server', spawnFn });
  remote.on('error', () => {});
  remote.start();
  const [child] = children;
  const say = (m) => child.stdout.write(`${JSON.stringify(m)}\n`);
  say({ limits: JSON.stringify(tokenCount(5, 40)) });   // from an old rollout, at the start
  await flush();
  assert.equal(remote.limits.weekly.percent, 40);
  say({ open: 1, path: '/home/me/.codex/sessions/2026/09/25/rollout-x.jsonl' });
  say({ n: 1, l: JSON.stringify(tokenCount(20, 42)) });
  say({ close: 1 });
  await flush();
  assert.equal(remote.limits.weekly.percent, 42, 'still there once the rollout is closed');
  say({ limits: JSON.stringify(tokenCount(10, 41)) });   // older than what we have
  await flush();
  assert.equal(remote.limits.weekly.percent, 42);
  remote.stop();
});

test('the tracker shows threads running on an SSH host', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-pet-codex-'));
  const fake = new EventEmitter();
  Object.assign(fake, { files: new Map(), skew: SKEW, target: 'lab-server', port: null, identity: null, start() {}, stop() {} });
  const tracker = new CodexTracker({ ...pathsIn(home), remoteFactory: () => fake });
  try {
    fs.writeFileSync(path.join(home, '.codex-global-state.json'), JSON.stringify({
      'codex-managed-remote-connections': [{ hostId: 'remote-ssh-discovered:lab-server', displayName: 'lab-server', alias: 'lab-server' }],
    }));
    const now = Date.now();
    const state = createRolloutState();
    applyRolloutEntry(state, meta());
    applyRolloutEntry(state, { timestamp: new Date(now + SKEW - 60_000).toISOString(), type: 'event_msg', payload: { type: 'task_started' } });
    fake.files.set(1, { path: '/x/rollout.jsonl', state });
    const first = new Promise((resolve) => tracker.once('change', resolve));
    tracker.start();
    const [s] = await first;
    assert.equal(s.status, 'running');
    assert.equal(s.remote, 'lab-server');
    assert.equal(s.url, `codex://threads/${THREAD}?hostId=remote-ssh-discovered%3Alab-server`);
    assert.ok(Math.abs(s.since - (now - 60_000)) < 1000, 'since is on our clock');
  } finally {
    tracker.stop();
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 5 });
  }
});

test('the rate limits are the newest ones, from an old rollout here or from an SSH host', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-pet-codex-'));
  const fake = new EventEmitter();
  Object.assign(fake, { files: new Map(), skew: SKEW, limits: null, target: 'lab-server', port: null, identity: null, start() {}, stop() {} });
  const tracker = new CodexTracker({ ...pathsIn(home), remoteFactory: () => fake });
  const nextUsage = () => new Promise((resolve) => tracker.once('usage', ({ codex }) => resolve(codex)));
  try {
    fs.writeFileSync(path.join(home, '.codex-global-state.json'), JSON.stringify({
      'codex-managed-remote-connections': [{ hostId: 'remote-ssh-discovered:lab-server', displayName: 'lab-server', alias: 'lab-server' }],
    }));
    // Codex last ran here three hours ago: too long ago to follow that thread, but its limits count.
    const then = Date.now() - 3 * 3600_000;
    const day = path.join(home, 'sessions', '2026', '09', '24');
    fs.mkdirSync(day, { recursive: true });
    const file = path.join(day, `rollout-2026-09-24T10-00-00-${THREAD}.jsonl`);
    fs.writeFileSync(file, `${JSON.stringify(meta())}\n${JSON.stringify({ ...tokenCount(0, 40), timestamp: new Date(then).toISOString() })}\n`);
    fs.utimesSync(file, new Date(then), new Date(then));
    const first = nextUsage();
    tracker.start();
    assert.deepEqual(await first, { weekly: { percent: 40, resetsAt: RESETS_AT * 1000, windowMs: WEEK_MS }, fiveHour: null, at: then });

    // A reply on the SSH host a minute ago, stamped by its clock, which runs ahead of ours.
    const second = nextUsage();
    fake.limits = rateLimitsOf({ ...tokenCount(0, 55), timestamp: new Date(Date.now() - 60_000 + SKEW).toISOString() });
    fake.emit('change');
    const latest = await second;
    assert.equal(latest.weekly.percent, 55);
    assert.ok(Math.abs(latest.at - (Date.now() - 60_000)) < 2000, 'on our clock');
  } finally {
    tracker.stop();
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 5 });
  }
});

// The watcher is plain Python 3; run it here against a fake ~/.codex if Python is installed.
const python = ['python3', 'python'].find((cmd) => spawnSync(cmd, ['-c', 'import sys; sys.exit(sys.version_info[0] != 3)']).status === 0);

test('the watcher script streams a rollout and the lines added to it', { skip: !python && 'Python 3 is not installed' }, async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-pet-watch-'));
  const day = path.join(home, 'sessions', '2026', '09', '25');
  fs.mkdirSync(day, { recursive: true });
  const file = path.join(day, `rollout-2026-09-25T13-00-00-${THREAD}.jsonl`);
  fs.writeFileSync(file, `${JSON.stringify(meta())}\n${JSON.stringify(started(1))}\n`);
  const child = spawn(python, ['-u', '-c', LOADER], { env: { ...process.env, CODEX_HOME: home }, windowsHide: true });
  const exited = new Promise((resolve) => child.on('exit', resolve));
  try {
    const messages = [];
    let buffer = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      for (let nl = buffer.indexOf('\n'); nl >= 0; nl = buffer.indexOf('\n')) {
        messages.push(JSON.parse(buffer.slice(0, nl)));
        buffer = buffer.slice(nl + 1);
      }
    });
    child.stdin.write(`${JSON.stringify(WATCHER)}\n`);
    const waitFor = async (pred) => {
      for (let i = 0; i < 100 && !messages.some(pred); i++) await new Promise((r) => setTimeout(r, 50));
      return messages.find(pred);
    };
    assert.ok(await waitFor((m) => typeof m.now === 'number'), 'sends the host clock');
    const open = await waitFor((m) => m.open != null);
    assert.equal(path.resolve(open.path), path.resolve(file));
    const lines = () => messages.filter((m) => m.n === open.open).map((m) => JSON.parse(m.l).type);
    await waitFor(() => lines().length === 2);
    assert.deepEqual(lines(), ['session_meta', 'event_msg']);
    fs.appendFileSync(file, `${JSON.stringify(complete(9))}\n`);
    await waitFor(() => lines().length === 3);
    assert.deepEqual(lines(), ['session_meta', 'event_msg', 'event_msg']);

    // When the pet goes away its end of stdin closes, and the watcher exits.
    child.stdin.end();
    const late = new Promise((resolve) => setTimeout(() => resolve('still running'), 3000));
    assert.notEqual(await Promise.race([exited, late]), 'still running');
  } finally {
    child.kill();
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 5 });
  }
});

test('the watcher script sends the newest rate limits, even from a rollout too old to follow', { skip: !python && 'Python 3 is not installed' }, async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-pet-watch-'));
  const day = path.join(home, 'sessions', '2026', '09', '24');
  fs.mkdirSync(day, { recursive: true });
  const old = path.join(day, `rollout-2026-09-24T10-00-00-${THREAD}.jsonl`);
  fs.writeFileSync(old, [meta(), tokenCount(5, 40), tokenCount(8, 41), complete(9)].map((e) => `${JSON.stringify(e)}\n`).join(''));
  const then = new Date(Date.now() - 3 * 3600_000);
  fs.utimesSync(old, then, then);
  const child = spawn(python, ['-u', '-c', LOADER], { env: { ...process.env, CODEX_HOME: home }, windowsHide: true });
  try {
    const messages = [];
    let buffer = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      for (let nl = buffer.indexOf('\n'); nl >= 0; nl = buffer.indexOf('\n')) {
        messages.push(JSON.parse(buffer.slice(0, nl)));
        buffer = buffer.slice(nl + 1);
      }
    });
    child.stdin.write(`${JSON.stringify(WATCHER)}\n`);
    for (let i = 0; i < 100 && !messages.some((m) => m.limits); i++) await new Promise((r) => setTimeout(r, 50));
    await new Promise((r) => setTimeout(r, 300));   // the rest of that round
    const i = messages.findIndex((m) => m.limits);
    assert.ok(i > 0 && typeof messages[0].now === 'number', 'the host clock comes first');
    assert.equal(rateLimitsOf(JSON.parse(messages[i].limits)).weekly.percent, 41);
    assert.ok(!messages.some((m) => m.open != null), 'the old rollout itself is not followed');
  } finally {
    child.kill();
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 5 });
  }
});

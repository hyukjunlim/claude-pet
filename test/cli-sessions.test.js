'use strict';

// Claude Code sessions outside the desktop app: in VS Code, or `claude` in a terminal, on this PC,
// in WSL and on SSH hosts (sessions.js, claude-remote.js).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { applyEntry, createTurnState } = require('../src/transcript');
const { SessionTracker, clientOf } = require('../src/sessions');
const { ClaudeRemote } = require('../src/claude-remote');
const { ClaudeUsage } = require('../src/claude-usage');

const iso = (t) => new Date(t).toISOString();
const ID = {
  vscode: '11111111-1111-4111-8111-111111111111',
  terminal: '22222222-2222-4222-8222-222222222222',
  desktop: '33333333-3333-4333-8333-333333333333',
  sdk: '44444444-4444-4444-8444-444444444444',
  wsl: '55555555-5555-4555-8555-555555555555',
};

const prompt = (t, entrypoint, cwd = '/home/me/projects') => ({
  type: 'user', timestamp: iso(t), entrypoint, cwd, message: { role: 'user', content: 'look into it' },
});
const working = (t, entrypoint) => ({
  type: 'assistant', uuid: `a-${t}`, timestamp: iso(t), entrypoint,
  message: { role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: `t-${t}`, name: 'Bash', input: { command: 'make' } }] },
});
const done = (t, entrypoint) => ({
  type: 'assistant', uuid: `d-${t}`, timestamp: iso(t), entrypoint,
  message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'Done.' }] },
});
const lines = (...entries) => `${entries.map((e) => JSON.stringify(e)).join('\n')}\n`;

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ttokttok-pet-cli-'));
}

function writeTranscript(projects, dir, id, text) {
  fs.mkdirSync(path.join(projects, dir), { recursive: true });
  fs.writeFileSync(path.join(projects, dir, `${id}.jsonl`), text);
}

test('the transcript says what started it, and the title Claude Code gave it', () => {
  const state = createTurnState();
  applyEntry(state, prompt(1000, 'claude-vscode'));
  applyEntry(state, { type: 'ai-title', aiTitle: 'Model identifier', sessionId: ID.vscode });
  assert.equal(state.entrypoint, 'claude-vscode');
  assert.equal(state.aiTitle, 'Model identifier');
  assert.equal(state.title, null, "a title you set (custom-title) still wins: it's kept apart");

  assert.equal(clientOf('claude-vscode'), 'vscode');
  assert.equal(clientOf('cli'), 'terminal');
  assert.equal(clientOf(null), null, "not known yet: not listed (it may be the desktop app's)");
  assert.equal(clientOf('claude-desktop-3p'), null, "the desktop app's, by another name");
  assert.equal(clientOf('claude-desktop'), null, "the desktop app's come through the app");
  assert.equal(clientOf('sdk-cli'), null, "a program's aren't listed");
});

test("this PC's VS Code and terminal sessions are bubbles and sidebar rows; the desktop app's and programs' aren't", async () => {
  const root = tempRoot();
  try {
    const projects = path.join(root, 'projects');
    const now = Date.now();
    writeTranscript(projects, 'C--repo', ID.vscode, lines(
      prompt(now - 5000, 'claude-vscode', 'C:\\repo'), { type: 'ai-title', aiTitle: 'Model identifier' }, working(now - 4000, 'claude-vscode'),
    ));
    writeTranscript(projects, 'C--repo', ID.terminal, lines(prompt(now - 9000, 'cli', 'C:\\repo'), done(now - 8000, 'cli')));
    writeTranscript(projects, 'C--repo', ID.desktop, lines(prompt(now - 7000, 'claude-desktop', 'C:\\repo')));
    writeTranscript(projects, 'C--repo', ID.sdk, lines(prompt(now - 6000, 'sdk-cli', 'C:\\repo')));
    const tracker = new SessionTracker({ sessionsRoot: path.join(root, 'sessions'), projectsRoot: projects });
    await tracker.tick();

    const byId = Object.fromEntries(tracker.all.map((s) => [s.id, s]));
    assert.deepEqual(Object.keys(byId).sort(), [`cli:${ID.vscode}`, `cli:${ID.terminal}`].sort());
    const vscode = byId[`cli:${ID.vscode}`];
    assert.equal(vscode.client, 'vscode');
    assert.equal(vscode.sessionId, ID.vscode);
    assert.equal(vscode.title, 'Model identifier');
    assert.equal(vscode.status, 'running');
    assert.equal(vscode.machineKey, null, 'this PC');
    assert.equal(byId[`cli:${ID.terminal}`].client, 'terminal');
    assert.equal(byId[`cli:${ID.terminal}`].status, 'review', 'Ready for a few minutes after its turn');
    assert.deepEqual(tracker.sessions.filter((s) => s.status !== 'idle').map((s) => s.id).sort(), Object.keys(byId).sort());
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a WSL distro's sessions are read only while it runs, and stay as last seen meanwhile", async () => {
  const root = tempRoot();
  try {
    const wslProjects = path.join(root, 'wsl-home', '.claude', 'projects');
    const now = Date.now();
    writeTranscript(wslProjects, '-home-me-projects', ID.wsl, lines(prompt(now - 3000, 'claude-vscode'), done(now - 2000, 'claude-vscode')));
    const tracker = new SessionTracker({ sessionsRoot: path.join(root, 'sessions'), projectsRoot: path.join(root, 'projects') });
    const wsl = (active) => ({ root: wslProjects, machineKey: 'wsl:Ubuntu', machine: 'Ubuntu', active });

    tracker.setCliRoots([wsl(true)]);
    await tracker.tick();
    const row = tracker.all.find((s) => s.id === `cli:${ID.wsl}`);
    assert.equal(row.machineKey, 'wsl:Ubuntu');
    assert.equal(row.cwd, '/home/me/projects');

    // Stopped: its files aren't touched (here, gone), and what was seen stays.
    fs.rmSync(path.join(root, 'wsl-home'), { recursive: true, force: true });
    tracker.setCliRoots([wsl(false)]);
    tracker.lastProjectScan = 0;
    await tracker.tick();
    assert.ok(tracker.all.some((s) => s.id === `cli:${ID.wsl}`));

    tracker.setCliRoots([wsl(true)]);
    tracker.lastProjectScan = 0;
    await tracker.tick();
    assert.equal(tracker.all.some((s) => s.id === `cli:${ID.wsl}`), false, 'running again: read again');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("an SSH host's sessions come on the host's clock, and are shown on ours", () => {
  const T0 = Date.parse('2026-10-25T12:00:00.000Z');
  const SKEW = 345_000;   // the host's clock runs 5m45s ahead
  const state = createTurnState();
  for (const e of [prompt(T0 + SKEW, 'claude-vscode'), working(T0 + SKEW + 2000, 'claude-vscode')]) applyEntry(state, e);
  const tracker = new SessionTracker({ now: () => T0 + 10_000 });
  tracker.setRemoteChats([{ id: `cli:${ID.vscode}`, sessionId: ID.vscode, state, machineKey: 'ssh:me@lab:22', machine: 'lab', remote: 'lab', skew: SKEW }]);

  const [s] = tracker.sessions;
  assert.equal(s.status, 'running', 'not stale: on its own clock it started 10 s ago');
  assert.equal(s.since, T0);
  assert.equal(s.remote, 'lab');
  const [row] = tracker.all;
  assert.equal(row.machineKey, 'ssh:me@lab:22');
  assert.equal(row.lastActivityAt, T0 + 2000);

  // A turn that ended is Ready, until marked done on our clock.
  const ended = createTurnState();
  for (const e of [prompt(T0 + SKEW, 'claude-vscode'), done(T0 + SKEW + 5000, 'claude-vscode')]) applyEntry(ended, e);
  tracker.setRemoteChats([{ ...tracker.remoteChats[0], state: ended }]);
  assert.equal(tracker.sessions[0].status, 'review');
  assert.equal(tracker.sessions[0].since, T0 + 5000);
  tracker.now = () => T0 + 20_000;
  tracker.dismiss(`cli:${ID.vscode}`);
  assert.equal(tracker.sessions[0].status, 'idle');
});

test("the host watcher's messages make up its sessions, kept across a reconnect", () => {
  const remote = new ClaudeRemote({ key: 'ssh:me@lab:22', name: 'lab', target: 'me@lab' });
  let changed = 0;
  remote.chatsChanged = () => { changed += 1; };
  remote.onMessage({ chat: 1, id: ID.vscode });
  remote.onMessage({ cl: 1, l: JSON.stringify(prompt(1000, 'claude-vscode')) });
  remote.onMessage({ cl: 1, l: '{"half a line' });
  remote.onMessage({ chat: 2, id: 'not-a-session' });
  assert.deepEqual([...remote.chats.keys()], [ID.vscode]);
  assert.equal(remote.chats.get(ID.vscode).entrypoint, 'claude-vscode');
  assert.ok(changed >= 2);

  remote.onDisconnect();   // the next connection numbers them afresh
  remote.onMessage({ cl: 1, l: JSON.stringify(done(2000, 'claude-vscode')) });
  assert.equal(remote.chats.get(ID.vscode).turnEndedAt, 0, "an old number doesn't reach it");
  remote.onMessage({ chat: 7, id: ID.vscode });
  remote.onMessage({ cl: 7, l: JSON.stringify(prompt(1000, 'claude-vscode')) });
  remote.onMessage({ chats: [7] });
  assert.deepEqual([...remote.chats.keys()], [ID.vscode]);
  remote.onMessage({ chats: [] });
  assert.equal(remote.chats.size, 0, 'no longer followed (a week old): gone');
});

test("the hosts' sessions go by the key the desktop app's sessions there have, or a config host's name", () => {
  const usage = new ClaudeUsage({ usageFile: null });
  const state = createTurnState();
  usage.remotes.set('ssh:me@lab:22', { target: 'me@lab', port: 22, name: 'lab', skew: 5, chats: new Map([[ID.vscode, state]]) });
  usage.remotes.set('ssh-config:gpu', { target: 'gpu', port: null, name: 'gpu', skew: 0, chats: new Map([[ID.terminal, state]]) });
  usage.remotes.set('ssh:old@box:22', { target: 'old@box', port: 22, name: 'box' });   // a watcher without sessions
  assert.deepEqual(usage.chats().map((c) => [c.id, c.machineKey, c.remote, c.skew]), [
    [`cli:${ID.vscode}`, 'ssh:me@lab:22', 'lab', 5],
    [`cli:${ID.terminal}`, 'ssh:gpu:22', 'gpu', 0],
  ]);
});

test('an older session (not written to in a week) is listed quiet, from a quick look at both ends', async () => {
  const root = tempRoot();
  try {
    const projects = path.join(root, 'projects');
    const old = Date.now() - 20 * 24 * 60 * 60 * 1000;
    const filler = { type: 'system', content: 'x'.repeat(2000) };
    writeTranscript(projects, 'C--repo', ID.vscode, lines(
      prompt(old, 'claude-vscode', 'C:\repo'), { type: 'ai-title', aiTitle: 'Old work' },
      ...Array(150).fill(filler),   // 300 KB in the middle that the look skips
      working(old + 60_000, 'claude-vscode'),   // left mid-turn: still quiet
    ));
    const file = path.join(projects, 'C--repo', `${ID.vscode}.jsonl`);
    fs.utimesSync(file, new Date(old + 60_000), new Date(old + 60_000));
    const tracker = new SessionTracker({ sessionsRoot: path.join(root, 'sessions'), projectsRoot: projects });
    await tracker.tick();

    const [row] = tracker.all;
    assert.equal(row.id, `cli:${ID.vscode}`);
    assert.equal(row.title, 'Old work', 'from the start of the file');
    assert.equal(row.cwd, 'C:\repo');
    assert.equal(row.lastActivityAt, old + 60_000, 'from its end');
    assert.equal(row.status, 'idle');
    assert.equal(tracker.followers.size, 0, "it isn't followed");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('from cliReadyFrom on, a VS Code or terminal turn is Ready until marked done', () => {
  const T0 = Date.parse('2026-10-25T12:00:00.000Z');
  const ended = (at) => {
    const state = createTurnState();
    for (const e of [prompt(at - 5000, 'cli'), done(at, 'cli')]) applyEntry(state, e);
    return state;
  };
  const tracker = new SessionTracker({ cliReadyFrom: T0, now: () => T0 + 3 * 60 * 60 * 1000 });
  tracker.setRemoteChats([
    { id: `cli:${ID.terminal}`, sessionId: ID.terminal, state: ended(T0 + 60_000), machineKey: 'ssh:me@lab:22', skew: 0 },
    { id: `cli:${ID.vscode}`, sessionId: ID.vscode, state: ended(T0 - 60_000), machineKey: 'ssh:me@lab:22', skew: 0 },
  ]);
  const status = (id) => tracker.sessions.find((s) => s.id === `cli:${id}`).status;
  assert.equal(status(ID.terminal), 'review', 'three hours on, still Ready');
  assert.equal(status(ID.vscode), 'idle', 'ended before cliReadyFrom: a few minutes, as before');
  tracker.dismiss(`cli:${ID.terminal}`);
  assert.equal(status(ID.terminal), 'idle');
});

test("an SSH host's older sessions come from the watcher's quick look, listed quiet", () => {
  const remote = new ClaudeRemote({ key: 'ssh:me@lab:22', name: 'lab', target: 'me@lab' });
  remote.chatsChanged = () => {};
  remote.onMessage({ peek: { id: ID.vscode, entrypoint: 'claude-vscode', cwd: '/home/me/site', ai_title: 'Reagent website', at: '2026-10-16T09:00:00.000Z' } });
  remote.onMessage({ peek: { id: 'not-a-session', entrypoint: 'cli' } });
  assert.deepEqual([...remote.peeks.keys()], [ID.vscode]);

  const usage = new ClaudeUsage({ usageFile: null });
  usage.remotes.set('ssh:me@lab:22', remote);
  const tracker = new SessionTracker({});
  tracker.setRemoteChats(usage.chats());
  const [row] = tracker.all;
  assert.equal(row.title, 'Reagent website');
  assert.equal(row.status, 'idle');
  assert.equal(row.lastActivityAt, Date.parse('2026-10-16T09:00:00.000Z'));
  assert.equal(row.machineKey, 'ssh:me@lab:22');

  remote.onMessage({ chats: [], peeked: [] });
  assert.equal(remote.peeks.size, 0, 'gone from the host: gone here');
});

test("an older transcript with only long lines at its ends is still known for the desktop app's, and left out", async () => {
  const root = tempRoot();
  try {
    const projects = path.join(root, 'projects');
    const old = Date.now() - 20 * 24 * 60 * 60 * 1000;
    const big = (entrypoint) => ({ ...prompt(old, entrypoint, 'C:\repo'), message: { role: 'user', content: 'y'.repeat(100_000) } });
    // A scheduled task's earlier run: the desktop app's, but no longer in its index.
    writeTranscript(projects, 'C--repo', ID.desktop, lines(big('claude-desktop'), { type: 'custom-title', customTitle: 'Weekday digest' }, big('claude-desktop')));
    // One whose looks don't say at all.
    writeTranscript(projects, 'C--repo', ID.sdk, lines({ type: 'user', timestamp: iso(old), message: { role: 'user', content: 'z'.repeat(200_000) } }));
    for (const id of [ID.desktop, ID.sdk]) {
      fs.utimesSync(path.join(projects, 'C--repo', `${id}.jsonl`), new Date(old), new Date(old));
    }
    const tracker = new SessionTracker({ sessionsRoot: path.join(root, 'sessions'), projectsRoot: projects });
    await tracker.tick();
    assert.equal(tracker.cliPeeks.get(path.join(projects, 'C--repo', `${ID.desktop}.jsonl`)).state.entrypoint, 'claude-desktop');
    assert.deepEqual(tracker.all, []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

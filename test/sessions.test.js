'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { applyEntry, createTurnState } = require('../src/transcript');
const {
  SessionTracker, desktopStatus, estimateSkew, parseDesktopSession, parseLogLine, parseSshConnections, projectName,
} = require('../src/sessions');

const T0 = Date.parse('2026-09-24T14:00:00.000Z');
const SKEW = 345_000;                        // the SSH server's clock runs 5m45s ahead of ours
const remote = (s) => T0 + SKEW + s * 1000;  // a time on the server's clock, s seconds after T0
const iso = (t) => new Date(t).toISOString();

function copyOf(entries) {
  const state = createTurnState();
  for (const e of entries) applyEntry(state, e);
  return state;
}

const prompt = (t) => ({ type: 'user', timestamp: iso(t), message: { role: 'user', content: 'train it' } });
const reply = (t, uuid) => ({
  type: 'assistant', uuid, timestamp: iso(t),
  message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'Done.' }] },
});
const toolUse = (t, uuid) => ({
  type: 'assistant', uuid, timestamp: iso(t),
  message: { role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: `t-${uuid}`, name: 'Bash', input: { command: 'python train.py' } }] },
});

const sshSession = (extra = {}) => parseDesktopSession({
  sessionId: 'local_4f2c9a10-1d3e-4b5a-9c7d-2e8f6a1b3c4d',
  cliSessionId: '7b1e2d3c-4a5f-4e6d-8c9b-0a1f2e3d4c5b',
  sshConfig: { sshHost: 'alice@203.0.113.7', sshPort: 2222 },
  lastActivityAt: T0,
  ...extra,
});

test('the index describes SSH and WSL sessions as copied from another machine', () => {
  const r = sshSession({ priorCliSessionIds: ['old-1', 7] });
  assert.equal(r.mirrored, true);
  assert.equal(r.machineKey, 'ssh:alice@203.0.113.7:2222');
  assert.equal(r.machine, '203.0.113.7');
  assert.deepEqual(r.priorCliSessionIds, ['old-1']);
  const w = parseDesktopSession({ sessionId: 'local_w', wslConfig: { distro: 'Ubuntu' } });
  assert.equal(w.mirrored, true);
  assert.equal(w.machineKey, 'wsl:Ubuntu');
  assert.equal(parseDesktopSession({ sessionId: 'local_x', cwd: 'C:\\repo' }).mirrored, false);
});

test('saved SSH connections give each server its name', () => {
  const names = parseSshConnections({
    configs: [
      { name: 'lab-server', sshHost: 'alice@203.0.113.7', sshPort: 2222 },
      { name: ' wsl ', sshHost: '127.0.0.1' },
      { name: '', sshHost: 'nameless@10.0.0.1' },
      { sshHost: 'broken' },
    ],
  });
  assert.deepEqual([...names], [['ssh:alice@203.0.113.7:2222', 'lab-server'], ['ssh:127.0.0.1:22', 'wsl']]);
  assert.equal(parseSshConnections(null).size, 0);
});

const WORKING = 'Working on 203.0.113.7';
const sent = (s) => ({ running: true, at: T0 + s * 1000 });    // from the app's log, on our clock
const ended = (s) => ({ running: false, at: T0 + s * 1000 });

test('the app log shows an SSH turn as soon as the prompt is sent', () => {
  const copy = copyOf([prompt(remote(0)), reply(remote(30), 'a1')]);
  const r = sshSession({ latestUserFrameAt: remote(0), lastAssistantUuid: 'a1', postTurnSummaryFor: 'a1', lastFocusedAt: T0 + 60_000 });
  // The index still describes the previous turn, but the log saw the new prompt go out.
  assert.deepEqual(desktopStatus(r, copy, { now: T0 + 605_000, skew: SKEW, logTurn: sent(600) }), { status: 'running', detail: WORKING, since: T0 + 600_000 });
  // When the turn ends, the copy decides (here it hasn't been copied yet, so nothing new).
  assert.equal(desktopStatus(r, copy, { now: T0 + 700_000, skew: SKEW, logTurn: ended(690) }).status, 'idle');
});

test('a copy made during the turn gives the step, or the question Claude is asking', () => {
  const copy = copyOf([prompt(remote(600)), toolUse(remote(605), 'a2')]);
  const r = sshSession({ latestUserFrameAt: remote(600), lastAssistantUuid: 'a2' });
  const st = desktopStatus(r, copy, { now: T0 + 620_000, skew: SKEW, logTurn: sent(600) });
  assert.deepEqual(st, { status: 'running', detail: 'python train.py', since: T0 + 600_000 });
});

test('without the log, an SSH turn shows once the index records its prompt', () => {
  const r = sshSession({ latestUserFrameAt: remote(0), lastAssistantUuid: 'a1' });
  assert.deepEqual(desktopStatus(r, null, { now: T0 + 120_000, skew: SKEW }), { status: 'running', detail: WORKING, since: T0 });
});

test('a running SSH turn is named after its project folder when the index has one', () => {
  const r = sshSession({ latestUserFrameAt: remote(0), lastAssistantUuid: 'a1', cwd: '/srv/projects/tokenizer/' });
  assert.equal(desktopStatus(r, null, { now: T0 + 120_000, skew: SKEW }).detail, 'Working on tokenizer');
});

test('an SSH session whose last turn was summarized is not running', () => {
  const r = sshSession({ latestUserFrameAt: remote(0), lastAssistantUuid: 'a1', postTurnSummaryFor: 'a1' });
  assert.equal(desktopStatus(r, null, { now: T0 + 120_000, skew: SKEW }), null);
});

test('a prompt or reply the copy does not have yet means a turn is running', () => {
  const copy = copyOf([prompt(remote(0)), reply(remote(30), 'a1')]);
  const newPrompt = sshSession({ latestUserFrameAt: remote(600), lastAssistantUuid: 'a1', lastFocusedAt: T0 + 60_000 });
  assert.deepEqual(desktopStatus(newPrompt, copy, { now: T0 + 700_000, skew: SKEW }), { status: 'running', detail: WORKING, since: T0 + 600_000 });
  const newReply = sshSession({ latestUserFrameAt: remote(0), lastAssistantUuid: 'a9', lastFocusedAt: T0 + 60_000 });
  assert.equal(desktopStatus(newReply, copy, { now: T0 + 90_000, skew: SKEW }).detail, WORKING);
  // Unless the log saw that turn end, and the copy just hasn't arrived yet.
  assert.equal(desktopStatus(newPrompt, copy, { now: T0 + 700_000, skew: SKEW, logTurn: ended(650) }).status, 'idle');
});

test('the copy is used as soon as it has the latest reply', () => {
  const copy = copyOf([prompt(remote(0)), toolUse(remote(5), 'a1')]);
  const r = sshSession({ latestUserFrameAt: remote(0), lastAssistantUuid: 'a1' });
  assert.deepEqual(desktopStatus(r, copy, { now: T0 + 60_000, skew: SKEW }), { status: 'running', detail: 'python train.py', since: T0 });
});

test("a session's project is its folder, unless the app made that folder for it", () => {
  assert.equal(projectName('/srv/projects/tokenizer'), 'tokenizer');
  assert.equal(projectName('C:\\Users\\alice\\code\\billing\\'), 'billing');
  assert.equal(projectName('C:\\Users\\alice\\AppData\\Roaming\\Claude\\scratch-workspaces\\a1\\b2\\scratch-2026-09-24-0f3a'), null);
  assert.equal(projectName('/mnt/c/users/alice/documents/codex/2026-09-24/fix-the-hooks'), null);
  assert.equal(projectName(''), null);
});

test('the app log lines the pet understands', () => {
  const id = 'local_4f2c9a10-1d3e-4b5a-9c7d-2e8f6a1b3c4d';
  const local = (s) => new Date(2026, 8, 24, 23, 47, s).getTime();
  assert.deepEqual(parseLogLine(`2026-09-24 23:47:34 [info] Sending message to session ${id}`), { kind: 'start', sessionId: id, at: local(34) });
  const timing = `2026-09-24 23:47:50 [info] [CCD start-timing] ${id} preflight=2ms init=788ms first_assistant=19453ms | ccd_overhead=173ms total_to_init=974ms total_to_assistant=20430ms cache_hit`;
  assert.deepEqual(parseLogLine(timing), { kind: 'start', sessionId: id, at: local(50) - 20430 });
  assert.equal(parseLogLine(`2026-09-24 23:47:29 [info] Starting local session ${id} in /data/x`), null);   // may be a pre-warm
  // A prompt passed to the CLI without a "Sending message" line (e.g. one that was queued).
  assert.deepEqual(parseLogLine(`2026-09-24 23:47:36 [info] Mapping internal session ${id} to CLI session 7b1e2d3c-4a5f-4e6d-8c9b-0a1f2e3d4c5b`),
    { kind: 'start', sessionId: id, at: local(36) });
  assert.equal(parseLogLine(`2026-09-24 23:47:40 [info] [CCD CycleHealth] healthy cycle for ${id} (68s, hadFirstResponse=true)\r`).kind, 'end');
  assert.equal(parseLogLine(`2026-09-24 23:47:40 [info] [CCD CycleHealth] unhealthy cycle for ${id} (3s, hadFirstResponse=true, reason=api_error)`).kind, 'end');
  assert.equal(parseLogLine(`2026-09-24 23:47:40 [info] [Stop hook] Query completed for session ${id}`).kind, 'end');
  assert.equal(parseLogLine(`2026-09-24 23:47:40 [info] Session ${id} query iterator completed`).kind, 'end');
  assert.equal(parseLogLine(`2026-09-24 23:47:40 [info] [CCD] LocalSessions.setFocusedSession: sessionId=${id}`), null);
});

test('the server clock is accounted for when deciding whether you saw the result', () => {
  const copy = copyOf([prompt(remote(0)), reply(remote(30), 'a1')]);
  const r = sshSession({ latestUserFrameAt: remote(0), lastAssistantUuid: 'a1', lastFocusedAt: T0 + 60_000 });
  // You looked at the session 30 s after the turn ended (on our clock): nothing to report.
  assert.equal(desktopStatus(r, copy, { now: T0 + 90_000, skew: SKEW }).status, 'idle');
  // Before you looked, it's ready for review, and `since` is on our clock.
  const unseen = sshSession({ latestUserFrameAt: remote(0), lastAssistantUuid: 'a1', lastFocusedAt: T0 - 60_000 });
  assert.deepEqual(desktopStatus(unseen, copy, { now: T0 + 90_000, skew: SKEW }), { status: 'review', detail: 'Finished', since: T0 + 30_000 });
});

test('a turn with no news for a long time is not reported as running', () => {
  const r = sshSession({ latestUserFrameAt: remote(0), lastAssistantUuid: 'a1' });
  assert.equal(desktopStatus(r, null, { now: T0 + 2 * 60 * 60 * 1000, skew: SKEW }), null);
});

test('local sessions ignore the copy checks', () => {
  const r = parseDesktopSession({ sessionId: 'local_x', cwd: 'C:\\repo', latestUserFrameAt: T0, lastAssistantUuid: 'zzz' });
  const st = desktopStatus(r, copyOf([prompt(T0), reply(T0 + 5000, 'a1')]), { now: T0 + 10_000 });
  assert.equal(st.status, 'review');
});

test('clock skew is estimated from the most recent copies', () => {
  assert.equal(estimateSkew([]), 0);
  const samples = [
    { mtimeMs: 1000_000, lastStampAt: 1000_000 + SKEW - 900 },       // copied just after the turn ended
    { mtimeMs: 2000_000, lastStampAt: 1500_000 + SKEW },             // copied when opened, much later
    { mtimeMs: 3000_000, lastStampAt: 3000_000 + SKEW - 400 },
    { mtimeMs: 10, lastStampAt: 10 + SKEW + 60_000 },                // too old to count
  ];
  assert.equal(estimateSkew(samples), SKEW - 400);
  assert.equal(estimateSkew([{ mtimeMs: T0, lastStampAt: T0 - 90_000 }]), -90_000);   // a server that runs behind
});

test('terminal sessions skip SSH copies, deleted sessions and earlier IDs of desktop sessions', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-pet-test-'));
  try {
    const projects = path.join(root, 'projects');
    const index = path.join(root, 'sessions', 'acct', 'org');
    fs.mkdirSync(index, { recursive: true });
    const ids = {
      live: '11111111-1111-4111-8111-111111111111',
      copy: '22222222-2222-4222-8222-222222222222',
      deleted: '33333333-3333-4333-8333-333333333333',
      prior: '44444444-4444-4444-8444-444444444444',
      desktop: '55555555-5555-4555-8555-555555555555',
    };
    const write = (dir, id) => {
      fs.mkdirSync(path.join(projects, dir), { recursive: true });
      fs.writeFileSync(path.join(projects, dir, `${id}.jsonl`), `${JSON.stringify(prompt(Date.now()))}\n`);
    };
    write('C--repo', ids.live);
    write(`ssh-${ids.copy}`, ids.copy);
    write('C--repo', ids.deleted);
    fs.writeFileSync(path.join(projects, 'C--repo', `${ids.deleted}.desktop-released.json`),
      JSON.stringify({ v: 1, releasedAt: new Date(Date.now() + 1000).toISOString(), reason: 'delete' }));
    write('C--repo', ids.prior);
    fs.writeFileSync(path.join(index, 'local_abc.json'), JSON.stringify({
      sessionId: 'local_abc', cliSessionId: ids.desktop, priorCliSessionIds: [ids.prior], cwd: 'C:\\repo',
    }));

    const tracker = new SessionTracker({ sessionsRoot: path.join(root, 'sessions'), projectsRoot: projects });
    await tracker.scanDesktopIndex();
    await tracker.scanProjects();
    assert.deepEqual([...tracker.cliSessions.keys()], [ids.live]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a running SSH session is named after its saved connection', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-pet-test-'));
  try {
    const index = path.join(root, 'sessions', 'acct', 'org');
    fs.mkdirSync(index, { recursive: true });
    fs.writeFileSync(path.join(index, 'local_ssh1.json'), JSON.stringify({
      sessionId: 'local_ssh1', cliSessionId: '66666666-6666-4666-8666-666666666666', title: 'Train the model',
      cwd: '/data/proj', sshConfig: { sshHost: 'alice@10.0.0.5', sshPort: 2222 },
    }));
    const sshConnections = path.join(root, 'ssh_configs.json');
    fs.writeFileSync(sshConnections, JSON.stringify({ configs: [{ name: 'lab-server', sshHost: 'alice@10.0.0.5', sshPort: 2222 }] }));
    const appLog = path.join(root, 'main.log');
    fs.writeFileSync(appLog, logLine(Date.now() - 5000, 'Sending message to session local_ssh1'));

    const tracker = new SessionTracker({ sessionsRoot: path.join(root, 'sessions'), projectsRoot: path.join(root, 'projects'), appLog, sshConnections });
    await tracker.tick();
    const [s] = tracker.sessions;
    assert.equal(s.status, 'running');
    assert.equal(s.detail, 'Working on proj');   // its folder, /data/proj
    assert.equal(s.project, 'proj');
    assert.equal(s.remote, 'lab-server');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('file changes reach the pet right away, without waiting for the timer', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-pet-test-'));
  const index = path.join(root, 'sessions', 'acct', 'org');
  const project = path.join(root, 'projects', 'C--repo');
  fs.mkdirSync(index, { recursive: true });
  fs.mkdirSync(project, { recursive: true });
  const appLog = path.join(root, 'logs', 'main.log');
  fs.mkdirSync(path.dirname(appLog));
  fs.writeFileSync(appLog, '');
  fs.writeFileSync(path.join(index, 'local_ssh2.json'), JSON.stringify({
    sessionId: 'local_ssh2', cliSessionId: '88888888-8888-4888-8888-888888888888', title: 'On the server',
    sshConfig: { sshHost: 'alice@10.0.0.5' },
  }));
  // A 60 s timer: only the file notifications can deliver these updates in time.
  const tracker = new SessionTracker({ sessionsRoot: path.join(root, 'sessions'), projectsRoot: path.join(root, 'projects'), appLog, pollMs: 60_000 });
  const next = (title) => new Promise((resolve) => {
    const onChange = (list) => {
      const s = list.find((x) => x.title === title);
      if (s) {
        tracker.off('change', onChange);
        resolve(s);
      }
    };
    tracker.on('change', onChange);
  });
  const within = async (promise, ms) => {
    let timer;
    const late = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`no update within ${ms} ms`)), ms); });
    try {
      return await Promise.race([promise, late]);
    } finally {
      clearTimeout(timer);
    }
  };
  try {
    tracker.start();
    await new Promise((resolve) => setTimeout(resolve, 300));   // the first, empty update

    // A new local session: its transcript and its index entry appear.
    const local = next('Watch me');
    const id = '77777777-7777-4777-8777-777777777777';
    fs.writeFileSync(path.join(project, `${id}.jsonl`), `${JSON.stringify(prompt(Date.now()))}\n`);
    fs.writeFileSync(path.join(index, 'local_w1.json'), JSON.stringify({ sessionId: 'local_w1', cliSessionId: id, cwd: 'C:\\repo', title: 'Watch me' }));
    assert.equal((await within(local, 2000)).status, 'running');

    // A prompt sent to an SSH session shows up in the app's log.
    const ssh = next('On the server');
    fs.appendFileSync(appLog, logLine(Date.now(), 'Sending message to session local_ssh2'));
    assert.equal((await within(ssh, 2000)).status, 'running');
  } finally {
    tracker.stop();
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 });
  }
});

// A line the way the desktop app writes its log (local time, whole seconds).
function logLine(t, message) {
  const d = new Date(t);
  const p2 = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())} [info] ${message}\n`;
}

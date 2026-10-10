'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { applyEntry, createTurnState } = require('../src/transcript');
const {
  AppLogFollower, SessionTracker, desktopStatus, estimateSkew, parseDesktopSession, parseLogLine, parseSshConnections, projectName,
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
  assert.deepEqual(parseLogLine(`2026-09-24 23:47:40 [info] [CCD] LocalSessions.setFocusedSession: sessionId=${id}`),
    { kind: 'focus', sessionId: id, at: local(40) });
  assert.equal(parseLogLine('2026-09-24 23:47:40 [info] [CCD] LocalSessions.setFocusedSession: sessionId=null').sessionId, null);
  assert.equal(parseLogLine(`2026-09-24 23:47:40 [info] [CCD] LocalSessions.replaceEnabledMcpTools: sessionId=${id}, toolCount=3`), null);
  const req = '0f1e2d3c-4b5a-4968-8776-655443322110';
  assert.deepEqual(parseLogLine(`2026-09-24 23:47:41 [info] Emitted tool permission request ${req} for AskUserQuestion in session ${id}`),
    { kind: 'ask', sessionId: id, requestId: req, tool: 'AskUserQuestion', at: local(41) });
  assert.deepEqual(parseLogLine(`2026-09-24 23:47:45 [info] Received permission response for ${req}: once (tool: AskUserQuestion)`),
    { kind: 'answer', sessionId: null, requestId: req, at: local(45) });
  assert.deepEqual(parseLogLine(`2026-09-24 23:47:46 [info] Permission request ${req} for AskUserQuestion aborted`),
    { kind: 'answer', sessionId: null, requestId: req, at: local(46) });
  assert.equal(parseLogLine('2026-09-24 23:47:50 [info] Starting app {').kind, 'launch');
  assert.equal(parseLogLine('2026-09-24 23:47:51 [info] Not main instance, returning early from app ready').kind, 'second');
});

test('the log keeps each question until you answer it, a new prompt withdraws it or the app restarts', () => {
  const log = new AppLogFollower('main.log');
  const id = 'local_4f2c9a10-1d3e-4b5a-9c7d-2e8f6a1b3c4d';
  const line = (s, text) => log.handleLine(`2026-09-24 23:47:${String(s).padStart(2, '0')} [info] ${text}`);
  const local = (s) => new Date(2026, 8, 24, 23, 47, s).getTime();
  line(10, `Sending message to session ${id}`);
  assert.deepEqual(log.turnOf(id), { running: true, at: local(10), asking: null });
  line(20, `Emitted tool permission request r1 for Bash in session ${id}`);
  line(21, `Emitted tool permission request r2 for AskUserQuestion in session ${id}`);
  assert.deepEqual(log.turnOf(id), { running: true, at: local(10), asking: { tool: 'Bash', at: local(20) } });
  line(25, 'Received permission response for r1: once (tool: Bash)');
  assert.deepEqual(log.turnOf(id).asking, { tool: 'AskUserQuestion', at: local(21) });
  // The app's own questions (whether to load the mods Claude wrote) stay up after the turn.
  line(30, `[Stop hook] Query completed for session ${id}`);
  assert.deepEqual(log.turnOf(id), { running: false, at: local(30), asking: { tool: 'AskUserQuestion', at: local(21) } });
  line(31, 'Permission request r2 for AskUserQuestion aborted');
  assert.equal(log.turnOf(id).asking, null);
  line(32, `Emitted tool permission request r4 for AskUserQuestion in session ${id}`);
  line(35, `Sending message to session ${id}`);
  assert.equal(log.turnOf(id).asking, null);
  // Read from the middle of a turn: the question alone says a turn is running.
  line(40, 'Emitted tool permission request r3 for ExitPlanMode in session local_other');
  assert.deepEqual(log.turnOf('local_other'), { running: true, at: local(40), asking: { tool: 'ExitPlanMode', at: local(40) } });
  // Opening a claude:// link starts a second copy of the app, which quits at once.
  line(50, 'Starting app {');
  line(51, 'Not main instance, returning early from app ready');
  log.settleLaunches(local(59));
  assert.deepEqual(log.turnOf('local_other').asking, { tool: 'ExitPlanMode', at: local(40) });
  // The app itself restarting takes its questions along, but not ones asked since.
  line(52, 'Starting app {');
  line(53, `Emitted tool permission request r5 for AskUserQuestion in session ${id}`);
  assert.deepEqual(log.turnOf('local_other').asking, { tool: 'ExitPlanMode', at: local(40) });   // not known yet
  log.settleLaunches(local(58));
  assert.equal(log.turnOf('local_other'), null);
  assert.deepEqual(log.turnOf(id).asking, { tool: 'AskUserQuestion', at: local(53) });
});

test('the log says which session is selected in the app', () => {
  const log = new AppLogFollower('main.log');
  const line = (text) => log.handleLine(`2026-09-24 23:47:00 [info] [CCD] LocalSessions.setFocusedSession: sessionId=${text}`);
  line('local_a');
  assert.equal(log.selected, 'local_a');
  line('null');
  line('local_b');
  assert.equal(log.selected, 'local_b');
  // Switching away means it was on screen until then.
  assert.equal(log.leftAt('local_a'), new Date(2026, 8, 24, 23, 47, 0).getTime());
  assert.equal(log.leftAt('local_b'), 0);
  // A second copy of the app, from a claude:// link, changes nothing.
  log.handleLine('2026-09-24 23:48:00 [info] Starting app {');
  log.handleLine('2026-09-24 23:48:01 [info] Not main instance, returning early from app ready');
  log.settleLaunches(new Date(2026, 8, 24, 23, 49, 0).getTime());
  assert.equal(log.selected, 'local_b');
  log.handleLine('2026-09-24 23:50:00 [info] Starting app {');
  log.handleLine('2026-09-24 23:50:30 [info] Session local_c query iterator completed');
  assert.equal(log.selected, null);
  assert.equal(log.leftAt('local_b'), 0);   // the app closing isn't you looking
});

test('a turn that ends in the selected session is Ready only until the app comes to the front', () => {
  const copy = copyOf([prompt(T0), reply(T0 + 5000, 'a1')]);   // ended at T0 + 5 s
  const r = parseDesktopSession({ sessionId: 'local_x', cwd: 'C:\\repo', lastFocusedAt: T0 - 60_000 });   // selected before
  assert.equal(desktopStatus(r, copy, { now: T0 + 20_000 }).status, 'review');
  // The app was (or came) to the front with it selected after the turn ended: seen.
  assert.equal(desktopStatus(r, copy, { now: T0 + 20_000, seenAt: T0 + 6000 }).status, 'idle');
  assert.equal(desktopStatus(r, copy, { now: T0 + 20_000, seenAt: T0 + 1000 }).status, 'review');
  // While the pet finds out, the bubble waits a moment rather than flash "Ready".
  assert.deepEqual(desktopStatus(r, copy, { now: T0 + 7000, frontPending: true }), { status: 'running', detail: 'Wrapping up', since: T0 });
});

test('the front-window helper runs only while a turn in the selected session may be unseen', async () => {
  const { EventEmitter } = require('node:events');
  const helpers = [];
  const foreground = () => {
    const w = new EventEmitter();
    w.start = () => { w.running = true; };
    w.stop = () => { w.running = false; };
    helpers.push(w);
    return w;
  };
  const tracker = new SessionTracker({ foreground });
  tracker.running = true;
  tracker.watchFront(true);
  assert.equal(helpers.length, 1);
  assert.equal(helpers[0].running, true);
  tracker.watchFront(true);
  assert.equal(helpers.length, 1);   // one at a time
  helpers[0].emit('front', true);
  assert.equal(tracker.appInFront, true);
  tracker.watchFront(false);
  assert.equal(helpers[0].running, false);
  assert.equal(tracker.appInFront, null);
  // What it saw is kept (and saved: 'seen' tells main.js), for the next start.
  let saved = 0;
  tracker.on('seen', () => { saved += 1; });
  tracker.appLog = { selected: 'local_x', turnOf: () => null };
  tracker.appInFront = true;
  tracker.recompute();
  tracker.recompute();
  assert.equal(saved, 1);
  assert.ok(tracker.seenSnapshot().local_x > 0);
  assert.equal(new SessionTracker({ seen: tracker.seenSnapshot() }).frontSeen.get('local_x'), tracker.frontSeen.get('local_x'));
  tracker.appInFront = null;
  tracker.appLog = null;
  // A helper that dies (PowerShell blocked, say) isn't restarted right away.
  tracker.watchFront(true);
  helpers[1].emit('exit');
  tracker.watchFront(true);
  assert.equal(helpers.length, 2);
  tracker.running = false;
});

test('a question in the log shows "Needs you" before the SSH copy has it', () => {
  const copy = copyOf([prompt(remote(0)), reply(remote(30), 'a1')]);
  const r = sshSession({ latestUserFrameAt: remote(0), lastAssistantUuid: 'a1', postTurnSummaryFor: 'a1', lastFocusedAt: T0 + 60_000 });
  const asking = (tool, s) => ({ running: true, at: T0 + 600_000, asking: { tool, at: T0 + s * 1000 } });
  assert.deepEqual(desktopStatus(r, copy, { now: T0 + 700_000, skew: SKEW, logTurn: asking('AskUserQuestion', 650) }),
    { status: 'waiting', detail: 'Has a question for you', since: T0 + 650_000 });
  assert.equal(desktopStatus(r, copy, { now: T0 + 700_000, skew: SKEW, logTurn: asking('ExitPlanMode', 650) }).detail, 'Plan ready for your review');
  // Also for as long as it takes you to answer.
  assert.equal(desktopStatus(r, copy, { now: T0 + 5 * 60 * 60 * 1000, skew: SKEW, logTurn: asking('AskUserQuestion', 650) }).status, 'waiting');
  // Even once the turn is over: the app's own questions outlast it.
  const later = copyOf([prompt(remote(600)), reply(remote(660), 'a2')]);
  assert.deepEqual(desktopStatus(r, later, { now: T0 + 700_000, skew: SKEW, logTurn: { ...ended(660), asking: { tool: 'AskUserQuestion', at: T0 + 650_000 } } }),
    { status: 'waiting', detail: 'Has a question for you', since: T0 + 650_000 });
});

test('a permission prompt shows "Needs you" instead of "Running"', () => {
  const r = parseDesktopSession({ sessionId: 'local_x', cwd: 'C:\\repo' });
  const copy = copyOf([prompt(T0), toolUse(T0 + 5000, 'a1')]);
  assert.equal(desktopStatus(r, copy, { now: T0 + 10_000 }).status, 'running');
  const logTurn = { running: true, at: T0, asking: { tool: 'Bash', at: T0 + 6000 } };
  assert.deepEqual(desktopStatus(r, copy, { now: T0 + 10_000, logTurn }), { status: 'waiting', detail: 'Asking to use Bash', since: T0 + 6000 });
  assert.equal(desktopStatus(r, copy, { now: T0 + 10_000, logTurn, dismissedAt: T0 + 8000 }).status, 'running');   // the × on it
  const mcp = { ...logTurn, asking: { tool: 'mcp__files__read_file', at: T0 + 6000 } };
  assert.equal(desktopStatus(r, copy, { now: T0 + 10_000, logTurn: mcp }).detail, 'Asking to use read file');
});

test('the question from the transcript wins, since it has the words', () => {
  const r = parseDesktopSession({ sessionId: 'local_x', cwd: 'C:\\repo' });
  const copy = copyOf([prompt(T0), {
    type: 'assistant', uuid: 'a1', timestamp: iso(T0 + 5000),
    message: { role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'q1', name: 'AskUserQuestion', input: { questions: [{ question: 'Which port?' }] } }] },
  }]);
  const logTurn = { running: true, at: T0, asking: { tool: 'AskUserQuestion', at: T0 + 6000 } };
  assert.deepEqual(desktopStatus(r, copy, { now: T0 + 10_000, logTurn }), { status: 'waiting', detail: 'Which port?', since: T0 + 5000 });
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

test("a finished turn waits a moment for the app's summary, which may say it needs you", () => {
  const copy = copyOf([prompt(T0), reply(T0 + 5000, 'a1')]);
  const r = parseDesktopSession({ sessionId: 'local_x', cwd: 'C:\\repo', classifierSummaryEnabled: true });
  assert.deepEqual(desktopStatus(r, copy, { now: T0 + 7000 }), { status: 'running', detail: 'Wrapping up', since: T0 });
  assert.equal(desktopStatus(r, copy, { now: T0 + 16_000 }).status, 'review');   // no summary in time
  const blocked = parseDesktopSession({
    sessionId: 'local_x', cwd: 'C:\\repo', classifierSummaryEnabled: true, postTurnSummaryFor: 'a1',
    postTurnSummary: { status_category: 'blocked', needs_action: 'Pick a port', summarizes_uuid: 'a1' },
  });
  assert.deepEqual(desktopStatus(blocked, copy, { now: T0 + 8000 }), { status: 'waiting', detail: 'Pick a port', since: T0 + 5000 });
  // Sessions that get no summaries don't wait.
  const plain = parseDesktopSession({ sessionId: 'local_x', cwd: 'C:\\repo' });
  assert.equal(desktopStatus(plain, copy, { now: T0 + 7000 }).status, 'review');
});

test('local sessions ignore the copy checks', () => {
  const r = parseDesktopSession({ sessionId: 'local_x', cwd: 'C:\\repo', latestUserFrameAt: T0, lastAssistantUuid: 'zzz' });
  const st = desktopStatus(r, copyOf([prompt(T0), reply(T0 + 5000, 'a1')]), { now: T0 + 10_000 });
  assert.equal(st.status, 'review');
});

test("clock skew is estimated from the last day's copies", () => {
  assert.equal(estimateSkew([]), 0);
  const hour = 3600_000;
  const samples = [
    { mtimeMs: T0, lastStampAt: T0 + SKEW - 400 },                                  // copied just after a turn ended
    { mtimeMs: T0 + 5 * hour, lastStampAt: T0 + SKEW - 900 },                        // copied later, when you opened it
    // A burst of old sessions you opened, copied over again: none of them hides the good one.
    ...[1, 2, 3].map((i) => ({ mtimeMs: T0 + 6 * hour + i, lastStampAt: T0 - 48 * hour + SKEW })),
    { mtimeMs: T0 - 30 * hour, lastStampAt: T0 - 30 * hour + SKEW + 60_000 },        // over a day old: may predate a clock change
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
    // The SSH copies aren't even looked through, but a desktop session still finds its copy.
    assert.deepEqual(tracker.projectDirs.map((d) => path.basename(d)), ['C--repo']);
    const copy = await tracker.findTranscript({ cliSessionId: ids.copy, mirrored: true });
    assert.equal(copy, path.join(projects, `ssh-${ids.copy}`, `${ids.copy}.jsonl`));
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

test("your plan's usage comes from the desktop app's samples", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-pet-test-'));
  try {
    const planUsage = path.join(root, 'plan-usage-history.json');
    fs.writeFileSync(planUsage, JSON.stringify({ version: 2, samples: [{ t: T0 - 900_000, org: 'org', u: { fh: 12, sd: 67 } }, { t: T0, org: 'org', u: { fh: 18, sd: 68 } }] }));
    const tracker = new SessionTracker({ sessionsRoot: path.join(root, 'sessions'), projectsRoot: path.join(root, 'projects'), planUsage });
    const seen = [];
    tracker.on('usage', (u) => seen.push(u));
    await tracker.tick();
    assert.equal(seen.length, 1);
    const { claude } = seen[0];
    assert.deepEqual([claude.weekly.percent, claude.fiveHour.percent, claude.at], [68, 18, T0]);   // the newest sample
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

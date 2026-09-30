'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { applyEntry, createTurnState, deriveStatus, describeTool } = require('../src/transcript');

const T0 = Date.parse('2026-09-24T12:00:00.000Z');
const at = (s) => new Date(T0 + s * 1000).toISOString();

function run(entries) {
  const state = createTurnState();
  for (const e of entries) applyEntry(state, e);
  return state;
}

const prompt = (s, text = 'fix the bug') => ({ type: 'user', timestamp: at(s), message: { role: 'user', content: text } });
const toolUse = (s, id, name, input = {}) => ({
  type: 'assistant', uuid: `a-${id}`, timestamp: at(s),
  message: { role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', id, name, input }] },
});
const toolResult = (s, id, content = 'ok', toolUseResult = undefined) => ({
  type: 'user', timestamp: at(s), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content }] },
  ...(toolUseResult && { toolUseResult }),
});
const reply = (s, uuid = 'a-final', extra = {}) => ({
  type: 'assistant', uuid, timestamp: at(s),
  message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'Done.' }] }, ...extra,
});
const stopSummary = (s) => ({ type: 'system', subtype: 'stop_hook_summary', timestamp: at(s) });

test('a new prompt shows running/Thinking', () => {
  const s = run([prompt(0)]);
  assert.deepEqual(deriveStatus(s, {}, T0 + 5000), { status: 'running', detail: 'Thinking', since: T0 });
});

test('a pending tool is shown as running with a description', () => {
  const s = run([prompt(0), toolUse(2, 't1', 'Edit', { file_path: 'C:\\repo\\src\\main.js' })]);
  const st = deriveStatus(s, {}, T0 + 3000);
  assert.equal(st.status, 'running');
  assert.equal(st.detail, 'Editing main.js');
});

test('AskUserQuestion puts the pet in waiting until answered', () => {
  const ask = toolUse(3, 'q1', 'AskUserQuestion', { questions: [{ question: 'Which runtime?' }] });
  let s = run([prompt(0), ask]);
  assert.equal(deriveStatus(s, {}, T0 + 60_000).status, 'waiting');
  assert.equal(deriveStatus(s, {}, T0 + 60_000).detail, 'Which runtime?');
  assert.equal(deriveStatus(s, { dismissedAt: T0 + 30_000 }, T0 + 60_000).status, 'running');   // the × on it
  s = run([prompt(0), ask, toolResult(90, 'q1')]);
  assert.equal(deriveStatus(s, {}, T0 + 91_000).status, 'running');
});

test('a finished turn is review until the session is focused', () => {
  const s = run([prompt(0), toolUse(1, 't1', 'Bash', { command: 'npm test' }), toolResult(4, 't1'), reply(6), stopSummary(7)]);
  assert.equal(deriveStatus(s, { lastFocusedAt: T0 - 1000 }, T0 + 10_000).status, 'review');
  assert.equal(deriveStatus(s, { lastFocusedAt: T0 + 9000 }, T0 + 10_000).status, 'idle');
  assert.equal(deriveStatus(s, { dismissedAt: T0 + 9000 }, T0 + 10_000).status, 'idle');
});

test('the desktop summary for this turn can mark it as blocked on the user', () => {
  const s = run([prompt(0), reply(5, 'a-last'), stopSummary(6)]);
  const summary = { status_category: 'blocked', needs_action: 'Pick one of the 4 options', summarizes_uuid: 'a-last' };
  assert.deepEqual(deriveStatus(s, { summary }, T0 + 10_000), { status: 'waiting', detail: 'Pick one of the 4 options', since: T0 + 6000 });
});

test('a turn that ended waiting on you needs you until you have seen it', () => {
  const s = run([prompt(0), reply(5, 'a-last'), stopSummary(6)]);
  const summary = { status_category: 'need_input', status_detail: 'Asked which port to use', summarizes_uuid: 'a-last' };
  assert.equal(deriveStatus(s, { summary, lastFocusedAt: T0 - 1000 }, T0 + 10_000).status, 'waiting');
  assert.equal(deriveStatus(s, { summary, lastFocusedAt: T0 + 9000 }, T0 + 10_000).status, 'idle');   // looked at
  assert.equal(deriveStatus(s, { summary, dismissedAt: T0 + 9000 }, T0 + 10_000).status, 'idle');
  // A question Claude is still waiting on (the question tool) doesn't clear by looking.
  const asking = run([prompt(0), toolUse(3, 'q1', 'AskUserQuestion', { questions: [{ question: 'Which port?' }] })]);
  assert.equal(deriveStatus(asking, { lastFocusedAt: T0 + 9000 }, T0 + 10_000).status, 'waiting');
});

test("a reply split into thinking and text entries is still the turn's last reply", () => {
  const block = (s, uuid, type) => ({
    type: 'assistant', uuid, timestamp: at(s),
    message: { id: 'msg_1', role: 'assistant', stop_reason: 'end_turn', content: [type === 'text' ? { type, text: 'Which port?' } : { type, thinking: '' }] },
  });
  const s = run([prompt(0), block(4, 'a-think', 'thinking'), block(5, 'a-text', 'text'), stopSummary(6)]);
  const summary = { status_category: 'blocked', needs_action: 'Pick a port', summarizes_uuid: 'a-text' };
  assert.deepEqual(deriveStatus(s, { summary }, T0 + 10_000), { status: 'waiting', detail: 'Pick a port', since: T0 + 6000 });
  assert.equal(s.turnStartedAt, T0);
});

test('a reply that calls a tool after a block marked as the end keeps the turn running', () => {
  const block = (s, uuid, content) => ({
    type: 'assistant', uuid, timestamp: at(s), message: { id: 'msg_2', role: 'assistant', stop_reason: 'refusal', content: [content] },
  });
  const s = run([prompt(0), block(4, 'a1', { type: 'thinking', thinking: '' }), block(5, 'a2', { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'make' } })]);
  assert.deepEqual(deriveStatus(s, {}, T0 + 10_000), { status: 'running', detail: 'make', since: T0 });
});

test("a tool's output that mentions an interruption doesn't end the turn", () => {
  const read = toolUse(1, 't1', 'Read', { file_path: 'notes.md' });
  const s = run([prompt(0), read, toolResult(2, 't1', 'Match /\\[Request interrupted by user/ to see a stop.')]);
  assert.equal(deriveStatus(s, {}, T0 + 3000).status, 'running');
  const stopped = run([prompt(0), read, toolResult(2, 't1', '[Request interrupted by user for tool use]')]);
  assert.equal(deriveStatus(stopped, {}, T0 + 3000).status, 'idle');
});

test('a summary from an older turn is ignored', () => {
  const s = run([prompt(0), reply(5, 'a-new')]);
  const summary = { status_category: 'blocked', needs_action: 'old question', summarizes_uuid: 'a-old' };
  assert.equal(deriveStatus(s, { summary }, T0 + 10_000).status, 'review');
});

test('an API error ends the turn as failed', () => {
  const s = run([prompt(0), reply(3, 'a-err', { isApiErrorMessage: true, message: { stop_reason: 'stop_sequence', content: [{ type: 'text', text: 'API Error: 529 overloaded' }] } })]);
  const st = deriveStatus(s, {}, T0 + 5000);
  assert.equal(st.status, 'failed');
  assert.match(st.detail, /overloaded/);
});

test('an interrupted turn goes quiet instead of claiming it finished', () => {
  const s = run([prompt(0), toolUse(1, 't1', 'Bash'), toolResult(2, 't1', [{ type: 'text', text: '[Request interrupted by user for tool use]' }])]);
  assert.equal(deriveStatus(s, {}, T0 + 3000).status, 'idle');
  const s2 = run([prompt(0), prompt(4, '[Request interrupted by user]')]);
  assert.equal(deriveStatus(s2, {}, T0 + 5000).status, 'idle');
});

test('reading from the middle of a turn still detects running', () => {
  const s = run([toolResult(10, 'zzz'), toolUse(11, 't2', 'Grep', { pattern: 'TODO' })]);
  const st = deriveStatus(s, {}, T0 + 12_000);
  assert.equal(st.status, 'running');
  assert.equal(st.detail, 'Searching TODO');
});

test('a turn with no activity for a long time is treated as stale', () => {
  const s = run([prompt(0), toolUse(1, 't1', 'Bash')]);
  assert.equal(deriveStatus(s, {}, T0 + 2 * 60 * 60 * 1000).status, 'idle');
});

test('local slash commands do not start a turn', () => {
  const s = run([{ type: 'user', timestamp: at(0), message: { content: '<command-name>/config</command-name>' } }]);
  assert.equal(deriveStatus(s, {}, T0 + 1000).status, 'idle');
});

test('sidechain and meta entries are ignored', () => {
  const s = run([{ ...prompt(0), isMeta: true }, { ...toolUse(1, 'x', 'Bash'), isSidechain: true }]);
  assert.equal(deriveStatus(s, {}, T0 + 2000).status, 'idle');
});

test('custom titles are picked up', () => {
  const s = run([{ type: 'custom-title', customTitle: 'Pet feature' }]);
  assert.equal(s.title, 'Pet feature');
});

test('describeTool summarizes common tools', () => {
  assert.equal(describeTool('Bash', { command: 'npm test', description: 'Run tests' }), 'Run tests');
  assert.equal(describeTool('WebFetch', { url: 'https://docs.example.com/a' }), 'Reading docs.example.com');
  assert.equal(describeTool('mcp__github__create_issue', {}), 'create issue');
});

// ---------------------------------------------------------------- background tasks

const bashTask = (s, id, taskId, description = 'Watch the build') => [
  toolUse(s, id, 'Bash', { command: 'make', description, run_in_background: true }),
  toolResult(s + 1, id, `Command running in background with ID: ${taskId}.`, { backgroundTaskId: taskId }),
];
const notice = (taskId, status = 'completed') => (
  `<task-notification>\n<task-id>${taskId}</task-id>\n<status>${status}</status>\n<summary>done</summary>\n</task-notification>`
);
const noticePrompt = (s, taskId, status) => prompt(s, notice(taskId, status));
const noticeAttachment = (s, taskId, status) => ({
  type: 'attachment', timestamp: at(s), attachment: { type: 'queued_command', commandMode: 'task-notification', prompt: notice(taskId, status) },
});
const inBackground = [prompt(0), ...bashTask(1, 't1', 'b1'), reply(4), stopSummary(5)];

test('a turn that leaves a background task running stays running, seen or not', () => {
  const s = run(inBackground);
  for (const meta of [{}, { lastFocusedAt: T0 + 9000 }, { dismissedAt: T0 + 9000 }]) {
    assert.deepEqual(deriveStatus(s, meta, T0 + 60_000), { status: 'running', detail: 'In the background: Watch the build', since: T0 + 2000 });
  }
});

test('it goes back to Ready when the notice ends the task and the turn it starts is over', () => {
  const s = run([...inBackground, noticePrompt(60, 'b1'), reply(65, 'a-report'), stopSummary(66)]);
  assert.equal(deriveStatus(s, {}, T0 + 70_000).status, 'review');
  assert.equal(deriveStatus(s, { lastFocusedAt: T0 + 69_000 }, T0 + 70_000).status, 'idle');
});

test('a task that ends while Claude is working is not waited for after the turn', () => {
  const s = run([...inBackground, prompt(30, 'anything new?'), noticeAttachment(40, 'b1', 'failed'), reply(45, 'a-two'), stopSummary(46)]);
  assert.equal(deriveStatus(s, {}, T0 + 50_000).status, 'review');
});

test('the turn its notice starts is running, then Ready, with no gap in between', () => {
  const s = run([...inBackground, noticePrompt(60, 'b1')]);
  assert.deepEqual(deriveStatus(s, {}, T0 + 61_000), { status: 'running', detail: 'Thinking', since: T0 + 60_000 });
});

test('it stays running until every background task is done', () => {
  const s = run([prompt(0), ...bashTask(1, 't1', 'b1'), ...bashTask(3, 't2', 'b2'), reply(6), stopSummary(7)]);
  assert.equal(deriveStatus(s, {}, T0 + 60_000).detail, '2 background tasks');
  applyEntry(s, noticePrompt(60, 'b1'));
  applyEntry(s, reply(62, 'a-one'));
  applyEntry(s, stopSummary(63));
  assert.equal(deriveStatus(s, {}, T0 + 65_000).detail, 'In the background: Watch the build');
  applyEntry(s, noticePrompt(120, 'b2'));
  applyEntry(s, reply(122, 'a-two'));
  applyEntry(s, stopSummary(123));
  assert.equal(deriveStatus(s, {}, T0 + 125_000).status, 'review');
});

test('agents, workflows and monitors count too, but a monitor for the whole session does not', () => {
  const agent = run([prompt(0), toolUse(1, 'a1', 'Agent', { description: 'Review the diff' }),
    toolResult(2, 'a1', 'Async agent launched', { status: 'async_launched', agentId: 'agent1', isAsync: true }), reply(4), stopSummary(5)]);
  assert.equal(deriveStatus(agent, {}, T0 + 60_000).detail, 'In the background: Agent: Review the diff');
  const workflow = run([prompt(0), toolUse(1, 'w1', 'Workflow'),
    toolResult(2, 'w1', 'started', { status: 'async_launched', taskId: 'wf1', taskType: 'local_workflow' }), reply(4), stopSummary(5)]);
  assert.equal(deriveStatus(workflow, {}, T0 + 60_000).status, 'running');
  const monitor = (persistent) => run([prompt(0), toolUse(1, 'm1', 'Monitor', { description: 'the deploy' }),
    toolResult(2, 'm1', 'Monitor started (task m1x)', { taskId: 'm1x', timeoutMs: 1_800_000, persistent }), reply(4), stopSummary(5)]);
  assert.equal(deriveStatus(monitor(false), {}, T0 + 60_000).detail, 'In the background: Watching the deploy');
  assert.equal(deriveStatus(monitor(true), {}, T0 + 60_000).status, 'review');
});

test("a monitor's progress notice does not end it, but its last one does", () => {
  const s = run([prompt(0), toolUse(1, 'm1', 'Monitor'), toolResult(2, 'm1', 'Monitor started (task m1x)', { taskId: 'm1x', timeoutMs: 1000 }),
    reply(4), stopSummary(5),
    prompt(30, '<task-notification>\n<task-id>m1x</task-id>\n<summary>Monitor event: "the deploy"</summary>\n<event>step 2</event>\n</task-notification>'),
    reply(32, 'a-event'), stopSummary(33)]);
  assert.equal(deriveStatus(s, {}, T0 + 40_000).status, 'running');
  applyEntry(s, noticePrompt(90, 'm1x', 'completed'));
  applyEntry(s, reply(92, 'a-done'));
  applyEntry(s, stopSummary(93));
  assert.equal(deriveStatus(s, {}, T0 + 95_000).status, 'review');
});

test('stopping a task with TaskStop ends it, though that writes no notice', () => {
  const stop = (s, id, taskId) => [
    toolUse(s, id, 'TaskStop', { task_id: taskId }),
    toolResult(s + 1, id, '{"message":"Successfully stopped task"}', { message: 'Successfully stopped task', task_id: taskId, task_type: 'local_bash' }),
  ];
  const s = run([prompt(0), ...bashTask(1, 't1', 'b1', 'Watch the build'), ...bashTask(3, 't2', 'b2', 'Train the model'),
    ...stop(5, 's1', 'b1'), reply(8), stopSummary(9)]);
  assert.equal(deriveStatus(s, {}, T0 + 60_000).detail, 'In the background: Train the model');
  for (const e of [prompt(60), ...stop(61, 's2', 'b2'), reply(64, 'a-two'), stopSummary(65)]) applyEntry(s, e);
  assert.equal(deriveStatus(s, {}, T0 + 70_000).status, 'review');
});

test('one notice can end several tasks, as when the app reopens a session', () => {
  const s = run([prompt(0), ...bashTask(1, 't1', 'b1'), ...bashTask(3, 't2', 'b2'), ...bashTask(5, 't3', 'b3', 'Train the model'),
    reply(8), stopSummary(9)]);
  assert.equal(deriveStatus(s, {}, T0 + 30_000).detail, '3 background tasks');
  const reopened = '<task-notification>\n<task-id>b1</task-id>\n<task-id>b2</task-id>\n<task-id>__orphan_summary__:shell</task-id>\n'
    + '<status>stopped</status>\n<summary>2 background shell command tasks didn\'t finish before the previous session ended.</summary>\n</task-notification>';
  for (const e of [prompt(60, reopened), reply(64, 'a-two'), stopSummary(65)]) applyEntry(s, e);
  assert.equal(deriveStatus(s, {}, T0 + 70_000).detail, 'In the background: Train the model');
});

test('a background task that never reports back stops counting after a few hours', () => {
  const s = run(inBackground);
  assert.equal(deriveStatus(s, {}, T0 + 3 * 60 * 60 * 1000).status, 'running');
  assert.equal(deriveStatus(s, {}, T0 + 5 * 60 * 60 * 1000).status, 'review');
});

test('a question or an error still shows over a running background task', () => {
  const asked = run([prompt(0), ...bashTask(1, 't1', 'b1'),
    toolUse(4, 'q1', 'AskUserQuestion', { questions: [{ question: 'Which one?' }] })]);
  assert.equal(deriveStatus(asked, {}, T0 + 60_000).status, 'waiting');
  const failed = run([prompt(0), ...bashTask(1, 't1', 'b1'), reply(4, 'a-err', { isApiErrorMessage: true }), stopSummary(5)]);
  assert.equal(deriveStatus(failed, {}, T0 + 60_000).status, 'failed');
  const needsYou = run(inBackground);
  const summary = { summarizes_uuid: 'a-final', status_category: 'need_input', needs_action: 'Pick one' };
  assert.equal(deriveStatus(needsYou, { summary }, T0 + 60_000).status, 'waiting');
});

test('a hung turn is stale even with a background task behind it', () => {
  const s = run([prompt(0), ...bashTask(1, 't1', 'b1'), toolUse(4, 't2', 'Read', { file_path: 'a.js' })]);
  assert.equal(deriveStatus(s, {}, T0 + 2 * 60 * 60 * 1000).status, 'idle');
});

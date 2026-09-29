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
const toolResult = (s, id, content = 'ok') => ({
  type: 'user', timestamp: at(s), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content }] },
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

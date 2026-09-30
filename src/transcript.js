'use strict';

// Turns Claude Code transcript entries (one JSON object per line of
// ~/.claude/projects/<project>/<session>.jsonl) into a pet status.
//
// Statuses, highest priority first (same order ChatGPT's pet uses):
//   waiting  - Claude is blocked on you (a question, a plan to approve, or the
//              desktop app's end-of-turn summary says it needs a decision; sessions.js
//              adds permission prompts, from the app's log)
//   failed   - the turn ended with an API error
//   review   - the turn finished and you haven't looked at it yet
//   running  - a turn is in progress, or one it started in the background (a command, an agent,
//              a monitor) hasn't finished: its ending notice starts the next turn, and
//              "Ready" in between would just flicker
//   idle     - nothing to report

const path = require('node:path');

const WAITING_TOOLS = new Set(['AskUserQuestion', 'ExitPlanMode']);
const NEEDS_YOU = new Set(['blocked', 'need_input']);   // end-of-turn summaries the app marks yellow
const END_STOP_REASONS = new Set(['end_turn', 'stop_sequence', 'max_tokens', 'refusal']);
const TASK_ENDED = new Set(['completed', 'failed', 'killed', 'stopped']);   // <status> of a task's last notice
const STALE_RUNNING_MS = 45 * 60 * 1000;
// A background task that never reported back (its session was closed, say) stops counting after
// this long. Nearly all finish well within it; the rare longer one falls back to "Ready".
const STALE_BACKGROUND_MS = 4 * 60 * 60 * 1000;
const UNREAD_WINDOW_MS = 12 * 60 * 60 * 1000;
const MAX_TURN_UUIDS = 64;
const MAX_SEEN_ASSISTANTS = 2000;
const MAX_BACKGROUND_TASKS = 64;

const STATUS_PRIORITY = { waiting: 0, failed: 1, review: 2, running: 3, idle: 4 };

function createTurnState() {
  return {
    turnActive: false,
    turnStartedAt: 0,
    turnEndedAt: 0,
    lastEventAt: 0,
    pendingTools: new Map(),
    turnAssistantUuids: [],
    lastReplyId: null,           // the API message id of the newest assistant entry
    error: null,
    retrying: false,
    interrupted: false,
    backgroundTasks: new Map(),  // task id -> { detail, at }: sent to the background, no ending notice yet
    title: null,
    cwd: null,
    // Used to tell whether an SSH session's copied transcript has caught up with the desktop index.
    lastStampAt: 0,              // newest timestamp in the file, on the clock of the machine that wrote it
    lastUserAt: 0,               // newest user entry (a prompt, a tool result or a meta message)
    seenAssistants: new Set(),   // recent assistant message uuids, oldest first
  };
}

function timeOf(entry) {
  const t = Date.parse(entry.timestamp);
  return Number.isFinite(t) ? t : 0;
}

function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((c) => c && c.type === 'text' && typeof c.text === 'string')
    .map((c) => c.text)
    .join('\n');
}

function oneLine(text, max = 90) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function describeTool(name, input) {
  const i = input && typeof input === 'object' ? input : {};
  const file = (p) => (typeof p === 'string' && p ? path.basename(p.replace(/\\/g, '/')) : '');
  switch (name) {
    case 'Bash':
    case 'PowerShell':
      return oneLine(i.description || i.command || 'Running a command', 60);
    case 'Read':
      return `Reading ${file(i.file_path) || 'a file'}`;
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return `Editing ${file(i.file_path || i.notebook_path) || 'a file'}`;
    case 'Write':
      return `Writing ${file(i.file_path) || 'a file'}`;
    case 'Grep':
    case 'Glob':
      return oneLine(`Searching ${i.pattern ?? ''}`, 60);
    case 'WebSearch':
      return oneLine(`Searching the web: ${i.query ?? ''}`, 60);
    case 'WebFetch':
      try {
        return `Reading ${new URL(i.url).hostname}`;
      } catch {
        return 'Reading a web page';
      }
    case 'Agent':
    case 'Task':
      return oneLine(i.description ? `Agent: ${i.description}` : 'Running an agent', 60);
    case 'Monitor':
      return oneLine(i.description ? `Watching ${i.description}` : 'Watching a command', 60);
    case 'AskUserQuestion': {
      const q = Array.isArray(i.questions) ? i.questions[0]?.question : null;
      return oneLine(q || 'Has a question for you');
    }
    case 'ExitPlanMode':
      return 'Plan ready for your review';
    case 'TodoWrite':
    case 'TaskCreate':
    case 'TaskUpdate':
      return 'Updating the task list';
    default:
      if (typeof name === 'string' && name.startsWith('mcp__')) {
        return oneLine(name.split('__').slice(2).join(' ').replace(/_/g, ' ') || name, 60);
      }
      return oneLine(name || 'Working', 60);
  }
}

// What Claude is waiting on when the app asks you about tool `name`: a question, a plan, or
// permission to use any other tool.
function describeAsk(name) {
  if (WAITING_TOOLS.has(name)) return describeTool(name, {});
  const tool = typeof name === 'string' && name.startsWith('mcp__') ? describeTool(name, {}) : name;
  return oneLine(`Asking to use ${tool || 'a tool'}`, 60);
}

function startTurn(state, at) {
  if (!state.turnActive) {
    state.turnStartedAt = at;
    state.turnAssistantUuids = [];
  }
  state.turnActive = true;
  state.error = null;
  state.retrying = false;
  state.interrupted = false;
}

function endTurn(state, at, { interrupted = false } = {}) {
  state.turnActive = false;
  state.turnEndedAt = at || state.lastEventAt;
  state.pendingTools.clear();
  state.retrying = false;
  state.interrupted = interrupted;
}

// The id of the task a tool result says went to the background, or null: a command (also one
// that ran past its timeout), an agent or a workflow, or a Monitor (unless it watches for the
// whole session, which would never finish). `result` is the entry's structured toolUseResult;
// `call` is the pending tool call it answers.
function launchedTask(result, call) {
  if (!result || typeof result !== 'object') return null;
  if (result.backgroundTaskId) return String(result.backgroundTaskId);
  if (result.status === 'async_launched') return String(result.agentId || result.taskId || '') || null;
  if (call?.name === 'Monitor' && result.taskId && !result.persistent) return String(result.taskId);
  return null;
}

function startBackgroundTask(state, id, task) {
  state.backgroundTasks.delete(id);
  state.backgroundTasks.set(id, task);
  if (state.backgroundTasks.size > MAX_BACKGROUND_TASKS) state.backgroundTasks.delete(state.backgroundTasks.keys().next().value);
}

// A finished task reports back in a <task-notification> that reaches the transcript as the next
// prompt, or, if a turn is running, as a queued_command attachment. (A monitor's progress notices
// carry no <status>: the task goes on.)
function endBackgroundTasks(state, text) {
  if (!state.backgroundTasks.size || !text.includes('<task-notification>')) return;
  for (const [, notice] of text.matchAll(/<task-notification>([\s\S]*?)<\/task-notification>/g)) {
    const id = /<task-id>([\w-]+)<\/task-id>/.exec(notice)?.[1];
    const status = /<status>(\w+)<\/status>/.exec(notice)?.[1];
    if (id && TASK_ENDED.has(status)) state.backgroundTasks.delete(id);
  }
}

function applyEntry(state, entry) {
  if (!entry || typeof entry !== 'object') return;
  const at = timeOf(entry);
  if (at > state.lastStampAt) state.lastStampAt = at;
  if (entry.isSidechain) return;
  if (entry.cwd && typeof entry.cwd === 'string') state.cwd = entry.cwd;

  switch (entry.type) {
    case 'custom-title':
      if (typeof entry.customTitle === 'string') state.title = entry.customTitle;
      return;
    case 'summary':
      if (typeof entry.summary === 'string' && !state.title) state.title = entry.summary;
      return;
    case 'user':
      applyUser(state, entry, at);
      return;
    case 'assistant':
      applyAssistant(state, entry, at);
      return;
    case 'attachment':
      if (entry.attachment?.type === 'queued_command' && typeof entry.attachment.prompt === 'string') {
        endBackgroundTasks(state, entry.attachment.prompt);
      }
      return;
    case 'system':
      applySystem(state, entry, at);
      return;
    default:
      return;
  }
}

function applyUser(state, entry, at) {
  if (at > state.lastUserAt) state.lastUserAt = at;
  const content = entry.message?.content;
  if (typeof content === 'string') endBackgroundTasks(state, content);
  if (entry.isMeta || entry.isCompactSummary || entry.isVisibleInTranscriptOnly) return;
  if (at) state.lastEventAt = Math.max(state.lastEventAt, at);

  if (Array.isArray(content) && content.some((c) => c?.type === 'tool_result')) {
    let interrupted = false;
    // One entry holds one result, so its structured toolUseResult says what the call did.
    const single = content.filter((c) => c?.type === 'tool_result').length === 1;
    for (const c of content) {
      if (c?.type !== 'tool_result') continue;
      const call = state.pendingTools.get(c.tool_use_id);
      const task = launchedTask(single ? entry.toolUseResult : null, call);
      if (task) startBackgroundTask(state, task, { detail: call?.detail || 'a task', at });
      state.pendingTools.delete(c.tool_use_id);
      // Only at the start: a tool's output can contain these words (say, a file that mentions them).
      if (/^\s*\[Request interrupted by user/.test(textOf(c.content))) interrupted = true;
    }
    if (interrupted) {
      endTurn(state, at, { interrupted: true });
      return;
    }
    // A tool result means a turn is in flight, even if we started reading mid-turn.
    if (!state.turnActive && at > state.turnEndedAt) startTurn(state, at);
    return;
  }

  const text = textOf(content);
  if (/^\s*\[Request interrupted by user/.test(text)) {
    endTurn(state, at, { interrupted: true });
    return;
  }
  // Local slash commands (/config, /clear, …) echo into the transcript without a model turn.
  if (/<local-command-(stdout|stderr|caveat)>|^\s*<command-name>/.test(text)) return;
  if (!text.trim() && !(Array.isArray(content) && content.length)) return;
  startTurn(state, at);
}

function applyAssistant(state, entry, at) {
  const msg = entry.message || {};
  if (at) state.lastEventAt = Math.max(state.lastEventAt, at);
  // Each block of a reply (thinking, text, tool calls) is an entry of its own, and every one of
  // them carries the reply's stop_reason, so an earlier block of this reply may have ended the
  // turn too soon. Then the turn goes on, and ends again below if this block ends it too.
  if (!state.turnActive) {
    if (msg.id && msg.id === state.lastReplyId) state.turnActive = true;
    else startTurn(state, at);
  }
  state.lastReplyId = msg.id || null;
  if (entry.uuid) {
    state.turnAssistantUuids.push(entry.uuid);
    if (state.turnAssistantUuids.length > MAX_TURN_UUIDS) state.turnAssistantUuids.shift();
    state.seenAssistants.add(entry.uuid);
    if (state.seenAssistants.size > MAX_SEEN_ASSISTANTS) state.seenAssistants.delete(state.seenAssistants.values().next().value);
  }
  state.retrying = false;

  if (entry.isApiErrorMessage) {
    state.error = { message: oneLine(textOf(msg.content) || 'API error', 120), at };
  }
  if (Array.isArray(msg.content)) {
    for (const c of msg.content) {
      if (c?.type === 'tool_use' && c.id) {
        state.pendingTools.set(c.id, { name: c.name, detail: describeTool(c.name, c.input), at });
      }
    }
  }
  if (END_STOP_REASONS.has(msg.stop_reason) && state.pendingTools.size === 0) {
    endTurn(state, at);
  }
}

function applySystem(state, entry, at) {
  switch (entry.subtype) {
    case 'stop_hook_summary':
    case 'turn_duration':
      if (state.turnActive) endTurn(state, at);
      else if (at > state.turnEndedAt && state.turnEndedAt) state.turnEndedAt = at;
      return;
    case 'api_error':
      if (at) state.lastEventAt = Math.max(state.lastEventAt, at);
      state.retrying = true;
      return;
    default:
      return;
  }
}

// meta: { lastFocusedAt, dismissedAt, summary: postTurnSummary from the desktop session file }
function deriveStatus(state, meta = {}, now = Date.now()) {
  const derived = turnStatus(state, meta, now);
  // Between the turn that starts a background task and the one its notice starts, Claude isn't
  // working but the task is. That's still running, seen or not. A question, an error or a stale
  // turn (its session is gone, and its tasks with it) still show as they are.
  if (state.turnActive || (derived.status !== 'review' && derived.status !== 'idle')) return derived;
  const tasks = [...state.backgroundTasks.values()].filter((t) => now - t.at < STALE_BACKGROUND_MS);
  if (!tasks.length) return derived;
  return {
    status: 'running',
    detail: tasks.length === 1 ? `In the background: ${tasks[0].detail}` : `${tasks.length} background tasks`,
    since: Math.min(...tasks.map((t) => t.at)),
  };
}

function turnStatus(state, meta, now) {
  const pending = [...state.pendingTools.values()];
  const asking = pending.find((t) => WAITING_TOOLS.has(t.name));
  if (asking && !(meta.dismissedAt >= asking.at)) {   // dismissed, it shows as the running turn it is
    return { status: 'waiting', detail: asking.detail, since: asking.at };
  }

  if (state.turnActive) {
    if (now - state.lastEventAt > STALE_RUNNING_MS) return { status: 'idle', detail: '', since: state.lastEventAt };
    const tool = pending.at(-1);
    const detail = state.retrying ? 'Retrying after an API error' : tool ? tool.detail : 'Thinking';
    return { status: 'running', detail, since: state.turnStartedAt };
  }

  const ended = state.turnEndedAt;
  if (!ended || state.interrupted || now - ended > UNREAD_WINDOW_MS) return { status: 'idle', detail: '', since: ended };
  // How the turn ended matters only until you've seen it.
  const seenAt = Math.max(meta.lastFocusedAt || 0, meta.dismissedAt || 0);
  if (ended <= seenAt) return { status: 'idle', detail: '', since: ended };

  if (state.error) return { status: 'failed', detail: state.error.message, since: ended };

  const summary = meta.summary;
  const current = summary && summary.summarizes_uuid && state.turnAssistantUuids.includes(summary.summarizes_uuid) ? summary : null;
  const detail = current ? oneLine(current.needs_action || current.status_detail || '', 120) : '';
  // It ended waiting on your answer or decision (the app's yellow marker).
  if (current && NEEDS_YOU.has(current.status_category)) {
    return { status: 'waiting', detail: detail || 'Needs your decision', since: ended };
  }

  if (current) {
    if (current.status_category === 'failed' || current.status_category === 'error') {
      return { status: 'failed', detail: detail || 'Something went wrong', since: ended };
    }
    return { status: 'review', detail: oneLine(current.status_detail || 'Finished', 120), since: ended };
  }
  return { status: 'review', detail: 'Finished', since: ended };
}

function compareSessions(a, b) {
  const p = STATUS_PRIORITY[a.status] - STATUS_PRIORITY[b.status];
  if (p !== 0) return p;
  return (b.since || 0) - (a.since || 0);
}

module.exports = {
  STATUS_PRIORITY,
  STALE_RUNNING_MS,
  UNREAD_WINDOW_MS,
  applyEntry,
  compareSessions,
  createTurnState,
  deriveStatus,
  describeAsk,
  describeTool,
  oneLine,
};

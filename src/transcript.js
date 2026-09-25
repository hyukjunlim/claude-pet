'use strict';

// Turns Claude Code transcript entries (one JSON object per line of
// ~/.claude/projects/<project>/<session>.jsonl) into a pet status.
//
// Statuses, highest priority first (same order ChatGPT's pet uses):
//   waiting  - Claude is blocked on you (a question, a plan to approve, or the
//              desktop app's end-of-turn summary says it needs a decision)
//   failed   - the turn ended with an API error
//   review   - the turn finished and you haven't looked at it yet
//   running  - a turn is in progress
//   idle     - nothing to report

const path = require('node:path');

const WAITING_TOOLS = new Set(['AskUserQuestion', 'ExitPlanMode']);
const END_STOP_REASONS = new Set(['end_turn', 'stop_sequence', 'max_tokens', 'refusal']);
const STALE_RUNNING_MS = 45 * 60 * 1000;
const UNREAD_WINDOW_MS = 12 * 60 * 60 * 1000;
const MAX_TURN_UUIDS = 64;
const MAX_SEEN_ASSISTANTS = 2000;

const STATUS_PRIORITY = { waiting: 0, failed: 1, review: 2, running: 3, idle: 4 };

function createTurnState() {
  return {
    turnActive: false,
    turnStartedAt: 0,
    turnEndedAt: 0,
    lastEventAt: 0,
    pendingTools: new Map(),
    turnAssistantUuids: [],
    error: null,
    retrying: false,
    interrupted: false,
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
    case 'system':
      applySystem(state, entry, at);
      return;
    default:
      return;
  }
}

function applyUser(state, entry, at) {
  if (at > state.lastUserAt) state.lastUserAt = at;
  if (entry.isMeta || entry.isCompactSummary || entry.isVisibleInTranscriptOnly) return;
  const content = entry.message?.content;
  if (at) state.lastEventAt = Math.max(state.lastEventAt, at);

  if (Array.isArray(content) && content.some((c) => c?.type === 'tool_result')) {
    let interrupted = false;
    for (const c of content) {
      if (c?.type !== 'tool_result') continue;
      state.pendingTools.delete(c.tool_use_id);
      if (/\[Request interrupted by user/.test(textOf(c.content))) interrupted = true;
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
  if (entry.uuid) {
    state.turnAssistantUuids.push(entry.uuid);
    if (state.turnAssistantUuids.length > MAX_TURN_UUIDS) state.turnAssistantUuids.shift();
    state.seenAssistants.add(entry.uuid);
    if (state.seenAssistants.size > MAX_SEEN_ASSISTANTS) state.seenAssistants.delete(state.seenAssistants.values().next().value);
  }
  if (!state.turnActive) startTurn(state, at);
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
  const pending = [...state.pendingTools.values()];
  const asking = pending.find((t) => WAITING_TOOLS.has(t.name));
  if (asking) {
    return { status: 'waiting', detail: asking.detail, since: asking.at };
  }

  if (state.turnActive) {
    if (now - state.lastEventAt > STALE_RUNNING_MS) return { status: 'idle', detail: '', since: state.lastEventAt };
    const tool = pending.at(-1);
    const detail = state.retrying ? 'Retrying after an API error' : tool ? tool.detail : 'Thinking';
    return { status: 'running', detail, since: state.turnStartedAt };
  }

  const ended = state.turnEndedAt;
  if (!ended || state.interrupted || now - ended > UNREAD_WINDOW_MS) {
    return { status: 'idle', detail: '', since: ended };
  }
  const seenAt = Math.max(meta.lastFocusedAt || 0, meta.dismissedAt || 0);
  if (ended <= seenAt) return { status: 'idle', detail: '', since: ended };

  if (state.error) return { status: 'failed', detail: state.error.message, since: ended };

  const summary = meta.summary;
  const summaryIsCurrent = summary && summary.summarizes_uuid && state.turnAssistantUuids.includes(summary.summarizes_uuid);
  if (summaryIsCurrent) {
    const detail = oneLine(summary.needs_action || summary.status_detail || '', 120);
    if (summary.status_category === 'blocked') return { status: 'waiting', detail: detail || 'Needs your decision', since: ended };
    if (summary.status_category === 'failed' || summary.status_category === 'error') {
      return { status: 'failed', detail: detail || 'Something went wrong', since: ended };
    }
    return { status: 'review', detail: oneLine(summary.status_detail || 'Finished', 120), since: ended };
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
  describeTool,
  oneLine,
};

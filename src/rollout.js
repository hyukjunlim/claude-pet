'use strict';

// Turns Codex rollout entries (one JSON object per line of ~/.codex/sessions/…/rollout-*.jsonl)
// into a pet status. Used for rollouts on this PC and for those streamed from SSH hosts.

const { STALE_RUNNING_MS, UNREAD_WINDOW_MS, oneLine } = require('./transcript');

const CLI_REVIEW_MS = 10 * 60 * 1000;            // the CLI has no unread list: "Ready" this long
const DESKTOP_ORIGINATOR_RE = /desktop/i;        // "Codex Desktop", "codex_work_desktop"
const SHELL_RE = /(^|[\\/])(bash|zsh|sh|pwsh|powershell)(\.exe)?$/i;
const CALLS = new Set(['function_call', 'custom_tool_call', 'local_shell_call', 'web_search_call']);
const CALL_OUTPUTS = new Set(['function_call_output', 'custom_tool_call_output']);
const QUESTIONS = new Set(['exec_approval_request', 'apply_patch_approval_request', 'request_user_input', 'elicitation_request']);

function createRolloutState() {
  return {
    threadId: null,
    cwd: null,
    subagent: false,       // Codex's own helper threads (e.g. the auto-reviewer)
    fromDesktop: false,
    turnActive: false,
    turnStartedAt: 0,
    turnEndedAt: 0,
    lastEventAt: 0,
    step: '',
    lastMessage: '',
    aborted: false,
    error: null,
    question: null,
  };
}

const fromSeconds = (v) => (Number.isFinite(v) && v > 0 ? v * 1000 : 0);

function applyRolloutEntry(state, entry) {
  if (!entry || typeof entry !== 'object') return;
  const at = Date.parse(entry.timestamp) || 0;
  if (at > state.lastEventAt) state.lastEventAt = at;
  const p = entry.payload && typeof entry.payload === 'object' ? entry.payload : {};
  if (entry.type === 'session_meta') {
    if (typeof p.id === 'string') state.threadId = p.id;
    if (typeof p.cwd === 'string') state.cwd = p.cwd;
    state.subagent = Boolean(p.source && typeof p.source === 'object' && p.source.subagent);
    state.fromDesktop = DESKTOP_ORIGINATOR_RE.test(String(p.originator || ''));
    return;
  }
  if (entry.type === 'response_item') {
    if (CALL_OUTPUTS.has(p.type)) state.question = null;
    if (state.turnActive && CALLS.has(p.type)) state.step = describeCall(p);
    return;
  }
  if (entry.type !== 'event_msg') return;
  switch (p.type) {
    case 'task_started':
      Object.assign(state, {
        turnActive: true, turnStartedAt: fromSeconds(p.started_at) || at, step: '', aborted: false, error: null, question: null,
      });
      return;
    case 'task_complete':
      Object.assign(state, {
        turnActive: false,
        turnEndedAt: fromSeconds(p.completed_at) || at,
        lastMessage: typeof p.last_agent_message === 'string' ? p.last_agent_message : '',
        question: null,
      });
      return;
    case 'turn_aborted':
      Object.assign(state, { turnActive: false, turnEndedAt: at, aborted: true, question: null });
      return;
    case 'error':
      Object.assign(state, {
        turnActive: false, turnEndedAt: at, question: null, error: { message: oneLine(p.message || 'Something went wrong', 120) },
      });
      return;
    case 'exec_command_begin':
      state.question = null;
      if (state.turnActive) state.step = describeCommand(p.command);
      return;
    default:
      if (QUESTIONS.has(p.type) && state.turnActive) state.question = { detail: describeQuestion(p), at };
  }
}

function describeCommand(cmd) {
  let parts = Array.isArray(cmd) ? cmd.map(String) : typeof cmd === 'string' ? [cmd] : [];
  // ["bash", "-lc", "npm test"] -> "npm test"
  if (parts.length >= 3 && SHELL_RE.test(parts[0]) && /^-(l?c|Command)$/i.test(parts[1])) parts = parts.slice(2);
  return oneLine(parts.join(' ') || 'Running a command', 60);
}

function describeCall(p) {
  if (p.type === 'local_shell_call') return describeCommand(p.action?.command);
  if (p.type === 'web_search_call') return 'Searching the web';
  let args = p.arguments;
  if (typeof args === 'string') {
    try {
      args = JSON.parse(args);
    } catch {
      args = {};
    }
  }
  if (!args || typeof args !== 'object') args = {};
  const name = String(p.name || '');
  if (/^(shell|shell_command|exec_command|container\.exec)$/.test(name)) return describeCommand(args.command ?? args.cmd);
  if (name === 'apply_patch') return 'Editing files';
  if (name === 'update_plan') return 'Updating the plan';
  if (name === 'view_image') return 'Looking at an image';
  return oneLine(name.replace(/^mcp__/, '').replace(/__/g, ' ').replace(/_/g, ' ') || 'Working', 60);
}

function describeQuestion(p) {
  if (p.type === 'exec_approval_request') return oneLine(`Approve: ${describeCommand(p.command)}`, 90);
  if (p.type === 'apply_patch_approval_request') return 'Approve file changes';
  const q = Array.isArray(p.questions) ? p.questions[0]?.question : p.message;
  return oneLine(q || 'Has a question for you', 90);
}

// Threads from the desktop app are "Ready" while the app lists them as unread. CLI threads,
// which it doesn't track, are "Ready" for a few minutes after they finish. `skew` is how far
// the clock of the machine that wrote the rollout is ahead of ours.
function rolloutStatus(state, { now = Date.now(), unread = false, dismissedAt = 0, skew = 0 } = {}) {
  const clock = now + skew;
  const seen = dismissedAt ? dismissedAt + skew : 0;
  const local = (d) => (d.since ? { ...d, since: d.since - skew } : d);
  if (state.question) return local({ status: 'waiting', detail: state.question.detail, since: state.question.at });
  if (state.turnActive) {
    if (clock - state.lastEventAt > STALE_RUNNING_MS) return local({ status: 'idle', detail: '', since: state.lastEventAt });
    return local({ status: 'running', detail: state.step || 'Thinking', since: state.turnStartedAt });
  }
  const ended = state.turnEndedAt;
  const idle = local({ status: 'idle', detail: '', since: ended });
  if (!ended || state.aborted || ended <= seen || clock - ended > UNREAD_WINDOW_MS) return idle;
  if (state.fromDesktop ? !unread : clock - ended > CLI_REVIEW_MS) return idle;
  if (state.error) return local({ status: 'failed', detail: state.error.message, since: ended });
  return local({ status: 'review', detail: oneLine(state.lastMessage, 120) || 'Finished', since: ended });
}

module.exports = { applyRolloutEntry, createRolloutState, describeCall, describeCommand, rolloutStatus };

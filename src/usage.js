'use strict';

// How much of this week's usage your Claude and Codex plans have used, from what the two apps
// keep on this PC.
//
//   - Claude: the desktop app samples your plan's usage every 15 minutes into
//     <appData>/Claude/plan-usage-history.json: { samples: [{ t, org, u: { fh, sd } }] }, with the
//     5-hour (fh) and weekly (sd) windows in percent. It doesn't keep when they reset, but the
//     weekly one resets at the same time every week (see withWeeklyResets).
//   - Codex: each reply's token_count event in a rollout carries the account's rate limits,
//     { primary, secondary: { used_percent, window_minutes, resets_at } }. Which of the two is the
//     weekly window depends on the plan.

const DAY_MINUTES = 24 * 60;
const WEEK_MINUTES = 7 * DAY_MINUTES;
const WEEK_MS = WEEK_MINUTES * 60_000;
const FIVE_HOURS_MS = 5 * 60 * 60_000;
const CLAUDE_STALE_MS = 60 * 60 * 1000;   // no sample for this long: the desktop app isn't running

// The newest sample that has the weekly figure: { weekly, fiveHour, at }, each window
// { percent, resetsAt, windowMs }.
function parseClaudeUsage(j) {
  let newest = null;
  for (const s of Array.isArray(j?.samples) ? j.samples : []) {
    const u = s?.u;
    if (!Number.isFinite(u?.sd) || !Number.isFinite(s.t) || (newest && s.t <= newest.at)) continue;
    newest = {
      weekly: { percent: u.sd, resetsAt: null, windowMs: WEEK_MS },
      fiveHour: Number.isFinite(u.fh) ? { percent: u.fh, resetsAt: null, windowMs: FIVE_HOURS_MS } : null,
      at: s.t,
    };
  }
  return newest;
}

// A token_count event's rate_limits, for a reply at `at`: { weekly, fiveHour }, each
// { percent, resetsAt, windowMs } or null. Older Codex versions give resets_in_seconds instead of
// resets_at, and may leave out window_minutes (then primary is the 5-hour window, secondary the
// weekly one).
function parseRateLimits(r, at) {
  if (!r || typeof r !== 'object' || (r.limit_id != null && r.limit_id !== 'codex')) return null;
  const out = { weekly: null, fiveHour: null };
  for (const [w, minutesIfUnsaid] of [[r.primary, 300], [r.secondary, WEEK_MINUTES]]) {
    if (!Number.isFinite(w?.used_percent)) continue;
    const minutes = Number.isFinite(w.window_minutes) ? w.window_minutes : minutesIfUnsaid;
    const resetsAt = Number.isFinite(w.resets_at) ? w.resets_at * 1000
      : Number.isFinite(w.resets_in_seconds) && at ? at + w.resets_in_seconds * 1000 : null;
    const window = { percent: w.used_percent, resetsAt, windowMs: minutes * 60_000 };
    if (minutes >= WEEK_MINUTES - DAY_MINUTES) out.weekly = window;
    else if (minutes <= DAY_MINUTES) out.fiveHour = window;
  }
  return out.weekly || out.fiveHour ? out : null;
}

// Claude's weekly limit resets at the same time every week, a time set for your account (Claude
// shows it in Settings > Usage). The desktop app doesn't save it anywhere the pet can read, so
// you pick it in the tray menu once. `anchor` is any one of those resets; it gives them all.
function withWeeklyResets(u, anchor) {
  if (!u?.weekly || !Number.isFinite(anchor)) return u;
  return { ...u, weekly: { ...u.weekly, resetsAt: nextWeeklyReset(anchor, u.at), repeats: true } };
}

// The first reset after `t` of a limit that resets every week, `anchor` being one of its resets.
function nextWeeklyReset(anchor, t) {
  return anchor + (Math.floor((t - anchor) / WEEK_MS) + 1) * WEEK_MS;
}

// The next time it's `hour`:00 on weekday `day` (0 is Sunday), on this PC's clock.
function nextLocalTime(day, hour, now = Date.now()) {
  const t = new Date(now);
  t.setHours(hour, 0, 0, 0);
  t.setDate(t.getDate() + ((day - t.getDay() + 7) % 7));
  if (t.getTime() <= now) t.setDate(t.getDate() + 7);
  return t.getTime();
}

// What the pet shows: each app's weekly limit, [{ app, name, percent, elapsed, resetsIn, stale }].
// `percent` is how much of the limit is used and `elapsed` how much of the week has gone by, so
// using more than `elapsed` means you'd run out before the reset. Without a known reset time,
// `elapsed` and `resetsIn` are null.
function usageView({ claude = null, codex = null } = {}, now = Date.now()) {
  const out = [];
  const pct = (n) => Math.round(Math.min(100, Math.max(0, n)));
  for (const [app, name, u] of [['claude', 'Claude', claude], ['codex', 'Codex', codex]]) {
    const w = u?.weekly;
    if (!w || !Number.isFinite(w.percent)) continue;
    const reset = w.resetsAt != null && w.resetsAt <= now;   // a new week began since these figures
    const next = reset && w.repeats ? nextWeeklyReset(w.resetsAt, now) : w.resetsAt;
    const known = next != null && next > now;   // (a Codex week starts with its first reply)
    out.push({
      app,
      name,
      percent: reset ? 0 : pct(w.percent),
      elapsed: known && w.windowMs > 0 ? pct(100 - ((next - now) / w.windowMs) * 100) : null,
      resetsIn: known ? formatDuration(next - now) : null,
      // Claude's figures only change while the desktop app runs; Codex's come with each reply.
      stale: app === 'claude' && now - u.at > CLAUDE_STALE_MS,
    });
  }
  return out;
}

// "2d 5h", "5h", "40m"
function formatDuration(ms) {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  const days = Math.floor(minutes / DAY_MINUTES);
  const hours = Math.floor((minutes % DAY_MINUTES) / 60);
  if (days) return hours ? `${days}d ${hours}h` : `${days}d`;
  return hours ? `${hours}h` : `${minutes}m`;
}

module.exports = {
  formatDuration, nextLocalTime, nextWeeklyReset, parseClaudeUsage, parseRateLimits, usageView, withWeeklyResets,
};

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  formatDuration, nextLocalTime, nextWeeklyReset, parseClaudeUsage, parseRateLimits, usageView, withWeeklyResets,
} = require('../src/usage');

const T0 = Date.parse('2026-09-25T04:00:00.000Z');
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

test("Claude's figures are the desktop app's newest usage sample", () => {
  const u = parseClaudeUsage({
    version: 2,
    samples: [
      { t: T0 - 2 * HOUR, org: 'org-a', u: { fh: 30, sd: 60 } },
      { t: T0 - HOUR, org: 'org-a', u: { fh: 5, sd: 61 } },
      { t: T0, org: 'org-b', u: {} },     // no figures, e.g. right after signing in
    ],
  });
  assert.deepEqual(u, {
    weekly: { percent: 61, resetsAt: null, windowMs: WEEK }, fiveHour: { percent: 5, resetsAt: null, windowMs: 5 * HOUR }, at: T0 - HOUR,
  });
  assert.equal(parseClaudeUsage(null), null);
  assert.equal(parseClaudeUsage({ samples: 'no' }), null);
});

test("Codex's weekly limit is the window that lasts a week, in whichever slot it comes", () => {
  const reset = T0 / 1000 + 2 * 86_400;
  // A plan with only a weekly limit
  assert.deepEqual(
    parseRateLimits({ limit_id: 'codex', primary: { used_percent: 99, window_minutes: 10080, resets_at: reset }, secondary: null }, T0),
    { weekly: { percent: 99, resetsAt: reset * 1000, windowMs: WEEK }, fiveHour: null },
  );
  // One with a 5-hour limit as well
  assert.deepEqual(
    parseRateLimits({
      primary: { used_percent: 12, window_minutes: 300, resets_at: T0 / 1000 + 3600 },
      secondary: { used_percent: 40, window_minutes: 10080, resets_at: reset },
    }, T0),
    { weekly: { percent: 40, resetsAt: reset * 1000, windowMs: WEEK }, fiveHour: { percent: 12, resetsAt: T0 + HOUR, windowMs: 5 * HOUR } },
  );
  // Older Codex: no window lengths, and the resets counted from the reply
  assert.deepEqual(
    parseRateLimits({ primary: { used_percent: 12, resets_in_seconds: 600 }, secondary: { used_percent: 40, resets_in_seconds: 86_400 } }, T0),
    { weekly: { percent: 40, resetsAt: T0 + DAY, windowMs: WEEK }, fiveHour: { percent: 12, resetsAt: T0 + 10 * MINUTE, windowMs: 5 * HOUR } },
  );
  // Another limit's figures, or none
  assert.equal(parseRateLimits({ limit_id: 'other', primary: { used_percent: 5, window_minutes: 10080 } }, T0), null);
  assert.equal(parseRateLimits(null, T0), null);
});

test('the pet shows how much of each weekly limit is used, and how far into the week it is', () => {
  const claude = { weekly: { percent: 67.6, resetsAt: null, windowMs: WEEK }, fiveHour: null, at: T0 - 10 * MINUTE };
  const codex = { weekly: { percent: 99, resetsAt: T0 + 2 * DAY + 5 * HOUR, windowMs: WEEK }, fiveHour: null, at: T0 - DAY };
  assert.deepEqual(usageView({ claude, codex }, T0), [
    { app: 'claude', name: 'Claude', percent: 68, elapsed: null, resetsIn: null, stale: false },   // no reset time set
    { app: 'codex', name: 'Codex', percent: 99, elapsed: 68, resetsIn: '2d 5h', stale: false },    // 4d 19h of 7d gone
  ]);
  // Three days on, Codex's week has turned over (the next one starts with its next reply), and
  // Claude's figures are old (the desktop app is closed).
  assert.deepEqual(usageView({ claude, codex }, T0 + 3 * DAY), [
    { app: 'claude', name: 'Claude', percent: 68, elapsed: null, resetsIn: null, stale: true },
    { app: 'codex', name: 'Codex', percent: 0, elapsed: null, resetsIn: null, stale: false },
  ]);
  assert.deepEqual(usageView({ claude: null, codex: { weekly: null, fiveHour: { percent: 3, resetsAt: null }, at: T0 } }, T0), []);
});

test("one of Claude's weekly resets gives them all", () => {
  const anchor = T0 + 2 * DAY + 5 * HOUR - 3 * WEEK;   // three weeks back; the next is in 2d 5h
  assert.equal(nextWeeklyReset(anchor, T0), T0 + 2 * DAY + 5 * HOUR);
  assert.equal(nextWeeklyReset(anchor + 10 * WEEK, T0), T0 + 2 * DAY + 5 * HOUR, 'or ahead');
  const claude = { weekly: { percent: 69, resetsAt: null, windowMs: WEEK }, fiveHour: null, at: T0 - 10 * MINUTE };
  const [now] = usageView({ claude: withWeeklyResets(claude, anchor) }, T0);
  assert.deepEqual([now.percent, now.elapsed, now.resetsIn], [69, 68, '2d 5h']);
  // After the reset, and before the desktop app's next sample: a fresh week.
  const [later] = usageView({ claude: withWeeklyResets(claude, anchor) }, T0 + 2 * DAY + 5 * HOUR + 1000);
  assert.deepEqual([later.percent, later.elapsed, later.resetsIn], [0, 0, '7d']);
  // Without a reset time, there's no telling how far into the week it is.
  assert.equal(usageView({ claude: withWeeklyResets(claude, null) }, T0)[0].elapsed, null);
});

test('a weekday and hour picked in the menu become the next such time', () => {
  const friday6pm = new Date(2026, 8, 25, 18, 0).getTime();   // on this PC's clock
  assert.equal(nextLocalTime(3, 11, friday6pm), new Date(2026, 8, 30, 11, 0).getTime());  // Wednesday 11:00
  assert.equal(nextLocalTime(5, 20, friday6pm), new Date(2026, 8, 25, 20, 0).getTime());  // later today
  assert.equal(nextLocalTime(5, 9, friday6pm), new Date(2026, 9, 2, 9, 0).getTime());     // earlier today: next week
});

test('reset times read as the time left', () => {
  assert.equal(formatDuration(2 * DAY + 5 * HOUR + 10 * MINUTE), '2d 5h');
  assert.equal(formatDuration(3 * DAY), '3d');
  assert.equal(formatDuration(5 * HOUR + 20 * MINUTE), '5h');
  assert.equal(formatDuration(40 * MINUTE), '40m');
  assert.equal(formatDuration(10_000), '1m');
});

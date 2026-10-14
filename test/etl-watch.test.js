'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { diff, priorityOf, resetTokenExpired, MAX_SEEN_ANNOUNCEMENTS, TOKEN_SETTINGS_URL } = require('../src/etl/watch');

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const T0 = Date.parse('2026-10-14T03:00:00.000Z');   // 12:00 KST
const iso = (ms) => new Date(ms).toISOString();
const COURSE = { id: 100001, name: '공학 세미나' };
const OTHER = { id: 401, name: '미적분학학' };

const assignment = (id, extra = {}) => ({
  id,
  name: `과제 ${id}`,
  published: true,
  due_at: iso(T0 + 5 * DAY),
  points_possible: 10,
  submission_types: ['online_upload'],
  html_url: `https://myetl.snu.ac.kr/courses/${COURSE.id}/assignments/${id}`,
  submission: { workflow_state: 'unsubmitted', submitted_at: null },
  ...extra,
});
const graded = (score) => ({ workflow_state: 'graded', submitted_at: iso(T0 - DAY), score });
const announcement = (id, extra = {}) => ({
  id,
  title: `공지 ${id}`,
  message: '<p>다음 주 <b>휴강</b>입니다.</p>',
  posted_at: iso(T0 - HOUR),
  context_code: `course_${COURSE.id}`,
  html_url: `https://myetl.snu.ac.kr/courses/${COURSE.id}/discussion_topics/${id}`,
  ...extra,
});
const snap = (assignments = [], { announcements = [], errors = [], course = COURSE, more = [] } = {}) => ({
  unauthorized: false,
  results: [{ course, assignments }, ...more],
  errors,
  announcements,
});
// The state after a first check of `assignments`, so the next diff isn't a first run.
const baseline = (assignments = [], opts) => diff(null, snap(assignments, opts), T0 - DAY).state;
const ids = (alerts) => alerts.map((a) => a.id);

test('the first check records everything and only says it is connected, with the count of open assignments', () => {
  const list = [
    assignment(1),
    assignment(2, { due_at: iso(T0 + 2 * DAY) }),
    assignment(3, { submission: { workflow_state: 'submitted', submitted_at: iso(T0) } }),
    assignment(4, { submission_types: ['on_paper'] }),
    assignment(5, { due_at: iso(T0 - DAY) }),
  ];
  const { state, alerts } = diff(null, snap(list, { announcements: [announcement(77)] }), T0);
  assert.deepEqual(ids(alerts), ['etl:connected']);
  const [connected] = alerts;
  assert.equal(connected.title, '마감 전 미제출 2건');
  assert.equal(connected.badge, 'eTL 연결됨');
  assert.equal(connected.kind, 'etl');
  assert.equal(connected.status, 'review');
  assert.match(connected.project, /과제 2/);              // the nearest due time comes first
  assert.equal(connected.since, T0);
  assert.equal(connected.expiresAt, T0 + 3 * DAY);
  assert.equal(state.initialized, true);
  assert.deepEqual(Object.keys(state.assignments).sort(), ['100001:1', '100001:2', '100001:3', '100001:4', '100001:5']);
  assert.deepEqual(state.announcementsSeen, ['77']);
});

test('the first check still reminds about a deadline that is already close', () => {
  const { alerts } = diff(null, snap([assignment(1, { due_at: iso(T0 + 2 * HOUR) })]), T0);
  assert.deepEqual(ids(alerts), ['etl:remind3h:100001:1', 'etl:connected']);
});

test('an assignment not seen before is announced as new, with its course and due time', () => {
  const state = baseline([assignment(1)]);
  const { alerts } = diff(state, snap([assignment(1), assignment(2, { name: '6주차 보고서 제출' })]), T0);
  assert.deepEqual(ids(alerts), ['etl:new:100001:2']);
  const [a] = alerts;
  assert.equal(a.badge, '새 과제');
  assert.equal(a.status, 'review');
  assert.equal(a.title, '6주차 보고서 제출');
  assert.equal(a.project, '5일 0시간 남음 · 공학 세미나');
  assert.match(a.detail, /^공학 세미나 · 마감 2026-10-19\(월\) 12:00 \(5일 0시간 남음\)$/);
  assert.equal(a.url, 'https://myetl.snu.ac.kr/courses/100001/assignments/2');
  assert.equal(a.expiresAt, T0 + 3 * DAY);
});

test('unpublished assignments are ignored', () => {
  const state = baseline([]);
  const { state: next, alerts } = diff(state, snap([assignment(9, { published: false })]), T0);
  assert.deepEqual(alerts, []);
  assert.equal(next.assignments['100001:9'], undefined);
});

test('a changed due time shows the old and the new time', () => {
  const state = baseline([assignment(1)]);
  const due = T0 + 7 * DAY;
  const { alerts } = diff(state, snap([assignment(1, { due_at: iso(due) })]), T0);
  assert.deepEqual(ids(alerts), [`etl:due:100001:1:${due}`]);
  assert.equal(alerts[0].badge, '마감 변경');
  assert.match(alerts[0].project, /2026-10-19\(월\) 12:00 → 2026-10-21\(수\) 12:00/);
  assert.match(alerts[0].detail, /→/);
});

test('a due time that is removed or added reads "없음" on that side', () => {
  const state = baseline([assignment(1)]);
  const removed = diff(state, snap([assignment(1, { due_at: null })]), T0);
  assert.deepEqual(ids(removed.alerts), ['etl:due:100001:1:none']);
  assert.match(removed.alerts[0].detail, /→ 없음$/);
  const added = diff(removed.state, snap([assignment(1, { due_at: iso(T0 + 10 * HOUR) })]), T0);
  assert.match(added.alerts.find((a) => a.id.startsWith('etl:due:')).detail, /없음 →/);
});

test('pushing a deadline back clears its reminders, so they come again for the new time', () => {
  let state = baseline([assignment(1)]);
  ({ state } = diff(state, snap([assignment(1, { due_at: iso(T0 + 20 * HOUR) })]), T0));
  assert.deepEqual(state.assignments['100001:1'].reminded, ['24h']);
  // Extended by two days: the 24-hour reminder is due again a day before the new time.
  const extended = iso(T0 + 68 * HOUR);
  ({ state } = diff(state, snap([assignment(1, { due_at: extended })]), T0 + HOUR));
  assert.deepEqual(state.assignments['100001:1'].reminded, []);
  const { alerts } = diff(state, snap([assignment(1, { due_at: extended })]), T0 + 46 * HOUR);
  assert.deepEqual(ids(alerts), ['etl:remind24h:100001:1']);
});

test('moving a deadline earlier keeps the reminders already sent', () => {
  let state = baseline([assignment(1, { due_at: iso(T0 + 20 * HOUR) })]);
  ({ state } = diff(state, snap([assignment(1, { due_at: iso(T0 + 20 * HOUR) })]), T0));
  ({ state } = diff(state, snap([assignment(1, { due_at: iso(T0 + 10 * HOUR) })]), T0));
  assert.deepEqual(state.assignments['100001:1'].reminded, ['24h']);
});

test('the 24-hour, 3-hour and 1-hour reminders come once each', () => {
  const a = assignment(1, { due_at: iso(T0 + 30 * HOUR) });
  let state = baseline([a]);
  let alerts;
  ({ state, alerts } = diff(state, snap([a]), T0));
  assert.deepEqual(alerts, []);                                      // 30 hours left
  ({ state, alerts } = diff(state, snap([a]), T0 + 8 * HOUR));       // 22 hours left
  assert.deepEqual(ids(alerts), ['etl:remind24h:100001:1']);
  assert.equal(alerts[0].status, 'waiting');
  assert.equal(alerts[0].badge, '마감 임박');
  assert.equal(alerts[0].project, '22시간 0분 남음 · 공학 세미나');
  assert.equal(alerts[0].expiresAt, T0 + 30 * HOUR);
  ({ state, alerts } = diff(state, snap([a]), T0 + 9 * HOUR));
  assert.deepEqual(alerts, []);
  ({ state, alerts } = diff(state, snap([a]), T0 + 28 * HOUR));      // 2 hours left
  assert.deepEqual(ids(alerts), ['etl:remind3h:100001:1']);
  assert.equal(alerts[0].expiresAt, T0 + 30 * HOUR);
  ({ state, alerts } = diff(state, snap([a]), T0 + 28.5 * HOUR));
  assert.deepEqual(alerts, []);
  ({ state, alerts } = diff(state, snap([a]), T0 + 29.5 * HOUR));    // 30 minutes left
  assert.deepEqual(ids(alerts), ['etl:remind1h:100001:1']);
  assert.equal(alerts[0].project, '30분 남음 · 공학 세미나');
  assert.equal(alerts[0].dueAt, T0 + 30 * HOUR);
  ({ state, alerts } = diff(state, snap([a]), T0 + 29.75 * HOUR));
  assert.deepEqual(alerts, []);
});

test('a deadline first seen two hours out gets only the 3-hour reminder, and the 24-hour one counts as sent', () => {
  const state = baseline([]);
  const a = assignment(1, { due_at: iso(T0 + 2 * HOUR) });
  const first = diff(state, snap([a]), T0);
  assert.deepEqual(ids(first.alerts), ['etl:remind3h:100001:1', 'etl:new:100001:1']);
  assert.deepEqual(first.state.assignments['100001:1'].reminded, ['24h', '3h']);
  assert.deepEqual(diff(first.state, snap([a]), T0 + 0.5 * HOUR).alerts, []);
});

test('no reminders for work handed in, on paper, or past its due time', () => {
  const soon = iso(T0 + 2 * HOUR);
  const list = [
    assignment(1, { due_at: soon, submission: { workflow_state: 'submitted', submitted_at: iso(T0) } }),
    assignment(2, { due_at: soon, submission_types: ['on_paper'] }),
    assignment(3, { due_at: soon, submission_types: ['none'] }),
    assignment(4, { due_at: iso(T0 - HOUR) }),
    assignment(5, { due_at: null }),
  ];
  const state = baseline(list);
  assert.deepEqual(diff(state, snap(list), T0).alerts, []);
});

test('assignments handed in are reported as resolved', () => {
  const state = baseline([assignment(1), assignment(2)]);
  const { resolved } = diff(state, snap([
    assignment(1, { submission: { workflow_state: 'pending_review' } }),
    assignment(2),
  ]), T0);
  assert.deepEqual(resolved, ['100001:1']);
});

test('a new or changed grade is announced as score / points', () => {
  let state = baseline([assignment(1)]);
  let alerts;
  ({ state, alerts } = diff(state, snap([assignment(1, { submission: graded(8) })]), T0));
  assert.deepEqual(ids(alerts), ['etl:grade:100001:1:8']);
  assert.equal(alerts[0].badge, '성적');
  assert.equal(alerts[0].project, '공학 세미나 · 8 / 10');
  assert.equal(alerts[0].detail, '공학 세미나 · 점수 8 / 10');
  ({ state, alerts } = diff(state, snap([assignment(1, { submission: graded(8) })]), T0));
  assert.deepEqual(alerts, []);
  ({ state, alerts } = diff(state, snap([assignment(1, { submission: graded(9.5) })]), T0));
  assert.deepEqual(ids(alerts), ['etl:grade:100001:1:9.5']);
  assert.equal(alerts[0].project, '공학 세미나 · 9.5 / 10');
});

test('a grade without points shows the score alone', () => {
  const state = baseline([assignment(1, { points_possible: null })]);
  const { alerts } = diff(state, snap([assignment(1, { points_possible: null, submission: graded(3) })]), T0);
  assert.equal(alerts[0].project, '공학 세미나 · 3');
});

test('a new announcement from the last 14 days is shown once', () => {
  let state = baseline([], { announcements: [announcement(1)] });
  let alerts;
  ({ state, alerts } = diff(state, snap([], { announcements: [announcement(1), announcement(2)] }), T0));
  assert.deepEqual(ids(alerts), ['etl:ann:2']);
  assert.equal(alerts[0].badge, '휴강 공지');           // the body says 휴강
  assert.equal(alerts[0].title, '공지 2');
  assert.equal(alerts[0].project, '공학 세미나');
  assert.equal(alerts[0].detail, '공학 세미나 · 다음 주 휴강입니다.');
  assert.equal(alerts[0].url, 'https://myetl.snu.ac.kr/courses/100001/discussion_topics/2');
  assert.deepEqual(state.announcementsSeen, ['1', '2']);
  ({ alerts } = diff(state, snap([], { announcements: [announcement(1), announcement(2)] }), T0));
  assert.deepEqual(alerts, []);
});

test('a notice about a makeup or cancelled class gets its own badge, others are 새 공지', () => {
  const state = baseline([]);
  const list = [
    announcement(11, { title: '보강 안내', message: '<p>10/20(월) 18:00 보강합니다.</p>' }),
    announcement(12, { title: '중간고사 범위', message: '<p>1~5장</p>' }),
    announcement(13, { title: '수업 공지', message: '<p>이번 주 목요일은 결강입니다.</p>' }),
  ];
  const { alerts } = diff(state, snap([], { announcements: list }), T0);
  assert.deepEqual(alerts.map((a) => [a.id, a.badge]),
    [['etl:ann:11', '보강 공지'], ['etl:ann:12', '새 공지'], ['etl:ann:13', '휴강 공지']]);
});

test('an announcement older than 14 days is recorded but not shown', () => {
  const state = baseline([]);
  const old = announcement(5, { posted_at: iso(T0 - 15 * DAY) });
  const { state: next, alerts } = diff(state, snap([], { announcements: [old] }), T0);
  assert.deepEqual(alerts, []);
  assert.deepEqual(next.announcementsSeen, ['5']);
});

test('at most 1000 seen announcement ids are kept, the newest', () => {
  const state = { ...baseline([]), announcementsSeen: Array.from({ length: MAX_SEEN_ANNOUNCEMENTS }, (_, i) => `old${i}`) };
  const { state: next } = diff(state, snap([], { announcements: [announcement(1), announcement(2)] }), T0);
  assert.equal(next.announcementsSeen.length, MAX_SEEN_ANNOUNCEMENTS);
  assert.deepEqual(next.announcementsSeen.slice(-2), ['1', '2']);
  assert.equal(next.announcementsSeen[0], 'old2');
});

test('when announcements fail to load, the ones already seen stay recorded', () => {
  const state = baseline([], { announcements: [announcement(1)] });
  const failed = diff(state, snap([], { announcements: null }), T0);
  assert.deepEqual(failed.state.announcementsSeen, ['1']);
  const back = diff(failed.state, snap([], { announcements: [announcement(1)] }), T0);
  assert.deepEqual(back.alerts, []);
});

test('links outside eTL are dropped, and an assignment falls back to its eTL address', () => {
  const state = baseline([]);
  const { alerts } = diff(state, snap([assignment(1, { html_url: 'https://evil.example/x' })], {
    announcements: [announcement(2, { html_url: 'http://myetl.snu.ac.kr/insecure' })],
  }), T0);
  assert.equal(alerts.find((a) => a.id === 'etl:new:100001:1').url, 'https://myetl.snu.ac.kr/courses/100001/assignments/1');
  assert.equal(alerts.find((a) => a.id === 'etl:ann:2').url, null);
});

test('long titles and details are cut to 200 and 300 characters', () => {
  const state = baseline([]);
  const { alerts } = diff(state, snap([], {
    announcements: [announcement(1, { title: '가'.repeat(500), message: '나'.repeat(1000) })],
  }), T0);
  assert.equal(alerts[0].title.length, 200);
  assert.ok(alerts[0].detail.length <= 300);
});

test('an expired token is said once, until a new token is registered', () => {
  const state = baseline([assignment(1)]);
  const unauthorized = { unauthorized: true, results: [], errors: [], announcements: null };
  const first = diff(state, unauthorized, T0);
  assert.deepEqual(ids(first.alerts), ['etl:token']);
  const [token] = first.alerts;
  assert.equal(token.status, 'waiting');
  assert.equal(token.badge, '토큰 만료');
  assert.equal(token.url, TOKEN_SETTINGS_URL);
  assert.equal(token.url, 'https://myetl.snu.ac.kr/profile/settings');
  assert.deepEqual(first.state.assignments, state.assignments);      // nothing else forgotten
  const again = diff(first.state, unauthorized, T0 + HOUR);
  assert.deepEqual(again.alerts, []);
  const reset = diff(resetTokenExpired(again.state), unauthorized, T0 + 2 * HOUR);
  assert.deepEqual(ids(reset.alerts), ['etl:token']);
});

test('a successful check after an expired token allows the warning again', () => {
  const expired = diff(baseline([]), { unauthorized: true }, T0).state;
  assert.equal(diff(expired, snap([]), T0).state.tokenExpiredNotified, false);
});

test('assignments missing from one check are not announced as new when they come back', () => {
  let state = baseline([assignment(1)], { more: [{ course: OTHER, assignments: [assignment(7)] }] });
  let alerts;
  // The first course fails this time; its assignment's record stays.
  ({ state, alerts } = diff(state, {
    unauthorized: false,
    results: [{ course: OTHER, assignments: [assignment(7)] }],
    errors: [{ course: { id: COURSE.id, name: COURSE.name }, error: 'eTL 요청 실패(500)' }],
    announcements: [],
  }, T0));
  assert.deepEqual(alerts, []);
  assert.ok(state.assignments['100001:1']);
  ({ alerts } = diff(state, snap([assignment(1)], { more: [{ course: OTHER, assignments: [assignment(7)] }] }), T0));
  assert.deepEqual(alerts, []);
});

test('nothing is saved when every course and the announcements failed', () => {
  const state = baseline([assignment(1)]);
  const out = diff(state, {
    unauthorized: false,
    results: [],
    errors: [{ course: { id: COURSE.id, name: COURSE.name }, error: 'eTL 연결 실패' }],
    announcements: null,
  }, T0);
  assert.deepEqual(out, { state: null, alerts: [], resolved: [] });
});

test('alerts come in priority order: reminder, due change, new, grade, announcement', () => {
  const state = baseline([assignment(1), assignment(2)]);
  const { alerts } = diff(state, snap([
    assignment(1, { submission: graded(5) }),
    assignment(2, { due_at: iso(T0 + 2 * HOUR) }),
    assignment(3),
  ], { announcements: [announcement(9)] }), T0);
  assert.deepEqual(ids(alerts), [
    'etl:remind3h:100001:2',
    `etl:due:100001:2:${T0 + 2 * HOUR}`,
    'etl:new:100001:3',
    'etl:grade:100001:1:5',
    'etl:ann:9',
  ]);
  assert.ok(priorityOf({ id: 'etl:token' }) < priorityOf({ id: 'etl:remind3h:1:2' }));
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  ANNOUNCEMENT_LIMIT, DESCRIPTION_LIMIT, formatKst, htmlToText, isGraded, isMissing, isOnline,
  isPublished, isSubmitted, matchesStatus, remaining, usableCourses, currentCourses, termRank,
} = require('../src/etl/model');

test("only the latest term's courses are current; unreadable terms drop out", () => {
  assert.ok(termRank('2026년 2학기') > termRank('2026년 1학기'));
  assert.ok(termRank('2022년 동계계절학기') > termRank('2022년 2학기'));
  assert.equal(termRank('e-Class'), null);
  const c = (id, term) => ({ id, name: `c${id}`, term: { name: term } });
  const list = [c(1, '2026년 2학기'), c(2, '2022년 2학기'), c(3, 'e-Class'), c(4, '2026년 2학기')];
  assert.deepEqual(currentCourses(list).map((x) => x.id), [1, 4]);
  assert.deepEqual(currentCourses([c(5, 'e-Class')]).map((x) => x.id), [5]);
});

const NOW = Date.parse('2026-10-14T03:00:00.000Z');   // 2026-10-14(수) 12:00 KST
const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const iso = (ms) => new Date(ms).toISOString();

const assignment = (extra = {}, submission = {}) => ({
  id: 1, name: '과제 1', published: true, submission_types: ['online_upload'],
  due_at: iso(NOW + DAY), submission: { workflow_state: 'unsubmitted', submitted_at: null, missing: false, ...submission },
  ...extra,
});

test('the limits match the plan', () => {
  assert.equal(ANNOUNCEMENT_LIMIT, 1200);
  assert.equal(DESCRIPTION_LIMIT, 4000);
});

test('usable courses have a name and aren’t closed off by date', () => {
  const courses = [
    { id: 1, name: '알고리즘' },
    { id: 2 },
    { id: 3, name: '' },
    { id: 4, access_restricted_by_date: true },
    { id: 5, name: '지난 학기', access_restricted_by_date: true },
  ];
  assert.deepEqual(usableCourses(courses).map((c) => c.id), [1]);
  assert.deepEqual(usableCourses(null), []);
});

test('an assignment is published unless it says otherwise', () => {
  assert.equal(isPublished({}), true);
  assert.equal(isPublished({ published: null }), true);
  assert.equal(isPublished({ published: true }), true);
  assert.equal(isPublished({ published: false }), false);
});

test('submitted means a submitted, graded or pending-review state, or a submission time', () => {
  for (const state of ['submitted', 'graded', 'pending_review']) {
    assert.equal(isSubmitted(assignment({}, { workflow_state: state })), true, state);
  }
  assert.equal(isSubmitted(assignment({}, { workflow_state: 'unsubmitted', submitted_at: iso(NOW) })), true);
  assert.equal(isSubmitted(assignment()), false);
  assert.equal(isSubmitted({ id: 1 }), false);
});

test('online means some submission type other than none, on paper or not graded', () => {
  assert.equal(isOnline({ submission_types: ['online_upload'] }), true);
  assert.equal(isOnline({ submission_types: ['on_paper', 'online_text_entry'] }), true);
  assert.equal(isOnline({ submission_types: ['none'] }), false);
  assert.equal(isOnline({ submission_types: ['on_paper', 'not_graded'] }), false);
  assert.equal(isOnline({ submission_types: [] }), false);
  assert.equal(isOnline({}), false);
});

test('graded means a graded state with a score', () => {
  assert.equal(isGraded(assignment({}, { workflow_state: 'graded', score: 9 })), true);
  assert.equal(isGraded(assignment({}, { workflow_state: 'graded', score: 0 })), true);
  assert.equal(isGraded(assignment({}, { workflow_state: 'graded', score: null })), false);
  assert.equal(isGraded(assignment({}, { workflow_state: 'submitted', score: 9 })), false);
});

test('missing means unsubmitted and either flagged missing or an online assignment past due', () => {
  const past = { due_at: iso(NOW - HOUR) };
  assert.equal(isMissing(assignment(past), NOW), true);
  assert.equal(isMissing(assignment(), NOW), false, 'not yet due');
  assert.equal(isMissing(assignment({ ...past, submission_types: ['on_paper'] }), NOW), false, 'paper assignments are handed in offline');
  assert.equal(isMissing(assignment({ submission_types: ['on_paper'] }, { missing: true }), NOW), true, 'eTL flagged it');
  assert.equal(isMissing(assignment(past, { workflow_state: 'submitted', missing: true }), NOW), false, 'submitted wins');
  assert.equal(isMissing(assignment({ due_at: null }), NOW), false, 'no due time');
});

test('matchesStatus sorts assignments into upcoming, missing, submitted and all', () => {
  const upcoming = assignment();
  const overdue = assignment({ due_at: iso(NOW - HOUR) });
  const done = assignment({}, { workflow_state: 'submitted', submitted_at: iso(NOW - DAY) });
  const undated = assignment({ due_at: null });
  const dueNow = assignment({ due_at: iso(NOW) });
  const pick = (status) => [upcoming, overdue, done, undated, dueNow].map((a) => matchesStatus(a, status, NOW));
  assert.deepEqual(pick('upcoming'), [true, false, false, false, true]);
  assert.deepEqual(pick('missing'), [false, true, false, false, false]);
  assert.deepEqual(pick('submitted'), [false, false, true, false, false]);
  assert.deepEqual(pick('all'), [true, true, true, true, true]);
  assert.throws(() => matchesStatus(upcoming, 'later', NOW), RangeError);
});

test('formatKst shows the date, the Korean weekday and the time in KST', () => {
  assert.equal(formatKst(NOW), '2026-10-14(수) 12:00');
  assert.equal(formatKst('2026-10-14T03:00:00Z'), '2026-10-14(수) 12:00');
  assert.equal(formatKst('2026-10-18T15:30:00Z'), '2026-10-19(월) 00:30', 'past midnight in KST is the next day');
  assert.equal(formatKst('2026-10-18T23:59:00+09:00'), '2026-10-18(일) 23:59');
  assert.equal(formatKst(null), null);
  assert.equal(formatKst(undefined), null);
  assert.equal(formatKst('not a date'), null);
});

test('remaining counts days and hours, hours and minutes, or minutes', () => {
  assert.equal(remaining(NOW + 2 * DAY + 3 * HOUR + 59 * MIN, NOW), '2일 3시간 남음');
  assert.equal(remaining(NOW + DAY, NOW), '1일 0시간 남음');
  assert.equal(remaining(NOW + 5 * HOUR + 7 * MIN + 30 * 1000, NOW), '5시간 7분 남음');
  assert.equal(remaining(NOW + 42 * MIN, NOW), '42분 남음');
  assert.equal(remaining(NOW + 30 * 1000, NOW), '0분 남음');
  assert.equal(remaining(iso(NOW + 3 * HOUR), NOW), '3시간 0분 남음');
});

test('remaining says 지남 once the due time has passed', () => {
  assert.equal(remaining(NOW - 10 * MIN, NOW), '10분 지남');
  assert.equal(remaining(NOW - 2 * HOUR - 5 * MIN, NOW), '2시간 5분 지남');
  assert.equal(remaining(NOW - 3 * DAY - HOUR, NOW), '3일 1시간 지남');
  assert.equal(remaining(NOW, NOW), '0분 남음');
});

test('remaining without a due time says so', () => {
  assert.equal(remaining(null, NOW), '마감일 없음');
});

test('htmlToText puts block tags on their own lines and starts list items with a dash', () => {
  const html = '<h2>공지</h2><p>중간고사 안내입니다.<br>범위: 1~5장</p>\n<ul>\n  <li>날짜: 10/20</li>\n  <li>장소: 301동</li>\n</ul><p>감사합니다.</p>';
  // <ul> and the first <li> each start a line, which leaves one blank line before the list.
  assert.equal(htmlToText(html), '공지\n중간고사 안내입니다.\n범위: 1~5장\n\n- 날짜: 10/20\n- 장소: 301동\n감사합니다.');
});

test('htmlToText writes links as text (URL)', () => {
  assert.equal(
    htmlToText('<p>자료는 <a href="https://myetl.snu.ac.kr/courses/1/files/2?a=1&amp;b=2" target="_blank">여기</a>에 있습니다.</p>'),
    '자료는 여기 (https://myetl.snu.ac.kr/courses/1/files/2?a=1&b=2)에 있습니다.',
  );
  assert.equal(htmlToText('<a href="/courses/1/pages/x">페이지</a>'), '페이지 (https://myetl.snu.ac.kr/courses/1/pages/x)');
  assert.equal(htmlToText('<a href="https://example.com/">https://example.com/</a>'), 'https://example.com/', 'a bare URL isn’t repeated');
  assert.equal(htmlToText('<a href="javascript:alert(1)">눌러</a> <a href="#top">위로</a>'), '눌러 위로');
});

test('htmlToText decodes common entities without turning them into tags', () => {
  assert.equal(htmlToText('<p>A&amp;B &lt;b&gt;굵게&lt;/b&gt; &quot;인용&quot; &#39;따옴&#39; &#x2713; &#8230;&nbsp;끝</p>'), 'A&B <b>굵게</b> "인용" \'따옴\' ✓ … 끝');
  assert.equal(htmlToText('&unknown; &'), '&unknown; &');
});

test('htmlToText collapses runs of blank lines and spaces', () => {
  const html = '<p>첫째</p><p>&nbsp;</p><p></p><div><br><br><br></div><p>둘째    셋째\n\n\n넷째</p>';
  assert.equal(htmlToText(html), '첫째\n\n둘째 셋째 넷째');
});

test('htmlToText drops scripts, styles and comments', () => {
  assert.equal(htmlToText('<style>p{color:red}</style><!-- 메모 --><p>본문</p><script>alert(1)</script>'), '본문');
});

test('htmlToText separates table cells and handles attributes that contain >', () => {
  assert.equal(htmlToText('<table><tr><td>주차</td><td>내용</td></tr><tr><td title="a>b">1</td><td>소개</td></tr></table>'), '주차 내용\n1 소개');
});

test('htmlToText truncates to the limit and marks the cut', () => {
  const long = `<p>${'가'.repeat(5000)}</p>`;
  const def = htmlToText(long);
  assert.equal(def.length, DESCRIPTION_LIMIT + 1);
  assert.ok(def.endsWith('…'));
  assert.equal(htmlToText(long, ANNOUNCEMENT_LIMIT), `${'가'.repeat(ANNOUNCEMENT_LIMIT)}…`);
  assert.equal(htmlToText('<p>짧음</p>', 10), '짧음');
  assert.equal(htmlToText('ab😀', 3), 'ab…', 'a surrogate pair isn’t split');
});

test('htmlToText of nothing is empty', () => {
  assert.equal(htmlToText(null), '');
  assert.equal(htmlToText(''), '');
  assert.equal(htmlToText(undefined, 10), '');
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EtlAuthError, EtlError } = require('../src/etl/client');
const { createQueries } = require('../src/etl/queries');

const NOW = Date.parse('2026-10-14T03:00:00.000Z');   // 2026-10-14(수) 12:00 KST
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const iso = (ms) => new Date(ms).toISOString();

const COURSES = [
  {
    id: 101, name: '알고리즘', term: { name: '2026-2학기' },
    enrollments: [{ type: 'student', computed_current_score: 91.5, computed_current_grade: 'A' }],
  },
  { id: 102, name: '미적분학', term: { name: '2026-2학기' }, enrollments: [{ type: 'teacher' }] },
  { id: 103, name: '지난 과목', access_restricted_by_date: true },
  { id: 104 },
];

const unsubmitted = { workflow_state: 'unsubmitted', submitted_at: null, missing: false, late: false, score: null };

function assignment(id, extra = {}, submission = {}) {
  return {
    id, name: `과제 ${id}`, published: true, points_possible: 10, submission_types: ['online_upload'],
    html_url: `https://myetl.snu.ac.kr/courses/101/assignments/${id}`,
    submission: { ...unsubmitted, ...submission },
    ...extra,
  };
}

const ASSIGNMENTS = {
  101: [
    assignment(1, { due_at: iso(NOW + 2 * DAY + 3 * HOUR) }),                         // upcoming, 2일 3시간
    assignment(2, { due_at: iso(NOW + 10 * DAY) }),                                   // upcoming, past 7 days
    assignment(3, { due_at: iso(NOW - DAY) }),                                        // missing (past, online)
    assignment(4, { due_at: iso(NOW - DAY), submission_types: ['on_paper'] }),        // past, offline: not missing
    assignment(5, { due_at: iso(NOW + HOUR) }, { workflow_state: 'graded', submitted_at: iso(NOW - DAY), score: 8 }),
    assignment(6, { due_at: iso(NOW + DAY), published: false }),                      // never shown
    assignment(7, { due_at: null }, { missing: true }),                               // missing per eTL, no due
    assignment(8, { due_at: null }),                                                  // no due: only in 'all'
  ],
  102: [
    assignment(21, { due_at: iso(NOW + 3 * HOUR), html_url: 'https://myetl.snu.ac.kr/courses/102/assignments/21' }),
    assignment(22, { due_at: iso(NOW - 2 * DAY) }, { workflow_state: 'graded', submitted_at: iso(NOW - 3 * DAY), score: 9.5, late: true }),
  ],
};

const ANNOUNCEMENTS = [
  {
    id: 1, context_code: 'course_101', title: '휴강 안내', posted_at: iso(NOW - 2 * DAY),
    author: { display_name: '김교수' }, message: '<p>다음 주 <b>휴강</b>입니다.</p><ul><li>보강: 금요일</li></ul>',
    html_url: 'https://myetl.snu.ac.kr/courses/101/discussion_topics/1',
  },
  {
    id: 2, context_code: 'course_102', title: '시험 범위', posted_at: iso(NOW - HOUR),
    author: { display_name: '이조교' }, message: `<p>${'가'.repeat(1500)}</p>`,
    url: 'https://myetl.snu.ac.kr/courses/102/discussion_topics/2',
  },
];

// A stand-in for src/etl/client.js serving the canned JSON above. `fail` maps a course ID to
// the error its assignments fetch throws; every call is recorded in `calls`.
function fakeClient({ courses = COURSES, fail = {}, announcementsError = null, selfError = null } = {}) {
  const calls = [];
  return {
    calls,
    async self() {
      calls.push(['self']);
      if (selfError) throw selfError;
      return { id: 7, name: '홍길동' };
    },
    async courses() {
      calls.push(['courses']);
      return courses;
    },
    async assignmentsByCourse(courses) {
      calls.push(['assignmentsByCourse', courses.map((c) => c.id)]);
      const results = [];
      const errors = [];
      for (const course of courses) {
        const err = fail[course.id];
        if (err instanceof EtlAuthError) throw err;
        if (err) errors.push({ course: { id: course.id, name: course.name }, error: err.message });
        else results.push({ course, assignments: ASSIGNMENTS[course.id] || [] });
      }
      return { results, errors };
    },
    async assignment(courseId, assignmentId) {
      calls.push(['assignment', courseId, assignmentId]);
      const found = Object.values(ASSIGNMENTS).flat().find((a) => a.id === assignmentId);
      if (!found) throw new EtlError(`eTL 요청 실패(404): /api/v1/courses/${courseId}/assignments/${assignmentId}`, { status: 404 });
      return {
        ...found,
        description: '<p>보고서를 제출하세요.</p><p><a href="/files/9">양식</a></p>',
        unlock_at: iso(NOW - 7 * DAY), lock_at: null, allowed_extensions: ['pdf'], allowed_attempts: -1,
      };
    },
    async announcements(courseIds, start, end) {
      calls.push(['announcements', courseIds, start, end]);
      if (announcementsError) throw announcementsError;
      return ANNOUNCEMENTS.filter((a) => courseIds.includes(Number(a.context_code.split('_')[1])));
    },
  };
}

const queriesWith = (opts) => {
  const client = fakeClient(opts);
  return { client, q: createQueries({ client, now: () => NOW }) };
};
const ids = (list) => list.map((a) => a.assignment_id);

test('check answers ok, the user’s name and the time in KST', async () => {
  const { q } = queriesWith();
  assert.deepEqual(await q.check(), { ok: true, user: '홍길동', now: '2026-10-14(수) 12:00' });
});

test('courses lists usable courses with their term and the student’s current score', async () => {
  const { q } = queriesWith();
  assert.deepEqual(await q.courses(), {
    courses: [
      { course_id: 101, name: '알고리즘', term: '2026-2학기', current_score: 91.5, current_grade: 'A', current: true },
      { course_id: 102, name: '미적분학', term: '2026-2학기', current_score: null, current_grade: null, current: true },
    ],
  });
});

test("lists cover this term's courses; older ones are marked and can still be asked for by ID", async () => {
  const old = { id: 90, name: '물리학 2', term: { name: '2022년 2학기' } };
  const { q } = queriesWith({ courses: [...COURSES, old] });
  const rows = (await q.courses()).courses;
  assert.deepEqual(rows.map((r) => [r.course_id, r.current]), [[101, true], [102, true], [90, false]]);
  const listed = await q.assignments({ status: 'all' });
  assert.ok(listed.assignments.every((a) => a.course_id !== 90));
  assert.equal((await q.assignments({ status: 'all', course: 90 })).count, 0);
});

test('an assignment in a list carries the prototype’s fields in KST', async () => {
  const { q } = queriesWith();
  const out = await q.assignments({ status: 'upcoming' });
  assert.deepEqual(Object.keys(out), ['now', 'count', 'assignments']);
  assert.equal(out.now, '2026-10-14(수) 12:00');
  assert.deepEqual(out.assignments.find((a) => a.assignment_id === 1), {
    course: '알고리즘',
    course_id: 101,
    assignment_id: 1,
    name: '과제 1',
    due: '2026-10-16(금) 15:00',
    remaining: '2일 3시간 남음',
    points: 10,
    submission_types: ['online_upload'],
    online_submission: true,
    submitted: false,
    missing: false,
    late: false,
    graded: false,
    score: null,
    url: 'https://myetl.snu.ac.kr/courses/101/assignments/1',
  });
});

test('upcoming means unsubmitted and not yet due, sorted by due time, published only', async () => {
  const { q } = queriesWith();
  const out = await q.assignments({ status: 'upcoming' });
  assert.deepEqual(ids(out.assignments), [21, 1, 2]);
  assert.equal(out.count, 3);
});

test('days limits upcoming assignments to those due within that many days', async () => {
  const { q } = queriesWith();
  assert.deepEqual(ids((await q.assignments({ status: 'upcoming', days: 7 })).assignments), [21, 1]);
  assert.deepEqual(ids((await q.assignments({ status: 'upcoming', days: 1 })).assignments), [21]);
});

test('missing covers eTL’s missing flag and past-due online work, not paper or submitted work', async () => {
  const { q } = queriesWith();
  const out = await q.assignments({ status: 'missing' });
  assert.deepEqual(ids(out.assignments), [3, 7]);           // no due time sorts last
  assert.equal(out.assignments[0].remaining, '1일 0시간 지남');
  assert.equal(out.assignments[1].remaining, '마감일 없음');
  assert.equal(out.assignments[1].due, null);
});

test('submitted lists submitted work, and all lists every published assignment', async () => {
  const { q } = queriesWith();
  assert.deepEqual(ids((await q.assignments({ status: 'submitted' })).assignments), [22, 5]);
  const all = await q.assignments({ status: 'all' });
  assert.deepEqual(ids(all.assignments), [22, 3, 4, 5, 21, 1, 2, 7, 8]);
  assert.ok(!ids(all.assignments).includes(6));
  // days only narrows upcoming, as in the prototype
  assert.equal((await q.assignments({ status: 'all', days: 1 })).count, 9);
});

test('status defaults to upcoming', async () => {
  const { q } = queriesWith();
  assert.deepEqual(ids((await q.assignments()).assignments), [21, 1, 2]);
});

test('a course filter fetches only that course', async () => {
  const { q, client } = queriesWith();
  const out = await q.assignments({ status: 'all', course: 102 });
  assert.deepEqual(ids(out.assignments), [22, 21]);
  assert.deepEqual(client.calls.find((c) => c[0] === 'assignmentsByCourse'), ['assignmentsByCourse', [102]]);
});

test('an unknown or unusable course ID is a clear error, not an empty list', async () => {
  const { q } = queriesWith();
  for (const course of [999, 103]) {
    await assert.rejects(q.assignments({ course }), /수강 중인 과목에서 ID \d+를 찾을 수 없습니다/);
    await assert.rejects(q.announcements({ course }), /찾을 수 없습니다/);
    await assert.rejects(q.grades({ course }), /찾을 수 없습니다/);
  }
});

test('a course that fails to load is named in errors and the rest still come back', async () => {
  const { q } = queriesWith({ fail: { 102: new EtlError('eTL 요청 실패(500): /api/v1/courses/102/assignments', { status: 500 }) } });
  const out = await q.assignments({ status: 'all' });
  assert.deepEqual(out.errors, ['미적분학: eTL 요청 실패(500): /api/v1/courses/102/assignments']);
  assert.ok(ids(out.assignments).every((id) => id < 20));
  // with nothing failing there's no errors key at all, as in the prototype
  assert.ok(!('errors' in await queriesWith().q.assignments({})));
});

test('an expired token propagates from every command', async () => {
  const auth = new EtlAuthError('/api/v1/courses/101/assignments');
  const { q } = queriesWith({ fail: { 101: auth }, selfError: auth });
  await assert.rejects(q.check(), EtlAuthError);
  await assert.rejects(q.assignments({}), EtlAuthError);
  await assert.rejects(q.briefing(), EtlAuthError);
  await assert.rejects(q.grades({}), EtlAuthError);
  const ann = queriesWith({ announcementsError: auth }).q;
  await assert.rejects(ann.announcements({}), EtlAuthError);
  await assert.rejects(ann.briefing(), EtlAuthError);
});

test('assignment detail adds the description as text, open and close times, and submission rules', async () => {
  const { q, client } = queriesWith();
  const out = await q.assignment({ course: 101, id: 1 });
  assert.deepEqual(client.calls.find((c) => c[0] === 'assignment'), ['assignment', 101, 1]);
  assert.equal(out.course, '알고리즘');
  assert.equal(out.remaining, '2일 3시간 남음');
  assert.equal(out.description, '보고서를 제출하세요.\n양식 (https://myetl.snu.ac.kr/files/9)');
  assert.equal(out.unlock_at, '2026-10-07(수) 12:00');
  assert.equal(out.lock_at, null);
  assert.deepEqual(out.allowed_extensions, ['pdf']);
  assert.equal(out.allowed_attempts, -1);
  assert.ok(!('_due' in out) && !('_raw' in out));
  assert.deepEqual(Object.keys(out).slice(-5), ['description', 'unlock_at', 'lock_at', 'allowed_extensions', 'allowed_attempts']);
});

test('assignment detail of a course not in the list falls back to the ID as its name', async () => {
  const { q } = queriesWith();
  const out = await q.assignment({ course: 555, id: 21 });
  assert.equal(out.course, '555');
  assert.equal(out.course_id, 555);
});

test('announcements default to 7 days, ask for KST dates, and come newest first as text', async () => {
  const { q, client } = queriesWith();
  const out = await q.announcements({});
  assert.deepEqual(client.calls.find((c) => c[0] === 'announcements'), ['announcements', [101, 102], '2026-10-07', '2026-10-15']);
  assert.equal(out.days, 7);
  assert.equal(out.count, 2);
  assert.deepEqual(out.announcements.map((a) => a.title), ['시험 범위', '휴강 안내']);
  assert.deepEqual(out.announcements[1], {
    course: '알고리즘',
    title: '휴강 안내',
    posted: '2026-10-12(월) 12:00',
    author: '김교수',
    text: '다음 주 휴강입니다.\n\n- 보강: 금요일',
    url: 'https://myetl.snu.ac.kr/courses/101/discussion_topics/1',
  });
});

test('announcement text is cut at 1200 characters and falls back to url', async () => {
  const { q } = queriesWith();
  const [long] = (await q.announcements({ days: 3 })).announcements;
  assert.equal(long.text, `${'가'.repeat(1200)}…`);
  assert.equal(long.url, 'https://myetl.snu.ac.kr/courses/102/discussion_topics/2');
  assert.equal(long.course, '미적분학');
});

test('announcement days stay within 1 to 60 and a course narrows the request', async () => {
  const { q, client } = queriesWith();
  assert.equal((await q.announcements({ days: 3 })).days, 3);
  assert.equal((await q.announcements({ days: 90 })).days, 60);
  assert.equal((await q.announcements({ days: 0 })).days, 7);
  const one = await q.announcements({ days: 1, course: 101 });
  assert.deepEqual(client.calls.at(-1), ['announcements', [101], '2026-10-13', '2026-10-15']);
  assert.deepEqual(one.announcements.map((a) => a.title), ['휴강 안내']);
});

test('briefing has 7 days of deadlines, everything missing and 3 days of announcements', async () => {
  const { q, client } = queriesWith({ fail: { 102: new EtlError('eTL 연결 실패: /api/v1/courses/102/assignments') } });
  const out = await q.briefing();
  assert.deepEqual(Object.keys(out), ['now', 'upcoming_7_days', 'missing', 'announcements_3_days', 'errors']);
  assert.equal(out.now, '2026-10-14(수) 12:00');
  assert.deepEqual(ids(out.upcoming_7_days), [1]);
  assert.deepEqual(ids(out.missing), [3, 7]);
  assert.deepEqual(out.announcements_3_days.map((a) => a.title), ['시험 범위', '휴강 안내']);
  assert.deepEqual(out.errors, ['미적분학: eTL 연결 실패: /api/v1/courses/102/assignments']);
  assert.deepEqual(client.calls.find((c) => c[0] === 'announcements').slice(2), ['2026-10-11', '2026-10-15']);
  // assignments are fetched once for both lists
  assert.equal(client.calls.filter((c) => c[0] === 'assignmentsByCourse').length, 1);
});

test('briefing always has errors, and a failed announcement fetch lands there', async () => {
  assert.deepEqual((await queriesWith().q.briefing()).errors, []);
  const { q } = queriesWith({ announcementsError: new EtlError('eTL 요청 실패(500): /api/v1/announcements', { status: 500 }) });
  const out = await q.briefing();
  assert.deepEqual(out.announcements_3_days, []);
  assert.deepEqual(out.errors, ['공지: eTL 요청 실패(500): /api/v1/announcements']);
  assert.deepEqual(ids(out.upcoming_7_days), [21, 1]);
});

test('grades lists each course’s score with its graded assignments by due time', async () => {
  const { q } = queriesWith();
  assert.deepEqual(await q.grades({}), {
    courses: [
      {
        course_id: 101, name: '알고리즘', term: '2026-2학기', current_score: 91.5, current_grade: 'A',
        graded_assignments: [{ name: '과제 5', score: 8, points: 10, due: '2026-10-14(수) 13:00' }],
      },
      {
        course_id: 102, name: '미적분학', term: '2026-2학기', current_score: null, current_grade: null,
        graded_assignments: [{ name: '과제 22', score: 9.5, points: 10, due: '2026-10-12(월) 12:00' }],
      },
    ],
  });
});

test('grades for one course, with a failed course in errors', async () => {
  const { q } = queriesWith();
  const one = await q.grades({ course: 102 });
  assert.deepEqual(one.courses.map((c) => c.course_id), [102]);
  const failing = queriesWith({ fail: { 101: new EtlError('eTL 요청 실패(403): /api/v1/courses/101/assignments', { status: 403 }) } }).q;
  const out = await failing.grades({});
  assert.deepEqual(out.errors, ['알고리즘: eTL 요청 실패(403): /api/v1/courses/101/assignments']);
  assert.deepEqual(out.courses[0].graded_assignments, []);
});

// ---- api ------------------------------------------------------------------------------------

function apiClient(answer) {
  const calls = [];
  const reply = (p) => (typeof answer === 'function' ? answer(p) : answer);
  return {
    calls,
    async get(p) { calls.push(['get', p]); return reply(p); },
    async getAll(p, opts) { calls.push(['getAll', p, opts]); return reply(p); },
  };
}

test('api answers with what eTL returned, following pages only when asked', async () => {
  const client = apiClient({ id: 7, name: '홍길동' });
  const q = createQueries({ client, now: () => NOW });
  assert.deepEqual(await q.api({ path: '/api/v1/users/self/profile' }),
    { path: '/api/v1/users/self/profile', data: { id: 7, name: '홍길동' } });
  await q.api({ path: '/api/v1/courses/1/modules', all: true });
  assert.deepEqual(client.calls, [
    ['get', '/api/v1/users/self/profile'],
    ['getAll', '/api/v1/courses/1/modules', { orObject: true }],
  ]);
});

test('api strips the secrets out of signed file links and feed addresses', async () => {
  const q = createQueries({
    client: apiClient({
      url: 'https://myetl.snu.ac.kr/files/9/download?download_frd=1&verifier=abc123',
      nested: [{ preview_url: '/courses/1/files/9/preview?verifier=zzz&x=1' }],
      calendar: { ics: 'https://myetl.snu.ac.kr/feeds/calendars/user_SECRETfeed.ics' },
    }),
    now: () => NOW,
  });
  const { data } = await q.api({ path: '/api/v1/courses/1/files' });
  assert.equal(data.url, 'https://myetl.snu.ac.kr/files/9/download?download_frd=1&verifier=***');
  assert.equal(data.nested[0].preview_url, '/courses/1/files/9/preview?verifier=***&x=1');
  assert.equal(data.calendar.ics, 'https://myetl.snu.ac.kr/feeds/calendars/***');
  assert.ok(!JSON.stringify(data).includes('abc123') && !JSON.stringify(data).includes('SECRET'));
});

test('reading a conversation through api leaves it unread', async () => {
  const client = apiClient({ id: 5 });
  const q = createQueries({ client, now: () => NOW });
  await q.api({ path: '/api/v1/conversations/5' });
  await q.api({ path: '/api/v1/conversations/6?include[]=participant_avatars' });
  await q.api({ path: '/api/v1/conversations/7?auto_mark_as_read=true' });
  await q.api({ path: '/api/v1/conversations?scope=unread' });
  assert.deepEqual(client.calls.map((c) => c[1]), [
    '/api/v1/conversations/5?auto_mark_as_read=false',
    '/api/v1/conversations/6?include[]=participant_avatars&auto_mark_as_read=false',
    '/api/v1/conversations/7?auto_mark_as_read=true',
    '/api/v1/conversations?scope=unread',
  ]);
});

test('a huge api list is cut to what fits, and says so; a huge object is an error', async () => {
  const big = Array.from({ length: 400 }, (_, i) => ({ id: i, body: 'x'.repeat(10000) }));
  const q = createQueries({ client: apiClient(big), now: () => NOW });
  const r = await q.api({ path: '/api/v1/courses/1/pages', all: true });
  assert.ok(r.data.length > 0 && r.data.length < 400);
  assert.deepEqual(r.truncated, { shown: r.data.length, total: 400 });
  assert.ok(JSON.stringify(r.data).length <= 1_500_000);
  const q2 = createQueries({ client: apiClient({ body: 'x'.repeat(2_000_000) }), now: () => NOW });
  await assert.rejects(q2.api({ path: '/api/v1/courses/1' }), /너무 큽니다/);
});

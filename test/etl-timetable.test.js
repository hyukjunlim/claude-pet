'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  TimetableNotifier, catalogRef, createTimetable, dayClasses, fetchCatalog, parseChanges, parseMeetings,
  sameCourse, shortName, timetableItems,
} = require('../src/etl/timetable');

const kst = (s) => Date.parse(`${s}+09:00`);            // '2026-10-14T10:00:00' in KST
const SYLLABUS = (code, no) => '<p>수업계획서</p><a href="https://sugang.snu.ac.kr/sugang/cc/cc103.action?'
  + `openSchyy=2026&amp;openShtmFg=U000200002&amp;openDetaShtmFg=U000300001&amp;sbjtCd=${code}&amp;ltNo=${no}&amp;sbjtSubhCd=000&amp;">편집</a>`;

const DETAIL = {
  '999.101A': { LISTTAB01: { lsnTmtablFormaSmryCtnt: '월(17:00~18:15)|이론|000-101(무선랜제공)/수(17:00~18:15)|이론|000-101(무선랜제공)' } },
  '999.102': { LISTTAB01: { lsnTmtablFormaSmryCtnt: '월(15:30~16:45)|이론|000-202/수(15:30~16:45)|이론|000-202' } },
  'Z99.001': { ltTime: ['금(9:00~10:50)'], ltRoom: [''], LISTTAB01: { lsnTmtablFormaSmryCtnt: '' } },
};

const COURSES = [
  { id: 300001, name: '2026-2 가상현실공학 (001)', term: { name: '2026-2학기' }, syllabus_body: SYLLABUS('999.101A', '001') },
  { id: 300002, name: '2026-2 나노소자개론 (001)', term: { name: '2026-2학기' }, syllabus_body: SYLLABUS('999.102', '001') },
  { id: 300003, name: '2026-2 다이빙 (099)', term: { name: '2026-2학기' }, syllabus_body: SYLLABUS('Z99.001', '099') },
  { id: 310000, name: '2026-2 링크 없는 과목 (001)', term: { name: '2026-2학기' }, syllabus_body: '<p>없음</p>' },
  { id: 200001, name: '2026-1 지난 학기 (001)', term: { name: '2026-1학기' }, syllabus_body: SYLLABUS('999.001', '001') },
];

// The catalog: a search page that sets a session cookie, and the detail call that needs it.
function fakeCatalog({ failCode = null } = {}) {
  const calls = [];
  async function fetch(url, init = {}) {
    calls.push({ url, init });
    if (url.endsWith('cc100InterfaceSrch.action')) {
      return new Response('', { status: 302, headers: [['set-cookie', 'JSESSIONID=abc; Path=/'], ['set-cookie', 'WMONID=x; Path=/']] });
    }
    if (init.headers?.Cookie !== 'JSESSIONID=abc; WMONID=x') return new Response('<!DOCTYPE html>', { status: 200 });
    const code = new URLSearchParams(init.body).get('sbjtCd');
    if (code === failCode) return new Response('oops', { status: 500 });
    return new Response(JSON.stringify(DETAIL[code] ?? {}), { status: 200 });
  }
  return { fetch, calls };
}

function fakeClient({ events = [] } = {}) {
  const calls = [];
  return {
    calls,
    async getAll(p) {
      calls.push(p);
      if (p.startsWith('/api/v1/courses?')) return COURSES;
      if (p.startsWith('/api/v1/calendar_events?')) return events;
      throw new Error(`unexpected ${p}`);
    },
  };
}

const tmp = (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'etl-timetable-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};

test('the catalog reference comes from the syllabus link, and odd values are refused', () => {
  assert.deepEqual(catalogRef(SYLLABUS('999.101A', '001')), {
    openSchyy: '2026', openShtmFg: 'U000200002', openDetaShtmFg: 'U000300001', sbjtCd: '999.101A', ltNo: '001', sbjtSubhCd: '000',
  });
  assert.equal(catalogRef('<p>no link</p>'), null);
  assert.equal(catalogRef(SYLLABUS('430%20309', '001')), null);
  assert.equal(catalogRef(SYLLABUS('a"b', '001')), null);
});

test('meetings are read from the timetable summary, or the time and room lists', () => {
  assert.deepEqual(parseMeetings(DETAIL['999.101A']), [
    { day: '월', start: '17:00', end: '18:15', room: '000-101' },
    { day: '수', start: '17:00', end: '18:15', room: '000-101' },
  ]);
  assert.deepEqual(parseMeetings(DETAIL['Z99.001']), [{ day: '금', start: '09:00', end: '10:50', room: null }]);
  assert.deepEqual(parseMeetings({}), []);
});

test('the catalog is asked with the session cookie from its search page; a failure stays with its course', async () => {
  const { fetch, calls } = fakeCatalog({ failCode: '999.102' });
  const refs = [catalogRef(SYLLABUS('999.101A', '001')), catalogRef(SYLLABUS('999.102', '001'))];
  const got = await fetchCatalog(refs, { fetch, timeoutMs: 0 });
  assert.equal(got.get(0).length, 2);
  assert.ok(got.get(1) instanceof Error);
  assert.match(got.get(1).message, /500/);
  assert.equal(calls[1].init.method, 'POST');
  assert.equal(new URLSearchParams(calls[1].init.body).get('ltNo'), '001');
});

test('timetable.md change lines are read; other lines and bad dates are skipped', () => {
  const text = [
    '# 시간표 변경',
    '- 2026-10-20 보강 18:00~19:15 | 가상현실공학 | 000-101 | 중간고사 대비',
    '- 2026-10-21(화) 휴강 | 나노소자개론 | 학회',
    '- 2026-10-22 보강 | 시간 없는 보강',
    '- 2026-02-30 휴강 | 없는 날',
    '그냥 메모',
  ].join('\n');
  assert.deepEqual(parseChanges(text), [
    { date: '2026-10-20', kind: '보강', start: '18:00', end: '19:15', course: '가상현실공학', room: '000-101', note: '중간고사 대비' },
    { date: '2026-10-21', kind: '휴강', start: null, end: null, course: '나노소자개론', note: '학회' },
  ]);
});

test('course names match by their short form, ignoring spaces', () => {
  assert.equal(shortName('2026-2 전기·정보세미나 3 (001)'), '전기·정보세미나 3');
  assert.equal(sameCourse('가상현실공학', '2026-2 가상현실공학 (001)'), true);
  assert.equal(sameCourse('현실 공학', '2026-2 가상현실공학 (001)'), true);
  assert.equal(sameCourse('나노소자개론', '2026-2 가상현실공학 (001)'), false);
  assert.equal(sameCourse('', '2026-2 가상현실공학 (001)'), false);
});

test('a day has its weekly classes, minus 휴강, plus 보강 and eTL events, by start time', () => {
  const weekly = { courses: [
    { course_id: 1, name: '2026-2 가상현실공학 (001)', meetings: [{ day: '수', start: '17:00', end: '18:15', room: '000-101' }] },
    { course_id: 2, name: '2026-2 나노소자개론 (001)', meetings: [{ day: '수', start: '15:30', end: '16:45', room: '000-202' }] },
    { course_id: 3, name: '2026-2 다이빙 (099)', meetings: [{ day: '금', start: '09:00', end: '10:50', room: null }] },
  ] };
  const changes = [
    { date: '2026-10-14', kind: '휴강', start: null, end: null, course: '나노소자개론', note: '학회' },
    { date: '2026-10-14', kind: '보강', start: '19:00', end: '20:15', course: '가상현실공학', room: '000-101', note: null },
    { date: '2026-10-15', kind: '보강', start: '09:00', end: '10:00', course: '다이빙', room: null, note: null },
  ];
  const events = [{ start: '10:00', end: '11:00', course: '다이빙', course_id: 3, room: '체육관', kind: '일정', note: '특강' }];
  const d = dayClasses({ date: '2026-10-14', weekly, changes, events });
  assert.equal(d.weekday, '수');
  assert.deepEqual(d.classes.map((c) => [c.start, c.course, c.kind]), [
    ['10:00', '다이빙', '일정'], ['17:00', '가상현실공학', '정규'], ['19:00', '가상현실공학', '보강'],
  ]);
  assert.deepEqual(d.cancelled.map((c) => [c.start, c.course, c.note]), [['15:30', '나노소자개론', '학회']]);
});

test('each class gets its own bubble from 6:00 until it ends; the current or next one stands out', () => {
  const today = {
    date: '2026-10-14',
    classes: [
      { start: '11:00', end: '12:15', course: '기계공학개론', course_id: 11, room: '301-118', kind: '정규' },
      { start: '17:00', end: '18:15', course: '가상현실공학', course_id: 12, room: '000-101', kind: '정규' },
      { start: '19:00', end: '20:15', course: '가상현실공학', course_id: 12, room: null, kind: '보강', note: '중간고사 대비' },
    ],
    cancelled: [{ start: '15:30', end: '16:45', course: '나노소자개론', course_id: 13, room: '000-202', kind: '정규', note: '학회' }],
  };
  assert.deepEqual(timetableItems(today, kst('2026-10-14T05:59:00')), []);
  const morning = timetableItems(today, kst('2026-10-14T09:40:00'));
  assert.deepEqual(morning.map((it) => [it.badge, it.title, it.project, it.status]), [
    ['11:00', '기계공학개론', '301-118 · 1시간 20분 후', 'review'],
    ['휴강', '나노소자개론', '15:30 수업 없음 · 학회', 'idle'],
    ['17:00', '가상현실공학', '000-101 · 7시간 20분 후', 'idle'],
    ['보강 19:00', '가상현실공학', '9시간 20분 후 · 중간고사 대비', 'idle'],
  ]);
  assert.equal(morning[0].id, 'etl:timetable:2026-10-14:11:00:정규:11');
  assert.equal(morning[0].url, 'https://myetl.snu.ac.kr/courses/11');
  assert.equal(morning[0].expiresAt, kst('2026-10-14T12:15:00'));
  assert.equal(morning[0].since, undefined, 'no "5m ago" on a class');
  assert.ok(morning.every((it) => it.keepOnOpen), 'opening a class keeps its bubble');
  assert.equal(new Set(morning.map((it) => it.id)).size, 4);

  const during = timetableItems(today, kst('2026-10-14T11:30:00'));
  assert.deepEqual(during[0].project, '301-118 · 수업 중 · ~12:15');
  const afternoon = timetableItems(today, kst('2026-10-14T16:00:00'));
  assert.deepEqual(afternoon.map((it) => [it.badge, it.status]), [['휴강', 'idle'], ['17:00', 'review'], ['보강 19:00', 'idle']]);
  const closed = timetableItems(today, kst('2026-10-14T16:00:00'), ['etl:timetable:2026-10-14:17:00:정규:12']);
  assert.deepEqual(closed.map((it) => it.badge), ['휴강', '보강 19:00']);
  assert.deepEqual(timetableItems(today, kst('2026-10-14T20:15:00')), []);
  assert.deepEqual(timetableItems(today, kst('2026-10-15T09:00:00')), []);   // another day's list
});

test('the weekly timetable is built from this term, cached for a day, and kept when the catalog fails', async (t) => {
  const dir = tmp(t);
  let now = kst('2026-10-14T09:00:00');
  const cat = fakeCatalog();
  const tt = createTimetable({ cacheFile: path.join(dir, 'cache.json'), fetch: cat.fetch, now: () => now });
  const w = await tt.weekly(fakeClient());
  assert.deepEqual(w.courses.map((c) => [c.course_id, c.meetings.length]), [[300001, 2], [300002, 2], [300003, 1], [310000, 0]]);
  assert.deepEqual(w.errors, ['링크 없는 과목: 강의계획서에 수강편람 링크가 없습니다']);
  const asked = cat.calls.length;

  await tt.weekly(fakeClient());                                   // cached
  assert.equal(cat.calls.length, asked);
  const again = createTimetable({ cacheFile: path.join(dir, 'cache.json'), fetch: cat.fetch, now: () => now });
  await again.weekly(fakeClient());                                // cached on disk too
  assert.equal(cat.calls.length, asked);

  now += 25 * 60 * 60 * 1000;
  const broken = fakeCatalog({ failCode: '999.101A' });
  const tt2 = createTimetable({ cacheFile: path.join(dir, 'cache.json'), fetch: broken.fetch, now: () => now });
  const w2 = await tt2.weekly(fakeClient());
  assert.equal(w2.courses[0].meetings.length, 2, 'what was known stays');
  assert.match(w2.errors.join(), /가상현실공학: 수강편람 응답 오류\(500\)/);
});

test('a day reads timetable.md and eTL events for this term, ten courses per request', async (t) => {
  const dir = tmp(t);
  fs.writeFileSync(path.join(dir, 'timetable.md'), '- 2026-10-14 휴강 | 가상현실공학\n');
  const events = [
    { start_at: '2026-10-14T10:00:00Z', end_at: '2026-10-14T11:00:00Z', context_code: 'course_300002', title: '보강', location_name: '000-202' },
    { start_at: '2026-10-14T00:00:00Z', all_day: true, context_code: 'course_300002', title: '종일' },
  ];
  const tt = createTimetable({ cacheFile: path.join(dir, 'cache.json'), fetch: fakeCatalog().fetch, workspaceDir: () => dir });
  const client = fakeClient({ events });
  const d = await tt.day(client, '2026-10-14');
  assert.deepEqual(d.classes.map((c) => [c.start, c.course, c.kind, c.room]), [
    ['15:30', '나노소자개론', '정규', '000-202'], ['19:00', '나노소자개론', '일정', '000-202'],
  ]);
  assert.deepEqual(d.cancelled.map((c) => c.course), ['가상현실공학']);
  const ev = client.calls.find((p) => p.startsWith('/api/v1/calendar_events?'));
  assert.match(ev, /start_date=2026-10-14&end_date=2026-10-14/);
  assert.equal((ev.match(/context_codes\[\]=/g) || []).length, 4);
});

test('the notifier shows today, keeps it current, and × hides one class until tomorrow or a restart', async (t) => {
  const dir = tmp(t);
  let now = kst('2026-10-14T09:00:00');
  const tt = createTimetable({ cacheFile: path.join(dir, 'cache.json'), fetch: fakeCatalog().fetch, now: () => now, workspaceDir: () => dir });
  const timers = { setInterval: () => 1, clearInterval() {} };
  const n = new TimetableNotifier({ timetable: tt, createClient: () => fakeClient(), now: () => now, timers });
  const seen = [];
  n.on('change', (list) => seen.push(list));
  const titles = () => seen.at(-1).map((it) => `${it.badge} ${it.title}`);
  n.start();
  await n.refresh();
  assert.deepEqual(titles(), ['15:30 나노소자개론', '17:00 가상현실공학']);
  assert.equal(seen.at(-1)[0].project, '000-202 · 6시간 30분 후');

  fs.writeFileSync(path.join(dir, 'timetable.md'), '- 2026-10-14 휴강 | 나노소자개론\n');
  now += 60 * 1000;
  n.tick();
  assert.deepEqual(titles(), ['휴강 나노소자개론', '17:00 가상현실공학'], 'timetable.md applies at the next tick');

  n.dismiss(seen.at(-1)[1].id);
  assert.deepEqual(titles(), ['휴강 나노소자개론']);
  n.dismiss(seen.at(-1)[0].id);
  assert.deepEqual(seen.at(-1), []);

  // A restart brings back what was closed by mistake.
  const restarted = new TimetableNotifier({ timetable: tt, createClient: () => fakeClient(), now: () => now, timers });
  const again = [];
  restarted.on('change', (list) => again.push(list));
  restarted.start();
  await restarted.refresh();
  assert.deepEqual(again.at(-1).map((it) => it.badge), ['휴강', '17:00']);
  restarted.stop();

  now = kst('2026-10-16T08:00:00');                              // Friday: 다이빙, nothing closed
  n.tick();
  await n.refresh();
  assert.deepEqual(titles(), ['09:00 다이빙']);
  n.stop();
  assert.deepEqual(seen.at(-1), []);
});

test('without a token the notifier stays quiet', async () => {
  const tt = createTimetable({ fetch: fakeCatalog().fetch });
  const n = new TimetableNotifier({ timetable: tt, createClient: () => null, timers: { setInterval: () => 1, clearInterval() {} } });
  const seen = [];
  n.on('change', (list) => seen.push(list));
  n.start();
  await n.refresh();
  assert.deepEqual(seen, []);
  n.stop();
});

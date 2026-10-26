'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EtlTracker, kstDate, MAX_ITEMS } = require('../src/etl/tracker');
const { EtlAuthError, EtlError } = require('../src/etl/client');

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const T0 = Date.parse('2026-10-14T03:00:00.000Z');
const iso = (ms) => new Date(ms).toISOString();
const COURSE = { id: 100001, name: '공학 세미나' };

const assignment = (id, extra = {}) => ({
  id,
  name: `과제 ${id}`,
  due_at: iso(T0 + 5 * DAY),
  submission_types: ['online_upload'],
  submission: { workflow_state: 'unsubmitted' },
  ...extra,
});

function tempFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'etl-tracker-'));
  return { dir, file: path.join(dir, 'etl-state.json') };
}

// A stand-in for client.js: `eTL.assignments` and `eTL.announcements` are what it serves,
// `eTL.unauthorized` makes every call a 401, and `eTL.calls` counts the requests.
function fakeEtl() {
  const eTL = { assignments: [], announcements: [], unauthorized: false, calls: 0, coursesGate: null, announcementRange: null };
  const guard = async () => {
    eTL.calls++;
    if (eTL.unauthorized) throw new EtlAuthError('/api/v1/courses');
  };
  eTL.client = {
    async courses() {
      await guard();
      if (eTL.coursesGate) await eTL.coursesGate;
      return [COURSE, { id: 9, name: '닫힌 과목', access_restricted_by_date: true }];
    },
    async assignmentsByCourse(courses) {
      await guard();
      return { results: courses.map((course) => ({ course, assignments: eTL.assignments })), errors: [] };
    },
    async announcements(ids, start, end) {
      await guard();
      eTL.announcementRange = { ids, start, end };
      return eTL.announcements;
    },
  };
  return eTL;
}

// Timers the test fires by hand.
function fakeTimers() {
  const t = { intervals: new Map(), timeouts: new Map(), next: 1 };
  t.setInterval = (fn, ms) => { const id = t.next++; t.intervals.set(id, { fn, ms }); return id; };
  t.clearInterval = (id) => t.intervals.delete(id);
  t.setTimeout = (fn, ms) => { const id = t.next++; t.timeouts.set(id, { fn, ms }); return id; };
  t.clearTimeout = (id) => t.timeouts.delete(id);
  t.tick = () => { for (const { fn } of [...t.intervals.values()]) fn(); };
  t.expire = () => { for (const [id, { fn }] of [...t.timeouts]) { t.timeouts.delete(id); fn(); } };
  return t;
}

function setup({ file = tempFile().file, eTL = fakeEtl(), clock = { now: T0 }, token = true } = {}) {
  const timers = fakeTimers();
  let made = 0;
  const tracker = new EtlTracker({
    createClient: () => {
      made++;
      return token ? eTL.client : null;
    },
    stateFile: file,
    now: () => clock.now,
    timers,
  });
  const changes = [];
  tracker.on('change', (items) => changes.push(items));
  tracker.on('error', () => {});
  return { tracker, timers, eTL, clock, file, changes, made: () => made };
}

// Start, then wait for the first check.
async function started(opts) {
  const s = setup(opts);
  s.tracker.start();
  await s.tracker.checkNow();
  return s;
}

const ids = (items) => items.map((it) => it.id);

test('nothing happens before start: no client, no file, no timer', async () => {
  const { dir, file } = tempFile();
  const s = setup({ file });
  await s.tracker.checkNow();
  s.tracker.dismiss('etl:connected');
  await s.tracker.tokenChanged();
  assert.equal(s.made(), 0);
  assert.equal(s.eTL.calls, 0);
  assert.deepEqual(fs.readdirSync(dir), []);
  assert.equal(s.timers.intervals.size + s.timers.timeouts.size, 0);
  assert.deepEqual(s.changes, []);
  assert.deepEqual(s.tracker.items(), []);
});

test('startup and periodic checks never list or download course files', async () => {
  const { dir, file } = tempFile();
  const eTL = fakeEtl();
  const forbidden = () => { throw new Error('Periodic checks must not request files'); };
  Object.assign(eTL.client, { get: forbidden, getAll: forbidden, files: forbidden, download: forbidden });
  const s = await started({ file, eTL });
  try {
    s.timers.tick();
    await s.tracker.checkNow();
    assert.equal(s.tracker.status().error, null);
    assert.deepEqual(fs.readdirSync(dir), ['etl-state.json']);
    assert.equal(s.eTL.calls, 6);
  } finally {
    s.tracker.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('start checks at once and then on the interval, and saves the state file', async () => {
  const s = await started();
  assert.deepEqual(ids(s.tracker.items()), ['etl:connected']);
  assert.deepEqual([...s.timers.intervals.values()].map((t) => t.ms), [30 * 60 * 1000]);
  const saved = JSON.parse(fs.readFileSync(s.file, 'utf8'));
  assert.equal(saved.watch.initialized, true);
  assert.deepEqual(ids(saved.items), ['etl:connected']);
  assert.equal(fs.existsSync(`${s.file}.tmp`), false);
  assert.deepEqual(s.tracker.status(), { lastChecked: T0, error: null });
  // Only usable courses, and announcements for the last 14 days through tomorrow in KST.
  assert.deepEqual(s.eTL.announcementRange, { ids: [100001], start: '2026-09-30', end: '2026-10-15' });

  s.eTL.assignments = [assignment(1)];
  s.timers.tick();
  await s.tracker.checkNow();
  assert.deepEqual(ids(s.tracker.items()), ['etl:new:100001:1', 'etl:connected']);
  assert.deepEqual(ids(s.changes.at(-1)), ['etl:new:100001:1', 'etl:connected']);
});

test('kstDate gives the day in Korea', () => {
  assert.equal(kstDate(Date.parse('2026-10-14T15:30:00Z')), '2026-10-15');
  assert.equal(kstDate(Date.parse('2026-10-14T14:59:00Z')), '2026-10-14');
});

test('concurrent checks share one request round', async () => {
  const s = setup();
  s.tracker.start();
  const a = s.tracker.checkNow();
  const b = s.tracker.checkNow();
  assert.equal(a, b);
  await a;
  assert.equal(s.eTL.calls, 3);   // courses, assignments, announcements
});

test('expired items are left out, and drop away when they expire', async () => {
  const { file } = tempFile();
  fs.writeFileSync(file, JSON.stringify({
    version: 1,
    watch: { version: 1, initialized: true, assignments: {}, announcementsSeen: [], tokenExpiredNotified: false },
    items: [
      { id: 'etl:ann:1', kind: 'etl', status: 'review', badge: '새 공지', title: 'old', since: T0 - 4 * DAY, expiresAt: T0 - DAY },
      { id: 'etl:ann:2', kind: 'etl', status: 'review', badge: '새 공지', title: 'live', since: T0 - DAY, expiresAt: T0 + HOUR },
    ],
  }));
  const s = await started({ file });
  assert.deepEqual(ids(s.tracker.items()), ['etl:ann:2']);
  assert.deepEqual(ids(s.changes[0]), ['etl:ann:2']);
  s.clock.now = T0 + 2 * HOUR;
  s.timers.expire();
  assert.deepEqual(s.tracker.items(), []);
  assert.deepEqual(s.changes.at(-1), []);
});

test('a closed item stays closed, also after a restart', async () => {
  const s = await started();
  s.eTL.assignments = [assignment(1)];
  s.timers.tick();
  await s.tracker.checkNow();
  s.tracker.dismiss('etl:new:100001:1');
  assert.deepEqual(ids(s.tracker.items()), ['etl:connected']);
  assert.deepEqual(s.tracker.dismissedSnapshot(), {});
  s.tracker.stop();

  const again = await started({ file: s.file, eTL: s.eTL });
  assert.deepEqual(ids(again.tracker.items()), ['etl:connected']);
  assert.deepEqual(ids(again.changes[0]), ['etl:connected']);
});

test('at most 30 notices are kept, the most urgent first; deadline bubbles come on top of them', async () => {
  const s = await started();
  s.eTL.assignments = Array.from({ length: 40 }, (_, i) => assignment(i + 1));
  s.eTL.assignments[39] = assignment(40, { due_at: iso(T0 + 2 * HOUR) });
  s.timers.tick();
  await s.tracker.checkNow();
  const items = s.tracker.items();
  assert.equal(items.length, MAX_ITEMS + 1);
  assert.equal(items[0].id, 'etl:deadline:100001:40');
  assert.ok(!ids(items).includes('etl:connected'));
  assert.equal(JSON.parse(fs.readFileSync(s.file, 'utf8')).items.length, MAX_ITEMS);
});

test('a deadline bubble stays once the assignment is handed in, and turns green', async () => {
  const s = await started();
  s.eTL.assignments = [assignment(1, { due_at: iso(T0 + 2 * HOUR) })];
  s.timers.tick();
  await s.tracker.checkNow();
  const deadline = () => s.tracker.items().find((it) => it.id === 'etl:deadline:100001:1');
  assert.equal(deadline().status, 'failed');
  s.eTL.assignments = [assignment(1, { due_at: iso(T0 + 2 * HOUR), submission: { workflow_state: 'submitted', submitted_at: iso(T0) } })];
  s.timers.tick();
  await s.tracker.checkNow();
  assert.equal(deadline().status, 'review');
  assert.equal(deadline().badge, '제출함');
  s.clock.now = T0 + 2 * HOUR;
  assert.equal(deadline(), undefined, 'gone at the due time');
});

test("a deadline's time left counts down between checks", async () => {
  const s = await started();
  s.eTL.assignments = [assignment(1, { due_at: iso(T0 + 2 * HOUR) })];
  s.timers.tick();
  await s.tracker.checkNow();
  const project = () => s.changes.at(-1).find((it) => it.id === 'etl:deadline:100001:1').project;
  assert.equal(project(), '미제출 · 2시간 0분 남음 · 공학 세미나');
  assert.ok([...s.timers.timeouts.values()].some((t) => t.ms <= 61_000));    // wakes in about a minute
  s.clock.now = T0 + 25 * 60 * 1000;
  s.timers.expire();
  assert.equal(project(), '미제출 · 1시간 35분 남음 · 공학 세미나');
  assert.equal(s.tracker.items().find((it) => it.id === 'etl:deadline:100001:1').project, '미제출 · 1시간 35분 남음 · 공학 세미나');
});

test('a closed deadline bubble comes back after an hour, also after a restart', async () => {
  const s = await started();
  s.eTL.assignments = [assignment(1, { due_at: iso(T0 + 20 * HOUR) })];
  s.timers.tick();
  await s.tracker.checkNow();
  s.tracker.dismiss('etl:deadline:100001:1');
  assert.ok(!ids(s.tracker.items()).includes('etl:deadline:100001:1'));
  assert.ok(!ids(s.changes.at(-1)).includes('etl:deadline:100001:1'));
  assert.ok([...s.timers.timeouts.values()].some((t) => t.ms <= HOUR + 1000), 'wakes when it is due back');
  s.tracker.stop();

  const again = await started({ file: s.file, eTL: s.eTL, clock: s.clock });
  assert.ok(!ids(again.tracker.items()).includes('etl:deadline:100001:1'), 'still hidden after a restart');
  again.clock.now = T0 + HOUR;
  again.timers.expire();
  assert.ok(ids(again.changes.at(-1)).includes('etl:deadline:100001:1'));
  assert.deepEqual(JSON.parse(fs.readFileSync(s.file, 'utf8')).hidden, {}, 'and forgotten once it is back');
});

test('a deadline bubble comes from the last check, so a failed check or none at all loses nothing', async () => {
  const s = await started();
  s.eTL.assignments = [assignment(1, { due_at: iso(T0 + 30 * HOUR) })];
  s.timers.tick();
  await s.tracker.checkNow();
  assert.ok(!ids(s.tracker.items()).includes('etl:deadline:100001:1'), '30 hours left');
  assert.ok([...s.timers.timeouts.values()].some((t) => t.ms <= 6 * HOUR + 1000), 'wakes when it comes within 24 hours');
  s.eTL.unauthorized = true;            // every check from here on fails
  s.clock.now = T0 + 6 * HOUR;
  s.timers.expire();
  assert.ok(ids(s.changes.at(-1)).includes('etl:deadline:100001:1'));
});

test("an older version's reminder bubbles give way to the deadline bubbles", async () => {
  const { file } = tempFile();
  const old = { id: 'etl:remind3h:100001:1', kind: 'etl', status: 'waiting', badge: '마감 임박', title: '과제 1', since: T0, expiresAt: T0 + 2 * HOUR };
  fs.writeFileSync(file, JSON.stringify({ version: 1, watch: null, items: [old], lastChecked: null }));
  const s = await started({ file });
  assert.ok(!ids(s.tracker.items()).some((id) => id.startsWith('etl:remind')));
});

test('after stop nothing more happens, and a check under way is ignored', async () => {
  const s = await started();
  let open;
  s.eTL.coursesGate = new Promise((resolve) => { open = resolve; });
  s.eTL.assignments = [assignment(1)];
  s.timers.tick();
  const pending = s.tracker.checkNow();
  s.tracker.stop();
  assert.deepEqual(s.changes.at(-1), []);
  assert.equal(s.timers.intervals.size + s.timers.timeouts.size, 0);
  const before = fs.readFileSync(s.file, 'utf8');
  const changes = s.changes.length;
  open();
  await pending;
  assert.equal(s.changes.length, changes);
  assert.equal(fs.readFileSync(s.file, 'utf8'), before);
  await s.tracker.checkNow();
  assert.equal(s.changes.length, changes);
});

test('after a 401 no requests are sent until a new token is registered', async () => {
  const s = await started();
  s.eTL.unauthorized = true;
  s.timers.tick();
  await s.tracker.checkNow();
  assert.ok(ids(s.tracker.items()).includes('etl:token'));
  assert.match(s.tracker.status().error, /토큰/);
  const calls = s.eTL.calls;
  s.timers.tick();
  await s.tracker.checkNow();
  assert.equal(s.eTL.calls, calls);
  assert.ok(ids(s.changes.at(-1)).includes('etl:token'));

  s.eTL.unauthorized = false;
  await s.tracker.tokenChanged();
  assert.ok(s.eTL.calls > calls);
  assert.ok(!ids(s.tracker.items()).includes('etl:token'));
  assert.equal(s.tracker.status().error, null);
});

test('a token that expires again after being replaced is announced again', async () => {
  const s = await started();
  s.eTL.unauthorized = true;
  await s.tracker.tokenChanged().then(() => s.tracker.checkNow());
  assert.ok(ids(s.tracker.items()).includes('etl:token'));
  s.tracker.dismiss('etl:token');
  await s.tracker.tokenChanged();
  assert.ok(ids(s.tracker.items()).includes('etl:token'));
});

test('without a token there are no requests', async () => {
  const s = await started({ token: false });
  assert.equal(s.eTL.calls, 0);
  assert.match(s.tracker.status().error, /토큰/);
  assert.deepEqual(s.tracker.items(), []);
});

test('a failed check reports the error and keeps what was there', async () => {
  const s = await started();
  const statuses = [];
  s.tracker.on('status', (st) => statuses.push(st));
  s.eTL.client.courses = async () => { throw new EtlError('eTL 연결 실패: /api/v1/courses'); };
  s.timers.tick();
  await s.tracker.checkNow();
  assert.deepEqual(ids(s.tracker.items()), ['etl:connected']);
  assert.deepEqual(statuses.at(-1), { lastChecked: T0, error: 'eTL 연결 실패: /api/v1/courses' });
});

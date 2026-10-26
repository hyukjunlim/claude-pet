'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const {
  AUTH_MESSAGE, COMMANDS, NOTICE, createBridge, createFileBridge, defaultPipePath, validateRequest,
} = require('../src/etl/bridge');

const CLI = path.join(__dirname, '..', 'etl-workspace', 'etl.js');
const NOT_RUNNING_LINE = '{"error":"Ttokttok Pet이 실행 중이 아니거나 eTL 기능이 꺼져 있습니다. 펫을 켜고 eTL을 켜 주세요."}';

function tempPipe() {
  const tag = `${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
  return process.platform === 'win32'
    ? `\\\\.\\pipe\\ttokttok-pet-etl-test-${tag}`
    : path.join(os.tmpdir(), `cpe-${tag}.sock`);
}

function fakeHandlers(overrides = {}) {
  const calls = [];
  const record = (cmd, data) => async (args) => { calls.push({ cmd, args }); return data; };
  return {
    calls,
    handlers: {
      check: record('check', { ok: true, user: '홍길동', now: '2026-10-14(수) 10:00' }),
      briefing: record('briefing', { upcoming: [] }),
      courses: record('courses', [{ id: 1, name: '회로이론' }]),
      assignments: record('assignments', [{ course: '회로이론', name: '과제 1' }]),
      assignment: record('assignment', { name: '과제 1' }),
      announcements: record('announcements', []),
      grades: record('grades', []),
      files: record('files', { course_id: 1, files: [{ id: 2, name: '3주차.pdf', downloaded: false }] }),
      download: record('download', { id: 2, downloaded: true, local_path: '강의자료/회로이론/3주차.pdf' }),
      ...overrides,
    },
  };
}

async function withBridge(options, fn) {
  const bridge = createBridge({ path: tempPipe(), ...options });
  await bridge.start();
  try {
    return await fn(bridge);
  } finally {
    await bridge.stop();
  }
}

// Sends raw bytes and collects everything until the bridge closes the connection.
function exchange(pipe, payload, { end = false } = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(pipe);
    const chunks = [];
    socket.on('connect', () => {
      if (payload === null) return;
      if (end) socket.end(payload);
      else socket.write(payload);
    });
    socket.on('data', (c) => chunks.push(c));
    socket.on('error', (err) => (chunks.length ? resolve(Buffer.concat(chunks).toString('utf8')) : reject(err)));
    socket.on('close', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

async function request(pipe, obj) {
  const text = await exchange(pipe, `${JSON.stringify(obj)}\n`);
  assert.ok(text.endsWith('\n'), 'the answer is one line');
  assert.equal(text.indexOf('\n'), text.length - 1, 'the answer is exactly one line');
  return JSON.parse(text);
}

function runCli(args, env = {}) {
  return new Promise((resolve) => {
    // Without CLAUDECODE (set when these tests run under Claude Code), as Codex would run it.
    const base = { ...process.env };
    delete base.CLAUDECODE;
    const child = spawn(process.execPath, [CLI, ...args], { env: { ...base, ...env }, windowsHide: true });
    const out = [];
    const err = [];
    child.stdout.on('data', (c) => out.push(c));
    child.stderr.on('data', (c) => err.push(c));
    child.on('close', (code) => resolve({
      code,
      stdout: Buffer.concat(out).toString('utf8'),
      stderr: Buffer.concat(err).toString('utf8'),
    }));
  });
}

// ---- validation ---------------------------------------------------------------------------

test('the default channel is a per-user named pipe on Windows and a socket under ~/.ttokttok-pet elsewhere', () => {
  const p = defaultPipePath();
  if (process.platform === 'win32') assert.match(p, /^\\\\\.\\pipe\\ttokttok-pet-etl-.+$/);
  else assert.equal(p, path.join(os.homedir(), '.ttokttok-pet', 'etl.sock'));
});

test('the whitelist holds exactly the read-only commands from the plan', () => {
  assert.deepEqual(Object.keys(COMMANDS).sort(),
    ['announcements', 'api', 'assignment', 'assignments', 'boards', 'briefing', 'check', 'courses', 'download', 'files',
      'grades', 'post', 'posts', 'timetable']);
});

test('the board commands take course, board and post ids, a page and a title search word', () => {
  assert.deepEqual(validateRequest({ cmd: 'boards', args: { course: 7 } }), { cmd: 'boards', args: { course: 7 } });
  assert.deepEqual(validateRequest({ cmd: 'posts', args: { course: 7, board: 3 } }),
    { cmd: 'posts', args: { course: 7, board: 3, page: 1 } });
  assert.deepEqual(validateRequest({ cmd: 'posts', args: { course: 7, board: 3, page: 2, keyword: '중간고사' } }).args,
    { course: 7, board: 3, page: 2, keyword: '중간고사' });
  assert.deepEqual(validateRequest({ cmd: 'post', args: { course: 7, board: 3, id: 9 } }).args, { course: 7, board: 3, id: 9 });
  assert.throws(() => validateRequest({ cmd: 'boards', args: {} }), /course 인자가 필요/);
  assert.throws(() => validateRequest({ cmd: 'posts', args: { course: 7 } }), /board 인자가 필요/);
  assert.throws(() => validateRequest({ cmd: 'post', args: { course: 7, board: 3 } }), /id 인자가 필요/);
  for (const keyword of ['', '   ', 'a'.repeat(101), 'x\ny', 5]) {
    assert.throws(() => validateRequest({ cmd: 'posts', args: { course: 7, board: 3, keyword } }), /keyword/, JSON.stringify(keyword));
  }
  assert.deepEqual(validateRequest({ cmd: 'download', args: { course: 7, id: 5, board: 3, post: 9 } }).args,
    { course: 7, id: 5, board: 3, post: 9 });
  assert.throws(() => validateRequest({ cmd: 'download', args: { course: 7, id: 5, post: 'x' } }), /post/);
  for (const page of [0, 1001, 1.5, '2']) {
    assert.throws(() => validateRequest({ cmd: 'posts', args: { course: 7, board: 3, page } }), /page/, String(page));
  }
});

test('api takes any /api/v1/ path with a query, and nothing that could leave the API', () => {
  for (const p of [
    '/api/v1/users/self/profile',
    '/api/v1/courses/1/modules?include[]=items&per_page=50',
    '/api/v1/calendar_events?type=event&start_date=2026-10-14&context_codes[]=course_1',
    '/api/v1/courses/1/pages/week-1%20notes',
    '/api/v1/users/self/logins',
  ]) {
    assert.deepEqual(validateRequest({ cmd: 'api', args: { path: p } }), { cmd: 'api', args: { path: p, all: false } }, p);
  }
  assert.deepEqual(validateRequest({ cmd: 'api', args: { path: '/api/v1/courses', all: true } }).args.all, true);
  for (const p of [
    'https://evil.example/api/v1/x', '//evil.example/api/v1/x', '/api/v2/x', '/login', 'api/v1/x',
    '/api/v1/../../login', '/api/v1/%2e%2e/x', '/api/v1/x\\y', '/api/v1/x#y', '/api/v1//x', '/api/v1/a b',
    '/api/v1/users/self/tokens', '/api/v1/users/1/tokens/5', '/api/v1/login/session_token',
    '/api/v1/login/session_token?return_to=/', '/api/v1/LOGIN/session_token', '/api/v1/%6Cogin/session_token',
    '/api/v1/x?' + 'a'.repeat(600), 42, null,
  ]) {
    assert.throws(() => validateRequest({ cmd: 'api', args: { path: p } }), /api 명령의 path 값이 올바르지 않습니다/, String(p));
  }
  assert.throws(() => validateRequest({ cmd: 'api', args: {} }), /path 인자가 필요/);
  assert.throws(() => validateRequest({ cmd: 'api', args: { path: '/api/v1/x', all: 'yes' } }), /all/);
});

test('timetable takes an optional real date and a week flag', () => {
  assert.deepEqual(validateRequest({ cmd: 'timetable' }), { cmd: 'timetable', args: { week: false } });
  assert.deepEqual(validateRequest({ cmd: 'timetable', args: { date: '2026-10-14', week: true } }).args,
    { date: '2026-10-14', week: true });
  for (const date of ['2026-13-01', '2026-02-30', '10/14', 20261014]) {
    assert.throws(() => validateRequest({ cmd: 'timetable', args: { date } }), /date/, String(date));
  }
});

test('valid requests pass, with the same defaults as etl.py filled in', () => {
  assert.deepEqual(validateRequest({ cmd: 'check' }), { cmd: 'check', args: {} });
  assert.deepEqual(validateRequest({ cmd: 'briefing', args: {} }), { cmd: 'briefing', args: {} });
  assert.deepEqual(validateRequest({ cmd: 'assignments', args: { days: 7 } }),
    { cmd: 'assignments', args: { status: 'upcoming', days: 7 } });
  assert.deepEqual(validateRequest({ cmd: 'assignments', args: { status: 'all', course: 12345 } }),
    { cmd: 'assignments', args: { status: 'all', course: 12345 } });
  assert.deepEqual(validateRequest({ cmd: 'assignment', args: { course: 1, id: 2 } }),
    { cmd: 'assignment', args: { course: 1, id: 2 } });
  assert.deepEqual(validateRequest({ cmd: 'announcements', args: { course: 5 } }),
    { cmd: 'announcements', args: { days: 7, course: 5 } });
  assert.deepEqual(validateRequest({ cmd: 'announcements', args: { days: 60 } }),
    { cmd: 'announcements', args: { days: 60 } });
  assert.deepEqual(validateRequest({ cmd: 'grades' }), { cmd: 'grades', args: {} });
});

test('commands outside the whitelist are refused, including names inherited from Object', () => {
  for (const cmd of ['setup', 'submit', 'upload', '__proto__', 'constructor', 'toString', '', 42, null]) {
    assert.throws(() => validateRequest({ cmd }), /허용되지 않은 명령/, String(cmd));
  }
  assert.throws(() => validateRequest({ args: {} }), /허용되지 않은 명령/);
});

test('requests that are not a plain object, or carry extra fields, are refused', () => {
  for (const req of [null, [], 'check', 1, true]) {
    assert.throws(() => validateRequest(req), /JSON 객체/);
  }
  assert.throws(() => validateRequest({ cmd: 'check', token: 'x' }), /알 수 없는 요청 항목/);
});

test('args must be an object with only the arguments the command takes', () => {
  for (const args of [null, [], 'days=7', 7]) {
    assert.throws(() => validateRequest({ cmd: 'assignments', args }), /args는 JSON 객체/);
  }
  assert.throws(() => validateRequest({ cmd: 'check', args: { verbose: true } }), /알 수 없는 인자/);
  assert.throws(() => validateRequest({ cmd: 'grades', args: { days: 3 } }), /알 수 없는 인자/);
  assert.throws(() => validateRequest(JSON.parse('{"cmd":"grades","args":{"__proto__":{"x":1}}}')), /알 수 없는 인자/);
});

test('argument values are checked strictly', () => {
  const bad = [
    ['assignments', { status: 'late' }],
    ['assignments', { status: 'UPCOMING' }],
    ['assignments', { days: '7' }],
    ['assignments', { days: 0 }],
    ['assignments', { days: -1 }],
    ['assignments', { days: 1.5 }],
    ['assignments', { course: true }],
    ['assignments', { course: 2 ** 60 }],
    ['assignment', { course: 1, id: '2' }],
    ['announcements', { days: 61 }],
    ['announcements', { days: 0 }],
    ['announcements', { course: -5 }],
    ['grades', { course: null }],
    ['files', { course: '1' }],
    ['download', { course: 1, id: '../2' }],
    ['download', { course: 1, id: 0 }],
  ];
  for (const [cmd, args] of bad) {
    assert.throws(() => validateRequest({ cmd, args }), /값이 올바르지 않습니다/, `${cmd} ${JSON.stringify(args)}`);
  }
});

test('file requests need positive course and file IDs and never take a URL or save path', () => {
  assert.deepEqual(validateRequest({ cmd: 'files', args: { course: 1 } }), { cmd: 'files', args: { course: 1 } });
  assert.deepEqual(validateRequest({ cmd: 'download', args: { course: 1, id: 2 } }),
    { cmd: 'download', args: { course: 1, id: 2 } });
  for (const req of [
    { cmd: 'files' }, { cmd: 'download', args: { course: 1 } }, { cmd: 'download', args: { id: 2 } },
  ]) assert.throws(() => validateRequest(req), /필요합니다/);
  for (const key of ['url', 'path', 'token']) {
    assert.throws(() => validateRequest({ cmd: 'download', args: { course: 1, id: 2, [key]: 'x' } }), /알 수 없는 인자/);
  }
});

test('assignment needs both a course and an id', () => {
  assert.throws(() => validateRequest({ cmd: 'assignment', args: { course: 1 } }), /id 인자가 필요/);
  assert.throws(() => validateRequest({ cmd: 'assignment' }), /course 인자가 필요/);
});

test('error messages repeat at most a short piece of an unknown name', () => {
  const err = (() => { try { validateRequest({ cmd: 'x'.repeat(1000) }); } catch (e) { return e; } })();
  assert.ok(err.message.length < 200);
});

// ---- the channel --------------------------------------------------------------------------

test('an answer carries the notice and the handler data, and the handler gets validated args', async () => {
  const { calls, handlers } = fakeHandlers();
  await withBridge({ handlers }, async (bridge) => {
    const res = await request(bridge.path, { cmd: 'assignments', args: { days: 7 } });
    assert.deepEqual(res, { notice: NOTICE, data: [{ course: '회로이론', name: '과제 1' }] });
    assert.deepEqual(calls, [{ cmd: 'assignments', args: { status: 'upcoming', days: 7 } }]);
  });
});

test('check answers without the notice, like etl.py', async () => {
  const { handlers } = fakeHandlers();
  await withBridge({ handlers }, async (bridge) => {
    const res = await request(bridge.path, { cmd: 'check' });
    assert.deepEqual(res, { data: { ok: true, user: '홍길동', now: '2026-10-14(수) 10:00' } });
  });
});

// Windows named pipes have no half-close (a client's end() closes the whole pipe), so there the
// request must end with a newline; etl.js always sends one.
const HALF_CLOSE = process.platform !== 'win32';

test('a client may end its side instead of sending a newline', { skip: !HALF_CLOSE && 'no half-close on named pipes' }, async () => {
  const { handlers } = fakeHandlers();
  await withBridge({ handlers }, async (bridge) => {
    const text = await exchange(bridge.path, JSON.stringify({ cmd: 'courses' }), { end: true });
    assert.deepEqual(JSON.parse(text).data, [{ id: 1, name: '회로이론' }]);
  });
});

test('refused requests get a one-line error and never reach a handler', async () => {
  const { calls, handlers } = fakeHandlers();
  await withBridge({ handlers }, async (bridge) => {
    assert.match((await request(bridge.path, { cmd: 'submit', args: {} })).error, /허용되지 않은 명령/);
    assert.match((await request(bridge.path, { cmd: 'announcements', args: { days: 90 } })).error, /1~60/);
    assert.match(JSON.parse(await exchange(bridge.path, '{not json\n')).error, /JSON이 아닙니다/);
    assert.match(JSON.parse(await exchange(bridge.path, '\n')).error, /JSON이 아닙니다/);
    if (HALF_CLOSE) assert.match(JSON.parse(await exchange(bridge.path, '', { end: true })).error, /비어 있습니다/);
    assert.deepEqual(calls, []);
  });
});

test('a request over the size limit is answered with an error and the connection closed', async () => {
  const { calls, handlers } = fakeHandlers();
  await withBridge({ handlers }, async (bridge) => {
    const big = JSON.stringify({ cmd: 'courses', args: { pad: 'x'.repeat(5000) } });
    const res = JSON.parse(await exchange(bridge.path, big));
    assert.match(res.error, /너무 큽니다.*4096/);
    const exact = `{"cmd":"courses"}${' '.repeat(4096 - 17)}\n`;   // exactly 4096 bytes before the newline
    assert.ok(JSON.parse(await exchange(bridge.path, exact)).data);
    assert.equal(calls.length, 1);
  });
});

test('connections over the limit are turned away while the others are still served', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  let entered = 0;
  let notify;
  const bothIn = new Promise((r) => { notify = r; });
  const { handlers } = fakeHandlers({
    briefing: async () => { if (++entered === 2) notify(); await gate; return { ok: 1 }; },
  });
  await withBridge({ handlers, maxConnections: 2 }, async (bridge) => {
    const first = request(bridge.path, { cmd: 'briefing' });
    const second = request(bridge.path, { cmd: 'briefing' });
    await bothIn;
    const third = await request(bridge.path, { cmd: 'courses' });
    assert.match(third.error, /동시 요청이 너무 많습니다/);
    release();
    assert.deepEqual((await first).data, { ok: 1 });
    assert.deepEqual((await second).data, { ok: 1 });
    assert.ok((await request(bridge.path, { cmd: 'courses' })).data, 'slots free up again');
  });
});

test('a request that takes too long, or never arrives, is cut off with a timeout error', async () => {
  const { handlers } = fakeHandlers({ grades: () => new Promise(() => {}) });
  await withBridge({ handlers, timeoutMs: 150 }, async (bridge) => {
    const started = Date.now();
    assert.match((await request(bridge.path, { cmd: 'grades' })).error, /시간이 초과/);
    assert.ok(Date.now() - started < 5000);
    assert.match(JSON.parse(await exchange(bridge.path, null)).error, /시간이 초과/);
  });
});

test('an expired token asks the user to register it again in the pet menu', async () => {
  class EtlAuthError extends Error {
    constructor(message) { super(message); this.name = 'EtlAuthError'; this.status = 401; }
  }
  const { handlers } = fakeHandlers({
    courses: async () => { throw new EtlAuthError('401 /api/v1/courses'); },
    grades: async () => { throw Object.assign(new Error('Unauthorized'), { status: 401 }); },
  });
  await withBridge({ handlers }, async (bridge) => {
    assert.deepEqual(await request(bridge.path, { cmd: 'courses' }), { error: AUTH_MESSAGE });
    assert.deepEqual(await request(bridge.path, { cmd: 'grades' }), { error: AUTH_MESSAGE });
    assert.match(AUTH_MESSAGE, /펫 트레이 메뉴.*토큰을 다시 등록/);
  });
});

test('other handler failures pass on the message only, never a stack', async () => {
  const { handlers } = fakeHandlers({
    courses: async () => { throw new Error('eTL 서버 오류 (500)'); },
    grades: async () => { throw 'plain'; },   // eslint-disable-line no-throw-literal
  });
  await withBridge({ handlers }, async (bridge) => {
    const res = await request(bridge.path, { cmd: 'courses' });
    assert.deepEqual(res, { error: 'eTL 서버 오류 (500)' });
    assert.doesNotMatch(JSON.stringify(res), /at .*bridge\.js|\n/);
    assert.deepEqual(await request(bridge.path, { cmd: 'grades' }), { error: 'plain' });
  });
});

test('a whitelisted command the pet has no handler for yet is answered with an error', async () => {
  const { handlers } = fakeHandlers();
  delete handlers.grades;
  await withBridge({ handlers }, async (bridge) => {
    assert.match((await request(bridge.path, { cmd: 'grades' })).error, /grades/);
  });
});

test('a second bridge on the same channel fails to start, and the channel is free again after stop', async () => {
  const { handlers } = fakeHandlers();
  const pipe = tempPipe();
  const a = createBridge({ handlers, path: pipe });
  await a.start();
  const b = createBridge({ handlers, path: pipe });
  await assert.rejects(b.start(), (err) => err.code === 'EADDRINUSE' && /다른 Ttokttok Pet/.test(err.message));
  assert.ok((await request(pipe, { cmd: 'courses' })).data, 'the first bridge still answers');
  await a.stop();
  await b.start();
  assert.ok((await request(pipe, { cmd: 'courses' })).data);
  await b.stop();
});

// ---- the CLI ------------------------------------------------------------------------------

test('the CLI turns flags into a request and prints the answer, Korean intact', async () => {
  const { calls, handlers } = fakeHandlers();
  await withBridge({ handlers }, async (bridge) => {
    const env = { TTOKTTOK_PET_ETL_PIPE: bridge.path };
    const r = await runCli(['assignments', '--status', 'upcoming', '--days', '7'], env);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout), { notice: NOTICE, data: [{ course: '회로이론', name: '과제 1' }] });
    assert.match(r.stdout, /^\{\n {2}"notice"/, 'pretty-printed');

    assert.equal((await runCli(['assignment', '1', '2'], env)).code, 0);
    assert.equal((await runCli(['assignment', '--course', '3', '--id=4'], env)).code, 0);
    assert.equal((await runCli(['announcements', '--days', '3', '--course', '5'], env)).code, 0);
    assert.equal((await runCli(['grades'], env)).code, 0);
    assert.deepEqual(calls.map((c) => [c.cmd, c.args]), [
      ['assignments', { status: 'upcoming', days: 7 }],
      ['assignment', { course: 1, id: 2 }],
      ['assignment', { course: 3, id: 4 }],
      ['announcements', { days: 3, course: 5 }],
      ['grades', {}],
    ]);
  });
});

test('the CLI sends board lookups, keeping a numeric search word as text', async () => {
  const record = (cmd) => async (args) => { calls.push({ cmd, args }); return {}; };
  const calls = [];
  const { handlers } = fakeHandlers({
    boards: record('boards'), posts: record('posts'), post: record('post'), download: record('download'),
  });
  await withBridge({ handlers }, async (bridge) => {
    const env = { TTOKTTOK_PET_ETL_PIPE: bridge.path };
    assert.equal((await runCli(['boards', '--course', '7'], env)).code, 0);
    assert.equal((await runCli(['posts', '--course', '7', '--board', '3', '--page', '2', '--keyword', '2026'], env)).code, 0);
    assert.equal((await runCli(['post', '--course', '7', '--board', '3', '--id', '9'], env)).code, 0);
    assert.equal((await runCli(['download', '7', '5', '--board', '3', '--post', '9'], env)).code, 0);
    assert.deepEqual(calls.map((c) => [c.cmd, c.args]), [
      ['boards', { course: 7 }],
      ['posts', { course: 7, board: 3, page: 2, keyword: '2026' }],
      ['post', { course: 7, board: 3, id: 9 }],
      ['download', { board: 3, post: 9, course: 7, id: 5 }],
    ]);
  });
});

test('the CLI sends api paths as given, undoing Git Bash path conversion, with --all', async () => {
  const { calls, handlers } = fakeHandlers({ api: async (args) => { calls.push({ cmd: 'api', args }); return { path: args.path, data: [] }; } });
  await withBridge({ handlers }, async (bridge) => {
    const env = { TTOKTTOK_PET_ETL_PIPE: bridge.path };
    assert.equal((await runCli(['api', '/api/v1/courses/1/modules?include[]=items'], env)).code, 0);
    assert.equal((await runCli(['api', 'C:/Program Files/Git/api/v1/users/self', '--all'], env)).code, 0);
    assert.equal((await runCli(['api', 'api/v1/planner/items?start_date=2026-10-14'], env)).code, 0);
    assert.equal((await runCli(['api', '/api/v1/a', '/api/v1/b'], env)).code, 2);
    assert.deepEqual(calls.map((c) => c.args), [
      { path: '/api/v1/courses/1/modules?include[]=items', all: false },
      { path: '/api/v1/users/self', all: true },
      { path: '/api/v1/planner/items?start_date=2026-10-14', all: false },
    ]);
  });
});

test('the CLI asks for a day timetable, a dated one, and the week', async () => {
  const { calls, handlers } = fakeHandlers({ timetable: async (args) => { calls.push({ cmd: 'timetable', args }); return { classes: [] }; } });
  await withBridge({ handlers }, async (bridge) => {
    const env = { TTOKTTOK_PET_ETL_PIPE: bridge.path };
    assert.equal((await runCli(['timetable'], env)).code, 0);
    assert.equal((await runCli(['timetable', '--date', '2026-10-16', '--week'], env)).code, 0);
    assert.equal((await runCli(['timetable', '--date', 'tomorrow'], env)).code, 1);
    assert.deepEqual(calls.map((c) => c.args), [{ week: false }, { date: '2026-10-16', week: true }]);
  });
});

test('the CLI exits non-zero when the pet answers with an error', async () => {
  const { calls, handlers } = fakeHandlers();
  await withBridge({ handlers }, async (bridge) => {
    const env = { TTOKTTOK_PET_ETL_PIPE: bridge.path };
    const r = await runCli(['announcements', '--days', '90'], env);
    assert.equal(r.code, 1);
    assert.match(JSON.parse(r.stdout).error, /1~60/);
    const bad = await runCli(['assignments', '--days', 'soon'], env);
    assert.equal(bad.code, 1);
    assert.match(JSON.parse(bad.stdout).error, /days/);
    assert.equal(calls.length, 0);
  });
});

test('the CLI lists course files and downloads one selected ID through the bridge', async () => {
  const { calls, handlers } = fakeHandlers();
  await withBridge({ handlers }, async (bridge) => {
    const env = { TTOKTTOK_PET_ETL_PIPE: bridge.path };
    const listed = await runCli(['files', '--course', '1'], env);
    assert.equal(listed.code, 0, listed.stderr);
    assert.equal(JSON.parse(listed.stdout).data.files[0].downloaded, false);
    assert.equal((await runCli(['download', '1', '2'], env)).code, 0);
    const downloaded = await runCli(['download', '--course=1', '--id', '2'], env);
    assert.equal(downloaded.code, 0, downloaded.stderr);
    assert.equal(JSON.parse(downloaded.stdout).notice, NOTICE);
    assert.equal(JSON.parse(downloaded.stdout).data.local_path, '강의자료/회로이론/3주차.pdf');
    assert.deepEqual(calls.map((c) => [c.cmd, c.args]), [
      ['files', { course: 1 }], ['download', { course: 1, id: 2 }], ['download', { course: 1, id: 2 }],
    ]);
    const invalid = await runCli(['download', '1'], env);
    assert.equal(invalid.code, 2);
    assert.match(JSON.parse(invalid.stdout).error, /사용법/);
  });
});

test('downloads get the longer request timeout while ordinary lookups keep their limit', async () => {
  const delay = (ms) => new Promise((r) => setTimeout(r, ms));
  const { handlers } = fakeHandlers({
    download: async () => { await delay(250); return { downloaded: true }; },
    courses: async () => { await delay(250); return []; },
  });
  await withBridge({ handlers, timeoutMs: 100, longTimeoutMs: 1000 }, async (bridge) => {
    assert.equal((await request(bridge.path, { cmd: 'download', args: { course: 1, id: 2 } })).data.downloaded, true);
    assert.match((await request(bridge.path, { cmd: 'courses' })).error, /시간이 초과/);
  });
});

test('the CLI can print escaped ASCII for terminals that garble Korean', async () => {
  const { handlers } = fakeHandlers();
  await withBridge({ handlers }, async (bridge) => {
    const r = await runCli(['courses', '--ascii'], { TTOKTTOK_PET_ETL_PIPE: bridge.path });
    assert.equal(r.code, 0);
    assert.match(r.stdout, /^[\x00-\x7f]*$/);
    assert.equal(JSON.parse(r.stdout).data[0].name, '회로이론');
  });
});

test('the CLI says the pet is not running when nothing listens, and exits non-zero', async () => {
  const r = await runCli(['briefing'], { TTOKTTOK_PET_ETL_PIPE: tempPipe() });
  assert.equal(r.code, 1);
  assert.equal(r.stdout.trim().split('\n').length, 1);
  assert.equal(JSON.parse(r.stdout).error, JSON.parse(NOT_RUNNING_LINE).error);
});

test('on Windows, output going to another program is escaped ASCII, unless Claude Code runs it', { skip: process.platform !== 'win32' }, async () => {
  const { handlers } = fakeHandlers();
  await withBridge({ handlers }, async (bridge) => {
    const plain = await runCli(['courses'], { TTOKTTOK_PET_ETL_PIPE: bridge.path });
    assert.match(plain.stdout, /^[\x00-\x7f]*$/);
    assert.equal(JSON.parse(plain.stdout).data[0].name, '회로이론');
    const claude = await runCli(['courses'], { TTOKTTOK_PET_ETL_PIPE: bridge.path, CLAUDECODE: '1' });
    assert.match(claude.stdout, /회로이론/);
  });
});

// ---- the file bridge (for Codex's sandbox) ------------------------------------------------

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'etl-files-'));
}

async function until(fn, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 20));
  }
  return null;
}

const readAnswer = (dir, id) => {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, 'responses', `${id}.json`), 'utf8'));
  } catch {
    return null;
  }
};

test('the file bridge takes a request file and answers it in responses/', async () => {
  const dir = tempDir();
  const { calls, handlers } = fakeHandlers();
  const fb = createFileBridge({ handlers, dir, pollMs: 20 });
  fb.start();
  try {
    const id = crypto.randomUUID();
    fs.writeFileSync(path.join(dir, 'requests', `${id}.json`), '{"cmd":"assignments","args":{"days":3}}');
    const answer = await until(() => readAnswer(dir, id));
    assert.deepEqual(answer, { notice: NOTICE, data: [{ course: '회로이론', name: '과제 1' }] });
    assert.deepEqual(calls, [{ cmd: 'assignments', args: { status: 'upcoming', days: 3 } }]);
    assert.equal(fs.existsSync(path.join(dir, 'requests', `${id}.json`)), false, 'the request is taken');
  } finally {
    fb.stop();
  }
});

test('the file bridge checks requests like the pipe, and ignores files that are not requests', async () => {
  const dir = tempDir();
  const { calls, handlers } = fakeHandlers();
  const fb = createFileBridge({ handlers, dir, pollMs: 20, maxBytes: 64 });
  fb.start();
  try {
    const bad = crypto.randomUUID();
    const big = crypto.randomUUID();
    fs.writeFileSync(path.join(dir, 'requests', `${bad}.json`), '{"cmd":"submit"}');
    fs.writeFileSync(path.join(dir, 'requests', `${big}.json`), `{"cmd":"check","pad":"${'x'.repeat(100)}"}`);
    fs.writeFileSync(path.join(dir, 'requests', 'notes.txt'), 'hello');
    fs.writeFileSync(path.join(dir, 'requests', 'x.json'), '{"cmd":"check"}');   // id too short
    assert.ok((await until(() => readAnswer(dir, bad))).error);
    assert.match((await until(() => readAnswer(dir, big))).error, /너무 큽니다/);
    await new Promise((r) => setTimeout(r, 100));
    assert.ok(fs.existsSync(path.join(dir, 'requests', 'notes.txt')));
    assert.ok(fs.existsSync(path.join(dir, 'requests', 'x.json')));
    assert.equal(calls.length, 0);
  } finally {
    fb.stop();
  }
});

test("the CLI goes through files when it can't open the pipe", async () => {
  const dir = tempDir();
  const { handlers } = fakeHandlers();
  const fb = createFileBridge({ handlers, dir, pollMs: 20 });
  fb.start();
  try {
    const r = await runCli(['check'], { TTOKTTOK_PET_ETL_PIPE: tempPipe(), TTOKTTOK_PET_ETL_DIR: dir });
    assert.equal(r.code, 0, r.stdout);
    assert.deepEqual(JSON.parse(r.stdout), { data: { ok: true, user: '홍길동', now: '2026-10-14(수) 10:00' } });
    assert.deepEqual(fs.readdirSync(path.join(dir, 'responses')), [], 'the answer is collected');
  } finally {
    fb.stop();
  }
});

test('the CLI says the pet is not running when nobody takes its request file', async () => {
  const dir = tempDir();
  fs.mkdirSync(path.join(dir, 'requests'), { recursive: true });
  const r = await runCli(['briefing'], { TTOKTTOK_PET_ETL_PIPE: tempPipe(), TTOKTTOK_PET_ETL_DIR: dir });
  assert.equal(r.code, 1);
  assert.equal(JSON.parse(r.stdout).error, JSON.parse(NOT_RUNNING_LINE).error);
  assert.deepEqual(fs.readdirSync(path.join(dir, 'requests')), [], 'the request is cleaned up');
});

test('the CLI handles help and bad usage without contacting the pet', async () => {
  const env = { TTOKTTOK_PET_ETL_PIPE: tempPipe() };
  const help = await runCli(['--help'], env);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /사용법: node etl\.js/);
  assert.equal((await runCli([], env)).code, 0);
  const usage = await runCli(['assignment', '1'], env);
  assert.equal(usage.code, 2);
  assert.match(JSON.parse(usage.stdout).error, /assignment <과목ID> <과제ID>/);
  assert.equal((await runCli(['courses', '--course'], env)).code, 2);
  assert.match(JSON.parse((await runCli(['setup'], env)).stdout).error, /펫 트레이 메뉴/);
});

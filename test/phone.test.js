'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { pushEvents } = require('../src/phone/notify');
const { phoneView, openTarget } = require('../src/phone/view');
const { PhoneFeature } = require('../src/phone/feature');
const { allowedHost } = require('../src/phone/server');

// ---------------------------------------------------------------- what buzzes

test('nothing buzzes for what is already there; a session turning Ready, Needs you or Error does', () => {
  let { memory, events } = pushEvents(null, [
    { id: 'local_a', kind: 'desktop', status: 'review', since: 1, title: 'Old', project: 'p' },
    { id: 'etl:ann:1', kind: 'etl', badge: '새 공지', title: 'Old notice' },
  ], 1000);
  assert.deepEqual(events, []);
  ({ memory, events } = pushEvents(memory, [
    { id: 'local_a', kind: 'desktop', status: 'review', since: 1, title: 'Old', project: 'p' },
    { id: 'local_b', kind: 'desktop', status: 'running', since: 2, title: 'Working' },
    { id: 'codex:c', kind: 'codex', client: 'vscode', status: 'waiting', since: 3, title: 'Asks', project: 'q' },
    { id: 'cli:d', kind: 'cli', client: 'terminal', status: 'failed', since: 4, title: 'Broke' },
    { id: 'web:e', kind: 'web', siteName: 'ChatGPT', status: 'review', since: 5, title: 'Answer' },
  ], 2000));
  assert.deepEqual(events.map((e) => [e.id, e.title, e.body]), [
    ['codex:c', 'Needs you · Asks', 'Codex · VS Code · q'],
    ['cli:d', 'Error · Broke', 'Claude Code · Terminal'],
    ['web:e', 'Ready · Answer', 'ChatGPT'],
  ]);
  ({ memory, events } = pushEvents(memory, [{ id: 'local_b', kind: 'desktop', status: 'review', since: 9, title: 'Working', project: 'p' }], 3000));
  assert.deepEqual(events.map((e) => e.title), ['Ready · Working']);
  assert.equal(events[0].tag, 'local_b');
});

test('a session that drops out and comes back as it was doesn\'t buzz again; its next turn does', () => {
  const ready = { id: 'local_a', kind: 'desktop', status: 'review', since: 5, title: 'T' };
  let { memory } = pushEvents(null, [], 0);
  let events;
  ({ memory, events } = pushEvents(memory, [ready], 1));
  assert.equal(events.length, 1);
  ({ memory, events } = pushEvents(memory, [], 2));
  ({ memory, events } = pushEvents(memory, [ready], 3));
  assert.equal(events.length, 0);
  ({ memory, events } = pushEvents(memory, [{ ...ready, status: 'running', since: 6 }], 4));
  ({ memory, events } = pushEvents(memory, [{ ...ready, since: 7 }], 5));
  assert.equal(events.length, 1);
});

test('eTL: new notices, assignments, grades, deadline changes and 마감 임박 buzz; classes and handed-in work don\'t', () => {
  let { memory } = pushEvents(null, [{ id: 'etl:ann:1', kind: 'etl', badge: '새 공지', title: 'seen' }], 0);
  let events;
  ({ memory, events } = pushEvents(memory, [
    { id: 'etl:ann:1', kind: 'etl', badge: '새 공지', title: 'seen' },
    { id: 'etl:ann:2', kind: 'etl', badge: '휴강 공지', title: '휴강', project: '자료구조' },
    { id: 'etl:new:7', kind: 'etl', badge: '새 과제', title: 'HW3' },
    { id: 'etl:grade:7:90', kind: 'etl', badge: '성적', title: 'HW2' },
    { id: 'etl:due:7:123', kind: 'etl', badge: '마감 변경', title: 'HW3' },
    { id: 'etl:token', kind: 'etl', badge: '토큰 만료', title: 'token' },
    { id: 'etl:deadline:8', kind: 'etl', badge: '마감 임박', title: 'HW4' },
    { id: 'etl:deadline:9', kind: 'etl', badge: '제출함', title: 'HW5' },
    { id: 'etl:timetable:2026-10-28:10:00:정규:1', kind: 'etl', badge: '10:00', title: '자료구조' },
    { id: 'etl:connected', kind: 'etl', badge: 'eTL 연결됨', title: '마감 전 미제출 2건' },
    { id: 'etl:assistant', kind: 'etl', assistant: true, badge: 'eTL 비서', title: '물어보기' },
  ], 1));
  assert.deepEqual(events.map((e) => e.title), [
    '휴강 공지 · 휴강', '새 과제 · HW3', '성적 · HW2', '마감 변경 · HW3', '토큰 만료 · token', '마감 임박 · HW4',
  ]);
  assert.equal(events[0].body, '자료구조');
  ({ events } = pushEvents(memory, [{ id: 'etl:deadline:8', kind: 'etl', badge: '마감 임박', title: 'HW4' }], 2));
  assert.equal(events.length, 0, 'each notice once');
});

// ---------------------------------------------------------------- what the phone shows

test('a tap opens the app: Claude Code in Claude, Codex in ChatGPT, a web chat at its conversation', () => {
  assert.deepEqual(openTarget('claude'), { app: 'claude', url: 'https://claude.ai/code' });
  assert.deepEqual(openTarget('terminal'), { app: 'claude', url: 'https://claude.ai/code' });
  assert.deepEqual(openTarget('codex-vscode'), { app: 'chatgpt', url: 'https://chatgpt.com/codex' });
  assert.deepEqual(openTarget('chatgpt', 'https://chatgpt.com/c/abc'), { app: 'chatgpt', url: 'https://chatgpt.com/c/abc' });
  assert.deepEqual(openTarget('claude-web', 'https://evil.example/x'), { app: 'claude', url: 'https://claude.ai/' });
  assert.deepEqual(openTarget('gemini'), { app: 'gemini', url: 'https://gemini.google.com/app' });
});

test('the view keeps the tree, drops the eTL assistant, and sends eTL notices to LearningX', () => {
  const s = (id, app, extra = {}) => ({ id, app, title: id, status: 'review', detail: '', since: 1, lastActivityAt: 2, ...extra });
  const view = phoneView({
    hosts: [
      { key: 'chat', kind: 'chat', label: 'Chat', attention: 1, busy: 0, folders: [], loose: [s('web:1', 'chatgpt', { siteName: 'ChatGPT' })] },
      {
        key: 'pc', kind: 'pc', label: 'Local', attention: 1, busy: 0, loose: [],
        folders: [{ key: 'pc|c:', label: 'C:\\pet', path: 'C:\\pet', open: true, attention: 1, busy: 0, sessions: [s('local_1', 'claude')], children: [] }],
      },
    ],
    notices: [
      { id: 'etl:ann:1', kind: 'etl', status: 'review', badge: '새 공지', title: '공지', project: '자료구조', url: 'https://myetl.snu.ac.kr/courses/1/discussion_topics/2' },
      { id: 'etl:token', kind: 'etl', status: 'waiting', badge: '토큰 만료', title: '토큰', url: 'https://myetl.snu.ac.kr/profile/settings' },
      { id: 'etl:x', kind: 'etl', status: 'review', badge: '새 과제', title: 'x', url: 'https://elsewhere.example/' },
      { id: 'etl:assistant', kind: 'etl', assistant: true, status: 'background', title: '물어보기' },
    ],
    usage: [{ app: 'claude', name: 'Claude', percent: 42, elapsed: 55, resetsIn: '3d', age: null, extra: 'dropped' }],
    chatUrl: (id) => (id === 'web:1' ? 'https://chatgpt.com/c/1' : null),
  });
  assert.equal(view.hosts[0].loose[0].open.url, 'https://chatgpt.com/c/1');
  assert.equal(view.hosts[1].folders[0].sessions[0].open.url, 'https://claude.ai/code');
  assert.deepEqual(view.notices.map((n) => n.id), ['etl:ann:1', 'etl:token', 'etl:x']);
  assert.deepEqual(view.notices[0].open, { app: 'learningx', url: 'https://myetl.snu.ac.kr/courses/1/discussion_topics/2' });
  assert.equal(view.notices[2].open.url, 'https://myetl.snu.ac.kr/', 'a link outside eTL goes to eTL\'s front page');
  assert.deepEqual(view.usage, [{ app: 'claude', name: 'Claude', percent: 42, elapsed: 55, resetsIn: '3d', age: null }]);
});

test('only this PC and its tailnet name may ask', () => {
  assert.ok(allowedHost('127.0.0.1:47823'));
  assert.ok(allowedHost('localhost:47823'));
  assert.ok(allowedHost('desktop-pc.tail1234.ts.net'));
  assert.ok(allowedHost('desktop-pc.tail1234.ts.net:443'));
  assert.ok(!allowedHost('evil.example.com'));
  assert.ok(!allowedHost('ts.net.evil.example.com'));
  assert.ok(!allowedHost('192.168.0.10:47823'));
  assert.ok(!allowedHost(undefined));
});

// ---------------------------------------------------------------- the server, end to end

function fakePush() {
  const sent = [];
  const request = (url, opts, onResponse) => {
    const req = new EventEmitter();
    req.end = (body) => {
      sent.push({ url: String(url), headers: opts.headers, body });
      const res = new EventEmitter();
      res.statusCode = 201;
      res.resume = () => {};
      onResponse(res);
      res.emit('end');
    };
    req.destroy = () => {};
    return req;
  };
  return { request, sent };
}

async function running(t, snapshot = () => ({})) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phone-'));
  const data = { phone: true };
  const settings = { get: (k) => data[k], set: (p) => Object.assign(data, p) };
  const push = fakePush();
  const f = new PhoneFeature({ electron: {}, settings, userData: dir, snapshot, port: 0, request: push.request });
  await f.start();
  t.after(() => f.stop());
  return { f, dir, push, port: f.listening };
}

function call(port, { method = 'GET', path: p = '/', host = `127.0.0.1:${port}`, origin, cookie, body, etag } = {}) {
  return new Promise((resolve, reject) => {
    const headers = { Host: host };
    if (origin) headers.Origin = origin;
    if (cookie) headers.Cookie = cookie;
    if (etag) headers['If-None-Match'] = etag;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { text += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }));
    });
    req.on('error', reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

function subscription() {
  const ua = crypto.createECDH('prime256v1');
  ua.generateKeys();
  return { endpoint: 'https://fcm.googleapis.com/fcm/send/xyz', keys: { p256dh: ua.getPublicKey().toString('base64url'), auth: crypto.randomBytes(16).toString('base64url') } };
}

test('the page is served; data only to a paired phone, and only from this PC or the tailnet', async (t) => {
  const { f, port } = await running(t, () => ({ hosts: [], notices: [], usage: [{ app: 'claude', name: 'Claude', percent: 10 }] }));
  const page = await call(port);
  assert.equal(page.status, 200);
  assert.match(page.text, /<title>Ttokttok Pet<\/title>/);
  assert.match(page.headers['content-security-policy'], /default-src 'self'/);
  assert.equal((await call(port, { host: 'attacker.example' })).status, 421);
  assert.equal((await call(port, { path: '/api/state' })).status, 401);

  const origin = `http://127.0.0.1:${port}`;
  assert.equal((await call(port, { method: 'POST', path: '/api/pair', body: { code: '000000' } })).status, 403, 'no Origin, no change');
  assert.equal((await call(port, { method: 'POST', path: '/api/pair', origin, body: { code: '123456' } })).status, 403, 'no code asked for yet');

  const code = f.newCode();
  const paired = await call(port, { method: 'POST', path: '/api/pair', origin, body: { code: `${code.slice(0, 3)} ${code.slice(3)}`, name: 'iPhone' } });
  assert.equal(paired.status, 200);
  const cookie = paired.headers['set-cookie'][0].split(';')[0];
  assert.match(paired.headers['set-cookie'][0], /HttpOnly; SameSite=Strict/);
  assert.equal((await call(port, { method: 'POST', path: '/api/pair', origin, body: { code } })).status, 403, 'a code works once');

  f.changed();
  await new Promise((r) => setTimeout(r, 400));
  const state = await call(port, { path: '/api/state', cookie });
  assert.equal(state.status, 200);
  assert.equal(JSON.parse(state.text).usage[0].percent, 10);
  assert.equal((await call(port, { path: '/api/state', cookie, etag: state.headers.etag })).status, 304);
  assert.equal(f.devices[0].name, 'iPhone');
});

test('wrong codes use the code up', async (t) => {
  const { f, port } = await running(t);
  const origin = `http://127.0.0.1:${port}`;
  const code = f.newCode();
  const wrong = code === '000000' ? '111111' : '000000';
  for (let i = 0; i < 5; i++) assert.equal((await call(port, { method: 'POST', path: '/api/pair', origin, body: { code: wrong } })).status, 403);
  assert.equal((await call(port, { method: 'POST', path: '/api/pair', origin, body: { code } })).status, 403);
});

test('a paired phone subscribes, gets pushes for what turns Ready, and can unpair', async (t) => {
  const { f, dir, push, port } = await running(t);
  const origin = `http://127.0.0.1:${port}`;
  const code = f.newCode();
  const cookie = (await call(port, { method: 'POST', path: '/api/pair', origin, body: { code } })).headers['set-cookie'][0].split(';')[0];
  const key = JSON.parse((await call(port, { path: '/api/push-key', cookie })).text);
  assert.equal(Buffer.from(key.key, 'base64url').length, 65);
  assert.equal(key.subscribed, false);
  assert.equal((await call(port, { method: 'POST', path: '/api/push', origin, cookie, body: { subscription: { endpoint: 'https://evil.example/x', keys: {} } } })).status, 400);
  const sub = subscription();
  assert.equal((await call(port, { method: 'POST', path: '/api/push', origin, cookie, body: { subscription: sub } })).status, 200);

  const saved = fs.readFileSync(path.join(dir, 'phone.json'), 'utf8');
  assert.ok(!saved.includes(cookie.split('=')[1]), 'only the cookie\'s hash is kept');
  assert.equal(JSON.parse(saved).devices[0].subscription.endpoint, sub.endpoint);

  f.observe([{ id: 'local_a', kind: 'desktop', status: 'running', since: 1, title: 'Fix it' }]);
  f.observe([{ id: 'local_a', kind: 'desktop', status: 'review', since: 2, title: 'Fix it', project: 'pet' }]);
  await new Promise((r) => setImmediate(r));
  assert.equal(push.sent.length, 1);
  assert.equal(push.sent[0].url, sub.endpoint);
  assert.equal(push.sent[0].headers['Content-Encoding'], 'aes128gcm');

  assert.equal((await call(port, { method: 'POST', path: '/api/test-push', origin, cookie, body: {} })).status, 200);
  assert.equal(push.sent.length, 2);

  assert.equal((await call(port, { method: 'POST', path: '/api/unpair', origin, cookie, body: {} })).status, 200);
  assert.equal(f.devices.length, 0);
  assert.equal((await call(port, { path: '/api/state', cookie })).status, 401);
});

test('a sample eTL notice shows on the phone for a while and comes as a notification', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phone-'));
  const data = { phone: true };
  let clock = 1_000_000;
  const push = fakePush();
  const f = new PhoneFeature({
    electron: {},
    settings: { get: (k) => data[k], set: (p) => Object.assign(data, p) },
    userData: dir,
    port: 0,
    request: push.request,
    now: () => clock,
    snapshot: () => ({ notices: [{ id: 'etl:ann:1', kind: 'etl', status: 'review', badge: '새 공지', title: '공지', url: 'https://myetl.snu.ac.kr/courses/1/discussion_topics/2' }] }),
    sampleNotice: () => ({ title: 'HW3', project: '자료구조', url: 'https://myetl.snu.ac.kr/courses/7/assignments/8' }),
  });
  await f.start();
  t.after(() => f.stop());
  const origin = `http://127.0.0.1:${f.listening}`;
  const code = f.newCode();
  const cookie = (await call(f.listening, { method: 'POST', path: '/api/pair', origin, body: { code } })).headers['set-cookie'][0].split(';')[0];
  await call(f.listening, { method: 'POST', path: '/api/push', origin, cookie, body: { subscription: subscription() } });

  const id = f.showSample();
  await new Promise((r) => setImmediate(r));
  const notices = JSON.parse((await call(f.listening, { path: '/api/state', cookie })).text).notices;
  assert.deepEqual(notices.map((n) => [n.id, n.badge, n.title]), [[id, '테스트', 'HW3'], ['etl:ann:1', '새 공지', '공지']]);
  assert.deepEqual(notices[0].open, { app: 'learningx', url: 'https://myetl.snu.ac.kr/courses/7/assignments/8' });
  assert.equal(push.sent.length, 1, 'and a notification for it');

  clock += 11 * 60_000;
  f.changed();
  await new Promise((r) => setTimeout(r, 400));
  const later = JSON.parse((await call(f.listening, { path: '/api/state', cookie })).text).notices;
  assert.deepEqual(later.map((n) => n.id), ['etl:ann:1'], 'gone after ten minutes');
});

test('off: nothing listens and nothing is written', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phone-'));
  const settings = { get: () => undefined, set() {} };
  const f = new PhoneFeature({ electron: {}, settings, userData: dir, port: 0 });
  await f.start();
  f.menu();
  f.observe([{ id: 'local_a', kind: 'desktop', status: 'review', since: 1, title: 'x' }]);
  assert.equal(f.server, null);
  assert.ok(!fs.existsSync(path.join(dir, 'phone.json')));
});

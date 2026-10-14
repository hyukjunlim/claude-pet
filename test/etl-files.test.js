'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { BASE, EtlAuthError, EtlError } = require('../src/etl/client');
const { createFiles, MAX_BYTES, safeName } = require('../src/etl/files');

const TOKEN = 'test-token-never-in-output';
const NOW = Date.parse('2026-10-14T03:00:00Z');
const COURSE = { id: 7, name: '2026-2 회로이론' };
const STORAGE = 'https://kr.object.gov-ncloudstorage.com';
const unavailable = () => new EtlError('not available', { status: 401 });
const file = (id, extra = {}) => ({
  id, display_name: `lecture-${id}.pdf`, size: 4, 'content-type': 'application/pdf',
  updated_at: '2026-10-13T03:00:00Z', url: `${BASE}/files/${id}/download?verifier=private-signed-value`,
  ...extra,
});

function setup(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'etl-materials-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const root = path.join(dir, 'chat');
  fs.mkdirSync(root);
  const recordsFile = path.join(dir, 'etl-downloads.json');
  const state = {
    courses: [COURSE], listed: [], folders: [], modules: [], assignments: [], announcements: [],
    metadata: new Map(), denied: new Set(), errors: {}, moduleItems: [],
    ...options.state,
  };
  const calls = [];
  const client = {
    async courses() { calls.push(['courses']); return state.courses; },
    async assignments(cid) {
      calls.push(['assignments', cid]);
      if (state.errors.assignments) throw state.errors.assignments;
      return state.assignments;
    },
    async announcements(ids, start, end) {
      calls.push(['announcements', ids, start, end]);
      if (state.errors.announcements) throw state.errors.announcements;
      return state.announcements;
    },
    async getAll(p) {
      calls.push(['getAll', p]);
      let key;
      if (/\/modules\/\d+\/items\?/.test(p)) key = 'moduleItems';
      else if (/\/files\?/.test(p)) key = 'listed';
      else if (/\/folders\?/.test(p)) key = 'folders';
      else if (/\/modules\?/.test(p)) key = 'modules';
      else throw new Error(`Unexpected API path: ${p}`);
      if (state.errors[key]) throw state.errors[key];
      return state[key];
    },
    async get(p) {
      calls.push(['get', p]);
      if (state.denied.has(p)) throw unavailable();
      const id = Number(/\/files\/(\d+)$/.exec(p)?.[1]);
      const f = state.metadata.get(id);
      if (f instanceof Error) throw f;
      if (!f) throw new EtlError('not found', { status: 404 });
      return f;
    },
  };
  const fetched = [];
  const fetch = async (url, opts) => {
    fetched.push({ url, ...opts });
    return options.fetch ? options.fetch(url, opts) : new Response('data', { headers: { 'content-length': '4' } });
  };
  const make = () => createFiles({ client, token: TOKEN, fetch, workspaceDir: root, recordsFile, now: () => NOW, ...options.config });
  return { api: make(), make, state, root, recordsFile, calls, fetched, dir };
}

function assertPrivate(result) {
  const text = JSON.stringify(result);
  for (const secret of [TOKEN, 'private-signed-value', 'X-Amz-Signature']) assert.ok(!text.includes(secret), secret);
}

function savedFiles(root) {
  return fs.readdirSync(root, { recursive: true }).filter((p) => fs.statSync(path.join(root, p)).isFile());
}

test('files merges the Files tab, modules, announcements, assignment links and submissions without downloading', async (t) => {
  const s = setup(t);
  s.state.listed = [file(1, { folder_id: 10 }), file(1)];
  s.state.folders = [{ id: 10, full_name: 'course files/강의자료' }];
  s.state.modules = [{ id: 20, name: '3주차', items: [
    { type: 'File', content_id: 1 }, { type: 'File', content_id: 2, title: '자료 2' },
    { type: 'ExternalUrl', content_id: 99 },
  ] }];
  s.state.assignments = [{ id: 30, name: '실습', description: '<a href="/courses/7/files/3/download?wrap=1&amp;x=2">양식</a>',
    attachments: [file(6)], submission: { attachments: [file(4)] } }];
  s.state.announcements = [{ title: '오래된 공지', posted_at: '2024-01-01T00:00:00Z',
    attachment: file(5), attachments: [file(1)], message: '<a href="/files/5">공지 자료</a>' }];
  for (const id of [2, 3, 5, 6]) s.state.metadata.set(id, file(id));
  const result = await s.api.files({ course: 7 });
  assert.deepEqual(result.files.map((r) => r.id).sort((a, b) => a - b), [1, 2, 3, 4, 5, 6]);
  assert.equal(result.files.find((r) => r.id === 1).folder, '강의자료');
  assert.equal(result.files.find((r) => r.id === 1).module, '3주차');
  assert.equal(result.files.find((r) => r.id === 3).source, 'assignment');
  assert.equal(result.files.find((r) => r.id === 4).source, 'submission');
  assert.equal(result.files.find((r) => r.id === 5).announcement, '오래된 공지');
  assert.ok(result.files.every((r) => !r.downloaded));
  assert.equal(result.downloaded_count, 0);
  assert.equal(s.fetched.length, 0);
  assert.deepEqual(fs.readdirSync(s.root), []);
  assert.equal(fs.existsSync(s.recordsFile), false);
  assert.equal(s.calls.find((c) => c[0] === 'announcements')[2], '1970-01-01');
  assertPrivate(result);
});

test('a hidden Files tab falls back to module items, including items left out of a module response', async (t) => {
  const s = setup(t);
  s.state.errors.listed = unavailable();
  s.state.modules = [{ id: 20, name: '강의', items_count: 1 }];
  s.state.moduleItems = [{ type: 'File', content_id: 2, title: '2주차' }];
  s.state.metadata.set(2, file(2));
  const out = await s.api.files({ course: 7 });
  assert.equal(out.count, 1);
  assert.equal(out.files[0].source, 'module');
  assert.equal(s.fetched.length, 0);
});

test('file references ignore other courses and hosts, invalid IDs and unpublished assignments', async (t) => {
  const s = setup(t);
  s.state.assignments = [
    { description: `<a href="${BASE}.evil.test/files/90">x</a><a href="https://evil.test/files/91">x</a>
      <a href="/courses/8/files/92">x</a><a href="/files/0">x</a><a href="/files/2">ok</a>` },
    { published: false, attachments: [file(99)] },
  ];
  s.state.metadata.set(2, file(2));
  assert.deepEqual((await s.api.files({ course: 7 })).files.map((r) => r.id), [2]);
});

test('partial listing failures are explained and LearningX-only courses return a useful note', async (t) => {
  const s = setup(t);
  s.state.errors = { listed: unavailable(), modules: unavailable(), assignments: unavailable(), announcements: unavailable() };
  const out = await s.api.files({ course: 7 });
  assert.equal(out.count, 0);
  assert.equal(out.errors.length, 3);
  assert.match(out.note, /LearningX/);
});

test('an expired token propagates from listing and download instead of looking like an empty course', async (t) => {
  const s = setup(t);
  s.state.errors.listed = new EtlAuthError('/api/v1/courses/7/files');
  await assert.rejects(s.api.files({ course: 7 }), EtlAuthError);
  s.state.metadata.set(2, new EtlAuthError('/api/v1/courses/7/files/2'));
  await assert.rejects(s.api.download({ course: 7, id: 2 }), EtlAuthError);
  assert.equal(s.fetched.length, 0);
});

test('download receives exactly one file, saves it atomically and reports its usable path', async (t) => {
  const s = setup(t);
  s.state.metadata.set(2, file(2));
  s.state.metadata.set(3, file(3));
  const out = await s.api.download({ course: 7, id: 2 });
  assert.equal(out.downloaded, true);
  assert.equal(out.reused, false);
  assert.equal(fs.readFileSync(out.path, 'utf8'), 'data');
  assert.equal(path.resolve(s.root, out.local_path), out.path);
  assert.equal(s.fetched.length, 1);
  assert.equal(s.fetched[0].headers.Authorization, `Bearer ${TOKEN}`);
  assert.equal(s.fetched[0].redirect, 'manual');
  assert.equal(savedFiles(s.root).length, 1);
  const records = JSON.parse(fs.readFileSync(s.recordsFile, 'utf8'));
  assert.deepEqual(Object.keys(records.files), ['2']);
  assert.equal(records.files[2].bytes, 4);
  assertPrivate(out);
  assertPrivate(records);
});

test('a saved file survives new handler instances and is listed and reused without another download', async (t) => {
  const s = setup(t);
  s.state.listed = [file(2)];
  s.state.metadata.set(2, file(2));
  const first = await s.api.download({ course: 7, id: 2 });
  const out = await s.make().download({ course: 7, id: 2 });
  assert.equal(out.reused, true);
  assert.equal(out.path, first.path);
  const listed = await s.make().files({ course: 7 });
  assert.equal(listed.downloaded_count, 1);
  assert.equal(listed.files[0].local_path, out.local_path);
  assert.equal(s.fetched.length, 1);
});

test('changed, deleted or truncated local files are downloaded again', async (t) => {
  const s = setup(t);
  s.state.metadata.set(2, file(2));
  const first = await s.api.download({ course: 7, id: 2 });
  s.state.metadata.set(2, file(2, { updated_at: '2026-10-14T03:00:00Z' }));
  assert.equal((await s.api.download({ course: 7, id: 2 })).reused, false);
  fs.unlinkSync(first.path);
  assert.equal((await s.api.download({ course: 7, id: 2 })).reused, false);
  fs.writeFileSync(first.path, 'd');
  assert.equal((await s.api.download({ course: 7, id: 2 })).reused, false);
  assert.equal(s.fetched.length, 4);
  assert.equal(savedFiles(s.root).length, 1);
});

test('metadata without a modification time cannot claim a saved copy is current', async (t) => {
  const s = setup(t);
  s.state.metadata.set(2, file(2, { updated_at: null }));
  await s.api.download({ course: 7, id: 2 });
  assert.equal((await s.api.download({ course: 7, id: 2 })).reused, false);
  assert.equal(s.fetched.length, 2);
});

test('a failed replacement keeps the previous complete file and its record', async (t) => {
  let fail = false;
  const s = setup(t, { fetch: () => fail ? new Response('bad', { status: 500 }) : new Response('data') });
  s.state.metadata.set(2, file(2));
  const first = await s.api.download({ course: 7, id: 2 });
  const records = fs.readFileSync(s.recordsFile, 'utf8');
  s.state.metadata.set(2, file(2, { updated_at: '2026-10-14T03:00:00Z' }));
  fail = true;
  await assert.rejects(s.api.download({ course: 7, id: 2 }), /500/);
  assert.equal(fs.readFileSync(first.path, 'utf8'), 'data');
  assert.equal(fs.readFileSync(s.recordsFile, 'utf8'), records);
  assert.equal(savedFiles(s.root).length, 1);
});

test('same-named files, including concurrent requests, get separate paths and never overwrite user files', async (t) => {
  const s = setup(t);
  const folder = path.join(s.root, '강의자료', COURSE.name);
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, 'lecture.pdf'), 'user copy');
  for (const id of [2, 3]) s.state.metadata.set(id, file(id, { display_name: 'lecture.pdf' }));
  const out = await Promise.all([s.api.download({ course: 7, id: 2 }), s.make().download({ course: 7, id: 3 })]);
  assert.deepEqual(out.map((r) => path.basename(r.path)).sort(), ['lecture (2).pdf', 'lecture (3).pdf']);
  assert.equal(fs.readFileSync(path.join(folder, 'lecture.pdf'), 'utf8'), 'user copy');
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(s.recordsFile, 'utf8')).files).sort(), ['2', '3']);
});

test('Windows-invalid names and directory traversal are made into safe path components', async (t) => {
  for (const name of ['CON.txt', 'NUL', 'LPT1.pdf', 'COM¹.pdf']) assert.ok(safeName(name, 'file').startsWith('_'));
  assert.equal(safeName('..', 'file'), 'file');
  assert.equal(safeName('a<>:"/\\|?*\u0000.pdf  ', 'file'), 'a__________.pdf');
  const long = safeName('가'.repeat(200) + '.pdf', 'file');
  assert.equal(long.length, 120);
  assert.ok(long.endsWith('.pdf'));
  const s = setup(t);
  s.state.courses = [{ ...COURSE, name: '../../outside:course' }];
  s.state.metadata.set(2, file(2, { display_name: '../../escape.pdf' }));
  const out = await s.api.download({ course: 7, id: 2 });
  assert.ok(out.path.startsWith(path.join(s.root, '강의자료') + path.sep));
  assert.equal(savedFiles(s.root).length, 1);
  assert.equal(fs.existsSync(path.join(s.dir, 'escape.pdf')), false);
});

test('a materials folder junction outside the chat folder is refused before downloading', async (t) => {
  const s = setup(t);
  const outside = path.join(s.dir, 'outside');
  fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(s.root, '강의자료'), process.platform === 'win32' ? 'junction' : 'dir');
  s.state.metadata.set(2, file(2));
  await assert.rejects(s.api.download({ course: 7, id: 2 }), /채팅 폴더 밖/);
  assert.deepEqual(fs.readdirSync(outside), []);
  assert.equal(s.fetched.length, 0);
});

test('a tampered saved path cannot reuse or overwrite a file outside the chat folder', async (t) => {
  const s = setup(t);
  const outside = path.join(s.dir, 'outside.pdf');
  fs.writeFileSync(outside, 'data');
  s.state.metadata.set(2, file(2));
  fs.writeFileSync(s.recordsFile, JSON.stringify({ files: { 2: {
    path: '../outside.pdf', updated_at: file(2).updated_at, size: 4, bytes: 4,
  } } }));
  const out = await s.api.download({ course: 7, id: 2 });
  assert.equal(out.reused, false);
  assert.notEqual(out.path, outside);
  assert.equal(fs.readFileSync(outside, 'utf8'), 'data');
});

test('videos, oversized, locked, hidden and unavailable files return only their eTL link', async (t) => {
  const s = setup(t);
  const cases = [
    { 'content-type': 'video/mp4' }, { mime_class: 'video' }, { size: MAX_BYTES + 1 },
    { locked_for_user: true }, { hidden_for_user: true }, { url: null },
  ];
  for (let i = 0; i < cases.length; i++) {
    s.state.metadata.set(i + 1, file(i + 1, cases[i]));
    const out = await s.api.download({ course: 7, id: i + 1 });
    assert.equal(out.downloaded, false);
    assert.ok(out.skip);
    assert.equal(out.url, `${BASE}/courses/7/files/${i + 1}`);
    assertPrivate(out);
  }
  assert.equal(s.fetched.length, 0);
  assert.deepEqual(fs.readdirSync(s.root), []);
});

test('a file linked in an announcement or submitted by the user can use fresh global metadata', async (t) => {
  const s = setup(t);
  s.state.denied.add('/api/v1/courses/7/files/2');
  s.state.denied.add('/api/v1/courses/7/files/3');
  s.state.announcements = [{ title: '자료', message: '<a href="/courses/7/files/2">자료</a>' }];
  s.state.assignments = [{ name: '제출물', submission: { attachments: [file(3)] } }];
  for (const id of [2, 3]) s.state.metadata.set(id, file(id));
  assert.equal((await s.api.download({ course: 7, id: 2 })).downloaded, true);
  assert.equal((await s.api.download({ course: 7, id: 3 })).assignment, '제출물');
  assert.equal(s.fetched.length, 2);
});

test('a global file outside the requested course is never probed or downloaded', async (t) => {
  const s = setup(t);
  s.state.denied.add('/api/v1/courses/7/files/2');
  s.state.metadata.set(2, file(2));
  await assert.rejects(s.api.download({ course: 7, id: 2 }), /찾을 수 없거나/);
  assert.ok(!s.calls.some((c) => c[1] === '/api/v1/files/2'));
  assert.equal(s.fetched.length, 0);
});

test('allowed storage redirects are followed by GET and receive no eTL authorization header', async (t) => {
  const s = setup(t, { fetch: (url) => url.startsWith(BASE)
    ? new Response(null, { status: 302, headers: { location: `${STORAGE}/bucket/file?X-Amz-Signature=private-signed-value` } })
    : new Response('data') });
  s.state.metadata.set(2, file(2));
  const out = await s.api.download({ course: 7, id: 2 });
  assert.equal(s.fetched.length, 2);
  assert.equal(s.fetched[1].headers.Authorization, undefined);
  assert.ok(s.fetched.every((r) => r.method === 'GET' && r.redirect === 'manual'));
  assertPrivate(out);
  assertPrivate(JSON.parse(fs.readFileSync(s.recordsFile, 'utf8')));
});

test('unsafe initial URLs and redirect destinations are refused without exposing signed query strings', async (t) => {
  const s = setup(t);
  const bad = [
    'http://myetl.snu.ac.kr/files/2', `${BASE}.evil.test/files/2`, 'https://127.0.0.1/file',
    'https://user:password@myetl.snu.ac.kr/files/2', 'https://myetl.snu.ac.kr:444/file',
  ];
  for (const url of bad) {
    s.state.metadata.set(2, file(2, { url: `${url}?signature=private-signed-value` }));
    await assert.rejects(s.api.download({ course: 7, id: 2 }), (e) => {
      assert.match(e.message, /허용되지 않은 주소/);
      assertPrivate(e.message);
      return true;
    });
  }
  assert.equal(s.fetched.length, 0);
  const redirect = setup(t, { fetch: () => new Response(null, { status: 302, headers: { location: bad[1] } }) });
  redirect.state.metadata.set(2, file(2));
  await assert.rejects(redirect.api.download({ course: 7, id: 2 }), /허용되지 않은 주소/);
  assert.equal(redirect.fetched.length, 1);
  assert.equal(savedFiles(redirect.root).length, 0);
});

test('redirect loops and missing locations stop without leaving a partial download', async (t) => {
  for (const headers of [{ location: '/files/2/download' }, {}]) {
    const s = setup(t, { fetch: () => new Response(null, { status: 302, headers }) });
    s.state.metadata.set(2, file(2));
    await assert.rejects(s.api.download({ course: 7, id: 2 }), /너무 여러 번|이동할 주소/);
    assert.ok(s.fetched.length <= 6);
    assert.equal(savedFiles(s.root).length, 0);
  }
});

test('the declared length and actual streamed bytes both enforce the download size limit', async (t) => {
  for (const headers of [{ 'content-length': '9' }, {}]) {
    const s = setup(t, { config: { maxBytes: 8 }, fetch: () => new Response('123456789', { headers }) });
    s.state.metadata.set(2, file(2, { size: 9 }));
    await assert.rejects(s.api.download({ course: 7, id: 2 }), /넘어 받지 않았습니다/);
    assert.equal(savedFiles(s.root).length, 0);
    assert.equal(fs.existsSync(s.recordsFile), false);
  }
});

test('a video response, truncated body or wrong metadata size is never saved as a complete file', async (t) => {
  for (const headers of [{ 'content-type': 'video/mp4' }, { 'content-length': '9' }, {}]) {
    const s = setup(t, { fetch: () => new Response('x', { headers }) });
    s.state.metadata.set(2, file(2));
    await assert.rejects(s.api.download({ course: 7, id: 2 }), /동영상|연결이 끊어졌습니다|크기가/);
    assert.equal(savedFiles(s.root).length, 0);
    assert.equal(fs.existsSync(s.recordsFile), false);
  }
});

test('timeouts and raw fetch errors remove partial files and reveal neither tokens nor signed URLs', async (t) => {
  const s = setup(t, { config: { timeoutMs: 20 }, fetch: (_url, { signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(new Error(`${TOKEN} private-signed-value`)), { once: true });
  }) });
  s.state.metadata.set(2, file(2));
  await assert.rejects(s.api.download({ course: 7, id: 2 }), (err) => {
    assert.match(err.message, /시간이 너무 오래/);
    assertPrivate(err.message);
    return true;
  });
  assert.equal(savedFiles(s.root).length, 0);
  const fail = setup(t, { fetch: () => { throw new Error(`${TOKEN} private-signed-value`); } });
  fail.state.metadata.set(2, file(2));
  await assert.rejects(fail.api.download({ course: 7, id: 2 }), (err) => { assertPrivate(err.message); return true; });
});

test('unknown courses and malformed file IDs fail before any binary download', async (t) => {
  const s = setup(t);
  await assert.rejects(s.api.files({ course: 8 }), /과목 ID/);
  for (const id of [0, -1, '../2', Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(s.api.download({ course: 7, id }), /파일 ID/);
  }
  assert.equal(s.fetched.length, 0);
});

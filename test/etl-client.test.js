'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { BASE, EtlAuthError, EtlError, createClient, nextLink } = require('../src/etl/client');

const TOKEN = 'fake-token-for-tests';

// A fake eTL: `routes` maps a path-and-query (or a full URL) to a reply, or to a function that
// makes one. A reply is { status = 200, body, link }; a body that isn't a string is sent as JSON.
function fakeEtl(routes) {
  const calls = [];
  async function fetch(url, init) {
    calls.push({ url, init });
    const u = new URL(url);
    let reply = routes[url] ?? routes[u.pathname + u.search];
    if (typeof reply === 'function') reply = await reply(u, init);
    if (!reply) return new Response('{"errors":[{"message":"not found"}]}', { status: 404 });
    const headers = { 'content-type': 'application/json' };
    if (reply.link) headers.link = reply.link;
    const body = typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body ?? null);
    return new Response(body, { status: reply.status ?? 200, headers });
  }
  return { fetch, calls };
}

const client = (routes) => {
  const etl = fakeEtl(routes);
  return { ...etl, api: createClient({ token: TOKEN, fetch: etl.fetch }) };
};

const COURSES = '/api/v1/courses?enrollment_state=active&include[]=total_scores&include[]=term&per_page=100';
const assignmentsPath = (id) => `/api/v1/courses/${id}/assignments?include[]=submission&order_by=due_at&per_page=100`;

function assertNoToken(err) {
  for (const s of [err.message, String(err), err.stack, JSON.stringify(err), String(err.cause ?? '')]) {
    assert.ok(!String(s).includes(TOKEN), `token leaked: ${s}`);
  }
}

test('requests are GETs to eTL with the bearer token and a JSON accept header', async () => {
  const { api, calls } = client({ '/api/v1/users/self': { body: { id: 7, name: '학생' } } });
  assert.deepEqual(await api.self(), { id: 7, name: '학생' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `${BASE}/api/v1/users/self`);
  assert.equal(calls[0].init.method, 'GET');
  assert.deepEqual(calls[0].init.headers, { Authorization: `Bearer ${TOKEN}`, Accept: 'application/json' });
});

test('each endpoint asks for exactly the plan’s path and query', async () => {
  const seen = [];
  const fetch = async (url) => {
    seen.push(url.slice(BASE.length));
    return new Response(url.includes('/assignments/') ? '{}' : '[]', { status: 200 });
  };
  const api = createClient({ token: TOKEN, fetch });
  await api.courses();
  await api.assignments(11);
  await api.assignment(11, 22);
  await api.announcements([11, 12], '2026-10-01', '2026-10-15');
  assert.deepEqual(seen, [
    COURSES,
    assignmentsPath(11),
    '/api/v1/courses/11/assignments/22?include[]=submission',
    '/api/v1/announcements?context_codes[]=course_11&context_codes[]=course_12&start_date=2026-10-01&end_date=2026-10-15&per_page=50',
  ]);
});

test('announcements for no courses makes no request', async () => {
  const { api, calls } = client({});
  assert.deepEqual(await api.announcements([], '2026-10-01', '2026-10-15'), []);
  assert.equal(calls.length, 0);
});

test('ids and dates that could change the path are refused before any request', async () => {
  const { api, calls } = client({});
  await assert.rejects(api.assignments('1/../../users'), TypeError);
  await assert.rejects(api.assignment(1, '2?x=1'), TypeError);
  await assert.rejects(api.announcements([1], '2026-10-01&x=1', '2026-10-15'), TypeError);
  await assert.rejects(api.get('https://example.com/api'), TypeError);
  await assert.rejects(api.get('//example.com/api'), TypeError);
  assert.equal(calls.length, 0);
});

test('a list follows Link rel="next" across pages', async () => {
  const { api, calls } = client({
    [COURSES]: { body: [{ id: 1 }], link: `<${BASE}/api/v1/courses?page=2&per_page=100>; rel="next", <${BASE}/api/v1/courses?page=1&per_page=100>; rel="first"` },
    '/api/v1/courses?page=2&per_page=100': { body: [{ id: 2 }], link: `<${BASE}/api/v1/courses?page=1&per_page=100>; rel="first", <${BASE}/api/v1/courses?page=3&per_page=100>; rel="next"` },
    '/api/v1/courses?page=3&per_page=100': { body: [{ id: 3 }], link: `<${BASE}/api/v1/courses?page=3&per_page=100>; rel="last"` },
  });
  assert.deepEqual(await api.courses(), [{ id: 1 }, { id: 2 }, { id: 3 }]);
  assert.equal(calls.length, 3);
  for (const c of calls) assert.equal(c.init.headers.Authorization, `Bearer ${TOKEN}`);
});

test('a relative next link resolves against the current page', async () => {
  const { api } = client({
    '/api/v1/x': { body: [1], link: '</api/v1/x?page=2>; rel="next"' },
    '/api/v1/x?page=2': { body: [2] },
  });
  assert.deepEqual(await api.getAll('/api/v1/x'), [1, 2]);
});

test('paging stops after 20 pages', async () => {
  let requests = 0;
  // Every page points at one more, forever.
  const fetch = async (url) => {
    requests++;
    const page = Number(new URL(url).searchParams.get('page') || 1);
    return new Response(JSON.stringify([page]), { status: 200, headers: { link: `<${BASE}/api/v1/x?page=${page + 1}>; rel="next"` } });
  };
  const items = await createClient({ token: TOKEN, fetch }).getAll('/api/v1/x');
  assert.equal(requests, 20);
  assert.deepEqual(items, Array.from({ length: 20 }, (_, i) => i + 1));
});

test('a next link off the eTL origin is refused, so the token never follows it', async () => {
  for (const next of ['https://evil.example/api/v1/courses?page=2', 'http://myetl.snu.ac.kr/api/v1/courses?page=2', '//evil.example/x']) {
    const { api, calls } = client({ [COURSES]: { body: [{ id: 1 }], link: `<${next}>; rel="next"` } });
    await assert.rejects(api.courses(), (e) => e instanceof EtlError && !e.message.includes('evil') && e.path === '/api/v1/courses');
    assert.equal(calls.length, 1, next);
  }
});

test('nextLink finds rel=next among other rels and ignores headers without one', () => {
  assert.equal(nextLink('<https://a/1>; rel="current", <https://a/2>; rel="next"'), 'https://a/2');
  assert.equal(nextLink('<https://a/2>; rel=next'), 'https://a/2');
  assert.equal(nextLink('<https://a/9>; rel="last"'), null);
  assert.equal(nextLink(null), null);
});

test('a while(1); prefix is stripped before the JSON is read', async () => {
  const { api } = client({
    '/api/v1/users/self': { body: 'while(1);{"id":5}' },
    '/api/v1/x': { body: 'while(1);[1,2]', link: `<${BASE}/api/v1/x?page=2>; rel="next"` },
    '/api/v1/x?page=2': { body: 'while(1);[3]' },
  });
  assert.deepEqual(await api.self(), { id: 5 });
  assert.deepEqual(await api.getAll('/api/v1/x'), [1, 2, 3]);
});

test('a 401 is an EtlAuthError', async () => {
  const { api } = client({ '/api/v1/users/self': { status: 401, body: { errors: [{ message: 'Invalid access token.' }] } } });
  await assert.rejects(api.self(), (e) => {
    assert.ok(e instanceof EtlAuthError);
    assert.ok(e instanceof EtlError);
    assert.equal(e.status, 401);
    assert.equal(e.path, '/api/v1/users/self');
    assertNoToken(e);
    return true;
  });
});

test('other HTTP errors name the path and status but not the query string', async () => {
  const { api } = client({ [assignmentsPath(3)]: { status: 500, body: 'oops' } });
  await assert.rejects(api.assignments(3), (e) => {
    assert.ok(e instanceof EtlError && !(e instanceof EtlAuthError));
    assert.equal(e.status, 500);
    assert.equal(e.path, '/api/v1/courses/3/assignments');
    assert.match(e.message, /500/);
    assert.match(e.message, /\/api\/v1\/courses\/3\/assignments/);
    assert.ok(!e.message.includes('?'));
    return true;
  });
});

test('a body that isn’t JSON is an EtlError', async () => {
  const { api } = client({ '/api/v1/users/self': { body: '<html>login</html>' } });
  await assert.rejects(api.self(), (e) => e instanceof EtlError && e.path === '/api/v1/users/self');
});

test('a list endpoint that returns an object is an EtlError', async () => {
  const { api } = client({ [COURSES]: { body: { errors: [] } } });
  await assert.rejects(api.courses(), EtlError);
});

test('the token never appears in an error, whatever went wrong', async () => {
  const echo = { status: 400, body: `bad token ${TOKEN}` };
  const { api } = client({
    '/api/v1/a': echo,
    '/api/v1/b': { status: 401, body: TOKEN },
    '/api/v1/c': { body: `not json ${TOKEN}` },
  });
  for (const p of ['/api/v1/a', '/api/v1/b', '/api/v1/c', '/api/v1/missing']) {
    await assert.rejects(api.get(p), (e) => {
      assertNoToken(e);
      return true;
    });
  }
  // A lower layer whose message quotes the request (headers and all).
  const leaky = createClient({
    token: TOKEN,
    fetch: async (url, init) => {
      throw new Error(`connect ECONNREFUSED ${url} ${JSON.stringify(init.headers)}`);
    },
  });
  await assert.rejects(leaky.get('/api/v1/users/self?x=1'), (e) => {
    assert.ok(e instanceof EtlError);
    assert.equal(e.status, undefined);
    assert.equal(e.path, '/api/v1/users/self');
    assertNoToken(e);
    return true;
  });
});

test('a missing or malformed token is refused without echoing it', () => {
  assert.throws(() => createClient({ token: '', fetch: async () => {} }), TypeError);
  assert.throws(() => createClient({ fetch: async () => {} }), TypeError);
  assert.throws(() => createClient({ token: 'abc\r\nX-Evil: 1', fetch: async () => {} }), (e) => !e.message.includes('X-Evil'));
});

test('assignmentsByCourse collects failed courses in errors and returns the rest in order', async () => {
  const { api } = client({
    [assignmentsPath(1)]: { body: [{ id: 101 }] },
    [assignmentsPath(2)]: { status: 403, body: 'forbidden' },
    [assignmentsPath(3)]: { body: [{ id: 301 }, { id: 302 }] },
    [assignmentsPath(4)]: { body: 'garbage' },
  });
  const courses = [1, 2, 3, 4].map((id) => ({ id, name: `과목${id}`, term: { name: '2026-2' } }));
  const { results, errors } = await api.assignmentsByCourse(courses);
  assert.deepEqual(results, [
    { course: courses[0], assignments: [{ id: 101 }] },
    { course: courses[2], assignments: [{ id: 301 }, { id: 302 }] },
  ]);
  assert.equal(errors.length, 2);
  assert.deepEqual(errors.map((e) => e.course), [{ id: 2, name: '과목2' }, { id: 4, name: '과목4' }]);
  assert.match(errors[0].error, /403/);
  assert.equal(typeof errors[1].error, 'string');
  for (const e of errors) assert.ok(!e.error.includes(TOKEN));
});

test('assignmentsByCourse rethrows an expired token instead of collecting it', async () => {
  const { api } = client({
    [assignmentsPath(1)]: { body: [] },
    [assignmentsPath(2)]: { status: 401, body: '' },
    [assignmentsPath(3)]: { body: [] },
  });
  await assert.rejects(api.assignmentsByCourse([1, 2, 3].map((id) => ({ id, name: `c${id}` }))), EtlAuthError);
});

test("a 401 for one thing the user may not see is a plain error, not a bad token", async () => {
  const denied = { status: 401, body: { status: 'unauthorized', errors: [{ message: 'user not authorized to perform that action' }] } };
  const { api } = client({ '/api/v1/courses/7/files?per_page=100': denied });
  await assert.rejects(api.getAll('/api/v1/courses/7/files?per_page=100'), (e) => {
    assert.ok(!(e instanceof EtlAuthError));
    assert.ok(e instanceof EtlError);
    assert.equal(e.status, 401);
    assert.match(e.message, /권한이 없습니다/);
    assertNoToken(e);
    return true;
  });
});

test('the same denial in Korean (an account set to Korean) is not a bad token either', async () => {
  const denied = { status: 401, body: { status: '권한이 없음', errors: [{ message: '사용자에게 이 동작을 수행할 권한이 없음' }] } };
  const { api } = client({ '/api/v1/courses/7/files?per_page=100': denied });
  await assert.rejects(api.getAll('/api/v1/courses/7/files?per_page=100'), (e) => {
    assert.ok(!(e instanceof EtlAuthError));
    assert.equal(e.status, 401);
    return true;
  });
  const { api: bad } = client({ '/api/v1/users/self': { status: 401, body: { errors: [{ message: '잘못된 액세스 토큰입니다.' }] } } });
  await assert.rejects(bad.self(), EtlAuthError);
});

test('an unauthorized status with an invalid token message still expires the token', async () => {
  const { api } = client({ '/api/v1/users/self': { status: 401, body: {
    status: 'unauthorized', errors: [{ message: 'Invalid access token.' }],
  } } });
  await assert.rejects(api.self(), EtlAuthError);
});

test('an ambiguous unauthorized response is not silently treated as a hidden course resource', async () => {
  const { api } = client({ '/api/v1/users/self': { status: 401, body: { status: 'unauthorized' } } });
  await assert.rejects(api.self(), EtlAuthError);
});

test('assignmentsByCourse collects a course the user may not see, and goes on', async () => {
  const { api } = client({
    [assignmentsPath(1)]: { body: [{ id: 10 }] },
    [assignmentsPath(2)]: { status: 401, body: { status: 'unauthorized', errors: [{ message: 'user not authorized to perform that action' }] } },
  });
  const { results, errors } = await api.assignmentsByCourse([1, 2].map((id) => ({ id, name: `c${id}` })));
  assert.deepEqual(results.map((r) => r.course.id), [1]);
  assert.deepEqual(errors.map((e) => e.course.id), [2]);
});

test('assignmentsByCourse runs at most 6 courses at once', async () => {
  let inFlight = 0;
  let peak = 0;
  const fetch = async (url) => {
    inFlight++;
    peak = Math.max(peak, inFlight);
    await new Promise((r) => setTimeout(r, 5));
    inFlight--;
    const id = /courses\/(\d+)\//.exec(url)[1];
    return new Response(JSON.stringify([{ id: Number(id) * 100 }]), { status: 200 });
  };
  const api = createClient({ token: TOKEN, fetch });
  const courses = Array.from({ length: 15 }, (_, i) => ({ id: i + 1, name: `c${i + 1}` }));
  const { results, errors } = await api.assignmentsByCourse(courses);
  assert.equal(peak, 6);
  assert.equal(errors.length, 0);
  assert.deepEqual(results.map((r) => r.assignments[0].id), courses.map((c) => c.id * 100));
});

test('assignmentsByCourse of no courses is empty', async () => {
  const { api, calls } = client({});
  assert.deepEqual(await api.assignmentsByCourse([]), { results: [], errors: [] });
  assert.equal(calls.length, 0);
});

test('getAll with orObject hands back an object answer as it is, and still pages lists', async () => {
  const { api } = client({
    '/api/v1/users/self/profile': { body: { id: 1 } },
    '/api/v1/x': { body: [1, 2], link: '<https://myetl.snu.ac.kr/api/v1/x?page=2>; rel="next"' },
    '/api/v1/x?page=2': { body: [3] },
  });
  assert.deepEqual(await api.getAll('/api/v1/users/self/profile', { orObject: true }), { id: 1 });
  assert.deepEqual(await api.getAll('/api/v1/x', { orObject: true }), [1, 2, 3]);
  await assert.rejects(api.getAll('/api/v1/users/self/profile'), /목록이 아닙니다/);
});

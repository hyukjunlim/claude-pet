'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { BASE, EtlAuthError, EtlError } = require('../src/etl/client');
const { createBoard, createBoardSession, jwtExpiry, launchForm } = require('../src/etl/board');

const NOW = Date.parse('2026-10-16T05:00:00Z');
const COURSE = { id: 305930, name: '2026-2 제어공학개론 (001)' };
const TOOL = 85;
const VERIFIER = 'private-verifier-value';
const SIGNATURE = 'private-oauth-signature';
const OWNER = 'owner-a';

const jwt = (exp) => [
  Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url'),
  Buffer.from(JSON.stringify({ user_login: '2022-00000', role: 'student', iat: exp - 7200, exp })).toString('base64url'),
  'private-jwt-signature',
].join('.');

const TABS = [
  { id: 'home', type: 'internal', label: '홈' },
  { id: `context_external_tool_${TOOL}`, type: 'external', label: '게시판' },
  { id: 'context_external_tool_48', type: 'external', label: '강의/출결' },
];

const launchPage = (action = `${BASE}/learningx/lti/learningx_board/boards`) => `<!doctype html><html><body>
<form action="${action}" method="POST" id="tool_form">
  <input type="hidden" name="oauth_signature" value="${SIGNATURE}">
  <input type="hidden" name="context_title" value="2026-2 &quot;제어&quot; &amp; 공학">
  <input type="hidden" name="custom_canvas_course_id" value="${COURSE.id}">
</form><script>document.getElementById('tool_form').submit()</script></body></html>`;

const BOARDS = [{
  id: 153242, type: 'anonymous', title: '아무거나 게시판', description: '<p>무기명 게시판</p>',
  total_post_count: 18, unread_post_count: 2, latest_post_created_at: '2026-10-15T17:19:18.000000Z',
}];
const POSTS = {
  items: [
    { id: 779536, idx: 19, depth: 0, user_name: '조교', title: '중간고사 공지', is_notice: true, is_secret: false,
      view_count: 89, attachment_count: 0, comment_count: 0, created_at: '2026-10-13T13:15:56.000000Z' },
    { id: 781528, idx: 20, depth: 1, user_name: '익명', title: 'Re: 질문', is_notice: false, is_secret: false,
      view_count: 3, attachment_count: 1, comment_count: 2, created_at: '2026-10-15T17:19:18.000000Z' },
  ],
  pagination: { total: 21, current_page: 1, last_page: 2, per_page: 20 },
};
const POST = {
  id: 779536, user_name: '조교', title: '중간고사 공지', is_notice: true, view_count: 89,
  content: '<p>일시: <strong>10월 22일</strong></p><p>장소: 301동</p>',
  attachments: [{ id: 787697, filename: '좌석표.pdf', filesize: 1234, url: `${BASE}/files/5/download?verifier=${VERIFIER}`, canvas_file_id: 5 }],
  comments: [{ user_name: '학생', content: '<p>감사합니다</p>', created_at: '2026-10-14T00:00:00.000000Z' }],
  post_url: `${BASE}/learningx/redirect/courses/${COURSE.id}/external_tools/${TOOL}?post_id=779536`,
  created_at: '2026-10-13T13:15:56.000000Z', updated_at: '2026-10-16T04:46:34.000000Z',
  prev_post: { id: 777092, title: '중간고사', user_name: '학생', created_at: '2026-10-11T12:56:04.000000Z' },
  next_post: null,
};

function setup(options = {}) {
  const state = {
    tabs: TABS, exp: Math.floor(NOW / 1000) + 7200, launches: 0, at: NOW,
    page: launchPage(), apiStatus: [], ...options.state,
  };
  const session = options.session || createBoardSession();
  const calls = [];
  const client = {
    async courses() { return [COURSE]; },
    async get(p) {
      calls.push(['get', p]);
      if (/\/tabs$/.test(p)) {
        if (state.tabs instanceof Error) throw state.tabs;
        return state.tabs;
      }
      if (/\/external_tools\/sessionless_launch\?id=\d+&launch_type=course_navigation$/.test(p)) {
        state.launches++;
        return { id: TOOL, name: '게시판', url: state.launchUrl ?? `${BASE}/courses/${COURSE.id}/external_tools/sessionless_launch?verifier=${VERIFIER}` };
      }
      throw new Error(`Unexpected API path: ${p}`);
    },
  };
  const fetched = [];
  const fetch = async (url, init = {}) => {
    fetched.push({ url, method: init.method, headers: init.headers, body: init.body });
    const u = new URL(url);
    if (u.pathname.endsWith('/external_tools/sessionless_launch')) return new Response(state.page, { headers: { 'content-type': 'text/html' } });
    if (u.pathname.startsWith('/learningx/lti/')) {
      const headers = new Headers({ 'content-type': 'text/html' });
      headers.append('set-cookie', 'laravel_session=abc; path=/; httponly');
      if (state.cookie !== false) headers.append('set-cookie', `xn_api_token=${jwt(state.exp)}; path=/; secure`);
      return new Response('<html></html>', { headers });
    }
    if (u.pathname.startsWith('/learningx/api/v1/learningx_board/')) {
      const forced = state.apiStatus.shift();
      if (forced) return new Response('<title>Invalid request.</title>', { status: forced });
      const rest = u.pathname.replace(`/learningx/api/v1/learningx_board/courses/${COURSE.id}`, '');
      const body = rest === '/boards' ? BOARDS : /\/posts$/.test(rest) ? POSTS : POST;
      return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };
  const make = (owner = OWNER) => createBoard({
    client, session, owner, fetch: options.fetch || fetch, now: () => state.at, timeoutMs: 0,
  });
  return { board: make(), make, state, session, calls, fetched };
}

function assertPrivate(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  for (const secret of [VERIFIER, SIGNATURE, 'private-jwt-signature', 'eyJ']) assert.ok(!text.includes(secret), secret);
}

const posts = (fetched) => fetched.filter((f) => f.method === 'POST');
const apiCalls = (fetched) => fetched.filter((f) => f.url.includes('/learningx/api/'));

test('boards launches the board tool once and reads LearningX with its token', async () => {
  const s = setup();
  const out = await s.board.boards({ course: COURSE.id });
  assert.deepEqual(out, {
    course: COURSE.name,
    course_id: COURSE.id,
    boards: [{
      board_id: 153242, title: '아무거나 게시판', anonymous: true, description: '무기명 게시판',
      posts: 18, unread: 2, latest_post: '2026-10-16(금) 02:19',
    }],
    url: `${BASE}/courses/${COURSE.id}/external_tools/${TOOL}`,
  });
  assertPrivate(out);

  // The one POST is the LTI launch, to LearningX on eTL, with exactly the form's fields decoded.
  const [launch] = posts(s.fetched);
  assert.equal(posts(s.fetched).length, 1);
  assert.equal(launch.url, `${BASE}/learningx/lti/learningx_board/boards`);
  assert.deepEqual([...new URLSearchParams(launch.body)], [
    ['oauth_signature', SIGNATURE], ['context_title', '2026-2 "제어" & 공학'], ['custom_canvas_course_id', String(COURSE.id)],
  ]);
  // The launch page is fetched without the Canvas token; the API gets LearningX's token.
  const page = s.fetched.find((f) => f.url.includes('sessionless_launch'));
  assert.ok(!page.headers.Authorization);
  assert.equal(apiCalls(s.fetched)[0].headers.Authorization, `Bearer ${jwt(s.state.exp)}`);
  assert.ok(s.fetched.every((f) => new URL(f.url).origin === BASE));
});

test('the LearningX token is reused across requests and courses until shortly before it expires', async () => {
  const s = setup();
  await s.board.boards({ course: COURSE.id });
  await s.make().posts({ course: COURSE.id, board: 153242 });
  assert.equal(s.state.launches, 1);

  s.state.at = s.state.exp * 1000 - 4 * 60 * 1000;   // within the 5-minute margin
  s.state.exp += 7200;                                // the next launch's token
  await s.make().post({ course: COURSE.id, board: 153242, id: 779536 });
  assert.equal(s.state.launches, 2);
});

test('a different eTL token never gets the cached LearningX token', async () => {
  const s = setup();
  await s.board.boards({ course: COURSE.id });
  await s.make('owner-b').boards({ course: COURSE.id });
  assert.equal(s.state.launches, 2);
});

test('requests at the same time share one launch', async () => {
  const s = setup();
  await Promise.all([s.make().boards({ course: COURSE.id }), s.make().boards({ course: COURSE.id })]);
  assert.equal(s.state.launches, 1);
});

test('a token LearningX turns down is dropped and the launch tried once more', async () => {
  const s = setup({ state: { apiStatus: [401] } });
  const out = await s.board.boards({ course: COURSE.id });
  assert.equal(out.boards.length, 1);
  assert.equal(s.state.launches, 2);

  const t = setup({ state: { apiStatus: [400, 400] } });
  await assert.rejects(t.board.boards({ course: COURSE.id }), (err) => {
    assert.match(err.message, /게시판이 펫의 접속을 거절했습니다/);
    assert.notEqual(err.status, 401, 'never read as an expired eTL token');
    return true;
  });
});

test('posts lists one page with notices, replies and the page count', async () => {
  const s = setup();
  const out = await s.board.posts({ course: COURSE.id, board: 153242, page: 1, keyword: '중간 고사' });
  assert.deepEqual(out.posts[1], {
    post_id: 781528, title: 'Re: 질문', author: '익명', notice: false, reply: true, secret: false,
    attachments: 1, comments: 2, views: 3, created: '2026-10-16(금) 02:19',
  });
  assert.equal(out.posts[0].notice, true);
  assert.deepEqual([out.page, out.last_page, out.total], [1, 2, 21]);
  const url = new URL(apiCalls(s.fetched)[0].url);
  assert.equal(url.pathname, `/learningx/api/v1/learningx_board/courses/${COURSE.id}/boards/153242/posts`);
  assert.deepEqual(Object.fromEntries(url.searchParams), { page: '1', filter: 'title', keyword: '중간 고사' });
});

test('post gives the text, attachment names without links, comments and neighbours', async () => {
  const s = setup();
  const out = await s.board.post({ course: COURSE.id, board: 153242, id: 779536 });
  assert.equal(out.text, '일시: 10월 22일\n장소: 301동');
  assert.deepEqual(out.attachments, [{ name: '좌석표.pdf', size: 1234, file_id: 5 }]);
  assert.equal(out.attachment_note, `첨부파일은 download ${COURSE.id} <file_id> --board 153242 --post 779536 로 받습니다.`);
  assert.deepEqual(out.comments, [{ author: '학생', text: '감사합니다', created: '2026-10-14(수) 09:00' }]);
  assert.deepEqual(out.previous, { id: 777092, title: '중간고사', author: '학생', created: '2026-10-11(일) 21:56' });
  assert.equal(out.next, null);
  assert.equal(out.url, POST.post_url);
  assertPrivate(out);
  // Only GETs after the launch: reading doesn't count a view.
  assert.ok(!s.fetched.some((f) => f.url.includes('view_count')));
});

test('attachment confirms a file is attached to the post before it may be downloaded', async () => {
  const s = setup();
  assert.deepEqual(await s.board.attachment({ course: COURSE.id, board: 153242, post: 779536, id: 5 }),
    { title: '중간고사 공지', url: POST.post_url });
  await assert.rejects(s.board.attachment({ course: COURSE.id, board: 153242, post: 779536, id: 6 }), /파일 ID 6인 첨부가 없습니다/);
  await assert.rejects(s.board.attachment({ course: COURSE.id, board: 153242, post: 0, id: 5 }), /글 ID/);
});

test('findAttachment opens only posts with attachments to find the one holding a file', async () => {
  const s = setup();
  assert.deepEqual(await s.board.findAttachment({ course: COURSE.id, id: 5 }), { title: '중간고사 공지', url: POST.post_url });
  const opened = apiCalls(s.fetched).map((f) => new URL(f.url).pathname).filter((p) => /\/posts\/\d+$/.test(p));
  assert.deepEqual(opened, [`/learningx/api/v1/learningx_board/courses/${COURSE.id}/boards/153242/posts/781528`]);
  assert.equal(await s.make().findAttachment({ course: COURSE.id, id: 6 }), null);

  const t = setup({ state: { tabs: TABS.filter((tab) => tab.label !== '게시판') } });
  assert.equal(await t.board.findAttachment({ course: COURSE.id, id: 5 }), null);
});

test('a course without a 게시판 tab says so without launching anything', async () => {
  const s = setup({ state: { tabs: TABS.filter((t) => t.label !== '게시판') } });
  await assert.rejects(s.board.boards({ course: COURSE.id }), /게시판 메뉴가 없습니다/);
  assert.equal(s.fetched.length, 0);

  const t = setup({ state: { tabs: new EtlError('not available', { status: 404 }) } });
  await assert.rejects(t.board.boards({ course: COURSE.id }), /게시판 메뉴가 없습니다/);

  const u = setup({ state: { tabs: new EtlAuthError('/tabs') } });
  await assert.rejects(u.board.boards({ course: COURSE.id }), EtlAuthError);
});

test('a launch that would leave eTL or LearningX posts nothing', async () => {
  for (const state of [
    { launchUrl: `https://evil.example/courses/${COURSE.id}/external_tools/sessionless_launch?verifier=x` },
    { launchUrl: `${BASE}/login/session_token?verifier=x` },
    { page: launchPage('https://evil.example/learningx/lti/learningx_board/boards') },
    { page: launchPage(`${BASE}/courses/1/submit`) },
    { page: '<html>no form</html>' },
    { cookie: false },
    { exp: Math.floor(NOW / 1000) + 60 },        // already inside the expiry margin
  ]) {
    const s = setup({ state });
    await assert.rejects(s.board.boards({ course: COURSE.id }), /게시판에 연결하지 못했습니다/, JSON.stringify(state));
    assert.ok(posts(s.fetched).every((f) => f.url === `${BASE}/learningx/lti/learningx_board/boards`));
    assert.ok(s.fetched.every((f) => new URL(f.url).origin === BASE));
  }
});

test('a failed connection never quotes the address it tried', async () => {
  const s = setup({ fetch: async (url) => { throw new Error(`connect ECONNREFUSED ${url}`); } });
  await assert.rejects(s.board.boards({ course: COURSE.id }), (err) => {
    assert.match(err.message, /eTL 연결 실패: 게시판 실행/);
    assertPrivate(err.message);
    return true;
  });
});

test('ids are checked and an unknown course is refused', async () => {
  const s = setup();
  await assert.rejects(s.board.posts({ course: COURSE.id, board: 0 }), /게시판 ID/);
  await assert.rejects(s.board.post({ course: COURSE.id, board: 1, id: -1 }), /글 ID/);
  await assert.rejects(s.board.boards({ course: 999 }), /ID 999를 찾을 수 없습니다/);
  assert.equal(s.fetched.length, 0);
});

test('launchForm and jwtExpiry read only what they need', () => {
  assert.equal(launchForm('<form action="/learningx/lti/x"><input name="a" value="1&amp;2"><input value="nameless"></form>').action,
    `${BASE}/learningx/lti/x`);
  assert.deepEqual(launchForm(`<form action='${BASE}/learningx/lti/x'><input name=a value=b></form>`).fields, [['a', 'b']]);
  assert.equal(launchForm('<form action="/courses/1"></form>'), null);
  assert.equal(jwtExpiry(jwt(1800000000)), 1800000000 * 1000);
  assert.equal(jwtExpiry('not-a-jwt'), null);
});

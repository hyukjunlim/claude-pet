'use strict';

// Course boards (게시판): the bridge's `boards`, `posts` and `post` commands.
//
// eTL's 게시판 tab is not Canvas: it's LearningX's board, an LTI tool on the same host with a JSON
// API under /learningx/api/v1/learningx_board/. That API doesn't take the Canvas token; it wants
// LearningX's own token (a JWT the browser keeps in the xn_api_token cookie, good for about two
// hours). The pet gets one the way the browser does, by launching the board tool:
//
//   1. GET  /api/v1/courses/<cid>/tabs                    the course's 게시판 tab -> its tool id
//   2. GET  /api/v1/courses/<cid>/external_tools/sessionless_launch?id=<tool>
//                                                        -> a one-time launch link (with a verifier)
//   3. GET  that link                                    -> Canvas's auto-submitting LTI form
//   4. POST the form to /learningx/lti/…                 -> Set-Cookie: xn_api_token=<JWT>
//
// Step 4 is the only POST the pet ever sends: a fixed LTI launch to LearningX on eTL's own host,
// with nothing but the fields Canvas signed. Everything after it is GET. The launch link, the
// form and the LearningX token stay in this module: no answer and no error message carries
// them. The token is kept in memory only (`session`), until shortly before it expires; it isn't
// tied to a course, so one launch serves every course.
//
// Reading a post doesn't count as a view: the board's own page sends a separate POST for that,
// and the pet doesn't. Attachments are Canvas files; files.js downloads them (see attachment()).

const { BASE, EtlAuthError, EtlError } = require('./client');
const { formatKst, htmlToText, usableCourses } = require('./model');

const API = `${BASE}/learningx/api/v1/learningx_board`;
const LTI_PATH = '/learningx/lti/';
const LAUNCH_PATH_RE = /^\/courses\/\d+\/external_tools\/sessionless_launch$/;
const TIMEOUT_MS = 20 * 1000;
const MAX_REDIRECTS = 3;
const MAX_HTML_BYTES = 1024 * 1024;   // Canvas's launch page is a few KB
const EXPIRY_MARGIN_MS = 5 * 60 * 1000;
const FALLBACK_TTL_MS = 30 * 60 * 1000;   // a token whose expiry can't be read
const BOARD_LABEL_RE = /게시판|board/i;
const POST_LIMIT = 8000;
const COMMENT_LIMIT = 2000;
const DESCRIPTION_LIMIT = 500;
const SEARCH_PAGES = 10;          // pages of each board looked through by findAttachment
const SEARCH_POSTS = 100;         // posts with attachments opened by findAttachment
const SEARCH_CONCURRENCY = 4;

const NO_BOARD = '이 과목에는 게시판 메뉴가 없습니다. eTL에서 과목 메뉴를 확인해 주세요.';
const LAUNCH_FAILED = '게시판에 연결하지 못했습니다. 잠시 후 다시 시도하고, 계속되면 eTL에서 게시판을 직접 열어 주세요.';
const REJECTED = '게시판이 펫의 접속을 거절했습니다. 잠시 후 다시 시도하고, 계속되면 eTL에서 게시판을 직접 열어 주세요.';

const validId = (v) => Number.isSafeInteger(Number(v)) && Number(v) > 0;

// The JWT's expiry (ms), or null. Only the payload is read; LearningX checks the signature.
function jwtExpiry(token) {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
    return Number.isFinite(payload?.exp) ? payload.exp * 1000 : null;
  } catch {
    return null;
  }
}

function decodeAttr(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|#39);/gi, (whole, name) => {
    const n = name.toLowerCase();
    if (n === 'amp') return '&';
    if (n === 'lt') return '<';
    if (n === 'gt') return '>';
    if (n === 'quot') return '"';
    if (n === 'apos') return "'";
    const code = n[1] === 'x' ? parseInt(n.slice(2), 16) : parseInt(n.slice(1), 10);
    try { return String.fromCodePoint(code); } catch { return whole; }
  });
}

function attr(attrs, name) {
  const m = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, 'i').exec(attrs);
  return m ? decodeAttr(m[1] ?? m[2] ?? m[3]) : null;
}

// The LTI form on Canvas's launch page: { action, fields } for the first form that posts to
// LearningX on eTL's host, or null. Reading the HTML never runs it.
function launchForm(html) {
  for (const m of String(html).matchAll(/<form\b([^>]*)>([\s\S]*?)<\/form>/gi)) {
    let action;
    try { action = new URL(attr(m[1], 'action') || '', BASE); } catch { continue; }
    if (action.origin !== BASE || !action.pathname.startsWith(LTI_PATH)) continue;
    const fields = [];
    for (const input of m[2].matchAll(/<input\b([^>]*)>/gi)) {
      const name = attr(input[1], 'name');
      if (name) fields.push([name, attr(input[1], 'value') ?? '']);
    }
    return { action: action.href, fields };
  }
  return null;
}

function cookieValue(res, name) {
  const all = typeof res.headers?.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  for (const c of all) {
    const [pair] = String(c).split(';');
    const eq = pair.indexOf('=');
    if (eq > 0 && pair.slice(0, eq).trim() === name) {
      try { return decodeURIComponent(pair.slice(eq + 1).trim()); } catch { return null; }
    }
  }
  return null;
}

// Holds the LearningX token between bridge requests (each request builds a new board). `owner`
// says whose it is, so a different eTL token never gets someone else's.
function createBoardSession() {
  let entry = null;           // { owner, token, until }
  let pending = null;         // { owner, promise }: a launch in progress, shared by requests
  return {
    get(owner, at) { return entry && entry.owner === owner && at < entry.until ? entry.token : null; },
    set(owner, token, until) { entry = { owner, token, until }; },
    drop(owner) { if (entry?.owner === owner) entry = null; },
    pending(owner) { return pending?.owner === owner ? pending.promise : null; },
    track(owner, promise) {
      pending = { owner, promise };
      const clear = () => { if (pending?.promise === promise) pending = null; };
      promise.then(clear, clear);
      return promise;
    },
  };
}

function createBoard({
  client, session, owner, fetch = globalThis.fetch, now = Date.now, timeoutMs = TIMEOUT_MS,
} = {}) {
  if (!client) throw new TypeError('createBoard needs a client');
  if (!session) throw new TypeError('createBoard needs a session');
  if (typeof owner !== 'string' || !owner) throw new TypeError('createBoard needs an owner');
  if (typeof fetch !== 'function') throw new TypeError('fetch를 사용할 수 없습니다.');
  const signal = () => (timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined);

  // A fetch whose own error message (which could quote the URL) never comes out.
  async function send(url, init, what) {
    try {
      return await fetch(url, { ...init, signal: signal() });
    } catch (err) {
      const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
      throw new EtlError(timedOut ? `eTL 응답 시간 초과: ${what}` : `eTL 연결 실패: ${what}`);
    }
  }

  async function courseFor(course) {
    if (!validId(course)) throw new TypeError('과목 ID는 1 이상의 정수여야 합니다.');
    const found = usableCourses(await client.courses()).find((c) => Number(c.id) === Number(course));
    if (!found) throw new Error(`수강 중인 과목에서 ID ${course}를 찾을 수 없습니다. courses 명령으로 과목 ID를 확인해 주세요.`);
    return found;
  }

  // Step 1: the course's board tool id, from its tabs (an external tab labelled 게시판).
  async function boardTool(courseId) {
    let tabs;
    try {
      tabs = await client.get(`/api/v1/courses/${courseId}/tabs`);
    } catch (err) {
      if (err instanceof EtlAuthError || !(err instanceof EtlError)) throw err;
      throw new Error(NO_BOARD);
    }
    const tab = (Array.isArray(tabs) ? tabs : []).find((t) => t?.type === 'external'
      && BOARD_LABEL_RE.test(String(t.label ?? '')) && /^context_external_tool_\d+$/.test(String(t.id)));
    if (!tab) throw new Error(NO_BOARD);
    return Number(String(tab.id).split('_').pop());
  }

  // GET within eTL's host, following at most MAX_REDIRECTS redirects that stay there.
  async function getPage(url) {
    let current = url;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const res = await send(current, { method: 'GET', redirect: 'manual', headers: { Accept: 'text/html' } }, '게시판 실행');
      if (res.status >= 300 && res.status < 400) {
        let next;
        try { next = new URL(res.headers.get('location') || '', current); } catch { next = null; }
        if (!next || next.origin !== BASE) throw new Error(LAUNCH_FAILED);
        current = next.href;
        continue;
      }
      if (!res.ok) throw new Error(LAUNCH_FAILED);
      const text = await res.text();
      if (text.length > MAX_HTML_BYTES) throw new Error(LAUNCH_FAILED);
      return text;
    }
    throw new Error(LAUNCH_FAILED);
  }

  // Steps 2-4 above: a fresh LearningX token, kept in `session` until shortly before it expires.
  async function launch(courseId, tool) {
    let link;
    try {
      link = await client.get(`/api/v1/courses/${courseId}/external_tools/sessionless_launch?id=${tool}&launch_type=course_navigation`);
    } catch (err) {
      if (err instanceof EtlAuthError || !(err instanceof EtlError)) throw err;
      throw new Error(LAUNCH_FAILED);
    }
    let url;
    try { url = new URL(link?.url); } catch { throw new Error(LAUNCH_FAILED); }
    if (url.origin !== BASE || !LAUNCH_PATH_RE.test(url.pathname)) throw new Error(LAUNCH_FAILED);
    const form = launchForm(await getPage(url.href));
    if (!form) throw new Error(LAUNCH_FAILED);
    const res = await send(form.action, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'text/html' },
      body: new URLSearchParams(form.fields).toString(),
    }, '게시판 실행');
    const token = cookieValue(res, 'xn_api_token');
    if (!token || !/^[\x21-\x7e]+$/.test(token)) throw new Error(LAUNCH_FAILED);
    const at = now();
    const exp = jwtExpiry(token);
    const until = exp != null ? exp - EXPIRY_MARGIN_MS : at + FALLBACK_TTL_MS;
    if (until <= at) throw new Error(LAUNCH_FAILED);
    session.set(owner, token, until);
    return token;
  }

  async function token(courseId, tool) {
    const cached = session.get(owner, now());
    if (cached) return cached;
    return session.pending(owner) || session.track(owner, launch(courseId, tool));
  }

  // A LearningX API answer for the course `c` (from open()). A token LearningX turns down (it
  // answers 400 or 401 then) is dropped and the launch done once more. No error here carries
  // status 401: the bridge would read that as the eTL token itself having expired.
  async function api({ id: courseId, tool }, pathAndQuery) {
    const what = pathAndQuery.split('?')[0];
    for (let attempt = 0; attempt < 2; attempt++) {
      const xn = await token(courseId, tool);
      const res = await send(`${API}${pathAndQuery}`, {
        method: 'GET',
        redirect: 'manual',
        headers: { Authorization: `Bearer ${xn}`, Accept: 'application/json' },
      }, what);
      if (res.status === 400 || res.status === 401) {
        session.drop(owner);
        continue;
      }
      if (res.status === 403 || res.status === 404) {
        throw new EtlError(`게시판에서 이 항목을 찾을 수 없거나 볼 권한이 없습니다(${res.status}).`, { status: res.status });
      }
      if (!res.ok) throw new EtlError(`게시판 요청 실패(${res.status}): ${what}`, { status: res.status });
      try {
        return JSON.parse(await res.text());
      } catch {
        throw new EtlError(`게시판 응답을 해석할 수 없습니다: ${what}`);
      }
    }
    throw new Error(REJECTED);
  }

  // The course and its board tab: { id, name, tool, url }.
  async function open(course) {
    const c = await courseFor(course);
    const tool = await boardTool(c.id);
    return { id: c.id, name: c.name, tool, url: `${BASE}/courses/${c.id}/external_tools/${tool}` };
  }

  const author = (p) => p?.user_name ?? p?.nickname ?? null;
  // LearningX's own link to a post, when it stays on eTL.
  const postLink = (p, fallback) => {
    try {
      const u = new URL(p?.post_url);
      return u.origin === BASE && !u.username && !u.password ? u.href : fallback;
    } catch {
      return fallback;
    }
  };

  // LearningX keeps an attachment as a Canvas file (in a folder hidden from students) and gives
  // { id, filename, filesize, url, canvas_file_id }. Its link isn't passed on.
  function attachmentRow(a) {
    return {
      name: a?.filename ?? a?.display_name ?? null,
      size: Number.isFinite(a?.filesize) ? a.filesize : Number.isFinite(a?.size) ? a.size : null,
      file_id: validId(a?.canvas_file_id) ? Number(a.canvas_file_id) : null,
    };
  }

  function commentRow(c) {
    return {
      author: author(c),
      text: htmlToText(c?.content ?? c?.comment ?? c?.body ?? '', COMMENT_LIMIT),
      created: formatKst(c?.created_at),
      ...(Array.isArray(c?.children) && c.children.length ? { replies: c.children.map(commentRow) } : {}),
    };
  }

  const neighbour = (p) => (p && validId(p.id) ? { id: p.id, title: p.title ?? null, author: author(p), created: formatKst(p.created_at) } : null);

  return {
    // The course's boards with their post counts.
    async boards({ course } = {}) {
      const c = await open(course);
      const list = await api(c, `/courses/${c.id}/boards`);
      return {
        course: c.name,
        course_id: c.id,
        boards: (Array.isArray(list) ? list : []).map((b) => ({
          board_id: b.id,
          title: b.title ?? null,
          anonymous: b.type === 'anonymous',
          description: htmlToText(b.description, DESCRIPTION_LIMIT),
          posts: b.total_post_count ?? null,
          unread: b.unread_post_count ?? null,
          latest_post: formatKst(b.latest_post_created_at),
        })),
        url: c.url,
      };
    },

    // One page (20 posts) of a board, newest first as the board shows it, notices on top.
    async posts({ course, board, page = 1, keyword } = {}) {
      if (!validId(board)) throw new TypeError('게시판 ID는 1 이상의 정수여야 합니다.');
      const c = await open(course);
      const q = new URLSearchParams({ page: String(page), filter: 'title', keyword: keyword ?? '' });
      const out = await api(c, `/courses/${c.id}/boards/${Number(board)}/posts?${q}`);
      const items = Array.isArray(out?.items) ? out.items : [];
      const pg = out?.pagination || {};
      return {
        course: c.name,
        board_id: Number(board),
        page: pg.current_page ?? page,
        last_page: pg.last_page ?? null,
        total: pg.total ?? null,
        posts: items.map((p) => ({
          post_id: p.id,
          title: p.title ?? null,
          author: author(p),
          notice: Boolean(p.is_notice),
          reply: Number(p.depth) > 0,
          secret: Boolean(p.is_secret),
          attachments: p.attachment_count ?? 0,
          comments: p.comment_count ?? 0,
          views: p.view_count ?? null,
          created: formatKst(p.created_at),
        })),
        url: c.url,
      };
    },

    // One post: its text, attachments (names only) and comments.
    async post({ course, board, id } = {}) {
      if (!validId(board)) throw new TypeError('게시판 ID는 1 이상의 정수여야 합니다.');
      if (!validId(id)) throw new TypeError('글 ID는 1 이상의 정수여야 합니다.');
      const c = await open(course);
      const p = await api(c, `/courses/${c.id}/boards/${Number(board)}/posts/${Number(id)}`);
      const attachments = Array.isArray(p?.attachments) ? p.attachments.map(attachmentRow) : [];
      const result = {
        course: c.name,
        board_id: Number(board),
        post_id: p?.id ?? Number(id),
        title: p?.title ?? null,
        author: author(p),
        notice: Boolean(p?.is_notice),
        created: formatKst(p?.created_at),
        updated: formatKst(p?.updated_at),
        views: p?.view_count ?? null,
        text: htmlToText(p?.content, POST_LIMIT),
        attachments,
        comments: Array.isArray(p?.comments) ? p.comments.map(commentRow) : [],
        previous: neighbour(p?.prev_post),
        next: neighbour(p?.next_post),
        url: postLink(p, c.url),
      };
      if (attachments.length) {
        result.attachment_note = `첨부파일은 download ${c.id} <file_id> --board ${Number(board)} --post ${result.post_id} 로 받습니다.`;
      }
      return result;
    },

    // Whether Canvas file `id` is attached to the post: { title, url } of the post, or an error.
    // files.js downloads a board attachment only after this says yes, since LearningX keeps
    // attachments in a folder Canvas marks hidden.
    async attachment({ course, board, post, id } = {}) {
      if (!validId(board)) throw new TypeError('게시판 ID는 1 이상의 정수여야 합니다.');
      if (!validId(post)) throw new TypeError('글 ID는 1 이상의 정수여야 합니다.');
      if (!validId(id)) throw new TypeError('파일 ID는 1 이상의 정수여야 합니다.');
      const c = await open(course);
      const p = await api(c, `/courses/${c.id}/boards/${Number(board)}/posts/${Number(post)}`);
      const found = (Array.isArray(p?.attachments) ? p.attachments : []).some((a) => Number(a?.canvas_file_id) === Number(id));
      if (!found) {
        throw new Error(`이 게시글에 파일 ID ${Number(id)}인 첨부가 없습니다. post 명령의 attachments에서 file_id를 확인해 주세요.`);
      }
      return { title: p?.title ?? null, url: postLink(p, c.url) };
    },

    // The post on any of the course's boards that has Canvas file `id` attached, as attachment()
    // gives it, or null (also when the course has no board). Only posts that say they have
    // attachments are opened, a few at a time, at most SEARCH_PAGES pages of each board and
    // SEARCH_POSTS posts in all.
    async findAttachment({ course, id } = {}) {
      if (!validId(id)) throw new TypeError('파일 ID는 1 이상의 정수여야 합니다.');
      let c;
      try {
        c = await open(course);
      } catch (err) {
        if (err.message === NO_BOARD) return null;
        throw err;
      }
      const boards = await api(c, `/courses/${c.id}/boards`);
      const candidates = [];
      const seen = new Set();                 // a new post can push one onto the next page meanwhile
      for (const b of Array.isArray(boards) ? boards : []) {
        if (!validId(b?.id)) continue;
        for (let page = 1; page <= SEARCH_PAGES; page++) {
          const out = await api(c, `/courses/${c.id}/boards/${Number(b.id)}/posts?page=${page}&filter=title&keyword=`);
          for (const p of Array.isArray(out?.items) ? out.items : []) {
            if (!validId(p?.id) || !(Number(p.attachment_count) > 0) || seen.has(Number(p.id))) continue;
            seen.add(Number(p.id));
            candidates.push([Number(b.id), Number(p.id)]);
          }
          if (!(Number(out?.pagination?.last_page) > page)) break;
        }
      }
      const queue = candidates.slice(0, SEARCH_POSTS);
      let found = null;
      async function worker() {
        while (!found && queue.length) {
          const [boardId, postId] = queue.shift();
          const p = await api(c, `/courses/${c.id}/boards/${boardId}/posts/${postId}`);
          const has = (Array.isArray(p?.attachments) ? p.attachments : []).some((a) => Number(a?.canvas_file_id) === Number(id));
          if (has && !found) found = { title: p?.title ?? null, url: postLink(p, c.url) };
        }
      }
      await Promise.all(Array.from({ length: Math.min(SEARCH_CONCURRENCY, queue.length) }, worker));
      return found;
    },
  };
}

module.exports = { createBoard, createBoardSession, jwtExpiry, launchForm };

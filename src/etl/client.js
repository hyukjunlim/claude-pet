'use strict';

// A read-only client for SNU eTL (Canvas LMS). It sends GET requests only.
//
// The token goes in the Authorization header and nowhere else: error messages name the
// request's path and status, never its query string, the token, or what a lower layer said
// (a failed fetch's message can quote anything). `fetch` is injectable so tests need no network.

const BASE = 'https://myetl.snu.ac.kr';
const MAX_PAGES = 20;
const CONCURRENCY = 6;                  // courses whose assignments are fetched at once
const TIMEOUT_MS = 20 * 1000;
const XSSI_PREFIX = /^\s*while\(1\);/;  // Canvas may guard JSON this way
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ID_RE = /^\d+$/;

class EtlError extends Error {
  constructor(message, { status, path } = {}) {
    super(message);
    this.name = 'EtlError';
    this.status = status;
    this.path = path;
  }
}

class EtlAuthError extends EtlError {
  constructor(path) {
    super('eTL 인증 실패(401): 토큰이 만료되었거나 잘못되었습니다.', { status: 401, path });
    this.name = 'EtlAuthError';
  }
}

// The URL of the Link header's rel="next" entry, or null.
function nextLink(header) {
  if (!header) return null;
  const re = /<([^>]*)>((?:\s*;\s*[^;,]*)*)/g;
  for (let m; (m = re.exec(header));) {
    for (const param of m[2].split(';')) {
      const rel = /^\s*rel\s*=\s*"?([^"]*)"?\s*$/i.exec(param);
      if (rel && rel[1].toLowerCase().split(/\s+/).includes('next')) return m[1];
    }
  }
  return null;
}

// Whether a 401 is Canvas's "user not authorized to perform that action" (this one resource),
// as opposed to "Invalid access token." Anything unclear counts as a bad token.
async function notAuthorizedHere(res) {
  let body = '';
  try {
    body = await res.text();
  } catch {
    return false;
  }
  try {
    const j = JSON.parse(String(body).replace(XSSI_PREFIX, ''));
    const messages = (Array.isArray(j?.errors) ? j.errors : []).map((e) => String(e?.message || ''));
    // `status: unauthorized` is shared by resource denials and invalid-token errors. Only
    // an explicit resource-denial message is enough to keep using the token.
    if (messages.some((m) => /(?:invalid|expired).*token|token.*(?:invalid|expired)/i.test(m))) return false;
    return messages.some((m) => /not authorized/i.test(m));
  } catch {
    return false;
  }
}

function checkId(id, what) {
  const s = String(id);
  if (!ID_RE.test(s)) throw new TypeError(`잘못된 ${what} ID입니다.`);
  return s;
}

function createClient({ token, fetch = globalThis.fetch, base = BASE, timeoutMs = TIMEOUT_MS } = {}) {
  // A header value with control characters would make fetch throw, and we can't vouch for
  // what that error says; Canvas tokens are printable ASCII anyway.
  if (typeof token !== 'string' || !/^[\x21-\x7e]+$/.test(token)) throw new TypeError('eTL 토큰이 없거나 형식이 잘못되었습니다.');
  if (typeof fetch !== 'function') throw new TypeError('fetch를 사용할 수 없습니다.');
  const origin = new URL(base).origin;
  const headers = { Authorization: `Bearer ${token}`, Accept: 'application/json' };

  // Last line of defence: no message we build should ever carry the token.
  const scrub = (s) => String(s).split(token).join('***');

  async function request(url) {
    const path = url.pathname;
    let res;
    try {
      res = await fetch(url.href, {
        method: 'GET',
        headers,
        signal: timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined,
      });
    } catch (e) {
      const timedOut = e?.name === 'TimeoutError' || e?.name === 'AbortError';
      throw new EtlError(scrub(timedOut ? `eTL 응답 시간 초과: ${path}` : `eTL 연결 실패: ${path}`), { path });
    }
    if (res.status === 401) {
      // Canvas answers 401 both for a bad token and for one thing this user may not see (a
      // course's hidden Files tab, say). Only the first means the token is bad.
      if (await notAuthorizedHere(res)) {
        throw new EtlError(scrub(`eTL에서 이 항목을 볼 권한이 없습니다(401): ${path}`), { status: 401, path });
      }
      throw new EtlAuthError(path);
    }
    if (!res.ok) throw new EtlError(scrub(`eTL 요청 실패(${res.status}): ${path}`), { status: res.status, path });
    let data;
    try {
      data = JSON.parse((await res.text()).replace(XSSI_PREFIX, ''));
    } catch {
      throw new EtlError(scrub(`eTL 응답을 해석할 수 없습니다: ${path}`), { status: res.status, path });
    }
    return { data, link: res.headers?.get?.('link') ?? null, path, status: res.status };
  }

  function urlOf(pathAndQuery) {
    if (typeof pathAndQuery !== 'string' || !pathAndQuery.startsWith('/') || pathAndQuery.startsWith('//')) {
      throw new TypeError('eTL 경로는 /로 시작해야 합니다.');
    }
    return new URL(origin + pathAndQuery);
  }

  async function get(pathAndQuery) {
    return (await request(urlOf(pathAndQuery))).data;
  }

  // Every page of a list, following Link rel="next" up to MAX_PAGES pages.
  async function getAll(pathAndQuery) {
    const out = [];
    let url = urlOf(pathAndQuery);
    for (let page = 0; url && page < MAX_PAGES; page++) {
      const { data, link, path, status } = await request(url);
      if (!Array.isArray(data)) throw new EtlError(`eTL 응답이 목록이 아닙니다: ${path}`, { status, path });
      out.push(...data);
      const next = nextLink(link);
      const current = url;
      url = null;
      if (next) {
        let nextUrl;
        try {
          nextUrl = new URL(next, current);
        } catch {
          nextUrl = null;
        }
        // The token would follow the link, so it must stay on eTL.
        if (!nextUrl || nextUrl.origin !== origin) {
          throw new EtlError(`eTL 다음 페이지 주소가 eTL 밖을 가리킵니다: ${path}`, { status, path });
        }
        url = nextUrl;
      }
    }
    return out;
  }

  const self = () => get('/api/v1/users/self');

  const courses = () => getAll('/api/v1/courses?enrollment_state=active&include[]=total_scores&include[]=term&per_page=100');

  const assignments = async (courseId) =>
    getAll(`/api/v1/courses/${checkId(courseId, '과목')}/assignments?include[]=submission&order_by=due_at&per_page=100`);

  const assignment = async (courseId, assignmentId) =>
    get(`/api/v1/courses/${checkId(courseId, '과목')}/assignments/${checkId(assignmentId, '과제')}?include[]=submission`);

  async function announcements(courseIds, startDate, endDate) {
    if (!courseIds?.length) return [];
    if (!DATE_RE.test(startDate) || !DATE_RE.test(endDate)) throw new TypeError('날짜는 YYYY-MM-DD 형식이어야 합니다.');
    const contexts = courseIds.map((id) => `context_codes[]=course_${checkId(id, '과목')}`).join('&');
    return getAll(`/api/v1/announcements?${contexts}&start_date=${startDate}&end_date=${endDate}&per_page=50`);
  }

  // Each course's assignments, CONCURRENCY courses at a time. A course that fails lands in
  // `errors` and the rest still come back; an expired token fails the whole call.
  async function assignmentsByCourse(list) {
    const items = Array.from(list || []);
    const slots = new Array(items.length);   // in the courses' order: { course, assignments } or { course, error }
    let nextIndex = 0;
    let authError = null;
    async function worker() {
      while (!authError && nextIndex < items.length) {
        const i = nextIndex++;
        const course = items[i];
        try {
          slots[i] = { course, assignments: await assignments(course.id) };
        } catch (e) {
          if (e instanceof EtlAuthError) {
            authError = authError || e;
            return;
          }
          if (!(e instanceof EtlError) && !(e instanceof TypeError)) throw e;
          slots[i] = { course: { id: course.id, name: course.name }, error: scrub(e.message) };
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, worker));
    if (authError) throw authError;
    const done = slots.filter(Boolean);
    return { results: done.filter((s) => !('error' in s)), errors: done.filter((s) => 'error' in s) };
  }

  return { get, getAll, self, courses, assignments, assignment, announcements, assignmentsByCourse };
}

module.exports = { BASE, MAX_PAGES, CONCURRENCY, EtlError, EtlAuthError, createClient, nextLink };

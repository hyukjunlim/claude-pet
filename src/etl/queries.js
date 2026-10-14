'use strict';

// The eTL lookups behind the bridge's commands: each turns Canvas JSON into the same `data`
// shape the Python prototype (etl.py / tools.py) printed, so the chat folder's instructions
// read it unchanged. Read-only; `client` is src/etl/client.js and `now` is injectable for tests.
//
// An EtlAuthError is never caught here: the bridge turns it into a "register the token again"
// message. A course whose assignments fail lands in `errors` as '<course name>: <message>'.

const { EtlAuthError, EtlError } = require('./client');
const {
  ANNOUNCEMENT_LIMIT, DESCRIPTION_LIMIT, formatKst, htmlToText, isOnline, isPublished, isSubmitted,
  currentCourses, matchesStatus, remaining, toMs, usableCourses,
} = require('./model');

const DAY_MS = 24 * 60 * 60 * 1000;
const LIST_LIMIT = 100;            // assignments in one list answer
const GRADED_LIMIT = 500;          // graded assignments across courses in a grades answer
const DEFAULT_ANNOUNCEMENT_DAYS = 7;
const MAX_ANNOUNCEMENT_DAYS = 60;
const BRIEFING_DAYS = 7;
const BRIEFING_ANNOUNCEMENT_DAYS = 3;

const API_MAX_CHARS = 1_500_000;   // an `api` answer, as JSON
const SIGNED_RE = /([?&](?:verifier|sf_verifier|download_frd_token|session_token)=)[^&#"\s]+/gi;
const FEED_RE = /(\/feeds\/[a-z_]+\/)[^\s"?#]+/gi;   // calendar and other feeds open with their own secret

// The KST calendar date of a moment, 'YYYY-MM-DD'.
const kstDate = (ms) => formatKst(ms).slice(0, 10);

// Signed links (a file's `url` carries a verifier that opens it without the token, a feed's path
// a secret of its own, a session_token link signs in) lose their signature before an `api` answer
// goes to the AI, as files.js never hands them out either.
function unsign(value) {
  if (typeof value === 'string') return value.replace(SIGNED_RE, '$1***').replace(FEED_RE, '$1***');
  if (Array.isArray(value)) return value.map(unsign);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, unsign(v)]));
  }
  return value;
}

// Reading a conversation marks it read unless told otherwise; looking shouldn't change eTL.
function readOnlyPath(p) {
  if (!/^\/api\/v1\/conversations\/\d+(\?|$)/.test(p) || /[?&]auto_mark_as_read=/.test(p)) return p;
  return `${p}${p.includes('?') ? '&' : '?'}auto_mark_as_read=false`;
}

// An `api` answer within API_MAX_CHARS: a list keeps as many items as fit and says so.
function capAnswer(path, data) {
  const size = (v) => JSON.stringify(v).length;
  if (size(data) <= API_MAX_CHARS) return { path, data };
  if (!Array.isArray(data)) {
    throw new Error('응답이 너무 큽니다. include[]를 줄이거나 더 좁은 경로로 다시 조회해 주세요.');
  }
  let lo = 0;
  let hi = data.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (size(data.slice(0, mid)) <= API_MAX_CHARS) lo = mid;
    else hi = mid - 1;
  }
  return { path, data: data.slice(0, lo), truncated: { shown: lo, total: data.length } };
}

function unknownCourse(course) {
  return new Error(`수강 중인 과목에서 ID ${course}를 찾을 수 없습니다. courses 명령으로 과목 ID를 확인해 주세요.`);
}

// One assignment as the prototype listed it. `_due` (ms or null, for sorting) and `_raw` (the
// Canvas object, for the status rules) are dropped before the answer goes out.
function summary(a, course, now) {
  const sub = a.submission || {};
  const types = Array.isArray(a.submission_types) ? a.submission_types : [];
  return {
    course: course.name,
    course_id: course.id,
    assignment_id: a.id,
    name: a.name ?? null,
    due: formatKst(a.due_at),
    remaining: remaining(a.due_at, now),
    points: a.points_possible ?? null,
    submission_types: types,
    online_submission: isOnline(a),
    submitted: isSubmitted(a),
    missing: Boolean(sub.missing),
    late: Boolean(sub.late),
    graded: sub.workflow_state === 'graded',
    score: sub.score ?? null,
    url: a.html_url ?? null,
    _due: toMs(a.due_at),
    _raw: a,
  };
}

// A summary without its underscore helpers.
const strip = ({ _due, _raw, ...rest }) => rest;

// Sorted by due time (no due time last), at most `limit`, without `_due`.
function finalize(items, limit = LIST_LIMIT) {
  const key = (x) => (x._due == null ? Infinity : x._due);
  return items
    .slice()
    .sort((x, y) => key(x) - key(y))
    .slice(0, limit)
    .map(strip);
}

function createQueries({ client, now = Date.now } = {}) {
  if (!client) throw new TypeError('createQueries needs a client');

  // This term's courses, or just the one asked for, from any term (an unknown ID is an error,
  // not an empty answer).
  async function coursesFor(course) {
    const list = await client.courses();
    if (course == null) return currentCourses(list);
    const all = usableCourses(list);
    const picked = all.filter((c) => Number(c.id) === Number(course));
    if (!picked.length) throw unknownCourse(course);
    return picked;
  }

  // Every published assignment of `courses` as summaries, plus per-course error strings.
  async function allAssignments(courses, at) {
    const { results, errors } = await client.assignmentsByCourse(courses);
    const items = [];
    for (const { course, assignments } of results) {
      for (const a of assignments || []) {
        if (a && isPublished(a)) items.push(summary(a, course, at));
      }
    }
    return { items, errors: errors.map((e) => `${e.course.name}: ${e.error}`) };
  }

  // The prototype's status filter, plus the `days` horizon for upcoming ones.
  function filterStatus(items, status, days, at) {
    const horizon = status === 'upcoming' && days ? at + days * DAY_MS : null;
    return items.filter((it) => matchesStatus(it._raw, status, at)
      && (horizon == null || it._due <= horizon));
  }

  function listResult(items, errors, at) {
    const result = { now: formatKst(at), count: items.length, assignments: finalize(items) };
    if (errors.length) result.errors = errors;
    return result;
  }

  async function announcementList(courses, days, at) {
    const names = new Map(courses.map((c) => [Number(c.id), c.name]));
    const start = kstDate(at - days * DAY_MS);
    const end = kstDate(at + DAY_MS);
    const raw = await client.announcements(courses.map((c) => c.id), start, end);
    const out = (raw || []).map((it) => {
      const cid = Number(String(it.context_code ?? 'course_0').split('_').pop());
      return {
        course: names.get(cid) ?? String(cid),
        title: it.title ?? null,
        posted: formatKst(it.posted_at),
        author: it.author?.display_name ?? null,
        text: htmlToText(it.message, ANNOUNCEMENT_LIMIT),
        url: it.html_url || it.url || null,
        _posted: toMs(it.posted_at),
      };
    });
    const key = (x) => (x._posted == null ? -Infinity : x._posted);
    out.sort((x, y) => key(y) - key(x));
    return out.map(({ _posted, ...rest }) => rest);
  }

  function courseRow(c) {
    const enrollments = Array.isArray(c.enrollments) ? c.enrollments : [];
    const enr = enrollments.find((e) => e && e.type === 'student') || {};
    return {
      course_id: c.id,
      name: c.name,
      term: c.term?.name ?? null,
      current_score: enr.computed_current_score ?? null,
      current_grade: enr.computed_current_grade ?? null,
    };
  }

  return {
    async check() {
      const me = await client.self();
      return { ok: true, user: me?.name ?? null, now: formatKst(now()) };
    },

    // 7 days of upcoming deadlines, everything missing, and 3 days of announcements.
    async briefing() {
      const at = now();
      const courses = await coursesFor(null);
      const { items, errors } = await allAssignments(courses, at);
      const upcoming = filterStatus(items, 'upcoming', BRIEFING_DAYS, at);
      const missing = filterStatus(items, 'missing', null, at);
      let announcements = [];
      try {
        announcements = await announcementList(courses, BRIEFING_ANNOUNCEMENT_DAYS, at);
      } catch (err) {
        // The deadlines are still worth answering with; only an expired token stops everything.
        if (err instanceof EtlAuthError || !(err instanceof EtlError)) throw err;
        errors.push(`공지: ${err.message}`);
      }
      return {
        now: formatKst(at),
        upcoming_7_days: finalize(upcoming),
        missing: finalize(missing),
        announcements_3_days: announcements,
        errors,
      };
    },

    // Every course, this term's first and marked `current`, so older ones can still be asked for.
    async courses() {
      const list = await client.courses();
      const current = new Set(currentCourses(list).map((c) => c.id));
      const rows = usableCourses(list).map((c) => ({ ...courseRow(c), current: current.has(c.id) }));
      return { courses: [...rows.filter((r) => r.current), ...rows.filter((r) => !r.current)] };
    },

    async assignments({ status = 'upcoming', days, course } = {}) {
      const at = now();
      const { items, errors } = await allAssignments(await coursesFor(course), at);
      return listResult(filterStatus(items, status, days, at), errors, at);
    },

    async assignment({ course, id } = {}) {
      const at = now();
      const [courses, a] = await Promise.all([client.courses(), client.assignment(course, id)]);
      const known = usableCourses(courses).find((c) => Number(c.id) === Number(course));
      return {
        ...strip(summary(a, known || { id: Number(course), name: String(course) }, at)),
        description: htmlToText(a.description, DESCRIPTION_LIMIT),
        unlock_at: formatKst(a.unlock_at),
        lock_at: formatKst(a.lock_at),
        allowed_extensions: a.allowed_extensions ?? null,
        allowed_attempts: a.allowed_attempts ?? null,
      };
    },

    async announcements({ days = DEFAULT_ANNOUNCEMENT_DAYS, course } = {}) {
      const n = Math.max(1, Math.min(Math.trunc(Number(days)) || DEFAULT_ANNOUNCEMENT_DAYS, MAX_ANNOUNCEMENT_DAYS));
      const list = await announcementList(await coursesFor(course), n, now());
      return { days: n, count: list.length, announcements: list };
    },

    // Each course's current score with its graded assignments (by due time).
    async grades({ course } = {}) {
      const at = now();
      const courses = await coursesFor(course);
      const { items, errors } = await allAssignments(courses, at);
      const graded = items.filter((a) => a.graded && a.score != null);
      const byCourse = new Map();
      for (const a of finalize(graded, GRADED_LIMIT)) {
        if (!byCourse.has(a.course_id)) byCourse.set(a.course_id, []);
        byCourse.get(a.course_id).push({ name: a.name, score: a.score, points: a.points, due: a.due });
      }
      const result = {
        courses: courses.map((c) => ({ ...courseRow(c), graded_assignments: byCourse.get(c.id) || [] })),
      };
      if (errors.length) result.errors = errors;
      return result;
    },

    // Any Canvas API path, read with GET, as eTL returns it (signed links aside). With `all`,
    // a list's later pages are followed too.
    async api({ path, all = false } = {}) {
      const p = readOnlyPath(path);
      const data = all ? await client.getAll(p, { orObject: true }) : await client.get(p);
      return capAnswer(p, unsign(data));
    },
  };
}

module.exports = { createQueries };

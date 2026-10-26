'use strict';

// Decides what in eTL is news: compares what a check fetched with what the last one saw, and
// turns the differences into bubble items. Pure: no clock, files or network (`now` is passed in),
// so EtlTracker does the fetching and saving and this file holds the rules (PLAN 5.3).
//
// A snapshot is what one check fetched:
//   {
//     unauthorized: bool,        // eTL answered 401; nothing else in the snapshot is read
//     results: [{ course: { id, name, ... }, assignments: [raw Canvas assignment] }],
//     errors: [{ course: { id, name }, error: string }],   // both as client.assignmentsByCourse gives them
//     announcements: [raw Canvas announcement] | null,      // null: fetching them failed
//   }
//
// The state it keeps between checks (EtlTracker stores it as `watch` in etl-state.json):
//   {
//     version: 1,
//     initialized: bool,                           // a check has set the baseline
//     assignments: { '<cid>:<aid>': { name, course, due: ms | null, score: number | null, submitted: bool,
//                                     online: bool, url: string | null } },
//     announcementsSeen: ['<id>', ...],            // oldest first, at most MAX_SEEN_ANNOUNCEMENTS
//     tokenExpiredNotified: bool,                  // the 401 bubble was shown; cleared by resetTokenExpired
//   }

const { formatKst, htmlToText, isGraded, isOnline, isPublished, isSubmitted, remaining, toMs } = require('./model');

const STATE_VERSION = 1;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const DEADLINE_WINDOW_MS = DAY_MS;            // a deadline's bubble shows this long before it
const URGENT_MS = 3 * HOUR_MS;                 // ... and turns red this close to it, if not handed in
const ANNOUNCE_WINDOW_MS = 14 * DAY_MS;
const MAX_SEEN_ANNOUNCEMENTS = 1000;
const NOTICE_TTL_MS = 3 * DAY_MS;              // how long a bubble stays
const TITLE_LIMIT = 200;
const DETAIL_LIMIT = 300;
const PROJECT_LIMIT = 80;
const ANNOUNCEMENT_SNIPPET = 200;
const ETL_URL = 'https://myetl.snu.ac.kr/';
const TOKEN_SETTINGS_URL = 'https://myetl.snu.ac.kr/profile/settings';
const ID_RE = /^\d+$/;

// Which bubbles go first when there are too many (lower first): PLAN 5.3's order, with the
// expired token up front and the one-off "connected" bubble last.
const PRIORITY = { token: 0, deadline: 1, due: 2, new: 3, grade: 4, ann: 5, connected: 6 };

function priorityOf(item) {
  const kind = String(item?.id || '').split(':')[1];
  return PRIORITY[kind] ?? 9;
}

function clip(s, n) {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

// Only links into eTL itself are kept; anything else is dropped rather than opened.
function etlUrl(url) {
  return typeof url === 'string' && url.startsWith(ETL_URL) ? url : null;
}

function assignmentUrl(a, cid, aid) {
  return etlUrl(a.html_url)
    || (ID_RE.test(cid) && ID_RE.test(aid) ? `${ETL_URL}courses/${cid}/assignments/${aid}` : null);
}

function item({ id, status = 'review', badge, title, project, detail, url, now, expiresAt }) {
  return {
    id,
    kind: 'etl',
    status,
    badge,
    title: clip(title, TITLE_LIMIT) || '(제목 없음)',
    project: clip(project, PROJECT_LIMIT),
    detail: clip(detail, DETAIL_LIMIT),
    url: etlUrl(url),
    since: now,
    expiresAt: expiresAt ?? now + NOTICE_TTL_MS,
  };
}

function tokenItem(now) {
  return item({
    id: 'etl:token',
    status: 'waiting',
    badge: '토큰 만료',
    title: 'eTL 토큰이 만료되었습니다',
    project: '새 토큰을 등록해 주세요',
    detail: 'eTL 설정에서 새 토큰을 만들고, 트레이 메뉴의 Sources → eTL에서 등록해 주세요.',
    url: TOKEN_SETTINGS_URL,
    now,
  });
}

// The state with the "token expired" bubble allowed again, for when a new token is registered.
function resetTokenExpired(state) {
  return state ? { ...state, tokenExpiredNotified: false } : state;
}

// A notice about a class moving gets its own badge: the AI can then put it in timetable.md.
function announcementBadge(n) {
  const text = `${n?.title ?? ''} ${htmlToText(n?.message, 2000)}`;
  if (/보강/.test(text)) return '보강 공지';
  if (/휴강|결강/.test(text)) return '휴강 공지';
  return '새 공지';
}

const scoreText = (n) => (typeof n === 'number' ? String(Math.round(n * 100) / 100) : String(n));

// A bubble for each assignment due in the next 24 hours, from what the last check saw, so a check
// that failed doesn't lose one: whether it's handed in or not, until the due time. Yellow while it
// isn't, red in its last 3 hours; green once it is; gray for work handed in on paper (eTL doesn't
// know). `hidden`: id -> until when a closed one stays out of sight (EtlTracker).
function deadlineItems(assignments, now, hidden = {}) {
  const out = [];
  for (const [key, rec] of Object.entries(assignments || {})) {
    const due = rec?.due;
    if (!Number.isFinite(due) || due <= now || due - now > DEADLINE_WINDOW_MS) continue;
    const id = `etl:deadline:${key}`;
    if (hidden[id] > now) continue;
    const offline = rec.online === false;
    const submitted = rec.submitted === true;
    // A short label, so the assignment's name still fits beside it; the rest goes on the line below.
    const [status, badge, timePrefix] = offline ? ['background', '오프라인', '마감 ']
      : submitted ? ['review', '제출함', '마감 ']
        : [due - now <= URGENT_MS ? 'failed' : 'waiting', '마감 임박', '미제출 · '];
    out.push({
      ...item({
        id, status, badge, title: rec.name, url: rec.url, now: due - DEADLINE_WINDOW_MS,
        project: `${timePrefix}${remaining(due, now)} · ${rec.course}`,
        detail: `${rec.course} · 마감 ${formatKst(due)}`,
        expiresAt: due,
      }),
      // `course`, `dueAt` and `timePrefix` let the tracker keep the time left in `project` current.
      course: rec.course,
      dueAt: due,
      timePrefix,
    });
  }
  return out;
}

function diff(prevState, snapshot, now) {
  const prev = prevState && typeof prevState === 'object' ? prevState : {};

  if (snapshot?.unauthorized) {
    // Said once; the rest of what we know stays as it was.
    if (prev.tokenExpiredNotified) return { state: prev, alerts: [] };
    return { state: { ...prev, tokenExpiredNotified: true }, alerts: [tokenItem(now)] };
  }

  const results = Array.isArray(snapshot?.results) ? snapshot.results : [];
  const errors = Array.isArray(snapshot?.errors) ? snapshot.errors : [];
  const announcements = Array.isArray(snapshot?.announcements) ? snapshot.announcements : null;
  // Nothing came back at all: keep the last state rather than baseline on an empty one.
  if (!results.length && errors.length && !announcements) return { state: null, alerts: [] };

  const firstRun = !prev.initialized;
  const oldRecords = prev.assignments && typeof prev.assignments === 'object' ? prev.assignments : {};
  const records = {};
  const alerts = [];
  const pending = [];        // first run: what's due and not yet handed in
  const courseNames = new Map();

  for (const { course, assignments } of results) {
    if (!course) continue;
    const cid = String(course.id);
    const courseName = course.name || cid;
    courseNames.set(cid, courseName);
    for (const a of Array.isArray(assignments) ? assignments : []) {
      if (!a || a.id == null || !isPublished(a)) continue;
      const aid = String(a.id);
      const key = `${cid}:${aid}`;
      const old = oldRecords[key];
      const due = toMs(a.due_at);
      const submitted = isSubmitted(a);
      const score = isGraded(a) ? a.submission.score : null;
      const url = assignmentUrl(a, cid, aid);
      const rec = { name: a.name || '(제목 없음)', course: courseName, due, score, submitted, online: isOnline(a), url };
      const dueText = due != null ? `마감 ${formatKst(due)} (${remaining(due, now)})` : '마감일 없음';

      if (!old) {
        if (!firstRun) {
          alerts.push(item({
            id: `etl:new:${key}`, badge: '새 과제', title: rec.name, url, now,
            project: due != null ? `${remaining(due, now)} · ${courseName}` : courseName,
            detail: `${courseName} · ${dueText}`,
          }));
        }
      } else {
        const oldDue = toMs(old.due);
        if (oldDue !== due) {
          const change = `${formatKst(oldDue) || '없음'} → ${formatKst(due) || '없음'}`;
          alerts.push(item({
            id: `etl:due:${key}:${due ?? 'none'}`, badge: '마감 변경', title: rec.name, url, now,
            project: `${courseName} · ${change}`,
            detail: `${courseName} · ${change}`,
          }));
        }
        if (score != null && old.score !== score) {
          const points = typeof a.points_possible === 'number' ? ` / ${scoreText(a.points_possible)}` : '';
          const result = `${scoreText(score)}${points}`;
          alerts.push(item({
            id: `etl:grade:${key}:${score}`, badge: '성적', title: rec.name, url, now,
            project: `${courseName} · ${result}`,
            detail: `${courseName} · 점수 ${result}`,
          }));
        }
      }

      // The first check's summary: online work not handed in yet, before its due time. (The
      // deadline bubbles themselves come from the records, see deadlineItems.)
      if (firstRun && due != null && !submitted && isOnline(a) && due > now) pending.push({ rec, due });
      records[key] = rec;
    }
  }
  for (const { course } of errors) if (course?.id != null) courseNames.set(String(course.id), course.name || String(course.id));

  // Assignments this check didn't see (a course that failed, one hidden for now) keep their
  // records, so they aren't "new" again when they come back.
  for (const [key, rec] of Object.entries(oldRecords)) if (!(key in records)) records[key] = rec;

  // Announcements: ids not seen before, posted in the last 14 days. If fetching them failed,
  // the ids we've seen stay as they were.
  let seen = Array.isArray(prev.announcementsSeen) ? prev.announcementsSeen.map(String) : [];
  if (announcements) {
    const seenSet = new Set(seen);
    const byPosted = [...announcements].filter((n) => n && n.id != null)
      .sort((x, y) => (toMs(x.posted_at) ?? 0) - (toMs(y.posted_at) ?? 0));
    for (const n of byPosted) {
      const id = String(n.id);
      if (seenSet.has(id)) continue;
      seenSet.add(id);
      seen.push(id);
      const posted = toMs(n.posted_at);
      if (firstRun || (posted != null && posted < now - ANNOUNCE_WINDOW_MS)) continue;
      const cid = String(n.context_code || '').replace(/^course_/, '');
      const courseName = courseNames.get(cid) || '';
      alerts.push(item({
        id: `etl:ann:${id}`, badge: announcementBadge(n), title: n.title || '(제목 없음)', now,
        url: n.html_url || n.url,
        project: courseName,
        detail: [courseName, htmlToText(n.message, ANNOUNCEMENT_SNIPPET)].filter(Boolean).join(' · '),
      }));
    }
    seen = seen.slice(-MAX_SEEN_ANNOUNCEMENTS);
  }

  if (firstRun) {
    pending.sort((x, y) => x.due - y.due);
    const next = pending[0];
    alerts.push(item({
      id: 'etl:connected', badge: 'eTL 연결됨', title: `마감 전 미제출 ${pending.length}건`, now,
      url: ETL_URL,
      project: next ? `다음 마감: ${next.rec.name} · ${remaining(next.due, now)}` : '새 과제와 마감을 알려 드립니다',
      detail: pending.slice(0, 5).map((p) => `${p.rec.course} | ${p.rec.name} | ${remaining(p.due, now)}`).join(', ')
        || '마감 전 미제출 과제가 없습니다.',
    }));
  }

  alerts.sort((x, y) => priorityOf(x) - priorityOf(y));
  return {
    state: {
      version: STATE_VERSION,
      initialized: true,
      assignments: records,
      announcementsSeen: seen,
      tokenExpiredNotified: false,
    },
    alerts,
  };
}

module.exports = {
  ANNOUNCE_WINDOW_MS,
  MAX_SEEN_ANNOUNCEMENTS,
  NOTICE_TTL_MS,
  TOKEN_SETTINGS_URL,
  deadlineItems,
  diff,
  priorityOf,
  resetTokenExpired,
};

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
//     assignments: { '<cid>:<aid>': { name, course, due: ms | null, score: number | null, reminded: ['24h', '3h'] } },
//     announcementsSeen: ['<id>', ...],            // oldest first, at most MAX_SEEN_ANNOUNCEMENTS
//     tokenExpiredNotified: bool,                  // the 401 bubble was shown; cleared by resetTokenExpired
//   }

const { formatKst, htmlToText, isGraded, isOnline, isPublished, isSubmitted, remaining, toMs } = require('./model');

const STATE_VERSION = 1;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const REMINDERS = [{ hours: 1, tag: '1h' }, { hours: 3, tag: '3h' }, { hours: 24, tag: '24h' }];   // shortest first
const ANNOUNCE_WINDOW_MS = 14 * DAY_MS;
const MAX_SEEN_ANNOUNCEMENTS = 1000;
const NOTICE_TTL_MS = 3 * DAY_MS;              // how long a bubble stays, unless it's a reminder
const TITLE_LIMIT = 200;
const DETAIL_LIMIT = 300;
const PROJECT_LIMIT = 80;
const ANNOUNCEMENT_SNIPPET = 200;
const ETL_URL = 'https://myetl.snu.ac.kr/';
const TOKEN_SETTINGS_URL = 'https://myetl.snu.ac.kr/profile/settings';
const ID_RE = /^\d+$/;

// Which bubbles go first when there are too many (lower first): PLAN 5.3's order, with the
// expired token up front and the one-off "connected" bubble last.
const PRIORITY = { token: 0, remind24h: 1, remind3h: 1, remind1h: 1, due: 2, new: 3, grade: 4, ann: 5, connected: 6 };

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
    detail: 'eTL 설정에서 새 토큰을 만들고, 트레이 메뉴의 eTL에서 등록해 주세요.',
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

// The reminder stage due now, if it hasn't been sent: the shortest stage the time left fits in.
// Sending it also counts every longer stage as sent, so a deadline first seen 2 hours out gets
// the 3-hour reminder only, and once.
function reminderDue(dueMs, reminded, now) {
  const left = dueMs - now;
  const stage = REMINDERS.find((r) => left <= r.hours * HOUR_MS);
  if (!stage || reminded.includes(stage.tag)) return null;
  const sent = REMINDERS.filter((r) => r.hours >= stage.hours).map((r) => r.tag);
  return { stage, reminded: [...new Set([...reminded, ...sent])].sort() };
}

function diff(prevState, snapshot, now) {
  const prev = prevState && typeof prevState === 'object' ? prevState : {};

  if (snapshot?.unauthorized) {
    // Said once; the rest of what we know stays as it was.
    if (prev.tokenExpiredNotified) return { state: prev, alerts: [], resolved: [] };
    return { state: { ...prev, tokenExpiredNotified: true }, alerts: [tokenItem(now)], resolved: [] };
  }

  const results = Array.isArray(snapshot?.results) ? snapshot.results : [];
  const errors = Array.isArray(snapshot?.errors) ? snapshot.errors : [];
  const announcements = Array.isArray(snapshot?.announcements) ? snapshot.announcements : null;
  // Nothing came back at all: keep the last state rather than baseline on an empty one.
  if (!results.length && errors.length && !announcements) return { state: null, alerts: [], resolved: [] };

  const firstRun = !prev.initialized;
  const oldRecords = prev.assignments && typeof prev.assignments === 'object' ? prev.assignments : {};
  const records = {};
  const alerts = [];
  const resolved = [];
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
      const rec = {
        name: a.name || '(제목 없음)',
        course: courseName,
        due,
        score,
        reminded: Array.isArray(old?.reminded) ? [...old.reminded] : [],
      };
      const url = assignmentUrl(a, cid, aid);
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
          // Pushed back, or given a due time it didn't have: remind again for the new one.
          if (due != null && (oldDue == null || due > oldDue)) rec.reminded = [];
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

      if (submitted) resolved.push(key);
      // Reminders: online, not handed in, and still before the due time.
      if (due != null && !submitted && isOnline(a) && due > now) {
        if (firstRun) pending.push({ rec, due });
        const r = reminderDue(due, rec.reminded, now);
        if (r) {
          rec.reminded = r.reminded;
          // `course` and `dueAt` let the tracker keep the time left in `project` current.
          alerts.push({
            ...item({
              id: `etl:remind${r.stage.tag}:${key}`, status: 'waiting', badge: '마감 임박', title: rec.name, url, now,
              project: `${remaining(due, now)} · ${courseName}`,
              detail: `${courseName} · ${dueText}`,
              expiresAt: due,
            }),
            course: courseName,
            dueAt: due,
          });
        }
      }
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
    resolved,
  };
}

module.exports = {
  ANNOUNCE_WINDOW_MS,
  MAX_SEEN_ANNOUNCEMENTS,
  NOTICE_TTL_MS,
  TOKEN_SETTINGS_URL,
  diff,
  priorityOf,
  resetTokenExpired,
};

'use strict';

// How eTL (Canvas) courses and assignments are read: which ones count, whether an assignment
// is submitted or missing, and how times and HTML bodies are shown. Pure functions; `now` is
// always passed in (ms since the epoch) so the rules are easy to test.

const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
const WEEKDAYS = '일월화수목금토';                 // indexed by Date#getUTCDay()
const SUBMITTED_STATES = new Set(['submitted', 'graded', 'pending_review']);
const OFFLINE_TYPES = new Set(['none', 'on_paper', 'not_graded']);
const STATUSES = new Set(['upcoming', 'missing', 'submitted', 'all']);
const ANNOUNCEMENT_LIMIT = 1200;
const DESCRIPTION_LIMIT = 4000;
const LINK_BASE = 'https://myetl.snu.ac.kr';      // site-relative links in eTL bodies point here

// ms since the epoch from an ISO string or a number; null when missing or unreadable.
function toMs(isoOrMs) {
  if (isoOrMs == null || isoOrMs === '') return null;
  const ms = typeof isoOrMs === 'number' ? isoOrMs : Date.parse(isoOrMs);
  return Number.isFinite(ms) ? ms : null;
}

// ------------------------------------------------------------------ courses and assignments

// Courses worth showing: named, and not closed off by their dates.
function usableCourses(courses) {
  return (Array.isArray(courses) ? courses : []).filter((c) => c && c.name && !c.access_restricted_by_date);
}

// eTL keeps every course a student ever took "active" and gives no end dates, so the term's
// name is what tells this semester apart: "2026년 2학기", "2022년 동계계절학기", …
const SEASONS = [[/1학기/, 1], [/하계|여름/, 2], [/2학기/, 3], [/동계|겨울/, 4]];

// A sortable number for a term name (year, then season), or null for one like "e-Class".
function termRank(name) {
  const s = String(name ?? '');
  const year = /(\d{4})\s*(?:년|-)/.exec(s);
  const season = SEASONS.find(([re]) => re.test(s));
  return year && season ? Number(year[1]) * 10 + season[1] : null;
}

// The usable courses of the latest term among them. Courses whose term can't be read go too
// (old boards and open courses); if no term can be read at all, all of them stay.
function currentCourses(courses) {
  const usable = usableCourses(courses);
  const ranks = usable.map((c) => termRank(c.term?.name));
  const latest = Math.max(...ranks.filter((r) => r != null));
  if (!Number.isFinite(latest)) return usable;
  return usable.filter((_, i) => ranks[i] === latest);
}

const submissionOf = (a) => a?.submission || {};

// An assignment without the field is published.
function isPublished(a) {
  return Boolean(a?.published ?? true);
}

function isSubmitted(a) {
  const sub = submissionOf(a);
  return SUBMITTED_STATES.has(sub.workflow_state) || Boolean(sub.submitted_at);
}

// Submitted through eTL, as opposed to on paper or not at all.
function isOnline(a) {
  const types = Array.isArray(a?.submission_types) ? a.submission_types : [];
  return types.some((t) => !OFFLINE_TYPES.has(t));
}

function isGraded(a) {
  const sub = submissionOf(a);
  return sub.workflow_state === 'graded' && sub.score != null;
}

// Not submitted, and either eTL says it's missing or it's an online assignment past its due time.
function isMissing(a, now) {
  if (isSubmitted(a)) return false;
  if (submissionOf(a).missing) return true;
  const due = toMs(a?.due_at);
  return due != null && due < now && isOnline(a);
}

function matchesStatus(a, status, now) {
  if (!STATUSES.has(status)) throw new RangeError(`알 수 없는 과제 상태입니다: ${status}`);
  if (status === 'all') return true;
  if (status === 'submitted') return isSubmitted(a);
  if (status === 'missing') return isMissing(a, now);
  const due = toMs(a?.due_at);
  return !isSubmitted(a) && due != null && due >= now;   // upcoming
}

// ------------------------------------------------------------------ times

// 'YYYY-MM-DD(요일) HH:MM' in KST, or null.
function formatKst(isoOrMs) {
  const ms = toMs(isoOrMs);
  if (ms == null) return null;
  const d = new Date(ms + KST_OFFSET_MS);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`
    + `(${WEEKDAYS[d.getUTCDay()]}) ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

// How long until (or since) a due time, to the minute: 'N일 N시간', 'N시간 N분' or 'N분',
// then '남음' or '지남'.
function remaining(isoOrMs, now) {
  const due = toMs(isoOrMs);
  if (due == null) return '마감일 없음';
  const secs = Math.trunc((due - now) / 1000);
  const suffix = secs >= 0 ? ' 남음' : ' 지남';
  const abs = Math.abs(secs);
  const d = Math.floor(abs / 86400);
  const h = Math.floor((abs % 86400) / 3600);
  const m = Math.floor((abs % 3600) / 60);
  const body = d ? `${d}일 ${h}시간` : h ? `${h}시간 ${m}분` : `${m}분`;
  return body + suffix;
}

// ------------------------------------------------------------------ HTML -> text

const BLOCK_TAGS = new Set([
  'p', 'div', 'br', 'li', 'tr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'table',
  'blockquote', 'pre', 'hr', 'section', 'article',
]);
const CELL_TAGS = new Set(['td', 'th']);
const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  middot: '·', hellip: '…', ndash: '–', mdash: '—', bull: '•',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', copy: '©', times: '×',
};
// <tag attrs>, </tag> or <tag/>, with quoted attribute values that may hold '>'.
const TAG_RE = /<(\/?)([a-zA-Z][\w:-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g;

function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name) => {
    if (name[0] === '#') {
      const code = name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      try {
        return code > 0 ? String.fromCodePoint(code) : whole;
      } catch {
        return whole;
      }
    }
    return NAMED_ENTITIES[name.toLowerCase()] ?? whole;
  });
}

function hrefOf(attrs) {
  const m = /(?:^|\s)href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i.exec(attrs);
  if (!m) return null;
  const href = decodeEntities(m[1] ?? m[2] ?? m[3]).trim();
  if (/^https?:\/\//i.test(href)) return href;
  if (href.startsWith('/') && !href.startsWith('//')) return LINK_BASE + href;
  return null;                                   // mailto:, javascript:, anchors and the like
}

// Plain text from an eTL HTML body: block tags start new lines, list items start with '- ',
// links read 'text (URL)', at most one blank line in a row, and at most `limit` characters
// (then '…').
function htmlToText(html, limit = DESCRIPTION_LIMIT) {
  if (!html) return '';
  const src = String(html)
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, '');
  let out = '';
  const links = [];                              // open <a>s: { href, start }
  const text = (raw) => {
    // Source line breaks are just spaces in HTML; only tags make new lines.
    out += decodeEntities(raw.replace(/[ \t\r\n\f]+/g, ' '));
  };
  let last = 0;
  for (const m of src.matchAll(TAG_RE)) {
    text(src.slice(last, m.index));
    last = m.index + m[0].length;
    const closing = m[1] === '/';
    const tag = m[2].toLowerCase();
    if (tag === 'a') {
      if (!closing) {
        links.push({ href: hrefOf(m[3]), start: out.length });
      } else if (links.length) {
        const { href, start } = links.pop();
        // A bare URL as its own link text needn't be repeated.
        if (href && out.slice(start).trim() !== href) out += ` (${href})`;
      }
      continue;
    }
    if (closing) continue;
    if (BLOCK_TAGS.has(tag)) out += '\n';
    if (tag === 'li') out += '- ';
    if (CELL_TAGS.has(tag)) out += ' ';
  }
  text(src.slice(last));

  let t = out
    .replace(/[ \t ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (limit != null && t.length > limit) {
    let cut = limit;
    const c = t.charCodeAt(cut - 1);
    if (c >= 0xd800 && c <= 0xdbff) cut--;      // don't split a surrogate pair
    t = t.slice(0, cut) + '…';
  }
  return t;
}

module.exports = {
  ANNOUNCEMENT_LIMIT,
  DESCRIPTION_LIMIT,
  usableCourses,
  currentCourses,
  termRank,
  isPublished,
  isSubmitted,
  isOnline,
  isGraded,
  isMissing,
  matchesStatus,
  formatKst,
  remaining,
  htmlToText,
  toMs,
};

'use strict';

// Checks eTL every half hour and keeps the eTL bubbles, the way CodexTracker keeps Codex's.
//
// Each check fetches courses, their assignments and the last 14 days of announcements, and
// hands them to watch.diff, which says what's news. The bubbles it makes stay 3 days or until you
// close them. Each assignment due in the next 24 hours also gets one, made afresh from the last
// check's records whenever the bubbles are drawn (watch.deadlineItems); closing it hides it for an
// hour. All of it lives in one state file (userData/etl-state.json), written atomically:
//   { version: 1, watch: <watch.js state>, items: [bubble item], hidden: { id: until },
//     lastChecked: ms | null }
// A closed bubble is taken out of `items`, so it stays closed across restarts without the
// 24-hour dismissal list main.js keeps for sessions (dismissedSnapshot() is empty).
//
// Nothing happens before start(): no file is read or written, no timer set, no request sent.

const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { EtlAuthError } = require('./client');
const { currentCourses, remaining } = require('./model');
const { deadlineItems, diff, priorityOf, resetTokenExpired } = require('./watch');
const { compareSessions } = require('../transcript');

const STATE_VERSION = 1;
const DEFAULT_INTERVAL_MS = 30 * 60 * 1000;
const MAX_ITEMS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
const ANNOUNCE_DAYS = 14;
const MAX_TIMEOUT_MS = 2 ** 31 - 1;             // setTimeout's limit
const OLD_REMINDER_RE = /^etl:remind\d+h:/;      // before deadline bubbles, one per reminder time
const COUNTDOWN_MS = 60 * 1000;                 // how often deadlines' time left is redone
const HIDE_MS = 60 * 60 * 1000;                 // how long a closed deadline bubble stays hidden
const DEADLINE_LEAD_MS = DAY_MS;                // a deadline's bubble comes this long before it (watch.js)
const PROJECT_LIMIT = 80;

// 'YYYY-MM-DD' of the KST day `ms` falls in.
const kstDate = (ms) => new Date(ms + KST_OFFSET_MS).toISOString().slice(0, 10);

// A deadline bubble shows the time left as of now, not as of the check that made it.
function withTimeLeft(it, now) {
  if (!Number.isFinite(it.dueAt) || typeof it.course !== 'string') return it;
  const project = `${it.timePrefix ?? ''}${remaining(it.dueAt, now)} · ${it.course}`;
  return { ...it, project: project.length > PROJECT_LIMIT ? `${project.slice(0, PROJECT_LIMIT - 1)}…` : project };
}

// Bubbles in display order: by status like sessions, then newest, then the more urgent kind,
// then the sooner deadline.
function sortItems(items) {
  return [...items].sort((a, b) => compareSessions(a, b) || priorityOf(a) - priorityOf(b)
    || (a.dueAt ?? Infinity) - (b.dueAt ?? Infinity));
}

// At most `max` bubbles, keeping the most urgent kinds and then the newest.
function capItems(items, max = MAX_ITEMS) {
  if (items.length <= max) return items;
  return [...items].sort((a, b) => priorityOf(a) - priorityOf(b) || (b.since || 0) - (a.since || 0)).slice(0, max);
}

class EtlTracker extends EventEmitter {
  constructor({
    createClient, stateFile, intervalMs = DEFAULT_INTERVAL_MS, now = Date.now,
    timers = { setInterval, clearInterval, setTimeout, clearTimeout },
  } = {}) {
    super();
    this.createClient = createClient;
    this.stateFile = stateFile;
    this.intervalMs = intervalMs;
    this.now = now;
    this.timers = timers;
    this.running = false;
    this.generation = 0;           // bumped by stop() and tokenChanged(): older checks' results are dropped
    this.inflight = null;          // the check under way
    this.interval = null;
    this.expiryTimer = null;
    this.unauthorized = false;     // eTL said 401: no requests until a new token is registered
    this.watch = null;
    this.itemList = [];
    this.hidden = {};              // deadline bubble id -> until when it stays closed
    this.lastChecked = null;
    this.lastError = null;
    this.lastEmitted = null;
    this.tokenReset = false;       // tokenChanged() before start(): applied once the state file is read
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.load();
    if (this.tokenReset) {
      this.tokenReset = false;
      this.forgetExpiredToken();
    }
    this.publish(true);
    this.interval = this.timers.setInterval(() => {
      this.checkNow().catch((err) => this.fail(err));
    }, this.intervalMs);
    this.checkNow().catch((err) => this.fail(err));
  }

  stop() {
    if (!this.running) return;
    this.running = false;
    this.generation++;
    this.inflight = null;
    this.timers.clearInterval(this.interval);
    this.timers.clearTimeout(this.expiryTimer);
    this.interval = null;
    this.expiryTimer = null;
    this.lastEmitted = null;
    this.emit('change', []);
  }

  // Check now, or join the check already under way.
  checkNow() {
    if (!this.running) return Promise.resolve();
    if (!this.inflight) {
      const p = this.check(this.generation).finally(() => {
        if (this.inflight === p) this.inflight = null;
      });
      this.inflight = p;
    }
    return this.inflight;
  }

  // A new token was registered (or the old one removed): say so again if it expires, and check.
  tokenChanged() {
    this.unauthorized = false;
    if (!this.running) {
      this.tokenReset = true;
      return Promise.resolve();
    }
    this.forgetExpiredToken();
    this.generation++;              // a check with the old token can't undo this
    this.inflight = null;
    this.save();
    this.publish();
    return this.checkNow();
  }

  forgetExpiredToken() {
    this.watch = resetTokenExpired(this.watch);
    this.itemList = this.itemList.filter((it) => it.id !== 'etl:token');
  }

  dismiss(id) {
    if (!this.running || !String(id).startsWith('etl:')) return;
    if (String(id).startsWith('etl:deadline:')) {   // back in an hour, until the due time
      this.hidden = { ...this.liveHidden(this.now()), [id]: this.now() + HIDE_MS };
      this.save();
      this.publish(true);
      return;
    }
    const before = this.itemList.length;
    this.itemList = this.itemList.filter((it) => it.id !== id);
    if (this.itemList.length === before) return;
    this.save();
    this.publish(true);
  }

  // Closed eTL bubbles are dropped from the state file instead (see the top of this file).
  dismissedSnapshot() {
    return {};
  }

  items() {
    if (!this.running) return [];
    const now = this.now();
    return sortItems([...this.itemList.filter((it) => !(it.expiresAt <= now)), ...this.deadlines(now)].map((it) => withTimeLeft(it, now)));
  }

  // The deadline bubbles due now (see the top of this file).
  deadlines(now) {
    return deadlineItems(this.watch?.assignments, now, this.hidden);
  }

  // The closed deadline bubbles still to stay hidden.
  liveHidden(now) {
    return Object.fromEntries(Object.entries(this.hidden).filter(([, until]) => until > now));
  }

  status() {
    return { lastChecked: this.lastChecked, error: this.lastError };
  }

  // ---------------------------------------------------------------- checking

  async check(gen) {
    const stale = () => gen !== this.generation || !this.running;
    if (this.unauthorized) {
      // Don't knock with a token eTL already turned down; the bubble saying so stays.
      this.publish();
      return;
    }
    let client;
    try {
      client = this.createClient();
    } catch (err) {
      this.setStatus(err?.message || String(err));
      return;
    }
    if (!client) {
      this.setStatus('eTL 토큰이 등록되지 않았습니다.');
      this.publish();
      return;
    }

    let snapshot;
    try {
      snapshot = await this.fetchSnapshot(client);
    } catch (err) {
      if (stale()) return;
      if (!(err instanceof EtlAuthError)) {
        this.setStatus(err?.message || String(err));
        this.fail(err);
        return;
      }
      snapshot = { unauthorized: true, results: [], errors: [], announcements: null };
    }
    if (stale()) return;

    const now = this.now();
    const { state, alerts } = diff(this.watch, snapshot, now);
    if (snapshot.unauthorized) {
      this.unauthorized = true;
    } else if (state) {
      this.itemList = this.itemList.filter((it) => it.id !== 'etl:token');
    }
    if (!state) {
      this.setStatus('eTL에서 과제와 공지를 모두 가져오지 못했습니다.');
      return;
    }
    this.watch = state;
    this.merge(alerts, now);
    if (!snapshot.unauthorized) this.lastChecked = now;
    this.save();
    this.setStatus(snapshot.unauthorized ? '토큰이 만료되었습니다. 새 토큰을 등록해 주세요.'
      : snapshot.errors.length ? `과목 ${snapshot.errors.length}개를 가져오지 못했습니다.`
        : snapshot.announcements ? null : '공지를 가져오지 못했습니다.');
    this.publish();
  }

  async fetchSnapshot(client) {
    const now = this.now();
    const courses = currentCourses(await client.courses());   // this term's only
    const ids = courses.map((c) => c.id);
    const [byCourse, announcements] = await Promise.all([
      client.assignmentsByCourse(courses),
      client.announcements(ids, kstDate(now - ANNOUNCE_DAYS * DAY_MS), kstDate(now + DAY_MS)).catch((err) => {
        if (err instanceof EtlAuthError) throw err;
        return null;                // fetching them failed: watch keeps the ids it has seen
      }),
    ]);
    return { unauthorized: false, results: byCourse.results, errors: byCourse.errors, announcements };
  }

  // New bubbles replace any with the same id (watch makes each one once per event); expired ones
  // go; then the cap.
  merge(alerts, now) {
    const fresh = new Set(alerts.map((a) => a.id));
    const kept = this.itemList.filter((it) => !fresh.has(it.id) && !(it.expiresAt <= now));
    this.itemList = capItems([...alerts, ...kept]);
  }

  setStatus(error) {
    this.lastError = error;
    this.emit('status', this.status());
  }

  // Send the visible bubbles if they changed, and wake up when the next one expires, a deadline
  // comes within 24 hours or a closed one is due back, or in a minute while a deadline's time
  // left is counting down.
  publish(force = false) {
    if (!this.running) return;
    const now = this.now();
    const live = this.itemList.filter((it) => !(it.expiresAt <= now));
    const hidden = this.liveHidden(now);
    if (live.length !== this.itemList.length || Object.keys(hidden).length !== Object.keys(this.hidden).length) {
      this.itemList = live;
      this.hidden = hidden;
      this.save();
    }
    const deadlines = this.deadlines(now);
    const shown = [...live, ...deadlines];
    const out = sortItems(shown.map((it) => withTimeLeft(it, now)));
    const key = JSON.stringify(out);
    if (force || key !== this.lastEmitted) {
      this.lastEmitted = key;
      this.emit('change', out);
    }
    this.timers.clearTimeout(this.expiryTimer);
    this.expiryTimer = null;
    const countdown = shown.some((it) => Number.isFinite(it.dueAt)) ? now + COUNTDOWN_MS : Infinity;
    const coming = Object.values(this.watch?.assignments || {})
      .map((rec) => rec?.due - DEADLINE_LEAD_MS).filter((t) => Number.isFinite(t) && t > now);
    const next = Math.min(countdown, ...shown.map((it) => it.expiresAt).filter(Number.isFinite), ...coming, ...Object.values(hidden));
    if (Number.isFinite(next)) {
      this.expiryTimer = this.timers.setTimeout(() => {
        this.expiryTimer = null;
        this.publish();
      }, Math.min(Math.max(next - now, 0) + 1000, MAX_TIMEOUT_MS));
    }
  }

  // ---------------------------------------------------------------- the state file

  load() {
    let j = null;
    try {
      j = JSON.parse(fs.readFileSync(this.stateFile, 'utf8'));
    } catch {
      // none yet, or unreadable: start over (the first check sets a new baseline)
    }
    if (!j || typeof j !== 'object') j = {};
    this.watch = j.watch && typeof j.watch === 'object' ? j.watch : null;
    this.itemList = Array.isArray(j.items)
      ? j.items.filter((it) => it && typeof it.id === 'string' && it.id.startsWith('etl:') && it.kind === 'etl'
        && !OLD_REMINDER_RE.test(it.id))   // the deadline bubbles take their place
      : [];
    this.hidden = j.hidden && typeof j.hidden === 'object'
      ? Object.fromEntries(Object.entries(j.hidden).filter(([id, until]) => id.startsWith('etl:deadline:') && Number.isFinite(until)))
      : {};
    this.lastChecked = Number.isFinite(j.lastChecked) ? j.lastChecked : null;
  }

  save() {
    if (!this.running) return;
    const data = JSON.stringify({
      version: STATE_VERSION, watch: this.watch, items: this.itemList, hidden: this.hidden, lastChecked: this.lastChecked,
    });
    const tmp = `${this.stateFile}.tmp`;
    try {
      fs.mkdirSync(path.dirname(this.stateFile), { recursive: true });
      fs.writeFileSync(tmp, data, 'utf8');
      fs.renameSync(tmp, this.stateFile);
    } catch (err) {
      this.fail(err);
    }
  }

  // A failed check or save is reported, not thrown: nobody listening mustn't crash the pet.
  fail(err) {
    if (this.listenerCount('error')) this.emit('error', err);
  }
}

module.exports = { EtlTracker, kstDate, MAX_ITEMS };

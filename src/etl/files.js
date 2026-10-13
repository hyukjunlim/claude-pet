'use strict';

// Course files on demand: the bridge's `files` and `download` commands.
//
//   files({ course })         lists a course's files and never downloads anything. It merges the
//                             Files tab, module File items, announcement and assignment
//                             attachments and links, and the user's own submission attachments.
//                             It also says which are already saved locally.
//   download({ course, id })  saves one file to <chat folder>/강의자료/<course>/<name> and
//                             returns its path. A file saved earlier that eTL hasn't changed since
//                             (same updated_at and size) and that is still on disk is returned
//                             as is, without fetching it again.
//
// Nothing here runs on its own: the tracker never calls it, and turning eTL on downloads nothing.
//
// What a download fetches: the file's `url` from fresh metadata, which answers with a redirect
// to signed object storage. Only https and the hosts in ALLOWED_HOSTS are followed (at most
// MAX_REDIRECTS hops), the token goes to eTL's own host only, and the signed URLs are neither
// stored nor put in any message. Videos, files over MAX_BYTES and files locked or hidden for the
// user are not downloaded; the answer carries their eTL page instead.
//
// Saved files are remembered in `recordsFile` (fileId -> updated_at, size, path relative to the
// chat folder), a JSON file of its own so it never races the tracker's etl-state.json. It's
// read and written synchronously, with no await in between, so two requests in this process
// can't interleave their updates.
//
// An EtlAuthError (the token itself is bad) always propagates. Any other EtlError on a
// per-course call (401/403/404 included) means "not available here" and is worked around.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { BASE, EtlAuthError, EtlError } = require('./client');
const { formatKst, isPublished, usableCourses } = require('./model');
const { isInside } = require('./workspace');

const MATERIALS_DIR = '강의자료';
const MAX_BYTES = 100 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const DOWNLOAD_TIMEOUT_MS = 4 * 60 * 1000;   // under the bridge's 5 minutes for `download`
const ETL_HOST = new URL(BASE).host;
const ALLOWED_HOSTS = new Set([ETL_HOST, 'kr.object.gov-ncloudstorage.com']);
const DETAIL_CONCURRENCY = 6;                // module files looked up at once
const DETAIL_LIMIT = 200;                    // referenced files looked up in one listing
const MAX_NAME_CHARS = 120;
const MAX_COURSE_DIR_CHARS = 80;
const MAX_SUFFIX = 999;

const FORBIDDEN_CHARS = /[<>:"/\\|?*\u0000-\u001f\u007f]/g;
const RESERVED_NAME = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])\s*(\..*)?$/i;

const SKIP = {
  video: '동영상 파일은 받지 않습니다. eTL에서 직접 보세요.',
  large: '100MB를 넘는 파일은 받지 않습니다. eTL에서 직접 받아 주세요.',
  locked: '아직 열리지 않았거나 잠긴 파일입니다. eTL에서 확인해 주세요.',
  hidden: '숨겨진 파일입니다. eTL에서 확인해 주세요.',
  noUrl: 'eTL이 이 파일의 다운로드 주소를 주지 않습니다. eTL에서 확인해 주세요.',
  noInfo: '파일 정보를 읽지 못했습니다. eTL에서 확인해 주세요.',
};

// ---- small helpers ------------------------------------------------------------------------

const isAuth = (err) => err instanceof EtlAuthError || err?.name === 'EtlAuthError';
// A failure that only means "this course doesn't offer that": worked around, never shown raw.
const isUnavailable = (err) => err instanceof EtlError && !isAuth(err);

// The value of a call, or { failed } when eTL says it isn't available; auth and other errors throw.
async function soft(promise) {
  try {
    return { value: await promise };
  } catch (err) {
    if (isUnavailable(err)) return { failed: err };
    throw err;
  }
}

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const contentType = (f) => f?.['content-type'] ?? f?.content_type ?? null;

function skipReason(f) {
  const type = String(contentType(f) || '').toLowerCase();
  if (type.startsWith('video/') || f?.mime_class === 'video') return SKIP.video;
  if (num(f?.size) != null && f.size > MAX_BYTES) return SKIP.large;
  if (f?.locked_for_user) return SKIP.locked;
  if (f?.hidden_for_user) return SKIP.hidden;
  return null;
}

const fileLink = (courseId, fileId) => `${BASE}/courses/${courseId}/files/${fileId}`;
const validId = (v) => Number.isSafeInteger(Number(v)) && Number(v) > 0;

// Only file links on eTL and in this course count. Reading HTML never executes its contents.
function linkedFiles(html, courseId) {
  const ids = new Set();
  const attrs = /\b(?:href|src|data-api-endpoint)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/gi;
  for (const m of String(html || '').matchAll(attrs)) {
    let url;
    try { url = new URL((m[1] ?? m[2] ?? m[3]).replace(/&amp;/gi, '&'), BASE); } catch { continue; }
    if (url.origin !== BASE || url.username || url.password) continue;
    const scoped = /^\/(?:api\/v1\/)?courses\/(\d+)\/files\/(\d+)(?:\/(?:download|preview))?\/?$/.exec(url.pathname);
    const global = /^\/(?:api\/v1\/)?files\/(\d+)(?:\/(?:download|preview))?\/?$/.exec(url.pathname);
    const id = scoped && Number(scoped[1]) === courseId ? scoped[2] : global?.[1];
    if (validId(id)) ids.add(Number(id));
  }
  return [...ids];
}

// Metadata and references exposed by announcements, assignments and the user's submissions.
function attachedFiles(assignments, announcements, courseId) {
  const out = [];
  const add = (item, source, labels, html) => {
    const attachments = [...(Array.isArray(item?.attachments) ? item.attachments : [])];
    if (item?.attachment) attachments.push(item.attachment);   // Canvas DiscussionTopic
    for (const f of attachments) {
      if (validId(f?.id)) out.push({ id: Number(f.id), meta: f, source, labels });
    }
    for (const id of linkedFiles(html, courseId)) out.push({ id, source, labels });
  };
  for (const a of assignments || []) {
    if (!a || !isPublished(a)) continue;
    const labels = { assignment: a.name ?? null };
    add(a, 'assignment', labels, a.description);
    add(a.submission, 'submission', labels);
  }
  for (const a of announcements || []) add(a, 'announcement', { announcement: a.title ?? null }, a.message);
  return out;
}

// A name that Windows (and every other OS) accepts as one path component: no forbidden or
// control characters, no trailing dots or spaces, not a reserved device name, not too long.
function safeName(raw, fallback, maxChars = MAX_NAME_CHARS) {
  let s = String(raw ?? '').normalize('NFC').replace(FORBIDDEN_CHARS, '_').trim();
  s = s.replace(/[\s.]+$/u, '');
  if (!s) s = fallback;
  if (RESERVED_NAME.test(s)) s = `_${s}`;
  if (s.length > maxChars) {
    const ext = path.extname(s);
    const keep = ext.length > 1 && ext.length <= 16 ? ext : '';
    s = s.slice(0, maxChars - keep.length).replace(/[\s.]+$/u, '') + keep;
  }
  return s;
}

const courseDirName = (c) => safeName(c.name, `course-${c.id}`, MAX_COURSE_DIR_CHARS);

// `name`, then "stem (2).ext", "stem (3).ext", ...
function* nameCandidates(name) {
  yield name;
  const ext = path.extname(name);
  const stem = ext && ext !== name ? name.slice(0, -ext.length) : name;
  const e = stem === name ? '' : ext;
  for (let n = 2; n <= MAX_SUFFIX; n++) yield `${stem} (${n})${e}`;
}

function derivesFrom(candidate, name) {
  for (const c of nameCandidates(name)) {
    if (sameName(c, candidate)) return true;
  }
  return false;
}

const sameName = (a, b) => (process.platform === 'win32' || process.platform === 'darwin'
  ? a.toLowerCase() === b.toLowerCase()
  : a === b);

// Lexically under `root` (not `root` itself), then again with links and junctions resolved.
function within(target, root) {
  const rel = path.relative(root, target);
  if (!rel || path.isAbsolute(rel) || rel === '..' || rel.startsWith(`..${path.sep}`)) return false;
  return isInside(target, root);
}

const toRel = (root, abs) => path.relative(root, abs).split(path.sep).join('/');

// ---- the records file -----------------------------------------------------------------------

function readRecords(file) {
  try {
    const obj = JSON.parse(fs.readFileSync(file, 'utf8'));
    const files = obj?.files;
    return files && typeof files === 'object' && !Array.isArray(files) ? files : {};
  } catch {
    return {};
  }
}

function writeRecords(file, files) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(tmp, `${JSON.stringify({ version: 1, files }, null, 2)}\n`);
    fs.renameSync(tmp, file);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* never written */ }
    throw err;
  }
}

// ---- the module -----------------------------------------------------------------------------

function createFiles({
  client,
  token,
  fetch = globalThis.fetch,
  workspaceDir,
  recordsFile,
  now = Date.now,
  maxBytes = MAX_BYTES,
  timeoutMs = DOWNLOAD_TIMEOUT_MS,
} = {}) {
  if (!client) throw new TypeError('createFiles needs a client');
  if (typeof token !== 'string' || !/^[\x21-\x7e]+$/.test(token)) throw new TypeError('eTL 토큰이 없거나 형식이 잘못되었습니다.');
  if (typeof fetch !== 'function') throw new TypeError('fetch를 사용할 수 없습니다.');
  if (typeof workspaceDir !== 'string' || !workspaceDir) throw new TypeError('createFiles needs the chat folder');
  if (typeof recordsFile !== 'string' || !recordsFile) throw new TypeError('createFiles needs a records file');
  const root = path.resolve(workspaceDir);

  async function courseFor(course) {
    if (!validId(course)) throw new TypeError('과목 ID는 1 이상의 정수여야 합니다.');
    const found = usableCourses(await client.courses()).find((c) => Number(c.id) === Number(course));
    if (!found) throw new Error(`수강 중인 과목에서 ID ${course}를 찾을 수 없습니다. courses 명령으로 과목 ID를 확인해 주세요.`);
    return found;
  }

  // The saved copy of file `id` if it's still on disk and matches eTL's `f`, else null.
  function savedCopy(record, f) {
    if (!record || typeof record.path !== 'string') return null;
    if (!f.updated_at || !Number.isFinite(Date.parse(f.updated_at))) return null;
    if ((record.updated_at ?? null) !== (f.updated_at ?? null)) return null;
    if ((record.size ?? null) !== num(f.size)) return null;
    const abs = path.join(root, ...record.path.split('/'));
    if (!within(abs, root)) return null;
    try {
      const st = fs.statSync(abs);
      if (!st.isFile() || (num(record.bytes) != null && st.size !== record.bytes)) return null;
    } catch {
      return null;
    }
    return { rel: toRel(root, abs), abs };
  }

  // ---- listing ----

  // The announcement API otherwise defaults to only the last 14 days. Files from older
  // announcements are still course materials, including when asking about a previous term.
  const announcementFiles = (courseId) => client.announcements(
    [courseId], '1970-01-01', new Date(now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
  );

  // Module items of type File as { id, title, module }, fetching items a module left out.
  async function moduleFiles(courseId) {
    const modules = await client.getAll(`/api/v1/courses/${courseId}/modules?include[]=items&per_page=100`);
    const out = [];
    for (const m of modules || []) {
      let items = m?.items;
      if (!Array.isArray(items) && m?.id != null && (m.items_count ?? 1) > 0) {
        items = (await soft(client.getAll(`/api/v1/courses/${courseId}/modules/${Number(m.id)}/items?per_page=100`))).value;
      }
      for (const it of items || []) {
        if (it?.type === 'File' && Number.isSafeInteger(Number(it.content_id)) && Number(it.content_id) > 0) {
          out.push({ id: Number(it.content_id), title: it.title ?? null, module: m.name ?? null });
        }
      }
    }
    return out;
  }

  // Details of referenced files the Files tab didn't list, a few at a time.
  async function details(courseId, ids) {
    const out = new Map();
    const queue = ids.slice(0, DETAIL_LIMIT);
    async function worker() {
      while (queue.length) {
        const id = queue.shift();
        const r = await soft(client.get(`/api/v1/courses/${courseId}/files/${id}`));
        if (r.value && typeof r.value === 'object') out.set(id, r.value);
      }
    }
    await Promise.all(Array.from({ length: Math.min(DETAIL_CONCURRENCY, queue.length) }, worker));
    return out;
  }

  function folderNames(folders) {
    const names = new Map();
    for (const f of folders || []) {
      if (f?.id == null) continue;
      const full = String(f.full_name ?? f.name ?? '');
      const label = full.replace(/^course files\/?/, '');
      names.set(Number(f.id), label || null);
    }
    return names;
  }

  function row(f, { id, name, source, labels = {}, url, records }) {
    const out = {
      id,
      name,
      size: num(f?.size),
      content_type: contentType(f),
      updated_at: formatKst(f?.updated_at),
      source,
    };
    for (const [k, v] of Object.entries(labels)) if (v) out[k] = v;
    out.downloaded = false;
    const skip = f ? skipReason(f) : SKIP.noInfo;
    if (skip) {
      out.skip = skip;
    } else {
      const saved = savedCopy(records[String(id)], f);
      if (saved) {
        out.downloaded = true;
        out.local_path = saved.rel;
      }
    }
    out.url = url;
    return out;
  }

  async function files({ course } = {}) {
    const c = await courseFor(course);
    const cid = Number(c.id);
    const errors = [];
    const [listed, folders, mods, assignments, announcements] = await Promise.all([
      soft(client.getAll(`/api/v1/courses/${cid}/files?per_page=100`)),
      soft(client.getAll(`/api/v1/courses/${cid}/folders?per_page=100`)),
      soft(moduleFiles(cid)),
      soft(client.assignments(cid)),
      soft(announcementFiles(cid)),
    ]);
    const records = readRecords(recordsFile);
    const byId = new Map();                       // file id -> row
    const folderOf = listed.value ? folderNames(folders.value) : new Map();
    const moduleOf = new Map((mods.value || []).map((m) => [m.id, m.module]));

    if (listed.failed && mods.failed) errors.push('과목 파일 목록과 모듈을 읽지 못했습니다.');
    for (const f of listed.value || []) {
      const id = Number(f?.id);
      if (!Number.isSafeInteger(id) || id <= 0 || byId.has(id)) continue;
      byId.set(id, row(f, {
        id,
        name: f.display_name || f.filename || `파일 ${id}`,
        source: 'files',
        labels: { folder: folderOf.get(Number(f.folder_id)) ?? null, module: moduleOf.get(id) ?? null },
        url: fileLink(cid, id),
        records,
      }));
    }

    if (assignments.failed) errors.push('과제 첨부·제출 파일 목록을 읽지 못했습니다.');
    if (announcements.failed) errors.push('공지 첨부 파일 목록을 읽지 못했습니다.');
    const refs = new Map();
    for (const m of mods.value || []) refs.set(m.id, { ...m, source: 'module', labels: { module: m.module } });
    for (const ref of attachedFiles(assignments.value, announcements.value, cid)) {
      const prev = refs.get(ref.id);
      refs.set(ref.id, prev ? { ...prev, meta: prev.meta || ref.meta, labels: { ...ref.labels, ...prev.labels } } : ref);
    }
    const missing = [...refs.values()].filter((r) => !byId.has(r.id));
    const found = await details(cid, missing.map((r) => r.id));
    if (missing.length > DETAIL_LIMIT) errors.push('파일이 많아 일부 파일의 상세 정보는 받기 요청 때 확인합니다.');
    for (const ref of refs.values()) {
      const listedRow = byId.get(ref.id);
      if (listedRow) {
        for (const [k, v] of Object.entries(ref.labels)) if (v && !listedRow[k]) listedRow[k] = v;
        continue;
      }
      const f = found.get(ref.id) || ref.meta || null;
      byId.set(ref.id, row(f, {
        id: ref.id,
        name: f?.display_name || f?.filename || ref.title || `파일 ${ref.id}`,
        source: ref.source,
        labels: ref.labels,
        url: fileLink(cid, ref.id),
        records,
      }));
    }

    const order = { files: 0, module: 0, assignment: 0, announcement: 0, submission: 1 };
    const label = (r) => r.folder || r.module || r.announcement || r.assignment || '';
    const list = [...byId.values()].sort((x, y) => order[x.source] - order[y.source]
      || label(x).localeCompare(label(y), 'ko', { numeric: true })
      || x.name.localeCompare(y.name, 'ko', { numeric: true }));

    const result = {
      course: c.name,
      course_id: cid,
      save_folder: `${MATERIALS_DIR}/${courseDirName(c)}`,
      count: list.length,
      downloaded_count: list.filter((r) => r.downloaded).length,
      files: list,
    };
    if (!list.length) {
      result.note = '이 과목에서 받을 수 있는 파일을 찾지 못했습니다. 자료가 주차학습(LearningX) 등에 있으면 eTL에서 직접 확인해야 합니다.';
    }
    if (errors.length) result.errors = errors;
    return result;
  }

  // ---- download ----

  // Fresh metadata for one course file, or a file explicitly attached or linked in that course.
  async function lookup(c, id) {
    const cid = Number(c.id);
    const direct = await soft(client.get(`/api/v1/courses/${cid}/files/${id}`));
    if (direct.value && typeof direct.value === 'object') return { meta: direct.value, link: fileLink(cid, id) };

    const [assignments, announcements] = await Promise.all([
      soft(client.assignments(cid)), soft(announcementFiles(cid)),
    ]);
    const ref = attachedFiles(assignments.value, announcements.value, cid).find((r) => r.id === id);
    if (!ref) return null;
    const own = await soft(client.get(`/api/v1/files/${id}`));
    const meta = own.value && typeof own.value === 'object' ? { ...ref.meta, ...own.value } : ref.meta;
    if (meta) return { meta, link: fileLink(cid, id), assignment: ref.labels.assignment };
    return null;
  }

  function allowedUrl(href, base) {
    let url;
    try {
      url = new URL(href, base);
    } catch {
      throw new Error('파일 주소를 해석할 수 없어 받지 않았습니다.');
    }
    if (url.protocol !== 'https:' || url.username || url.password || !ALLOWED_HOSTS.has(url.host)) {
      throw new Error(`허용되지 않은 주소(${url.protocol === 'https:' ? url.host : url.protocol})로 연결하려 해서 받지 않았습니다.`);
    }
    return url;
  }

  // The final response for the file, following allowed redirects by hand so each hop is checked
  // and the token stays on eTL. Messages name hosts only, never a (signed) URL.
  async function open(href, signal) {
    let url = allowedUrl(href, BASE);
    for (let hop = 0; ; hop++) {
      const headers = url.host === ETL_HOST ? { Authorization: `Bearer ${token}` } : {};
      let res;
      try {
        res = await fetch(url.href, { method: 'GET', headers, redirect: 'manual', signal });
      } catch {
        if (signal.aborted) throw new Error('파일을 받는 데 시간이 너무 오래 걸려 중단했습니다.');
        throw new Error(`파일을 받지 못했습니다. ${url.host}에 연결할 수 없습니다.`);
      }
      if (res.status >= 300 && res.status < 400) {
        const location = res.headers?.get?.('location');
        res.body?.cancel?.().catch(() => {});
        if (!location) throw new Error(`파일을 받지 못했습니다. ${url.host}가 이동할 주소를 주지 않았습니다.`);
        if (hop >= MAX_REDIRECTS) throw new Error('파일 주소가 너무 여러 번 바뀌어 받지 않았습니다.');
        url = allowedUrl(location, url);
        continue;
      }
      if (!res.ok) {
        res.body?.cancel?.().catch(() => {});
        throw new Error(`파일을 받지 못했습니다(${url.host} 응답 ${res.status}).`);
      }
      return res;
    }
  }

  // Streams the response body into `tmp`, stopping as soon as it passes maxBytes (the declared
  // Content-Length is checked first, but a server can't be trusted to send an honest one).
  async function save(res, tmp, signal) {
    const tooLarge = () => new Error(`파일이 ${Math.round(maxBytes / 1024 / 1024)}MB를 넘어 받지 않았습니다. eTL에서 직접 받아 주세요.`);
    const type = res.headers?.get?.('content-type') || '';
    if (type.toLowerCase().startsWith('video/')) {
      res.body?.cancel?.().catch(() => {});
      throw new Error(SKIP.video);
    }
    const length = res.headers?.get?.('content-length');
    const declared = length == null ? NaN : Number(length);
    if (Number.isFinite(declared) && declared > maxBytes) {
      res.body?.cancel?.().catch(() => {});
      throw tooLarge();
    }
    const fh = await fs.promises.open(tmp, 'wx');
    let total = 0;
    let failure = null;
    try {
      if (res.body) {
        for await (const chunk of res.body) {   // leaving the loop early cancels the stream
          total += chunk.byteLength;
          if (total > maxBytes) {
            failure = tooLarge();
            break;
          }
          try {
            await fh.writeFile(chunk);
          } catch {
            failure = new Error('파일을 쓰지 못했습니다. 디스크 공간과 채팅 폴더 권한을 확인해 주세요.');
            break;
          }
        }
      }
    } catch {
      failure = signal.aborted
        ? new Error('파일을 받는 데 시간이 너무 오래 걸려 중단했습니다.')
        : new Error('파일을 받는 중 연결이 끊어졌습니다. 다시 시도해 주세요.');
    } finally {
      await fh.close().catch(() => {});
    }
    if (failure) throw failure;
    if (signal.aborted) throw new Error('파일을 받는 데 시간이 너무 오래 걸려 중단했습니다.');
    // fetch may decompress responses, so their encoded Content-Length is not the saved size.
    if (Number.isFinite(declared) && !res.headers?.get?.('content-encoding') && total !== declared) {
      throw new Error('파일을 받는 중 연결이 끊어졌습니다. 다시 시도해 주세요.');
    }
    return total;
  }

  // The folder for course `c`, created, and refused if it resolves outside the chat folder.
  function courseDir(c) {
    const dir = path.join(root, MATERIALS_DIR, courseDirName(c));
    if (!within(dir, root)) throw new Error('저장 위치가 채팅 폴더 밖을 가리켜 받지 않았습니다.');
    fs.mkdirSync(dir, { recursive: true });
    if (!within(dir, root)) throw new Error('저장 위치가 채팅 폴더 밖을 가리켜 받지 않았습니다.');
    return dir;
  }

  // Where file `id` named `name` goes in `dir`: its earlier spot if that still fits the name,
  // else the first of name, "name (2)", ... that no other file owns and nothing occupies.
  function placeFor(dir, name, id, records) {
    const key = String(id);
    const owners = new Map();
    for (const [fid, r] of Object.entries(records)) {
      if (typeof r?.path === 'string') owners.set(r.path.toLowerCase(), fid);
    }
    const mine = records[key]?.path;
    if (typeof mine === 'string') {
      const abs = path.join(root, ...mine.split('/'));
      if (path.dirname(abs) === dir && derivesFrom(path.basename(abs), name)) return abs;
    }
    for (const candidate of nameCandidates(name)) {
      const abs = path.join(dir, candidate);
      const owner = owners.get(toRel(root, abs).toLowerCase());
      if (owner === key) return abs;
      if (owner !== undefined || fs.existsSync(abs)) continue;
      return abs;
    }
    throw new Error('같은 이름의 파일이 너무 많아 저장하지 못했습니다.');
  }

  async function download({ course, id } = {}) {
    if (!validId(id)) throw new TypeError('파일 ID는 1 이상의 정수여야 합니다.');
    const c = await courseFor(course);
    const cid = Number(c.id);
    const fid = Number(id);
    const found = await lookup(c, fid);
    if (!found) {
      throw new Error(`${c.name}에서 파일 ID ${fid}를 찾을 수 없거나 받을 권한이 없습니다. files 명령으로 파일 ID를 확인해 주세요.`);
    }
    const { meta, link } = found;
    const name = meta.display_name || meta.filename || `파일 ${fid}`;
    const base = {
      course: c.name,
      course_id: cid,
      id: fid,
      name,
      size: num(meta.size),
      content_type: contentType(meta),
      updated_at: formatKst(meta.updated_at),
    };
    if (found.assignment) base.assignment = found.assignment;

    const skip = skipReason(meta) || (meta.url ? null : SKIP.noUrl);
    if (skip) return { ...base, downloaded: false, skip, url: link };

    const saved = savedCopy(readRecords(recordsFile)[String(fid)], meta);
    if (saved) {
      return {
        ...base,
        downloaded: true,
        reused: true,
        message: '이미 받아 둔 최신 파일입니다. 다시 받지 않았습니다.',
        local_path: saved.rel,
        path: saved.abs,
        url: link,
      };
    }

    const dir = courseDir(c);
    const tmp = path.join(dir, `.download-${fid}-${crypto.randomBytes(6).toString('hex')}.part`);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let bytes;
    try {
      const res = await open(meta.url, controller.signal);
      bytes = await save(res, tmp, controller.signal);
      if (num(meta.size) != null && bytes !== meta.size) {
        throw new Error('받은 파일의 크기가 eTL 정보와 다릅니다. 다시 시도해 주세요.');
      }
    } catch (err) {
      try { fs.unlinkSync(tmp); } catch { /* never created */ }
      throw err;
    } finally {
      clearTimeout(timer);
    }

    // From here to the record write, nothing awaits: no other request can slip in between.
    let target;
    try {
      const records = readRecords(recordsFile);
      target = placeFor(dir, safeName(name, `file-${fid}`), fid, records);
      if (!within(target, root)) throw new Error('저장 위치가 채팅 폴더 밖을 가리켜 받지 않았습니다.');
      try {
        fs.renameSync(tmp, target);
      } catch {
        throw new Error('파일을 저장하지 못했습니다. 같은 파일이 다른 프로그램에서 열려 있으면 닫고 다시 시도해 주세요.');
      }
      records[String(fid)] = {
        course_id: cid,
        path: toRel(root, target),
        updated_at: meta.updated_at ?? null,
        size: num(meta.size),
        bytes,
        downloaded_at: new Date(now()).toISOString(),
      };
      writeRecords(recordsFile, records);
    } catch (err) {
      try { fs.unlinkSync(tmp); } catch { /* renamed already, or never there */ }
      throw err;
    }
    return {
      ...base,
      downloaded: true,
      reused: false,
      message: '파일을 받아 저장했습니다.',
      local_path: toRel(root, target),
      path: target,
      url: link,
    };
  }

  return { files, download };
}

module.exports = {
  ALLOWED_HOSTS, DOWNLOAD_TIMEOUT_MS, MATERIALS_DIR, MAX_BYTES, MAX_REDIRECTS, createFiles, safeName,
};

'use strict';

// Creates and refreshes the eTL chat folder: the folder the user opens once in the Claude
// desktop app (Code tab) or the Codex app, holding the instructions, skills and the `etl.js`
// CLI that asks the pet for eTL data.
//
// The folder is built from the template in <repo>/etl-workspace:
//   - Every template file is copied as is, except `todos.md.template`.
//   - `todos.md` is the user's own file. It is created from `todos.md.template` only when absent
//     and is never overwritten, not even when the template changes.
//   - `.etl-workspace-version` records a hash of the template. When the pet is updated and the
//     hash differs, every template file is rewritten. Between updates the user's copies are left
//     alone, but a template file that has gone missing is put back.
//   - Files dropped from the template in a later version are left in the folder. Telling a stale
//     template file from a file the user made there would need a manifest of past versions, and
//     a leftover instruction or skill file is harmless next to deleting something of the user's.

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TEMPLATE_DIR = path.join(__dirname, '..', '..', 'etl-workspace');
const VERSION_FILE = '.etl-workspace-version';
const TODOS_FILE = 'todos.md';
const TODOS_TEMPLATE = 'todos.md.template';
const DEFAULT_TODOS = '# 할 일\n\n## 진행 중\n\n## 완료\n';   // if the template lacks its own

function defaultWorkspaceDir() {
  return path.join(os.homedir(), 'Documents', 'etl-assistant');
}

// Relative paths (with '/') of the files to copy from the template, sorted so the version hash
// doesn't depend on directory order. Symlinks and other odd entries are skipped.
function templateFiles(templateDir) {
  const out = [];
  const walk = (rel) => {
    for (const entry of fs.readdirSync(path.join(templateDir, rel), { withFileTypes: true })) {
      const child = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(child);
      else if (entry.isFile() && !isSpecial(child)) out.push(child);
    }
  };
  walk('');
  return out.sort();
}

// Files the template must never place: the user's todo list (the template dir shouldn't hold
// one, but if it did it would clobber theirs) and the version stamp.
function isSpecial(rel) {
  return rel === TODOS_TEMPLATE || rel === TODOS_FILE || rel === VERSION_FILE;
}

function templateVersion(templateDir, files = templateFiles(templateDir)) {
  const hash = crypto.createHash('sha256');
  for (const rel of files) {
    hash.update(rel);
    hash.update('\0');
    hash.update(fs.readFileSync(path.join(templateDir, rel)));
    hash.update('\0');
  }
  return hash.digest('hex');
}

function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

// Writes through a temp file and a rename, so an AI session reading the file never sees half of it.
function writeAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, file);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}

// Creates `todos.md` if there isn't one. The 'wx' flag makes it a no-op rather than an overwrite
// if a file appears in between.
function ensureTodos(dir, templateDir) {
  const file = path.join(dir, TODOS_FILE);
  if (fs.existsSync(file)) return false;
  const content = readText(path.join(templateDir, TODOS_TEMPLATE)) ?? DEFAULT_TODOS;
  try {
    fs.writeFileSync(file, content, { flag: 'wx' });
    return true;
  } catch (err) {
    if (err.code === 'EEXIST') return false;
    throw err;
  }
}

// Sets up `dir` as the chat folder, or refreshes it. Returns { dir, created, updated }:
//   created: the folder had never been set up (no version stamp), so everything was copied.
//   updated: an existing folder got new or restored template files.
// The stamp is written last, so a run that fails halfway is retried in full next time.
function ensureWorkspace(dir, { templateDir = TEMPLATE_DIR } = {}) {
  dir = path.resolve(dir);
  templateDir = path.resolve(templateDir);
  if (!fs.statSync(templateDir).isDirectory()) throw new Error(`Not a directory: ${templateDir}`);
  if (isInside(dir, templateDir)) {
    throw new Error(`The chat folder can't be inside the template: ${dir}`);
  }

  const files = templateFiles(templateDir);
  const version = templateVersion(templateDir, files);
  const stampFile = path.join(dir, VERSION_FILE);
  const stamp = readText(stampFile);
  const created = stamp === null;
  const stale = stamp === null || stamp.trim() !== version;

  fs.mkdirSync(dir, { recursive: true });
  let wrote = false;
  for (const rel of files) {
    const target = path.join(dir, ...rel.split('/'));
    if (!stale && fs.existsSync(target)) continue;
    writeAtomic(target, fs.readFileSync(path.join(templateDir, rel)));
    wrote = true;
  }
  ensureTodos(dir, templateDir);
  if (stale) writeAtomic(stampFile, `${version}\n`);
  return { dir, created, updated: !created && wrote };
}

// Points the chat folder at `toDir`: sets it up there and brings the user's `todos.md` along
// when `toDir` has none. `fromDir` is never changed or deleted, since the user may keep other
// files there. Returns ensureWorkspace's result plus `copiedTodos`.
function moveWorkspace(fromDir, toDir, options = {}) {
  toDir = path.resolve(toDir);
  let copiedTodos = false;
  if (fromDir && !samePath(fromDir, toDir)) {
    const from = path.join(path.resolve(fromDir), TODOS_FILE);
    const to = path.join(toDir, TODOS_FILE);
    if (fs.existsSync(from) && !fs.existsSync(to)) {
      fs.mkdirSync(toDir, { recursive: true });
      try {
        fs.copyFileSync(from, to, fs.constants.COPYFILE_EXCL);
        copiedTodos = true;
      } catch (err) {
        if (err.code !== 'EEXIST') throw err;
      }
    }
  }
  return { ...ensureWorkspace(toDir, options), copiedTodos };
}

// The path with its existing part resolved through symlinks/junctions (and, on Windows, to its
// real casing and long names), and the not-yet-existing rest appended as given.
function canonical(p, pathApi) {
  let head = pathApi.resolve(p);
  const rest = [];
  for (;;) {
    try {
      return pathApi.join(fs.realpathSync.native(head), ...rest);
    } catch {
      const parent = pathApi.dirname(head);
      if (parent === head) return pathApi.resolve(p);
      rest.unshift(pathApi.basename(head));
      head = parent;
    }
  }
}

// True when `child` is `parent` itself or anywhere under it. `..` segments are resolved, and on
// Windows the comparison ignores case (and a path on another drive is never inside).
// `platform` exists for tests; resolving real paths on disk only happens for the running OS.
function isInside(child, parent, { platform = process.platform } = {}) {
  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  let c = pathApi.resolve(child);
  let p = pathApi.resolve(parent);
  if (platform === process.platform) {
    c = canonical(c, pathApi);
    p = canonical(p, pathApi);
  }
  if (platform === 'win32') {
    c = c.toLowerCase();
    p = p.toLowerCase();
  }
  const rel = pathApi.relative(p, c);
  if (rel === '') return true;
  if (pathApi.isAbsolute(rel)) return false;
  return rel !== '..' && !rel.startsWith(`..${pathApi.sep}`);
}

function samePath(a, b) {
  return isInside(a, b) && isInside(b, a);
}

module.exports = {
  TEMPLATE_DIR,
  VERSION_FILE,
  defaultWorkspaceDir,
  ensureWorkspace,
  moveWorkspace,
  isInside,
  templateVersion,
};

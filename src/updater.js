'use strict';

// In-app updates, for the pet's usual install: a git clone of the repo.
//
//   checkForUpdate(root)  fetches origin's main and says whether it has something new (or why this
//                         copy can't be updated: another branch, edited files, no git...).
//   startUpdate(...)      hands the update to a detached copy of this file and returns, so the pet
//                         can quit. The files can't change while it runs: on Windows electron.exe
//                         is locked, and `npm install` may need to replace it.
//   runUpdate(...)        is that detached part (`node updater.js <base64 json>`). It waits for the
//                         pet to exit, fast-forwards to the commit that was offered, reinstalls
//                         dependencies if package.json or the lockfile changed, and starts the pet
//                         again, updated or not.
//
// Everything a user sets up (settings, their pets, the log) lives outside the clone, so an update
// never touches it. If anything goes wrong the old commit stays, the pet still starts, and the
// reason is left in a result file for the pet to show.

const { execFile, spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const REMOTE = 'origin';
const BRANCH = 'main';
const TRACKING = `refs/remotes/${REMOTE}/${BRANCH}`;
const LOCKFILE = 'package-lock.json';
const FETCH_TIMEOUT_MS = 30_000;
const INSTALL_TIMEOUT_MS = 10 * 60_000;
const EXIT_TIMEOUT_MS = 30_000;
const MAX_CHANGES = 12;          // commit subjects listed in the dialog
const FULL_SHA_RE = /^[0-9a-f]{40}$/;

function git(root, args, { timeout = 15_000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile('git', args, {
      cwd: root,
      timeout,
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },   // never wait for a password
    }, (err, stdout, stderr) => {
      if (err) {
        err.stderr = String(stderr).trim();
        reject(err);
      } else {
        resolve(String(stdout).trimEnd());   // not trim(): `status` lines begin with a space
      }
    });
  });
}

async function isAncestor(root, ancestor, descendant) {
  try {
    await git(root, ['merge-base', '--is-ancestor', ancestor, descendant]);
    return true;
  } catch (err) {
    if (err.code === 1) return false;   // exit status 1 is "no"; anything else is a real error
    throw err;
  }
}

// Tracked files that differ from HEAD. npm sometimes rewrites the lockfile on its own, so a
// changed lockfile doesn't count: the update restores it.
async function editedFiles(root) {
  const lines = (await git(root, ['status', '--porcelain', '--untracked-files=no'])).split('\n').filter(Boolean);
  return lines.map((line) => line.slice(3)).filter((file) => file !== LOCKFILE);
}

function explain(err) {
  if (err.code === 'ENOENT') return "Git isn't installed, or isn't on your PATH.";
  if (err.killed) return "GitHub didn't answer in time.";
  return `Couldn't reach GitHub: ${err.stderr?.split('\n')[0] || err.message}`;
}

const blocked = (message) => ({ status: 'blocked', message });

// -> { status: 'current', head }
//  | { status: 'available', head, target, count, changes: [commit subjects, newest first] }
//  | { status: 'blocked' | 'error', message }
async function checkForUpdate(root) {
  if (!fs.existsSync(path.join(root, '.git'))) {
    return blocked("This copy of Claude Pet wasn't installed with git, so it can't update itself. Download the latest version from GitHub instead.");
  }
  try {
    const branch = await git(root, ['rev-parse', '--abbrev-ref', 'HEAD']);
    if (branch !== BRANCH) {
      return blocked(`Updates follow the ${BRANCH} branch, and this copy is ${branch === 'HEAD' ? 'not on a branch' : `on "${branch}"`}.`);
    }
    const edited = await editedFiles(root);
    if (edited.length) {
      const shown = edited.slice(0, 3).join(', ') + (edited.length > 3 ? `, and ${edited.length - 3} more` : '');
      return blocked(`These files have been changed in this copy: ${shown}. An update would overwrite them, so undo or save your changes first (a custom pet belongs in ~/.claude-pet/pets).`);
    }
    await git(root, ['fetch', '--quiet', REMOTE, `+refs/heads/${BRANCH}:${TRACKING}`], { timeout: FETCH_TIMEOUT_MS });
    const head = await git(root, ['rev-parse', 'HEAD']);
    const target = await git(root, ['rev-parse', TRACKING]);
    if (head === target || await isAncestor(root, target, head)) return { status: 'current', head };
    if (!await isAncestor(root, head, target)) {
      return blocked(`This copy has commits of its own that aren't on ${BRANCH}, so it can't be updated automatically.`);
    }
    const range = `${head}..${target}`;
    const count = Number(await git(root, ['rev-list', '--count', range]));
    const changes = (await git(root, ['log', `-n${MAX_CHANGES}`, '--format=%s', range])).split('\n').filter(Boolean);
    return { status: 'available', head, target, count, changes };
  } catch (err) {
    return { status: 'error', message: explain(err) };
  }
}

// Starts the detached update and resolves once it's running; the caller then quits the pet.
// `relaunch` is { exe, args }: how to start the pet again. Rejects if the updater can't start,
// in which case the pet should keep running.
function startUpdate({ root, target, relaunch, logFile, resultFile }) {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(JSON.stringify({ root, target, pid: process.pid, relaunch, logFile, resultFile })).toString('base64');
    // Node, not Electron: the updater may have to replace electron.exe, which would be locked.
    const child = spawn('node', [__filename, payload], { detached: true, stdio: 'ignore', windowsHide: true });
    child.once('error', (err) => reject(err.code === 'ENOENT' ? new Error("Node.js isn't on your PATH.") : err));
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
}

// ---------------------------------------------------------------- the detached part

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForExit(pid, timeoutMs = EXIT_TIMEOUT_MS) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try {
      process.kill(pid, 0);   // signal 0 only tests that the process exists
    } catch (err) {
      if (err.code === 'ESRCH') {
        await sleep(500);     // let Windows release its file locks
        return true;
      }
    }
    await sleep(200);
  }
  return false;
}

function npmInstall(root) {
  return new Promise((resolve, reject) => {
    execFile('npm', ['install', '--no-audit', '--no-fund'], {
      cwd: root,
      shell: process.platform === 'win32',   // npm is npm.cmd there
      windowsHide: true,
      timeout: INSTALL_TIMEOUT_MS,
      maxBuffer: 16 * 1024 * 1024,
    }, (err, _stdout, stderr) => {
      if (!err) return resolve();
      reject(new Error(String(stderr).trim().split('\n').slice(-3).join(' ') || err.message));
    });
  });
}

function startPet({ exe, args }, log) {
  const child = spawn(exe, args, { detached: true, stdio: 'ignore' });
  child.once('error', (err) => log(`could not start the pet again: ${err.message}`));
  child.unref();
}

async function applyUpdate(root, target, install, log) {
  const before = await git(root, ['rev-parse', 'HEAD']);
  if (await git(root, ['status', '--porcelain', '--untracked-files=no', '--', LOCKFILE])) {
    await git(root, ['checkout', '--', LOCKFILE]);   // npm rewrote it; the update brings its own
  }
  const edited = await editedFiles(root);
  if (edited.length) throw new Error(`files were changed after the check: ${edited.join(', ')}`);
  await git(root, ['merge', '--ff-only', target]);
  const changed = (await git(root, ['diff', '--name-only', before, target])).split('\n');
  if (changed.includes('package.json') || changed.includes(LOCKFILE)) {
    log('dependencies changed, running npm install');
    try {
      await install(root);
    } catch (err) {
      await git(root, ['reset', '--hard', before]);
      throw new Error(`npm install failed (${err.message}), so the old version was kept`);
    }
  }
  return { from: before, to: target };
}

// `deps` is for tests: waitForExit, install, start (the pet again) and log.
async function runUpdate({ root, target, pid, relaunch, resultFile }, deps = {}) {
  const log = deps.log || (() => {});
  const result = {};
  if (!await (deps.waitForExit || waitForExit)(pid)) {
    log('the pet did not exit, so it was not updated');
    return;
  }
  try {
    if (!FULL_SHA_RE.test(target)) throw new Error('not a commit to update to');
    Object.assign(result, await applyUpdate(root, target, deps.install || npmInstall, log), { ok: true });
    log(`updated ${result.from.slice(0, 7)} -> ${result.to.slice(0, 7)}`);
  } catch (err) {
    Object.assign(result, { ok: false, message: err.message });
    log(`update failed: ${err.message}`);
  }
  if (resultFile) {
    try {
      fs.mkdirSync(path.dirname(resultFile), { recursive: true });
      fs.writeFileSync(resultFile, JSON.stringify(result));
    } catch (err) {
      log(`could not write ${resultFile}: ${err.message}`);
    }
  }
  (deps.start || startPet)(relaunch, log);
}

// Same line format as the pet's own log (see main.js), appended to the same file.
function fileLog(file) {
  return (message) => {
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${now.toTimeString().slice(0, 8)}`;
    try {
      fs.appendFileSync(file, `[claude-pet ${stamp}] updater: ${message}\n`);
    } catch {
      // nowhere to report it
    }
  };
}

if (require.main === module) {
  const payload = JSON.parse(Buffer.from(process.argv[2], 'base64').toString('utf8'));
  runUpdate(payload, { log: payload.logFile ? fileLog(payload.logFile) : undefined }).catch(() => process.exit(1));
}

module.exports = { checkForUpdate, runUpdate, startUpdate };

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { checkForUpdate, runUpdate } = require('../src/updater');

const AUTHOR = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' };

function sh(cwd, ...args) {
  return execFileSync('git', args, { cwd, env: { ...process.env, ...AUTHOR }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

// A bare "GitHub", a clone to push new commits from, and `copy`: a user's install, one commit in.
function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-pet-update-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 }));
  const origin = path.join(dir, 'origin.git');
  sh(dir, 'init', '--bare', '-b', 'main', origin);
  const seed = path.join(dir, 'seed');
  sh(dir, 'clone', '-q', origin, seed);
  sh(seed, 'checkout', '-q', '-B', 'main');
  fs.writeFileSync(path.join(seed, 'a.txt'), 'a\n');
  fs.writeFileSync(path.join(seed, 'package.json'), '{"name":"x"}\n');
  fs.writeFileSync(path.join(seed, 'package-lock.json'), '{"v":1}\n');
  sh(seed, 'add', '.');
  sh(seed, 'commit', '-q', '-m', 'First');
  sh(seed, 'push', '-q', 'origin', 'main');
  const copy = path.join(dir, 'copy');
  sh(dir, 'clone', '-q', origin, copy);
  const push = (file, content, message) => {
    sh(seed, 'pull', '-q', '--ff-only', 'origin', 'main');
    fs.writeFileSync(path.join(seed, file), content);
    sh(seed, 'add', '.');
    sh(seed, 'commit', '-q', '-m', message);
    sh(seed, 'push', '-q', 'origin', 'main');
    return sh(seed, 'rev-parse', 'HEAD');
  };
  return { dir, copy, push, head: () => sh(copy, 'rev-parse', 'HEAD') };
}

// What runUpdate does besides the git work: wait for the pet, install, start the pet again.
function fakes({ installFails = false } = {}) {
  const calls = { installs: 0, starts: [], log: [] };
  return {
    calls,
    deps: {
      waitForExit: async () => true,
      install: async () => {
        calls.installs += 1;
        if (installFails) throw new Error('boom');
      },
      start: (relaunch) => calls.starts.push(relaunch),
      log: (line) => calls.log.push(line),
    },
  };
}

const RELAUNCH = { exe: 'electron', args: ['.'] };

test('a copy that is up to date has nothing to update', async (t) => {
  const { copy, head } = setup(t);
  assert.deepEqual(await checkForUpdate(copy), { status: 'current', head: head() });
});

test('new commits on main are offered, newest first', async (t) => {
  const { copy, push, head } = setup(t);
  push('b.txt', 'b', 'Add b');
  const target = push('c.txt', 'c', 'Add c');
  assert.deepEqual(await checkForUpdate(copy), {
    status: 'available', head: head(), target, count: 2, changes: ['Add c', 'Add b'],
  });
});

test('commits of its own on top of main are not an update', async (t) => {
  const { copy } = setup(t);
  fs.writeFileSync(path.join(copy, 'mine.txt'), 'mine');
  sh(copy, 'add', '.');
  sh(copy, 'commit', '-q', '-m', 'Mine');
  assert.equal((await checkForUpdate(copy)).status, 'current');
});

test('a copy that has gone its own way is refused', async (t) => {
  const { copy, push } = setup(t);
  fs.writeFileSync(path.join(copy, 'mine.txt'), 'mine');
  sh(copy, 'add', '.');
  sh(copy, 'commit', '-q', '-m', 'Mine');
  push('b.txt', 'b', 'Add b');
  const result = await checkForUpdate(copy);
  assert.equal(result.status, 'blocked');
  assert.match(result.message, /commits of its own/);
});

test('only the main branch is updated', async (t) => {
  const { copy } = setup(t);
  sh(copy, 'checkout', '-q', '-b', 'topic');
  const result = await checkForUpdate(copy);
  assert.equal(result.status, 'blocked');
  assert.match(result.message, /"topic"/);
});

test('edited files stop an update, but a rewritten lockfile and new files do not', async (t) => {
  const { copy, push } = setup(t);
  push('b.txt', 'b', 'Add b');
  fs.writeFileSync(path.join(copy, 'package-lock.json'), '{"v":2}\n');
  fs.writeFileSync(path.join(copy, 'new.txt'), 'untracked');
  assert.equal((await checkForUpdate(copy)).status, 'available');
  fs.writeFileSync(path.join(copy, 'a.txt'), 'edited\n');
  const result = await checkForUpdate(copy);
  assert.equal(result.status, 'blocked');
  assert.match(result.message, /a\.txt/);
});

test('a folder that is not a git checkout cannot update itself', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-pet-nogit-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const result = await checkForUpdate(dir);
  assert.equal(result.status, 'blocked');
  assert.match(result.message, /git/);
});

test('an unreachable origin is reported, not thrown', async (t) => {
  const { copy, dir } = setup(t);
  sh(copy, 'remote', 'set-url', 'origin', path.join(dir, 'gone.git'));
  const result = await checkForUpdate(copy);
  assert.equal(result.status, 'error');
  assert.match(result.message, /reach GitHub/);
});

test('the update moves to the offered commit, skips npm when dependencies are the same, and restarts the pet', async (t) => {
  const { copy, push, head } = setup(t);
  const before = head();
  const target = push('b.txt', 'b', 'Add b');
  assert.equal((await checkForUpdate(copy)).target, target);   // the check fetches what the update merges
  const { calls, deps } = fakes();
  const resultFile = path.join(path.dirname(copy), 'result.json');
  await runUpdate({ root: copy, target, pid: 1, relaunch: RELAUNCH, resultFile }, deps);
  assert.equal(head(), target);
  assert.equal(fs.readFileSync(path.join(copy, 'b.txt'), 'utf8'), 'b');
  assert.equal(calls.installs, 0);
  assert.deepEqual(calls.starts, [RELAUNCH]);
  assert.deepEqual(JSON.parse(fs.readFileSync(resultFile, 'utf8')), { from: before, to: target, ok: true });
});

test('npm install runs when the lockfile changed, and a lockfile npm rewrote does not get in the way', async (t) => {
  const { copy, push, head } = setup(t);
  const target = push('package-lock.json', '{"v":3}\n', 'Update deps');
  sh(copy, 'fetch', '-q');
  fs.writeFileSync(path.join(copy, 'package-lock.json'), '{"v":2}\n');   // what an older npm did to it
  const { calls, deps } = fakes();
  await runUpdate({ root: copy, target, pid: 1, relaunch: RELAUNCH }, deps);
  assert.equal(head(), target);
  assert.equal(calls.installs, 1);
  assert.equal(fs.readFileSync(path.join(copy, 'package-lock.json'), 'utf8').replace(/\r\n/g, '\n'), '{"v":3}\n');   // autocrlf may add the \r
});

test('a copy without a lockfile updates fine', async (t) => {
  const { copy, push, head } = setup(t);
  sh(copy, 'rm', '-q', 'package-lock.json');
  sh(copy, 'commit', '-q', '-m', 'Drop the lockfile');
  sh(copy, 'push', '-q', 'origin', 'main');
  const target = push('b.txt', 'b', 'Add b');
  sh(copy, 'fetch', '-q');
  const { calls, deps } = fakes();
  await runUpdate({ root: copy, target, pid: 1, relaunch: RELAUNCH }, deps);
  assert.equal(head(), target);
  assert.equal(calls.installs, 0);
});

test('a failed npm install goes back to the old version and the pet still starts', async (t) => {
  const { copy, push, head } = setup(t);
  const before = head();
  const target = push('package.json', '{"name":"x","v":2}\n', 'Bump');
  sh(copy, 'fetch', '-q');
  const { calls, deps } = fakes({ installFails: true });
  const resultFile = path.join(path.dirname(copy), 'result.json');
  await runUpdate({ root: copy, target, pid: 1, relaunch: RELAUNCH, resultFile }, deps);
  assert.equal(head(), before);
  assert.deepEqual(calls.starts, [RELAUNCH]);
  const result = JSON.parse(fs.readFileSync(resultFile, 'utf8'));
  assert.equal(result.ok, false);
  assert.match(result.message, /npm install failed \(boom\)/);
});

test('files edited after the check stop the update, and the pet still starts', async (t) => {
  const { copy, push, head } = setup(t);
  const before = head();
  const target = push('b.txt', 'b', 'Add b');
  sh(copy, 'fetch', '-q');
  fs.writeFileSync(path.join(copy, 'a.txt'), 'edited\n');
  const { calls, deps } = fakes();
  await runUpdate({ root: copy, target, pid: 1, relaunch: RELAUNCH }, deps);
  assert.equal(head(), before);
  assert.equal(fs.readFileSync(path.join(copy, 'a.txt'), 'utf8'), 'edited\n');
  assert.deepEqual(calls.starts, [RELAUNCH]);
});

test('only a full commit id is accepted as the target', async (t) => {
  const { copy, head } = setup(t);
  const before = head();
  const { calls, deps } = fakes();
  await runUpdate({ root: copy, target: '--help', pid: 1, relaunch: RELAUNCH }, deps);
  assert.equal(head(), before);
  assert.deepEqual(calls.starts, [RELAUNCH]);
});

test('nothing is touched while the pet is still running', async (t) => {
  const { copy, push, head } = setup(t);
  const before = head();
  const target = push('b.txt', 'b', 'Add b');
  const { calls, deps } = fakes();
  await runUpdate({ root: copy, target, pid: 1, relaunch: RELAUNCH }, { ...deps, waitForExit: async () => false });
  assert.equal(head(), before);
  assert.deepEqual(calls.starts, []);
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { BOOTSTRAP, LOADER, sshArgs } = require('../src/ssh-watcher');

test("the command that starts a watcher reads the same in sh, cmd.exe and PowerShell", () => {
  // cmd.exe has no `exec` and no single quotes, so a Windows host would refuse either.
  assert.equal(BOOTSTRAP, `python3 -u -c "${LOADER}"`);
  assert.doesNotMatch(BOOTSTRAP, /\bexec python3|'/);
  // Nothing inside the double quotes that sh ($ ` \ !), cmd (% ^) or PowerShell ($ `) would expand.
  assert.doesNotMatch(LOADER, /[$`\\!%^"]/);
});

test('ssh gets the options, the port and key when given, the host, then the command', () => {
  const args = sshArgs({ target: 'desktop', port: 2222, identity: 'C:\\k' }, BOOTSTRAP);
  assert.deepEqual(args.slice(-6), ['-p', '2222', '-i', 'C:\\k', 'desktop', BOOTSTRAP]);
  assert.ok(args.includes('BatchMode=yes'));
});

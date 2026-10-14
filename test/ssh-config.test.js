'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { isSameHost, parseSshConfig, sshConfigHosts } = require('../src/ssh-config');

test('the hosts are the Host names without wildcards, with their settings', () => {
  const text = [
    '# lab machines',
    'Host lab lab-alias *.corp !old',
    '  HostName 10.0.0.5',
    '  User alice',
    '  Port 2222',
    '  HostName ignored.example',   // the first value wins, as in ssh
    '',
    'Host="gpu box"',
    '  HostName=gpu.example',
    '',
    'Match host lab',
    '  User bob',                   // a Match block names no hosts
    '',
    'Host *',
    '  ServerAliveInterval 30',
  ].join('\r\n');
  assert.deepEqual(parseSshConfig(text), [
    { alias: 'lab', hostName: '10.0.0.5', user: 'alice', port: 2222 },
    { alias: 'lab-alias', hostName: '10.0.0.5', user: 'alice', port: 2222 },
    { alias: 'gpu box', hostName: 'gpu.example', user: null, port: null },
  ]);
});

test("~/.ssh/config's hosts follow Includes, merge repeats, and leave out git hosting", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-pet-ssh-'));
  const sshDir = path.join(home, '.ssh');
  try {
    assert.deepEqual(sshConfigHosts({ home }), [], 'no config');
    fs.mkdirSync(path.join(sshDir, 'config.d'), { recursive: true });
    fs.writeFileSync(path.join(sshDir, 'config'), [
      'Include config.d/*.conf ~/.ssh/missing',
      'Host lab',
      '  HostName 10.0.0.5',
      'Host github.com',
      '  User git',
      'Host gh',
      '  HostName github.com',
      'Host work-git',
      '  HostName git.example',
      '  User git',
    ].join('\n'));
    fs.writeFileSync(path.join(sshDir, 'config.d', 'b.conf'), 'Host gpu\n  HostName 10.0.0.7\n');
    fs.writeFileSync(path.join(sshDir, 'config.d', 'a.conf'), 'Host lab\n  Port 2222\n  HostName first.example\n');
    fs.writeFileSync(path.join(sshDir, 'config.d', 'notes.txt'), 'Host skipped\n');
    assert.deepEqual(sshConfigHosts({ home }), [
      { alias: 'lab', hostName: 'first.example', user: null, port: 2222 },
      { alias: 'gpu', hostName: '10.0.0.7', user: null, port: null },
    ]);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("a host from ~/.ssh/config can be one of the desktop app's connections", () => {
  const lab = { alias: 'lab', hostName: '10.0.0.5', user: 'alice', port: 2222 };
  assert.equal(isSameHost(lab, 'lab'), true, 'by its name, on the port the config gives');
  assert.equal(isSameHost(lab, 'alice@lab', 2222), true);
  assert.equal(isSameHost(lab, 'lab', 22), false);
  assert.equal(isSameHost(lab, 'alice@10.0.0.5', 2222), true, 'by its address and port');
  assert.equal(isSameHost(lab, '10.0.0.5'), false, 'on port 22');
  assert.equal(isSameHost({ alias: 'gpu', hostName: 'gpu.example', user: null, port: null }, 'gpu.example'), true);
});

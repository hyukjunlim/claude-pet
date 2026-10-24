'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildTree, splitPath } = require('../src/folder-tree');

const NOW = Date.parse('2026-10-25T00:00:00Z');
const ago = (days) => NOW - days * 24 * 60 * 60 * 1000;

// ~/.ssh/config and Codex's connections, as on a PC that works on one lab server and in WSL.
const SSH_HOSTS = [
  { alias: 'lab', hostName: '192.0.2.10', user: null, port: null },
  { alias: 'wsl-ubuntu', hostName: '127.0.0.1', user: null, port: null },
];
const CONNECTIONS = [
  { hostId: 'remote-ssh-discovered:lab', name: 'lab', target: 'lab', port: null },
  { hostId: 'remote-ssh-discovered:wsl-ubuntu', name: 'wsl-ubuntu', target: 'wsl-ubuntu', port: null },
];

const claude = (id, cwd, extra = {}) => ({
  id, kind: 'desktop', title: id, cwd, machineKey: null, machine: null, status: 'idle', since: ago(1), lastActivityAt: ago(1), ...extra,
});
const onLab = { machineKey: 'ssh:me@192.0.2.10:22', machine: '192.0.2.10' };
const codex = (id, cwd, hostId = 'local', extra = {}) => ({
  id: `codex:${id}`, kind: 'codex', title: id, cwd, hostId, status: 'idle', since: ago(2), lastActivityAt: ago(2), ...extra,
});

const build = (claudeList, codexList) => buildTree({
  claude: claudeList, codex: codexList, sshHosts: SSH_HOSTS, codexConnections: CONNECTIONS, defaultWsl: 'Ubuntu', now: NOW,
});
const titles = (n) => n.sessions.map((s) => s.title);

test('the two apps\' names for one server meet, and a parent folder\'s session stays at the parent', () => {
  const [lab] = build(
    [claude('paper figures', '/data/me/projects/BirdCount', onLab), claude('stride', '/data/me/projects/RiverSurvey', onLab)],
    [codex('compare descriptors', '/data/me/projects', 'remote-ssh-discovered:lab'), codex('outline stride', '/data/me/projects/RiverSurvey', 'remote-ssh-discovered:lab')],
  );
  assert.equal(lab.key, 'ssh:192.0.2.10:22');
  assert.equal(lab.label, 'lab');                         // the alias, not the address
  assert.equal(lab.folders.length, 1);
  const [projects] = lab.folders;
  assert.equal(projects.label, '/data/me/projects');      // the folders above it are one row
  assert.deepEqual(titles(projects), ['compare descriptors']);
  assert.deepEqual(projects.children.map((c) => [c.label, titles(c).sort(), c.both]), [
    ['BirdCount', ['paper figures'], false],
    ['RiverSurvey', ['outline stride', 'stride'], true],
  ]);
});

test('WSL is one host whether the path came as a distro, a share, Codex\'s local threads, or an SSH loopback', () => {
  const hosts = build(
    [claude('tok', '/home/me/tok', { machineKey: 'wsl:Ubuntu', machine: 'Ubuntu' }), claude('share', '\\\\wsl$\\Ubuntu\\home\\me\\tok')],
    [codex('chem', '/home/me/chem'), codex('loop', '/home/me/tok', 'remote-ssh-discovered:wsl-ubuntu')],
  );
  assert.deepEqual(hosts.map((h) => [h.key, h.label]), [['wsl:ubuntu', 'WSL · Ubuntu']]);
  const [home] = hosts[0].folders;
  assert.equal(home.label, '/home/me');
  assert.deepEqual(home.children.map((c) => [c.label, titles(c).sort()]), [['tok', ['loop', 'share', 'tok']], ['chem', ['chem']]]);
});

test('Windows paths match without case, /mnt/c is this PC, and an inner folder is shown below its parent', () => {
  const [pc] = build(
    [claude('home', 'C:\\Users\\Me'), claude('pet', 'c:\\users\\me\\claude-pet', { lastActivityAt: ago(0.5) })],
    [codex('etl', '/mnt/c/Users/Me/claude-pet')],
  );
  assert.equal(pc.key, 'pc');
  const [me] = pc.folders;
  assert.equal(me.label, 'C:\\Users\\Me');
  assert.deepEqual(titles(me), ['home']);
  assert.deepEqual(me.children.map((c) => [c.label, titles(c), c.both]), [['claude-pet', ['pet', 'etl'], true]]);
});

test('sessions without a folder of their own go under No folder', () => {
  const [pc] = build(
    [claude('scratch', 'C:\\Users\\me\\AppData\\Roaming\\Claude\\scratch-workspaces\\a\\b\\scratch-1'), claude('none', null)],
    [codex('brief', '/mnt/c/Users/me/Documents/Codex/2026-08-19/morning-brief')],
  );
  assert.deepEqual(pc.folders, []);
  assert.deepEqual(pc.loose.map((s) => s.title).sort(), ['brief', 'none', 'scratch']);
});

test('hosts come in a fixed order; folders by their latest session; folded when quiet for a month', () => {
  const hosts = build(
    [claude('lab old', '/data/old', { ...onLab, lastActivityAt: ago(60), since: ago(60) }), claude('lab new', '/data/new', onLab), claude('pc', 'C:\\x')],
    [codex('wsl', '/home/me/x')],
  );
  assert.deepEqual(hosts.map((h) => h.kind), ['pc', 'wsl', 'ssh']);
  const [data] = hosts[2].folders;
  assert.equal(data.label, '/data');                     // two folders in it: it stays a row of its own
  assert.deepEqual(data.children.map((f) => [f.label, f.open]), [['new', true], ['old', false]]);
});

test('a folder counts what needs you and what is working below it, so a folded one can say so', () => {
  const [lab] = build(
    [claude('asks', '/data/p/a', { ...onLab, status: 'waiting' }), claude('runs', '/data/p/b', { ...onLab, status: 'running' })],
    [codex('done', '/data/p', 'remote-ssh-discovered:lab', { status: 'review' })],
  );
  const [p] = lab.folders;
  assert.deepEqual([p.attention, p.busy], [2, 1]);
  assert.deepEqual([lab.attention, lab.busy], [2, 1]);
});

test('paths are read the way each app writes them', () => {
  assert.deepEqual(splitPath('\\\\wsl.localhost\\Ubuntu').segments, []);
  assert.equal(splitPath('\\\\wsl.localhost\\Ubuntu').host.key, 'wsl:ubuntu');
  assert.deepEqual(splitPath('/mnt/d/data').segments, ['D:', 'data']);
  assert.deepEqual(splitPath('C:/Users/me/').segments, ['C:', 'Users', 'me']);
  assert.equal(splitPath('relative/path'), null);
  assert.equal(splitPath(null), null);
});

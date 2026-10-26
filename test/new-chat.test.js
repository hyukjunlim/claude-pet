'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildTree } = require('../src/folder-tree');
const { markNewChats, newChatLinks, placeOf, sshTargets } = require('../src/new-chat');

const NOW = Date.parse('2026-10-25T00:00:00Z');

// ~/.ssh/config, as on a PC that works on one lab server through Claude and another through Codex.
const SSH_HOSTS = [
  { alias: 'lab', hostName: '192.0.2.10', user: null, port: null },
  { alias: 'gpu', hostName: '192.0.2.20', user: null, port: 2222 },
];
const CONNECTIONS = [{ hostId: 'remote-ssh-discovered:gpu', name: 'gpu', target: 'gpu', port: null }];

const claude = (id, cwd, extra = {}) => ({
  id, kind: 'desktop', title: id, cwd, machineKey: null, machine: null, status: 'idle', since: NOW, lastActivityAt: NOW, ...extra,
});
const codex = (id, cwd, hostId = 'local') => ({ id: `codex:${id}`, kind: 'codex', title: id, cwd, hostId, status: 'idle', since: NOW, lastActivityAt: NOW });

const HOSTS = buildTree({
  claude: [
    claude('pet', 'C:\\Users\\Me\\My Projects\\똑똑 pet'),
    claude('notes', 'C:\\Users\\Me\\notes'),
    claude('root', 'C:\\'),
    claude('figures', '/data/me/paper', { machineKey: 'ssh:me@192.0.2.10:22', machine: '192.0.2.10' }),
    claude('far', '/srv/far', { machineKey: 'ssh:me@192.0.2.30:2200', machine: '192.0.2.30' }),
    claude('wsl', '/home/me/tool', { machineKey: 'wsl:Ubuntu', machine: 'Ubuntu' }),
    claude('scratch', 'C:\\Users\\Me\\AppData\\Roaming\\Claude\\scratch-workspaces\\x'),
  ],
  codex: [codex('train', '/home/me/train', 'remote-ssh-discovered:gpu')],
  sshHosts: SSH_HOSTS,
  codexConnections: CONNECTIONS,
  now: NOW,
});
const CLAUDE_SSH = sshTargets(['ssh:me@192.0.2.10:22', 'ssh:me@192.0.2.30:2200']);
// Codex's projects, as its state file keeps them: on this PC, and in WSL as \\wsl$\<distro>\….
const CODEX_PROJECTS = [
  { id: 'p-notes', rootPaths: ['C:\\Users\\Me\\notes'] },
  { id: 'p-tool', rootPaths: ['\\\\wsl$\\Ubuntu\\home\\me\\tool'] },
];
const OPTS = { claudeSsh: CLAUDE_SSH, codexProjects: CODEX_PROJECTS, sshHosts: SSH_HOSTS };
const linksFor = (key, opts = {}) => newChatLinks(placeOf(HOSTS, key), { ...OPTS, ...opts });

test('a folder on this PC gets both apps\' new-chat links, its path as the tree shows it', () => {
  // Keys hold Windows paths in lower case; the link takes the folder's own spelling.
  assert.deepEqual(linksFor('pc|c:\\users\\me\\my projects\\똑똑 pet'), {
    claude: `claude://code/new?folder=${encodeURIComponent('C:\\Users\\Me\\My Projects\\똑똑 pet')}`,
    codex: `codex://threads/new?path=${encodeURIComponent('C:\\Users\\Me\\My Projects\\똑똑 pet')}`,
  });
  assert.equal(new URL(linksFor('pc|c:\\users\\me\\notes').claude).searchParams.get('folder'), 'C:\\Users\\Me\\notes');
});

test('a folder that only leads to others starts a chat there too', () => {
  // C:\Users\Me holds no session of its own, only the folders under it.
  assert.equal(new URL(linksFor('pc|c:\\users\\me').claude).searchParams.get('folder'), 'C:\\Users\\Me');
});

test('a drive\'s root is the root folder, not the drive', () => {
  assert.equal(new URL(linksFor('pc|c:').claude).searchParams.get('folder'), 'C:\\');
});

test('a folder on an SSH host opens Claude there under the name Claude knows the host by', () => {
  const { claude: url, codex: codexUrl } = linksFor('ssh:192.0.2.10:22|/data/me/paper');
  const params = Object.fromEntries(new URL(url).searchParams);
  assert.deepEqual(params, { ssh_host: 'me@192.0.2.10', ssh_folder: '/data/me/paper' });   // port 22 goes without saying
  assert.equal(codexUrl, null);   // Codex's new-chat link names no host
  assert.equal(new URL(linksFor('ssh:192.0.2.30:2200|/srv/far').claude).searchParams.get('ssh_port'), '2200');
});

test('an SSH host Claude has never connected to gets no link', () => {
  assert.deepEqual(linksFor('ssh:192.0.2.20:2222|/home/me/train'), { claude: null, codex: null });
});

test('a folder in WSL that is one of Codex\'s projects opens Codex on that project', () => {
  const { claude: url, codex: codexUrl } = linksFor('wsl:ubuntu|/home/me/tool');
  assert.equal(url, null);   // Claude's link has no way to name WSL
  assert.equal(codexUrl, 'codex://threads/new?projectId=p-tool&prompt=');   // Codex refuses a \\wsl$ path
  // Codex may keep the root as \\wsl.localhost, with the distro in another case or a trailing \.
  const other = [{ id: 'p-other', rootPaths: ['\\\\wsl.localhost\\ubuntu\\home\\me\\tool\\'] }];
  assert.equal(linksFor('wsl:ubuntu|/home/me/tool', { codexProjects: other }).codex, 'codex://threads/new?projectId=p-other&prompt=');
});

test('a folder in WSL that isn\'t a Codex project, or is in another distro, gets no link', () => {
  assert.equal(linksFor('wsl:ubuntu|/home/me/tool', { codexProjects: [] }).codex, null);
  const elsewhere = [
    { id: 'p-debian', rootPaths: ['\\\\wsl$\\Debian\\home\\me\\tool'] },
    { id: 'p-parent', rootPaths: ['\\\\wsl$\\Ubuntu\\home\\me'] },
    { id: 'p-pc', rootPaths: ['C:\\home\\me\\tool'] },
  ];
  assert.equal(linksFor('wsl:ubuntu|/home/me/tool', { codexProjects: elsewhere }).codex, null);
});

test('machines, "No folder" and unknown keys have no folder to start in', () => {
  for (const key of ['pc', 'ssh:192.0.2.10:22', 'wsl:ubuntu', 'pc|loose', 'pc|c:\\nowhere', 'chat', null]) {
    assert.deepEqual(linksFor(key), { claude: null, codex: null }, String(key));
  }
});

test('an app that isn\'t installed gets no link', () => {
  assert.deepEqual(linksFor('pc|c:\\users\\me\\notes', { claude: false }).claude, null);
  assert.deepEqual(linksFor('pc|c:\\users\\me\\notes', { codex: false }).codex, null);
  assert.equal(linksFor('ssh:192.0.2.10:22|/data/me/paper', { claude: false }).claude, null);
});

test('the folders an app can start a chat in are marked for their +, and nothing else changes', () => {
  const marked = markNewChats(HOSTS, OPTS);
  const flags = {};
  const walk = (n) => {
    flags[n.key] = n.newChat === true;
    n.children.forEach(walk);
  };
  for (const h of marked) h.folders.forEach(walk);
  assert.deepEqual(flags, {
    'pc|c:': true,
    'pc|c:\\users\\me': true,
    'pc|c:\\users\\me\\my projects\\똑똑 pet': true,
    'pc|c:\\users\\me\\notes': true,
    'ssh:192.0.2.10:22|/data/me/paper': true,
    'ssh:192.0.2.30:2200|/srv/far': true,
    'ssh:192.0.2.20:2222|/home/me/train': false,   // Claude has never connected to it, and Codex can't
    'wsl:ubuntu|/home/me/tool': true,
  });
  // With neither app installed, nothing gets a +.
  const none = markNewChats(HOSTS, { ...OPTS, claude: false, codex: false });
  assert.deepEqual(none, HOSTS);
  // A WSL folder that isn't a Codex project has none: Claude can't start a chat in WSL either.
  const [wsl] = markNewChats(HOSTS, { ...OPTS, codexProjects: [] }).filter((h) => h.kind === 'wsl');
  assert.equal(wsl.folders[0].newChat, undefined);
});

test('SSH targets come from machine keys once each; other keys are left out', () => {
  assert.deepEqual(sshTargets(['ssh:me@192.0.2.10:22', 'wsl:Ubuntu', null, 'ssh:me@192.0.2.10:22', 'ssh:lab:2200']), [
    { host: 'me@192.0.2.10', port: 22 },
    { host: 'lab', port: 2200 },
  ]);
});

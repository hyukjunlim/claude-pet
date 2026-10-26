'use strict';

// New chats from the sidebar: a folder's menu (its + or a right-click) hands Claude or Codex the
// app's own new-chat link for that folder, and the app starts the chat there. The pet makes nothing itself; the new
// session turns up in the tree once the app has written it.
//
//   Claude  claude://code/new?folder=<C:\path>                              on this PC
//           claude://code/new?ssh_host=<user@host>&ssh_port=<port>&ssh_folder=</path>
//                                                                           on an SSH host
//   Codex   codex://threads/new?path=<C:\path>                              on this PC
//           codex://threads/new?projectId=<id>&prompt=                      in WSL, a folder
//                                                                           that is one of its
//                                                                           projects
//
// Neither is documented. Claude's own jump list opens code/new?folder=…, and the ssh_ parameters
// and Codex's path and projectId are what the apps' link handlers read (Claude 3.6556, Codex
// 26.1021). Claude opens its new-session page there; nothing starts until you send a message.
// Claude's link has no way to name WSL: it leaves \\wsl$\…, \\wsl.localhost\… and /home/… folders
// unselected. Codex's path takes only a folder on this PC (it adds the folder to its projects if
// it isn't one yet) and refuses a \\ path, but its projects include WSL ones (kept as
// \\wsl$\<distro>\…), which projectId opens; it reads projectId only next to one of its other
// parameters, hence the empty prompt. An SSH host's folders it can't open by a link at all.

const { sshMachine } = require('./folder-tree');

// The folder a sidebar key names, from the tree main.js last sent: { host, path }, the path as
// the tree shows it (keys hold Windows paths in lower case). Null for a machine's heading, its
// "No folder" and anything not in the tree: there's no folder to start in.
function placeOf(hosts, key) {
  if (typeof key !== 'string' || !Array.isArray(hosts)) return null;
  const bar = key.indexOf('|');
  if (bar < 0) return null;
  const host = hosts.find((h) => h.key === key.slice(0, bar));
  const find = (n) => (n.key === key ? n : n.children.reduce((found, c) => found ?? find(c), null));
  const node = host?.folders?.reduce((found, f) => found ?? find(f), null);
  return node?.path ? { host, path: node.path } : null;
}

// The `user@host` and port of each SSH connection, from keys such as Claude's machine keys
// (`ssh:me@192.0.2.10:22`, sessions.js's sshKey).
function sshTargets(keys) {
  const targets = [];
  for (const key of keys) {
    const m = /^ssh:(.+):(\d+)$/.exec(key || '');
    if (m && !targets.some((t) => t.host === m[1] && t.port === Number(m[2]))) targets.push({ host: m[1], port: Number(m[2]) });
  }
  return targets;
}

// The links for a folder's menu: { claude, codex }, each a URL, or null where that app isn't
// installed or can't start a chat there. `claudeSsh`: Claude's own SSH connections (sshTargets),
// so a host goes by the name Claude knows it by; one Claude has never connected to gets no link.
// `codexProjects`: Codex's projects on this PC and in WSL ({ id, rootPaths }, codex.js's
// parseProjects). `sshHosts`: ~/.ssh/config, which the tree's machines are named by.
function newChatLinks(place, { claude = true, codex = true, claudeSsh = [], codexProjects = [], sshHosts = [] } = {}) {
  const links = { claude: null, codex: null };
  if (!place) return links;
  const { host, path: dir } = place;
  if (host.kind === 'pc' && /^[a-z]:/i.test(dir)) {
    const win = /^[a-z]:$/i.test(dir) ? `${dir}\\` : dir;   // the drive's root
    if (claude) links.claude = link('claude://code/new', { folder: win });
    if (codex) links.codex = link('codex://threads/new', { path: win });
  } else if (host.kind === 'wsl' && host.distro && dir.startsWith('/')) {
    const here = `${host.distro.toLowerCase()}|${dir.replace(/\//g, '\\').replace(/\\+$/, '')}`;
    const project = codex && codexProjects.find((p) => p.rootPaths.some((r) => wslRoot(r) === here));
    if (project) links.codex = link('codex://threads/new', { projectId: project.id, prompt: '' });
  } else if (host.kind === 'ssh' && dir.startsWith('/') && claude) {
    const target = claudeSsh.find((t) => {
      const m = sshMachine(t.host, t.port, sshHosts);
      return `ssh:${m.name}:${m.port}` === host.key;
    });
    if (target) {
      links.claude = link('claude://code/new', {
        ssh_host: target.host,
        ...(target.port !== 22 && { ssh_port: String(target.port) }),
        ssh_folder: dir,
      });
    }
  }
  return links;
}

// A project root in WSL as `<distro>|\path`, for comparing with a tree folder; null for others.
function wslRoot(root) {
  const m = /^\\\\wsl(?:\$|\.localhost)\\([^\\]+)(\\.*)?$/i.exec(root);
  return m && `${m[1].toLowerCase()}|${(m[2] || '').replace(/\\+$/, '')}`;
}

function link(base, params) {
  return `${base}?${Object.entries(params).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&')}`;
}

// The tree with `newChat: true` on each folder where an app can start a chat, for the sidebar's
// + on its row. `opts` as for newChatLinks.
function markNewChats(hosts, opts) {
  return hosts.map((host) => {
    const mark = (n) => {
      const links = newChatLinks(n.path ? { host, path: n.path } : null, opts);
      return { ...n, children: n.children.map(mark), ...((links.claude || links.codex) && { newChat: true }) };
    };
    return host.folders ? { ...host, folders: host.folders.map(mark) } : host;
  });
}

module.exports = { markNewChats, newChatLinks, placeOf, sshTargets };

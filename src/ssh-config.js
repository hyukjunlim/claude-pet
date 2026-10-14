'use strict';

// The hosts in your ~/.ssh/config, for running Claude Code over SSH from a terminal rather than
// from the desktop app (whose saved connections claude-usage.js reads on its own). These are the
// `Host` names without wildcards, following `Include`s. Git hosting (github.com, `User git`, …) is
// left out: there's no shell there to run Claude Code in.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const GIT_HOST_RE = /(^|\.)(github\.com|gitlab\.com|bitbucket\.org|codeberg\.org|dev\.azure\.com|visualstudio\.com|sr\.ht)$/i;
const MAX_INCLUDE_DEPTH = 8;

// A line's arguments, split on spaces, "quoted" ones kept whole.
function words(s) {
  return [...s.matchAll(/"([^"]*)"|(\S+)/g)].map((m) => m[1] ?? m[2]);
}

// [{ alias, hostName, user, port }] for each Host name without wildcards, in order, duplicates
// included. `include(pattern)` gives the texts of the files an `Include` line names.
function parseSshConfig(text, include = () => [], depth = 0) {
  const hosts = [];
  let block = [];   // the hosts the current Host line names
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^([^\s=]+)\s*(?:=\s*|\s)(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const args = words(m[2]);
    if (key === 'host') {
      block = args.filter((a) => !/[*?!]/.test(a)).map((alias) => ({ alias, hostName: null, user: null, port: null }));
      hosts.push(...block);
    } else if (key === 'match') {
      block = [];
    } else if (key === 'include') {
      if (depth >= MAX_INCLUDE_DEPTH) continue;
      for (const pattern of args) {
        for (const t of include(pattern)) hosts.push(...parseSshConfig(t, include, depth + 1));
      }
    } else if (args.length) {
      for (const h of block) {
        if (key === 'hostname') h.hostName ??= args[0];
        else if (key === 'user') h.user ??= args[0];
        else if (key === 'port') h.port ??= Number(args[0]) || null;
      }
    }
  }
  return hosts;
}

// The texts of the files an `Include` names: relative to ~/.ssh, with * and ? in the file name.
function includedTexts(pattern, { sshDir, home }) {
  let p = pattern.replace(/^~(?=[\\/]|$)/, home);
  if (!path.isAbsolute(p)) p = path.join(sshDir, p);
  const dir = path.dirname(p);
  const base = path.basename(p);
  let names = [base];
  if (/[*?]/.test(base)) {
    const re = new RegExp(`^${base.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`);
    try {
      names = fs.readdirSync(dir).filter((n) => re.test(n)).sort();
    } catch {
      return [];
    }
  }
  const texts = [];
  for (const n of names) {
    try {
      texts.push(fs.readFileSync(path.join(dir, n), 'utf8'));
    } catch {
      // gone, or a folder
    }
  }
  return texts;
}

// The hosts you could run Claude Code on, from ~/.ssh/config: [{ alias, hostName, user, port }].
// A host named in more than one block takes each setting from the first block that has it, as
// ssh does.
function sshConfigHosts({ home = os.homedir() } = {}) {
  const sshDir = path.join(home, '.ssh');
  let text;
  try {
    text = fs.readFileSync(path.join(sshDir, 'config'), 'utf8');
  } catch {
    return [];
  }
  const byAlias = new Map();
  for (const h of parseSshConfig(text, (pattern) => includedTexts(pattern, { sshDir, home }))) {
    const seen = byAlias.get(h.alias);
    if (!seen) byAlias.set(h.alias, h);
    else for (const k of ['hostName', 'user', 'port']) seen[k] ??= h[k];
  }
  return [...byAlias.values()].filter((h) => h.user !== 'git' && !GIT_HOST_RE.test(h.alias) && !GIT_HOST_RE.test(h.hostName ?? ''));
}

// Whether a ~/.ssh/config host is the machine the desktop app reaches as `target` ([user@]host)
// on `port`.
function isSameHost(h, target, port = null) {
  const host = target.slice(target.lastIndexOf('@') + 1);
  if (host === h.alias) return port == null || port === (h.port ?? 22);
  return host === h.hostName && (port ?? 22) === (h.port ?? 22);
}

module.exports = { isSameHost, parseSshConfig, sshConfigHosts };

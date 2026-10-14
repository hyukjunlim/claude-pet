'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { EtlFeature } = require('../src/etl/feature');

// An EtlFeature with fake Electron parts, a temp chat folder and no token (so no requests).
function feature(t, saved = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'etl-feature-'));
  const data = { etlEnabled: true, etlWorkspace: path.join(dir, 'ws'), etlAssistantBubble: false, ...saved };
  const settings = { get: (k) => data[k], set: (p) => Object.assign(data, p) };
  const electron = {
    app: { getPath: () => path.join(dir, 'userData') },
    powerMonitor: new EventEmitter(),
    dialog: {},
    shell: { openPath() {}, openExternal: async () => {} },
    safeStorage: { isEncryptionAvailable: () => false },
  };
  const f = new EtlFeature({ electron, settings, appRoot: dir, codexSessionsRoot: path.join(dir, 'sessions') });
  const changes = [];
  f.on('change', (list) => changes.push(list.map((it) => it.id)));
  t.after(() => f.stop());
  return { f, data, changes };
}

test('the eTL 비서 bubble shows only while turned on, and turning it on or off takes effect at once', (t) => {
  const { f, changes } = feature(t, { etlAssistantBubble: true });
  f.start();
  assert.deepEqual(changes.at(-1), ['etl:assistant']);
  f.setAssistantBubble(false);
  assert.deepEqual(changes.at(-1), []);
  f.setAssistantBubble(true);
  assert.deepEqual(changes.at(-1), ['etl:assistant']);
  f.dismiss('etl:assistant');                   // no × for it; nothing changes
  f.stop();
  assert.deepEqual(changes.at(-1), []);
});

test('with eTL off there is no eTL 비서 bubble, and its menu item is there to turn it on', (t) => {
  const { f, changes } = feature(t, { etlEnabled: false, etlAssistantBubble: true });
  f.start();
  assert.deepEqual(changes, []);
  const item = f.menu().submenu.find((m) => m.label === 'eTL 비서 말풍선 보이기');
  assert.equal(item.type, 'checkbox');
  assert.equal(item.checked, true);
});

test('clicking the bubble opens its links in order, a moment apart', async (t) => {
  const { f, data } = feature(t);
  f.codexInstalled = () => true;
  f.assistantLinks = () => ['codex://first', 'codex://second'];
  const opened = [];
  assert.equal(f.openAssistant((u) => opened.push(u), { gapMs: 20 }), true);
  assert.deepEqual(opened, ['codex://first']);
  await new Promise((r) => setTimeout(r, 60));
  assert.deepEqual(opened, ['codex://first', 'codex://second']);
  delete f.assistantLinks;
  const [link] = f.assistantLinks();
  assert.equal(new URL(link).searchParams.get('path'), data.etlWorkspace);
});

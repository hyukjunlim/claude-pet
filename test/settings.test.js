'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Settings, DEFAULTS } = require('../src/settings');

function settingsFile(t, content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ttokttok-pet-settings-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'settings.json');
  if (content !== undefined) fs.writeFileSync(file, content);
  return file;
}

test('a new install starts from the defaults and writes nothing yet', (t) => {
  const file = settingsFile(t);
  const s = new Settings(file);
  assert.equal(s.firstRun, true);
  assert.deepEqual(s.data, DEFAULTS);
  assert.equal(fs.existsSync(file), false);
});

test('saved settings are loaded over the defaults', (t) => {
  const file = settingsFile(t, JSON.stringify({ scale: 1, showUsage: false }));
  const s = new Settings(file);
  assert.equal(s.firstRun, false);
  assert.equal(s.get('scale'), 1);
  assert.equal(s.get('showUsage'), false);
  assert.equal(s.get('petKey'), DEFAULTS.petKey);
});

test('settings an older pet kept are dropped, and the file saved without them', (t) => {
  const file = settingsFile(t, JSON.stringify({ scale: 1, claudeWeeklyResetAt: 1767225600000 }));
  const s = new Settings(file);
  assert.equal(s.get('claudeWeeklyResetAt'), undefined);
  assert.equal(s.get('scale'), 1);
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal('claudeWeeklyResetAt' in saved, false);
  assert.equal(saved.scale, 1);
});

test('a file with nothing to drop is left as it is', (t) => {
  const content = JSON.stringify({ scale: 1 });
  const file = settingsFile(t, content);
  new Settings(file);
  assert.equal(fs.readFileSync(file, 'utf8'), content);
});

test('an unreadable file keeps the defaults and is left as it is', (t) => {
  const file = settingsFile(t, '{ not json');
  const s = new Settings(file);
  assert.deepEqual(s.data, DEFAULTS);
  assert.equal(fs.readFileSync(file, 'utf8'), '{ not json');
});

test('eTL starts off, with the chat folder in its default place', (t) => {
  const s = new Settings(settingsFile(t));
  assert.equal(s.get('etlEnabled'), false);
  assert.equal(s.get('etlWorkspace'), null);
  assert.equal(s.get('etlAssistantBubble'), false);
  assert.equal(s.get('etlAssistantAsked'), false);
});

test('the eTL settings survive a save and a reload', (t) => {
  const file = settingsFile(t);
  const s = new Settings(file);
  s.save();
  assert.equal(new Settings(file).get('etlEnabled'), false);
  assert.equal(new Settings(file).get('etlWorkspace'), null);

  s.set({ etlEnabled: true, etlWorkspace: 'D:\notes\etl' });
  s.save();
  const again = new Settings(file);
  assert.equal(again.get('etlEnabled'), true);
  assert.equal(again.get('etlWorkspace'), 'D:\notes\etl');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).etlEnabled, true);
});

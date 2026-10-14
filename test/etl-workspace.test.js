'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  TEMPLATE_DIR, VERSION_FILE, defaultWorkspaceDir, ensureWorkspace, moveWorkspace, isInside,
} = require('../src/etl/workspace');

function tempDir(t, name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `claude-pet-etl-${name}-`));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writeFile(dir, rel, content) {
  const file = path.join(dir, ...rel.split('/'));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function readFile(dir, rel) {
  return fs.readFileSync(path.join(dir, ...rel.split('/')), 'utf8');
}

// A small stand-in for <repo>/etl-workspace, so the tests don't depend on etl.js existing yet.
function fakeTemplate(t) {
  const dir = tempDir(t, 'template');
  writeFile(dir, 'AGENTS.md', '# 지침 v1\n');
  writeFile(dir, 'CLAUDE.md', '@AGENTS.md\n');
  writeFile(dir, 'etl.js', "'use strict';\n");
  writeFile(dir, '.claude/settings.json', '{}\n');
  writeFile(dir, '.agents/skills/briefing/SKILL.md', '---\nname: briefing\n---\n');
  writeFile(dir, 'todos.md.template', '# 할 일\n\n## 진행 중\n\n## 완료\n');
  return dir;
}

function setup(t) {
  const templateDir = fakeTemplate(t);
  const dir = path.join(tempDir(t, 'home'), 'etl-assistant');
  return { templateDir, dir };
}

test('the default chat folder is etl-assistant in the user\'s Documents', () => {
  assert.equal(defaultWorkspaceDir(), path.join(os.homedir(), 'Documents', 'etl-assistant'));
  assert.equal(path.basename(TEMPLATE_DIR), 'etl-workspace');
});

test('a new chat folder gets every template file, a todo list and a version stamp', (t) => {
  const { templateDir, dir } = setup(t);
  const result = ensureWorkspace(dir, { templateDir });
  assert.deepEqual(result, { dir: path.resolve(dir), created: true, updated: false });
  assert.equal(readFile(dir, 'AGENTS.md'), '# 지침 v1\n');
  assert.equal(readFile(dir, 'CLAUDE.md'), '@AGENTS.md\n');
  assert.equal(readFile(dir, 'etl.js'), "'use strict';\n");
  assert.equal(readFile(dir, '.claude/settings.json'), '{}\n');
  assert.equal(readFile(dir, '.agents/skills/briefing/SKILL.md'), '---\nname: briefing\n---\n');
  assert.equal(readFile(dir, 'todos.md'), '# 할 일\n\n## 진행 중\n\n## 완료\n');
  assert.match(readFile(dir, VERSION_FILE), /^[0-9a-f]{64}\n$/);
  assert.equal(fs.existsSync(path.join(dir, 'todos.md.template')), false);
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f.endsWith('.tmp')), []);
});

test('the user\'s todo list is never overwritten, even when the template changes', (t) => {
  const { templateDir, dir } = setup(t);
  ensureWorkspace(dir, { templateDir });
  writeFile(dir, 'todos.md', '- [ ] 레포트 초안\n');

  ensureWorkspace(dir, { templateDir });
  assert.equal(readFile(dir, 'todos.md'), '- [ ] 레포트 초안\n');

  writeFile(templateDir, 'AGENTS.md', '# 지침 v2\n');
  writeFile(templateDir, 'todos.md.template', '# 새 형식\n');
  const result = ensureWorkspace(dir, { templateDir });
  assert.equal(result.updated, true);
  assert.equal(readFile(dir, 'todos.md'), '- [ ] 레포트 초안\n');
});

test('a todo list the user deleted is created again', (t) => {
  const { templateDir, dir } = setup(t);
  ensureWorkspace(dir, { templateDir });
  fs.rmSync(path.join(dir, 'todos.md'));
  ensureWorkspace(dir, { templateDir });
  assert.equal(readFile(dir, 'todos.md'), '# 할 일\n\n## 진행 중\n\n## 완료\n');
});

test('a todo list is still made when the template has no todos.md.template', (t) => {
  const { templateDir, dir } = setup(t);
  fs.rmSync(path.join(templateDir, 'todos.md.template'));
  ensureWorkspace(dir, { templateDir });
  assert.match(readFile(dir, 'todos.md'), /## 진행 중/);
});

test('a todos.md in the template is never copied over the user\'s', (t) => {
  const { templateDir, dir } = setup(t);
  writeFile(templateDir, 'todos.md', '# 개발자의 할 일\n');
  ensureWorkspace(dir, { templateDir });
  assert.equal(readFile(dir, 'todos.md'), '# 할 일\n\n## 진행 중\n\n## 완료\n');
});

test('a changed template rewrites the template files and the version stamp', (t) => {
  const { templateDir, dir } = setup(t);
  ensureWorkspace(dir, { templateDir });
  const before = readFile(dir, VERSION_FILE);

  writeFile(templateDir, 'AGENTS.md', '# 지침 v2\n');
  writeFile(templateDir, '.agents/skills/todo/SKILL.md', '---\nname: todo\n---\n');
  writeFile(dir, 'CLAUDE.md', 'edited by hand\n');
  const result = ensureWorkspace(dir, { templateDir });

  assert.deepEqual(result, { dir: path.resolve(dir), created: false, updated: true });
  assert.equal(readFile(dir, 'AGENTS.md'), '# 지침 v2\n');
  assert.equal(readFile(dir, 'CLAUDE.md'), '@AGENTS.md\n');
  assert.equal(readFile(dir, '.agents/skills/todo/SKILL.md'), '---\nname: todo\n---\n');
  assert.notEqual(readFile(dir, VERSION_FILE), before);
});

test('an unchanged template leaves the folder alone', (t) => {
  const { templateDir, dir } = setup(t);
  ensureWorkspace(dir, { templateDir });
  writeFile(dir, 'AGENTS.md', 'edited by hand\n');
  const result = ensureWorkspace(dir, { templateDir });
  assert.deepEqual(result, { dir: path.resolve(dir), created: false, updated: false });
  assert.equal(readFile(dir, 'AGENTS.md'), 'edited by hand\n');
});

test('a template file that went missing is put back without a template change', (t) => {
  const { templateDir, dir } = setup(t);
  ensureWorkspace(dir, { templateDir });
  fs.rmSync(path.join(dir, 'etl.js'));
  const result = ensureWorkspace(dir, { templateDir });
  assert.equal(result.updated, true);
  assert.equal(readFile(dir, 'etl.js'), "'use strict';\n");
});

test('files dropped from the template and the user\'s own files stay in the folder', (t) => {
  const { templateDir, dir } = setup(t);
  ensureWorkspace(dir, { templateDir });
  writeFile(dir, '강의자료/notes.txt', 'mine\n');
  fs.rmSync(path.join(templateDir, 'CLAUDE.md'));
  ensureWorkspace(dir, { templateDir });
  assert.equal(readFile(dir, 'CLAUDE.md'), '@AGENTS.md\n');
  assert.equal(readFile(dir, '강의자료/notes.txt'), 'mine\n');
});

test('an existing folder without a version stamp counts as newly set up', (t) => {
  const { templateDir, dir } = setup(t);
  writeFile(dir, 'todos.md', '- [ ] 기존 할 일\n');
  writeFile(dir, 'AGENTS.md', 'old\n');
  const result = ensureWorkspace(dir, { templateDir });
  assert.equal(result.created, true);
  assert.equal(readFile(dir, 'AGENTS.md'), '# 지침 v1\n');
  assert.equal(readFile(dir, 'todos.md'), '- [ ] 기존 할 일\n');
});

test('the chat folder can\'t be the template itself or inside it', (t) => {
  const { templateDir } = setup(t);
  assert.throws(() => ensureWorkspace(templateDir, { templateDir }), /inside the template/);
  assert.throws(() => ensureWorkspace(path.join(templateDir, 'sub'), { templateDir }), /inside the template/);
});

test('a missing template is an error, not an empty chat folder', (t) => {
  const { dir } = setup(t);
  assert.throws(() => ensureWorkspace(dir, { templateDir: path.join(dir, 'nope') }), { code: 'ENOENT' });
  assert.equal(fs.existsSync(dir), false);
});

test('moving the chat folder brings the todo list along and keeps the old folder', (t) => {
  const { templateDir, dir: oldDir } = setup(t);
  ensureWorkspace(oldDir, { templateDir });
  writeFile(oldDir, 'todos.md', '- [ ] 레포트 초안\n');
  const newDir = path.join(tempDir(t, 'new'), 'chat');

  const result = moveWorkspace(oldDir, newDir, { templateDir });
  assert.deepEqual(result, { dir: path.resolve(newDir), created: true, updated: false, copiedTodos: true });
  assert.equal(readFile(newDir, 'todos.md'), '- [ ] 레포트 초안\n');
  assert.equal(readFile(newDir, 'AGENTS.md'), '# 지침 v1\n');
  assert.equal(readFile(oldDir, 'todos.md'), '- [ ] 레포트 초안\n');
  assert.equal(readFile(oldDir, 'AGENTS.md'), '# 지침 v1\n');
});

test('moving to a folder that already has a todo list keeps that list', (t) => {
  const { templateDir, dir: oldDir } = setup(t);
  ensureWorkspace(oldDir, { templateDir });
  writeFile(oldDir, 'todos.md', '- [ ] old\n');
  const newDir = tempDir(t, 'new');
  writeFile(newDir, 'todos.md', '- [ ] new\n');

  const result = moveWorkspace(oldDir, newDir, { templateDir });
  assert.equal(result.copiedTodos, false);
  assert.equal(readFile(newDir, 'todos.md'), '- [ ] new\n');
});

test('moving from a folder that was never made just sets up the new one', (t) => {
  const { templateDir, dir: newDir } = setup(t);
  const result = moveWorkspace(path.join(newDir, '..', 'missing'), newDir, { templateDir });
  assert.equal(result.created, true);
  assert.equal(result.copiedTodos, false);
  assert.equal(readFile(newDir, 'todos.md'), '# 할 일\n\n## 진행 중\n\n## 완료\n');

  const again = moveWorkspace(null, newDir, { templateDir });
  assert.equal(again.created, false);
});

test('moving to the same folder changes nothing', (t) => {
  const { templateDir, dir } = setup(t);
  ensureWorkspace(dir, { templateDir });
  writeFile(dir, 'todos.md', '- [ ] keep\n');
  const result = moveWorkspace(dir, path.join(dir, '.'), { templateDir });
  assert.equal(result.copiedTodos, false);
  assert.equal(readFile(dir, 'todos.md'), '- [ ] keep\n');
});

test('isInside treats a folder as inside itself and resolves ..', () => {
  const opts = { platform: 'linux' };
  assert.equal(isInside('/home/a/pet', '/home/a/pet', opts), true);
  assert.equal(isInside('/home/a/pet/src/etl', '/home/a/pet', opts), true);
  assert.equal(isInside('/home/a/pet/../notes', '/home/a/pet', opts), false);
  assert.equal(isInside('/home/a/pet/x/../../pet/y', '/home/a/pet', opts), true);
  assert.equal(isInside('/home/a/pet-old', '/home/a/pet', opts), false);
  assert.equal(isInside('/home/a/pet/..notes', '/home/a/pet', opts), true);
  assert.equal(isInside('/home/a', '/home/a/pet', opts), false);
  assert.equal(isInside('/home/a/PET/x', '/home/a/pet', opts), false);
});

test('isInside ignores case on Windows and never matches across drives', () => {
  const opts = { platform: 'win32' };
  assert.equal(isInside('C:\\Users\\A\\claude-pet\\x', 'c:\\users\\a\\CLAUDE-PET', opts), true);
  assert.equal(isInside('c:/users/a/claude-pet/etl-workspace', 'C:\\Users\\A\\claude-pet\\', opts), true);
  assert.equal(isInside('C:\\Users\\A\\claude-pet\\..\\Documents', 'C:\\Users\\A\\claude-pet', opts), false);
  assert.equal(isInside('C:\\Users\\A\\claude-pet2', 'C:\\Users\\A\\claude-pet', opts), false);
  assert.equal(isInside('D:\\Users\\A\\claude-pet', 'C:\\Users\\A\\claude-pet', opts), false);
});

test('isInside follows the real paths of folders that exist', (t) => {
  const root = tempDir(t, 'real');
  const parent = path.join(root, 'pet');
  fs.mkdirSync(path.join(parent, 'sub'), { recursive: true });
  assert.equal(isInside(path.join(parent, 'sub', 'not-yet', 'deeper'), parent), true);
  assert.equal(isInside(path.join(root, 'other'), parent), false);

  const link = path.join(root, 'link');
  try {
    fs.symlinkSync(parent, link, 'junction');
  } catch {
    return;   // no permission to make links here; the rest is covered above
  }
  assert.equal(isInside(path.join(link, 'sub'), parent), true);
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createTokenStore, normalizeToken } = require('../src/etl/token');

const TOKEN = 'fake~not-a-real-token-0123456789';
const MAGIC = Buffer.from('FAKEENC1');

// Stands in for Electron's safeStorage: a reversible scramble behind a header, so a file that
// wasn't made by it fails to decrypt the way a real one would.
function fakeSafeStorage({ available = true } = {}) {
  return {
    available,
    isEncryptionAvailable() {
      return this.available;
    },
    encryptString(s) {
      const body = Buffer.from(s, 'utf8').map((b) => b ^ 0x5a);
      return Buffer.concat([MAGIC, body]);
    },
    decryptString(buf) {
      if (!buf.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('Error while decrypting the ciphertext');
      return Buffer.from(buf.subarray(MAGIC.length).map((b) => b ^ 0x5a)).toString('utf8');
    },
  };
}

function tokenFile(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-pet-etl-token-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, 'nested', 'etl-token.bin');
}

test('a saved token loads back as it was', (t) => {
  const file = tokenFile(t);
  const store = createTokenStore({ safeStorage: fakeSafeStorage(), file });
  assert.equal(store.has(), false);
  assert.equal(store.load(), null);
  store.save(`  ${TOKEN}\n`);
  assert.equal(store.has(), true);
  assert.equal(store.load(), TOKEN);
  assert.equal(fs.existsSync(`${file}.tmp`), false);

  const again = createTokenStore({ safeStorage: fakeSafeStorage(), file });
  assert.equal(again.load(), TOKEN);
});

test('the token on disk is never the plain text', (t) => {
  const file = tokenFile(t);
  createTokenStore({ safeStorage: fakeSafeStorage(), file }).save(TOKEN);
  const bytes = fs.readFileSync(file);
  assert.equal(bytes.includes(Buffer.from(TOKEN)), false);
  assert.equal(bytes.toString('latin1').includes(TOKEN), false);
  assert.equal(bytes.toString('utf16le').includes(TOKEN), false);
});

test('saving is refused, and nothing is written, when encryption is not available', (t) => {
  const file = tokenFile(t);
  const store = createTokenStore({ safeStorage: fakeSafeStorage({ available: false }), file });
  assert.throws(() => store.save(TOKEN), (err) => {
    assert.match(err.message, /암호화/);
    assert.equal(err.message.includes(TOKEN), false);
    return true;
  });
  assert.equal(fs.existsSync(file), false);
  assert.equal(fs.existsSync(`${file}.tmp`), false);
  assert.equal(fs.existsSync(path.dirname(file)), false);
  assert.equal(store.has(), false);
});

test('a token that is saved replaces the one before it', (t) => {
  const file = tokenFile(t);
  const store = createTokenStore({ safeStorage: fakeSafeStorage(), file });
  store.save(TOKEN);
  store.save('fake~second-token');
  assert.equal(store.load(), 'fake~second-token');
});

test('blank or malformed tokens are refused with a Korean message', (t) => {
  const file = tokenFile(t);
  const store = createTokenStore({ safeStorage: fakeSafeStorage(), file });
  for (const bad of ['', '   ', undefined, null, 42, 'has a space', 'x'.repeat(513), 'tab\there']) {
    assert.throws(() => store.save(bad), /토큰/);
  }
  assert.equal(fs.existsSync(file), false);
  assert.equal(normalizeToken(`\t${TOKEN} `), TOKEN);
});

test('clear deletes the saved token', (t) => {
  const file = tokenFile(t);
  const store = createTokenStore({ safeStorage: fakeSafeStorage(), file });
  store.save(TOKEN);
  store.clear();
  assert.equal(fs.existsSync(file), false);
  assert.equal(store.has(), false);
  assert.equal(store.load(), null);
  store.clear();                     // clearing twice is fine
});

test('a damaged or foreign token file loads as null', (t) => {
  const file = tokenFile(t);
  const store = createTokenStore({ safeStorage: fakeSafeStorage(), file });
  fs.mkdirSync(path.dirname(file), { recursive: true });

  fs.writeFileSync(file, Buffer.from([1, 2, 3, 4, 5]));
  assert.equal(store.load(), null);

  fs.writeFileSync(file, Buffer.alloc(0));
  assert.equal(store.load(), null);

  // Decrypts, but to something that can't be a token.
  fs.writeFileSync(file, fakeSafeStorage().encryptString('not a token\n'));
  assert.equal(store.load(), null);
});

test('a saved token loads as null while encryption is not available', (t) => {
  const file = tokenFile(t);
  const safeStorage = fakeSafeStorage();
  const store = createTokenStore({ safeStorage, file });
  store.save(TOKEN);
  safeStorage.available = false;
  assert.equal(store.load(), null);
  assert.equal(store.has(), true);
});

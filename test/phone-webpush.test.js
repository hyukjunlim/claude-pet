'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { Pusher, encrypt, generateVapidKeys, topicOf, validSubscription, vapidJwt } = require('../src/phone/webpush');

const b64u = (s) => Buffer.from(s.replace(/\s+/g, ''), 'base64url');

// RFC 8291, Appendix A.
const RFC = {
  plaintext: 'When I grow up, I want to be a watermelon',
  asPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  uaPublic: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcx aOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  uaPrivate: 'q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94',
  salt: 'DGv6ra1nlYgDCS1FRnbzlw',
  auth: 'BTBZMqHH6r4Tts7J_aSIgg',
  header: 'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z 9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml mlMoZIIgDll6e3vCYLocInmYWAmS6Tlz AC8wEqKK6PBru3jl7A8',
  ciphertext: '8pfeW0KbunFT06SuDKoJH9Ql87S1QUrd irN6GcG7sFz1y1sqLgVi1VhjVkHsUoEs bI_0LpXMuGvnzQ',
};

// What the phone's browser does with a message: the receiving side of RFC 8291.
function decrypt(body, { uaPrivate, uaPublic, auth }) {
  const salt = body.subarray(0, 16);
  const idlen = body[20];
  const asPublic = body.subarray(21, 21 + idlen);
  const record = body.subarray(21 + idlen);
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.setPrivateKey(uaPrivate);
  const info = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]);
  const ikm = Buffer.from(crypto.hkdfSync('sha256', ecdh.computeSecret(asPublic), auth, info, 32));
  const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const decipher = crypto.createDecipheriv('aes-128-gcm', cek, nonce);
  decipher.setAuthTag(record.subarray(record.length - 16));
  const padded = Buffer.concat([decipher.update(record.subarray(0, record.length - 16)), decipher.final()]);
  assert.equal(padded.at(-1), 2, 'the last record ends in the 0x02 delimiter');
  return padded.subarray(0, -1).toString();
}

test('encrypts exactly as RFC 8291 Appendix A does', () => {
  const body = encrypt(RFC.plaintext, { p256dh: RFC.uaPublic.replace(/\s/g, ''), auth: RFC.auth }, {
    ephemeral: RFC.asPrivate,
    salt: b64u(RFC.salt),
  });
  assert.deepEqual(body.subarray(0, 86), b64u(RFC.header));
  assert.deepEqual(body.subarray(86), b64u(RFC.ciphertext));
});

test('a fresh message decrypts on the receiving side', () => {
  const ua = crypto.createECDH('prime256v1');
  ua.generateKeys();
  const auth = crypto.randomBytes(16);
  const text = JSON.stringify({ title: 'Ready · 토크나이저 고치기', body: 'Claude · tokenizer' });
  const body = encrypt(text, { p256dh: ua.getPublicKey().toString('base64url'), auth: auth.toString('base64url') });
  assert.equal(decrypt(body, { uaPrivate: ua.getPrivateKey(), uaPublic: ua.getPublicKey(), auth }), text);
});

test('the VAPID token is an ES256 JWT the public key verifies', () => {
  const keys = generateVapidKeys();
  assert.equal(b64u(keys.publicKey).length, 65);
  assert.equal(b64u(keys.privateKey).length, 32);
  const now = Date.UTC(2026, 9, 28);
  const jwt = vapidJwt({ audience: 'https://web.push.apple.com', subject: 'mailto:pet@example.com', keys, now });
  const [h, p, s] = jwt.split('.');
  assert.deepEqual(JSON.parse(b64u(h)), { typ: 'JWT', alg: 'ES256' });
  const claims = JSON.parse(b64u(p));
  assert.equal(claims.aud, 'https://web.push.apple.com');
  assert.equal(claims.sub, 'mailto:pet@example.com');
  assert.ok(claims.exp > now / 1000 && claims.exp <= now / 1000 + 24 * 3600, 'expires within a day');
  const pub = b64u(keys.publicKey);
  const key = crypto.createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: pub.subarray(1, 33).toString('base64url'), y: pub.subarray(33).toString('base64url') }, format: 'jwk' });
  assert.ok(crypto.verify('sha256', Buffer.from(`${h}.${p}`), { key, dsaEncoding: 'ieee-p1363' }, b64u(s)));
});

function subscription(endpoint = 'https://web.push.apple.com/QGuQyavXutnMGwgG3uB2gR') {
  const ua = crypto.createECDH('prime256v1');
  ua.generateKeys();
  return { endpoint, keys: { p256dh: ua.getPublicKey().toString('base64url'), auth: crypto.randomBytes(16).toString('base64url') } };
}

test('only phones\' push services, over https, with both keys', () => {
  assert.ok(validSubscription(subscription()));
  assert.ok(validSubscription(subscription('https://fcm.googleapis.com/fcm/send/abc')));
  assert.ok(validSubscription(subscription('https://updates.push.services.mozilla.com/wpush/v2/abc')));
  assert.ok(!validSubscription(subscription('http://web.push.apple.com/abc')));
  assert.ok(!validSubscription(subscription('https://push.apple.com.example.net/abc')));
  assert.ok(!validSubscription(subscription('https://192.168.0.1/abc')));
  assert.ok(!validSubscription({ ...subscription(), keys: { p256dh: 'AAAA', auth: 'BBBB' } }));
  assert.ok(!validSubscription(null));
});

function fakeRequest(status = 201) {
  const calls = [];
  const request = (url, opts, onResponse) => {
    const req = new EventEmitter();
    req.end = (body) => {
      calls.push({ url: String(url), opts, body });
      const res = new EventEmitter();
      res.statusCode = status;
      res.resume = () => {};
      onResponse(res);
      res.emit('end');
    };
    req.destroy = (err) => req.emit('error', err);
    return req;
  };
  return { request, calls };
}

test('a push carries the encrypted body, the VAPID header, TTL and Urgency, and reuses its token', async () => {
  const keys = generateVapidKeys();
  const { request, calls } = fakeRequest(201);
  let t = 1_000_000;
  const pusher = new Pusher({ keys, subject: 'https://github.com/hyukjunlim/ttokttok-pet', request, now: () => t });
  const sub = subscription();
  assert.deepEqual(await pusher.send(sub, { title: 'Ready' }, { topic: 'local_abc' }), { status: 201, gone: false });
  t += 60_000;
  await pusher.send(sub, { title: 'Needs you' });
  const [first, second] = calls;
  assert.equal(first.url, sub.endpoint);
  assert.equal(first.opts.method, 'POST');
  assert.equal(first.opts.headers['Content-Encoding'], 'aes128gcm');
  assert.equal(first.opts.headers.TTL, '86400');
  assert.equal(first.opts.headers.Urgency, 'high');
  assert.equal(first.opts.headers.Topic, topicOf('local_abc'));
  assert.ok(first.opts.headers.Topic.length <= 32);
  assert.match(first.opts.headers.Authorization, new RegExp(`^vapid t=[\\w-]+\\.[\\w-]+\\.[\\w-]+, k=${keys.publicKey}$`));
  assert.equal(second.opts.headers.Authorization, first.opts.headers.Authorization, 'the same token within the hour');
  assert.equal(second.opts.headers.Topic, undefined);
  assert.ok(first.body.length > 86);
});

test('a subscription the push service no longer knows comes back as gone', async () => {
  const { request } = fakeRequest(410);
  const pusher = new Pusher({ keys: generateVapidKeys(), subject: 'mailto:a@example.com', request });
  assert.deepEqual(await pusher.send(subscription(), { title: 'x' }), { status: 410, gone: true });
});

test('refuses endpoints outside the push services and messages that are too long', async () => {
  const pusher = new Pusher({ keys: generateVapidKeys(), subject: 'mailto:a@example.com', request: () => assert.fail('no request') });
  await assert.rejects(pusher.send(subscription('https://evil.example.com/x'), { title: 'x' }));
  await assert.rejects(pusher.send(subscription(), 'x'.repeat(4000)));
});

'use strict';

// Web Push from the pet itself, with nothing but node:crypto and node:https. The message is
// encrypted for the phone's browser (RFC 8291, the aes128gcm content coding of RFC 8188), and the
// pet says who it is with a VAPID key (RFC 8292). The push service (Apple's, Google's or Mozilla's)
// passes it on to the phone without being able to read it.

const crypto = require('node:crypto');
const https = require('node:https');

const RECORD_SIZE = 4096;
const JWT_LIFETIME_S = 12 * 60 * 60;    // Apple takes at most a day
const JWT_REUSE_MS = 6 * 60 * 60_000;   // and asks for no new one more often than every hour
const MAX_PAYLOAD = 3000;               // push services take 4096 bytes of body; leave room

// Only the push services phones' browsers use. A subscription naming anything else is refused, so
// a paired phone can't make the pet post to some other address.
const PUSH_HOSTS = [/(^|\.)push\.apple\.com$/, /^fcm\.googleapis\.com$/, /^android\.googleapis\.com$/, /(^|\.)push\.services\.mozilla\.com$/];

const b64u = (buf) => Buffer.from(buf).toString('base64url');
const fromB64u = (s) => Buffer.from(String(s).replace(/\s+/g, ''), 'base64url');

// A P-256 private key is 32 bytes; a raw export may drop leading zeros.
function pad32(buf) {
  return buf.length >= 32 ? buf : Buffer.concat([Buffer.alloc(32 - buf.length), buf]);
}

// A new VAPID key pair, base64url: the public key as the 65-byte point browsers want, the private
// key as its 32 bytes.
function generateVapidKeys() {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  return { publicKey: b64u(ecdh.getPublicKey()), privateKey: b64u(pad32(ecdh.getPrivateKey())) };
}

function signingKey({ publicKey, privateKey }) {
  const pub = fromB64u(publicKey);
  return crypto.createPrivateKey({
    key: { kty: 'EC', crv: 'P-256', d: b64u(pad32(fromB64u(privateKey))), x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33, 65)) },
    format: 'jwk',
  });
}

// The VAPID token for one push service (`audience`, its origin): an ES256 JWT.
function vapidJwt({ audience, subject, keys, now = Date.now() }) {
  const part = (o) => b64u(JSON.stringify(o));
  const data = `${part({ typ: 'JWT', alg: 'ES256' })}.${part({ aud: audience, exp: Math.floor(now / 1000) + JWT_LIFETIME_S, sub: subject })}`;
  const sig = crypto.sign('sha256', Buffer.from(data), { key: signingKey(keys), dsaEncoding: 'ieee-p1363' });
  return `${data}.${b64u(sig)}`;
}

function hkdf(salt, ikm, info, length) {
  return Buffer.from(crypto.hkdfSync('sha256', ikm, salt, info, length));
}

// The body of a push message: `plaintext` encrypted for the subscription's keys ({ p256dh, auth },
// base64url), as one aes128gcm record. `ephemeral` (a private key, base64url) and `salt` are for
// tests; normally both are new for every message.
function encrypt(plaintext, { p256dh, auth }, { ephemeral = null, salt = crypto.randomBytes(16) } = {}) {
  const uaPublic = fromB64u(p256dh);
  const authSecret = fromB64u(auth);
  if (uaPublic.length !== 65 || uaPublic[0] !== 4 || authSecret.length < 16) throw new Error('bad subscription keys');
  const ecdh = crypto.createECDH('prime256v1');
  if (ephemeral) ecdh.setPrivateKey(pad32(fromB64u(ephemeral)));
  else ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]);
  const ikm = hkdf(authSecret, ecdh.computeSecret(uaPublic), keyInfo, 32);
  const cek = hkdf(salt, ikm, Buffer.from('Content-Encoding: aes128gcm\0'), 16);
  const nonce = hkdf(salt, ikm, Buffer.from('Content-Encoding: nonce\0'), 12);
  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const record = Buffer.concat([cipher.update(Buffer.concat([Buffer.from(plaintext), Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const header = Buffer.alloc(21);
  salt.copy(header, 0);
  header.writeUInt32BE(RECORD_SIZE, 16);
  header.writeUInt8(asPublic.length, 20);
  return Buffer.concat([header, asPublic, record]);
}

// Whether `sub` is a subscription the pet will send to: an https endpoint at a known push service,
// with both keys.
function validSubscription(sub) {
  if (!sub || typeof sub !== 'object' || typeof sub.endpoint !== 'string' || sub.endpoint.length > 2048) return false;
  let url;
  try {
    url = new URL(sub.endpoint);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' || !PUSH_HOSTS.some((re) => re.test(url.hostname))) return false;
  const { p256dh, auth } = sub.keys || {};
  return typeof p256dh === 'string' && typeof auth === 'string' && fromB64u(p256dh).length === 65 && fromB64u(auth).length >= 16;
}

// Sends push messages for one VAPID key, reusing each push service's token for a while.
class Pusher {
  // subject: a mailto: or https: address for the push service to reach whoever runs the sender.
  constructor({ keys, subject, request = https.request, now = Date.now }) {
    Object.assign(this, { keys, subject, request, now });
    this.tokens = new Map();   // audience -> { jwt, at }
  }

  #token(audience) {
    const t = this.tokens.get(audience);
    if (t && this.now() - t.at < JWT_REUSE_MS) return t.jwt;
    const jwt = vapidJwt({ audience, subject: this.subject, keys: this.keys, now: this.now() });
    this.tokens.set(audience, { jwt, at: this.now() });
    return jwt;
  }

  // Resolves to { status, gone }: `gone` when the push service says the subscription is no more
  // (the phone unsubscribed, or the app was removed), so it can be forgotten. `topic`: a later
  // message with the same topic replaces one still waiting for the phone.
  send(subscription, payload, { ttl = 24 * 60 * 60, urgency = 'high', topic = null } = {}) {
    if (!validSubscription(subscription)) return Promise.reject(new Error('not a push subscription the pet sends to'));
    const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
    if (Buffer.byteLength(text) > MAX_PAYLOAD) return Promise.reject(new Error('push message too long'));
    const url = new URL(subscription.endpoint);
    const body = encrypt(text, subscription.keys);
    const headers = {
      TTL: String(ttl),
      Urgency: urgency,
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(body.length),
      Authorization: `vapid t=${this.#token(url.origin)}, k=${this.keys.publicKey}`,
    };
    if (topic) headers.Topic = topicOf(topic);
    return new Promise((resolve, reject) => {
      const req = this.request(url, { method: 'POST', headers, timeout: 15_000 }, (res) => {
        res.resume();
        res.on('end', () => resolve({ status: res.statusCode, gone: res.statusCode === 404 || res.statusCode === 410 }));
      });
      req.on('timeout', () => req.destroy(new Error('push service timed out')));
      req.on('error', reject);
      req.end(body);
    });
  }
}

// A Topic header is at most 32 base64url characters.
function topicOf(text) {
  return crypto.createHash('sha256').update(String(text)).digest().subarray(0, 18).toString('base64url');
}

module.exports = { Pusher, encrypt, generateVapidKeys, topicOf, validSubscription, vapidJwt, MAX_PAYLOAD };

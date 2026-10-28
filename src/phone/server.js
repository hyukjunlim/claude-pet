'use strict';

// The phone companion's web server. It listens on 127.0.0.1 only; the phone reaches it through
// Tailscale Serve, which puts it at https://<this PC>.<tailnet>.ts.net/ on the user's own tailnet
// (CONSTRAINTS.md, Network). The page itself is public to whoever gets that far; everything it
// shows comes from /api/, which wants the cookie a paired phone got for the pairing code.
//
//   GET  /api/state        the tree, the notices and the weekly limits (view.js), with an ETag
//   POST /api/pair         { code, name } -> sets the cookie
//   GET  /api/push-key     the pet's VAPID public key, for PushManager.subscribe
//   POST /api/push         { subscription } -> this phone's alerts on; DELETE turns them off
//   POST /api/test-push    a notification to this phone, to see that alerts work
//   POST /api/unpair       forgets this phone

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const COOKIE = 'tp_phone';
const COOKIE_DAYS = 400;            // as long as browsers keep one
const MAX_BODY = 16 * 1024;
const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/links.js': ['links.js', 'text/javascript; charset=utf-8'],
  '/app.css': ['app.css', 'text/css; charset=utf-8'],
  '/sw.js': ['sw.js', 'text/javascript; charset=utf-8'],
  '/manifest.webmanifest': ['manifest.webmanifest', 'application/manifest+json; charset=utf-8'],
};
const ICONS = { '/icon-192.png': 192, '/icon-512.png': 512, '/apple-touch-icon.png': 180 };
const SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Opener-Policy': 'same-origin',
};

// Who may ask: this PC itself, and the PC's name on a tailnet through Tailscale Serve. Anything
// else (a web page that pointed its own name at 127.0.0.1, say) is turned away.
function allowedHost(host) {
  return /^(127\.0\.0\.1|localhost)(:\d{1,5})?$/i.test(host || '')
    || /^[a-z0-9-]+(\.[a-z0-9-]+)*\.ts\.net(:443)?$/i.test(host || '');
}

function viaTailnet(host) {
  return /\.ts\.net(:443)?$/i.test(host || '');
}

function cookieOf(req) {
  for (const part of String(req.headers.cookie || '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === COOKIE) return v.join('=');
  }
  return null;
}

function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return false;
  try {
    return new URL(origin).host.toLowerCase() === String(req.headers.host).toLowerCase();
  } catch {
    return false;
  }
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, { ...SECURITY_HEADERS, ...headers });
  res.end(body);
}

function json(res, status, value, headers = {}) {
  send(res, status, JSON.stringify(value), { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
}

function readJson(req) {
  return new Promise((resolve) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) req.destroy();
      else chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null'));
      } catch {
        resolve(null);
      }
    });
    req.on('error', () => resolve(null));
  });
}

// `api` (feature.js): pair({ code, name }) -> token or null; device(token) -> device or null;
// state() -> { etag, body }; vapidKey(); subscribe(device, sub) -> bool; unsubscribe(device);
// testPush(device) -> Promise; unpair(device). `icon(size)`: PNG bytes of the app icon.
function createPhoneServer({ api, wwwDir = path.join(__dirname, 'www'), icon = () => null, log = () => {} }) {
  const files = new Map();
  const file = (name) => {
    if (!files.has(name)) files.set(name, fs.readFileSync(path.join(wwwDir, name)));
    return files.get(name);
  };

  async function handle(req, res) {
    const host = req.headers.host;
    if (!allowedHost(host)) return send(res, 421, 'Misdirected request', { 'Content-Type': 'text/plain' });
    const url = new URL(req.url, 'http://phone.invalid');
    const p = url.pathname;

    if (req.method === 'GET' && STATIC[p]) {
      const [name, type] = STATIC[p];
      return send(res, 200, file(name), { 'Content-Type': type, 'Cache-Control': 'no-cache' });
    }
    if (req.method === 'GET' && ICONS[p]) {
      const png = icon(ICONS[p]);
      return png ? send(res, 200, png, { 'Content-Type': 'image/png', 'Cache-Control': 'max-age=86400' }) : send(res, 404, '');
    }
    if (!p.startsWith('/api/')) return send(res, 404, 'Not found', { 'Content-Type': 'text/plain' });
    // Every change comes from the page itself: same origin, and only as POST or DELETE.
    if (req.method !== 'GET' && !sameOrigin(req)) return json(res, 403, { error: 'origin' });

    if (p === '/api/pair' && req.method === 'POST') {
      const body = await readJson(req);
      const token = api.pair({ code: String(body?.code ?? ''), name: String(body?.name ?? '') });
      if (!token) return json(res, 403, { error: 'code' });
      const secure = viaTailnet(host) ? '; Secure' : '';
      return json(res, 200, { ok: true }, {
        'Set-Cookie': `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${COOKIE_DAYS * 86400}${secure}`,
      });
    }

    const device = api.device(cookieOf(req));
    if (!device) return json(res, 401, { error: 'pair' });

    if (p === '/api/state' && req.method === 'GET') {
      const { etag, body } = api.state();
      if (req.headers['if-none-match'] === etag) return send(res, 304, '', { ETag: etag, 'Cache-Control': 'no-store' });
      return send(res, 200, body, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ETag: etag });
    }
    if (p === '/api/push-key' && req.method === 'GET') return json(res, 200, { key: api.vapidKey(), subscribed: Boolean(device.subscription) });
    if (p === '/api/push' && req.method === 'POST') {
      const body = await readJson(req);
      return api.subscribe(device, body?.subscription) ? json(res, 200, { ok: true }) : json(res, 400, { error: 'subscription' });
    }
    if (p === '/api/push' && req.method === 'DELETE') {
      api.unsubscribe(device);
      return json(res, 200, { ok: true });
    }
    if (p === '/api/test-push' && req.method === 'POST') {
      try {
        const r = await api.testPush(device);
        return json(res, 200, { ok: true, status: r?.status ?? null });
      } catch (err) {
        return json(res, 502, { error: err.message });
      }
    }
    if (p === '/api/unpair' && req.method === 'POST') {
      api.unpair(device);
      return json(res, 200, { ok: true }, { 'Set-Cookie': `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0` });
    }
    return json(res, 404, { error: 'not found' });
  }

  return http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      log('phone server:', err.message);
      if (!res.headersSent) json(res, 500, { error: 'server' });
      else res.destroy();
    });
  });
}

module.exports = { createPhoneServer, allowedHost, COOKIE };

'use strict';

// The phone page's service worker. It shows the pet's notifications, and a tap on one opens a
// small page about it with one button into its app: the session in Claude or ChatGPT, the eTL
// notice in LearningX (links.js). A phone opens an app only from a tap on a link in a page, never
// straight from a notification, hence the page. The worker makes that page itself, so it opens
// while the PC is out of reach. A notification with nothing to open (a test) opens the pet's page
// at that row. Nothing is cached; the pet's page always comes from the PC.

importScripts('/links.js');

const TAPPED = '/open';   // the page a tapped notification opens
const TAPPED_HEADERS = {
  'Content-Type': 'text/html; charset=utf-8',
  'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store',
};

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

// Every push shows a notification (an iPhone takes notifications away from a page that doesn't),
// with no sound or vibration when the pet says `silent`.
self.addEventListener('push', (e) => {
  let d = {};
  try {
    d = e.data ? e.data.json() : {};
  } catch {
    d = { title: e.data?.text() };
  }
  e.waitUntil(self.registration.showNotification(d.title || 'Ttokttok Pet', {
    body: d.body || '',
    tag: d.tag || undefined,
    renotify: Boolean(d.tag),
    silent: d.silent === true,
    icon: '/icon-192.png',
    data: { id: d.id || null, open: d.open || null },
  }));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const id = e.notification.data?.id || null;
  const open = e.notification.data?.open;
  e.waitUntil((async () => {
    if (self.phoneLinks.hrefOf(open)) {
      const q = new URLSearchParams({ id: id || '', title: e.notification.title, body: e.notification.body, app: open.app, url: open.url });
      await self.clients.openWindow(`${TAPPED}?${q}`);
      return;
    }
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const w of windows) {
      if ('focus' in w) {
        await w.focus();
        w.postMessage({ type: 'show', id });
        return;
      }
    }
    await self.clients.openWindow(id ? `/#item=${encodeURIComponent(id)}` : '/');
  })());
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.mode !== 'navigate' || url.origin !== self.location.origin || url.pathname !== TAPPED) return;
  e.respondWith(new Response(tappedPage(url.searchParams), { headers: TAPPED_HEADERS }));
});

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

// What the notification said, the button into its app, and a way to the pet's list. The page's
// colors are app.css's.
function tappedPage(q) {
  const open = { app: q.get('app'), url: q.get('url') };
  const href = self.phoneLinks.hrefOf(open);
  const id = q.get('id');
  // An intent opens the app over this page; a web address opens beside it.
  const beside = href && !href.startsWith('intent:') ? ' target="_blank" rel="noopener noreferrer"' : '';
  const button = href ? `<a class="open" href="${esc(href)}"${beside}>Open in ${esc(self.phoneLinks.appName(open.app))}</a>` : '';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="light dark">
<title>Ttokttok Pet</title>
<style>
:root { --page: #fafafa; --text: #191919; --muted: #6f6a64; }
@media (prefers-color-scheme: dark) { :root { --page: #1f1f1f; --text: #efefef; --muted: #b2aaa1; } }
body {
  margin: 0; background: var(--page); color: var(--text);
  font: 16px/1.4 system-ui, -apple-system, "Segoe UI", "Apple SD Gothic Neo", "Malgun Gothic", sans-serif;
  padding: env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left);
}
main { display: flex; flex-direction: column; gap: 8px; padding: 32px 16px; }
h1 { margin: 0; font-size: 20px; font-weight: 600; overflow-wrap: anywhere; }
p { margin: 0; color: var(--muted); overflow-wrap: anywhere; }
.open {
  display: block; margin-top: 24px; padding: 16px; border-radius: 12px;
  background: var(--text); color: var(--page); font-weight: 600; text-align: center; text-decoration: none;
}
.list { display: block; padding: 12px; color: var(--muted); font-size: 14px; text-align: center; }
</style>
</head>
<body>
<main>
<h1>${esc(q.get('title'))}</h1>
<p>${esc(q.get('body'))}</p>
${button}
<a class="list" href="${esc(id ? `/#item=${encodeURIComponent(id)}` : '/')}">Show in the list</a>
</main>
</body>
</html>
`;
}

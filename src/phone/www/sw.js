'use strict';

// The phone page's service worker: it shows the pet's notifications, and a tap on one opens the
// page at that session or notice. Nothing is cached; the page always comes from the PC.

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

// Every push shows a notification (an iPhone takes notifications away from a page that doesn't).
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
    icon: '/icon-192.png',
    data: { id: d.id || null },
  }));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const id = e.notification.data?.id || null;
  e.waitUntil((async () => {
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

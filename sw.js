/* ==========================================================================
   PERSONAL OS — sw.js

   Two jobs, both required by the alarm feature:

   1. OS-level notifications. On Android, `new Notification()` throws — the only
      way to raise a notification is ServiceWorkerRegistration.showNotification(),
      which needs this file to exist. It is also what lets a notification outlive
      the tab that created it and sit in the OS notification centre.

   2. Offline app shell, so a cold load with no network still opens.

   What this file deliberately does NOT do: schedule anything. A service worker
   cannot wake itself at a future time. Without a server to send a Web Push there
   is no way to alert a device whose browser is closed — see the alarm section of
   README.md for the honest limits and the ICS handoff that works around them.

   No build step: this file is served as-is, so keep it dependency-free and keep
   every path relative (GitHub Pages serves the app from a /NOTE-TAKER/ subpath,
   not the domain root).
   ========================================================================== */

const CACHE = 'personal-os-shell-v1';
const ASSETS = [
  './',
  './index.html',
  './app.js',
  './sync.js',
  './sw.js',
  './style.css',
  './privacy.html',
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE)
      // Individual puts, not addAll: one 404 must not abandon the whole install.
      .then(cache => Promise.all(ASSETS.map(url => cache.add(url).catch(() => {}))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

/* Network-first, cache as the offline fallback. A cache-first worker would pin
   users to a stale app.js forever, and this repo has no build step, no hashed
   filenames, and no version handshake to dig them back out with. */
self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  // Never mediate Google's auth script or the Drive API.
  if (url.origin !== self.location.origin) return;

  event.respondWith((async () => {
    try {
      const res = await fetch(req);
      if (res && res.ok) {
        const copy = res.clone();
        // Keep the cache write alive after the response is returned. Without
        // waitUntil a worker is free to terminate first, making offline support
        // intermittent on mobile.
        event.waitUntil(caches.open(CACHE).then(cache => cache.put(req, copy)).catch(() => {}));
      }
      return res;
    } catch (e) {
      const hit = await caches.match(req);
      if (hit) return hit;
      if (req.mode === 'navigate') {
        const shell = await caches.match('./index.html');
        if (shell) return shell;
      }
      // respondWith must always receive a Response. Returning undefined here
      // produces a browser-level TypeError instead of an honest offline 503.
      return new Response('Offline', { status: 503, statusText: 'Offline' });
    }
  })());
});

/* ---------- Alarm notifications ---------------------------------------- */

const ALARM_TAG_PREFIX = 'pos-alarm-';

function messageClients(payload) {
  return self.clients
    .matchAll({ type: 'window', includeUncontrolled: true })
    .then(clients => clients.forEach(client => client.postMessage(payload)));
}

/* Tapping the notification is one of the ways a user "turns the alarm off", so
   it has to reach the page and stop the ringing — the page owns the audio. */
self.addEventListener('notificationclick', event => {
  const data = event.notification.data || {};
  event.notification.close();

  event.waitUntil((async () => {
    await messageClients({ type: 'pos:alarm-stop', id: data.id, kind: data.kind, open: true });

    const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const existing = clients.find(c => 'focus' in c);
    if (existing) { await existing.focus(); return; }
    // No tab left to talk to: reopen the app so the alarm is not lost.
    if (self.clients.openWindow) await self.clients.openWindow('./');
  })());
});

/* Swiping the notification away counts as turning it off too. */
self.addEventListener('notificationclose', event => {
  const data = event.notification.data || {};
  event.waitUntil(messageClients({ type: 'pos:alarm-stop', id: data.id, kind: data.kind }));
});

/* Lets the page close every outstanding alarm notification in one call. */
self.addEventListener('message', event => {
  if (!event.data || event.data.type !== 'pos:clear-alarm-notifications') return;
  event.waitUntil(
    self.registration.getNotifications().then(list =>
      list.forEach(n => { if (n.tag && n.tag.startsWith(ALARM_TAG_PREFIX)) n.close(); })
    )
  );
});

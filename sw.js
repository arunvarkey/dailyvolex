/* Offline support.
 *
 * Opening the app on a phone with no signal used to show the browser's error
 * page. The shell and the latest post are cached, so it opens instantly and
 * still shows this morning's post on the Underground.
 *
 * Deliberately network-first for everything that can change: a cache-first
 * app serves yesterday's post and a stale build, and "turn it off and on
 * again" is not a workflow.
 */

const VERSION = 'dv-4';
const SHELL = `shell-${VERSION}`;
const DATA  = `data-${VERSION}`;

const SHELL_FILES = [
  './',
  './index.html',
  './manifest.json',
  './icon-180.png',
  './icon-192.png',
  './icon-512.png',
  './vendor/mp4box.min.js',
  './vendor/mp4-muxer.js',
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(SHELL)
      // One missing file must not fail the whole install, or the app simply
      // never goes offline-capable and nothing says why.
      .then(cache => Promise.allSettled(SHELL_FILES.map(f => cache.add(f))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k !== SHELL && k !== DATA).map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

async function networkFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  try {
    const fresh = await fetch(request);
    if (fresh && fresh.ok) cache.put(request, fresh.clone());
    return fresh;
  } catch (err) {
    const cached = await cache.match(request, { ignoreSearch: true });
    if (cached) return cached;
    throw err;
  }
}

self.addEventListener('fetch', event => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;   // never touch Google Fonts etc.

  // Today's post and its images: fresh when there is a connection, last
  // known good when there is not.
  if (url.pathname.includes('/data/')) {
    event.respondWith(networkFirst(request, DATA));
    return;
  }

  // The app itself: also network-first, so a new build is picked up the next
  // time the phone has a signal rather than after clearing site data.
  event.respondWith(
    networkFirst(request, SHELL).catch(() => caches.match('./index.html'))
  );
});

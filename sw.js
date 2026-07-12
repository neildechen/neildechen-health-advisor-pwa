/* Health Advisor PWA — service worker. Caches the APP SHELL ONLY.
 * Never caches API responses and never sees the token: API calls go to
 * script.google.com (cross-origin) and are deliberately not intercepted. */
'use strict';

const CACHE = 'ha-shell-v7';
const SHELL = [
  './',
  'index.html',
  'app.css?v=7',
  'app.js?v=7',
  'manifest.webmanifest',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/apple-touch-icon.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (url.origin !== self.location.origin) return; // API + everything else: straight to network
  e.respondWith(
    caches.match(e.request, { ignoreSearch: false }).then((hit) => hit || fetch(e.request))
  );
});

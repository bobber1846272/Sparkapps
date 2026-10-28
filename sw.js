// Spark Beheer — service worker
// Bewaart alleen de "schil" van de app (HTML, CSS, JS, iconen),
// zodat hij snel opent. Gegevens uit de database worden NOOIT bewaard.

const CACHE = 'spark-beheer-v6';
const SHELL = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './api.js',
  './config.js',
  './manifest.webmanifest',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Eerst het netwerk proberen (dan heb je altijd de nieuwste versie),
// alleen bij geen internet de bewaarde schil gebruiken.
self.addEventListener('fetch', event => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;

  event.respondWith(
    fetch(req.mode === 'navigate' ? req : new Request(req, { cache: 'no-cache' }))
      .then(res => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(req, copy));
        }
        return res;
      })
      .catch(() => caches.match(req).then(hit => hit || caches.match('./index.html')))
  );
});

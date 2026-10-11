// sw.js — offline support. NETWORK-FIRST: when online you always get the latest
// deployed files (so updates appear on the next reload); the cache is only a
// fallback when there is no connection. No financial data is ever cached here.
const CACHE = 'vac-shell-v1';
const SHELL = [
  './', './index.html', './styles.css', './manifest.webmanifest', './icon.svg', './icon-192.png',
  './app.js', './money.js', './parser.js', './ledger.js', './exporter.js', './storage.js', './speech.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      })
      .catch(() => caches.match(req, { ignoreSearch: true }).then((r) => r || caches.match('./index.html'))),
  );
});

// Service worker: aplikasi tetap bisa dibuka tanpa internet.
// Versi diganti otomatis saat build (lihat workflow), supaya update langsung terpakai.
const CACHE = 'btunote-__BUILD__';
const FILES = [
  './', 'index.html', 'css/app.css', 'manifest.webmanifest',
  'js/app.js', 'js/auth.js', 'js/config.js', 'js/db.js', 'js/enex.js', 'js/graph.js',
  'js/icons.js', 'js/keepimport.js', 'js/zip.js', 'js/viewer.js', 'lib/pdfjs/pdf.min.js', 'lib/pdfjs/pdf.worker.min.js', 'js/md5.js', 'js/model.js', 'js/sync.js',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/maskable-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  // Halaman: coba jaringan dulu (dapat versi terbaru), kalau offline pakai cache.
  if (e.request.mode === 'navigate') {
    e.respondWith(fetch(e.request).catch(() => caches.match('index.html')));
    return;
  }
  e.respondWith(caches.match(e.request, { ignoreSearch: true }).then((r) => r || fetch(e.request)));
});

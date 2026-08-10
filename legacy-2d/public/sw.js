// 오프라인 대비 최소 서비스 워커.
// 개발 중 낡은 파일이 남지 않도록 네트워크 우선, 실패 시에만 캐시를 쓴다.
const CACHE = 'sky-arena-v1';
const SHELL = [
  '/', '/css/style.css', '/manifest.webmanifest',
  '/js/main.js', '/js/net.js', '/js/input.js', '/js/world.js', '/js/render.js', '/js/audio.js',
  '/icons/icon-192.png', '/icons/icon-512.png',
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
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  if (url.pathname === '/stats.json' || url.pathname.startsWith('/ws')) return;

  e.respondWith(
    fetch(e.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(e.request).then((hit) => hit || caches.match('/')))
  );
});

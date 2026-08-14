// 서비스 워커 — 설치(PWA) 를 가능하게 하되 **낡은 코드를 절대 실행하지 않는다.**
//
// 예전 판은 모든 요청을 '네트워크 우선, 실패하면 캐시' 로 처리했다. 멀티플레이
// 게임이라 서버가 없으면 어차피 못 하는데, 서버를 재시작하는 몇 초 동안 앱을
// 열면 그 사이 요청만 캐시로 떨어졌다. 그 결과가 두 가지다.
//
//  1. 앱이 통째로 옛날 버전으로 되돌아간다(사용자가 실제로 겪은 증상).
//  2. 더 나쁜 경우 — 일부 모듈은 새 파일, 일부는 캐시의 옛 파일이 섞여 로드된다.
//     서로 안 맞는 코드가 반쯤 돌아가서, 오류도 안 나고 동작만 이상해진다.
//
// 그래서 **앱 코드(js/css/html)는 네트워크 전용**으로 바꿨다. 서버가 없으면
// 깔끔하게 실패하는 편이 낫다 — 어차피 서버 없이는 게임이 안 된다.
// 캐시는 아이콘·매니페스트처럼 코드가 아닌 것에만 쓴다(설치 요건).
const CACHE = 'sky-arena-v10';

// 코드가 아닌 것만 미리 담는다. 설치가 이것 때문에 실패하면 안 된다.
const SHELL = ['/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const c = await caches.open(CACHE);
    // addAll 은 하나라도 실패하면 통째로 거부된다 — 그러면 설치가 실패하고
    // **옛 워커가 계속 살아남아** 낡은 캐시를 계속 내준다. 개별로 담아
    // 한 파일이 없어도 설치는 끝까지 간다.
    await Promise.all(SHELL.map((u) => c.add(u).catch(() => {})));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
    // 낡은 번들을 이미 띄우고 있는 창이 있으면 새 코드로 갈아타게 한다.
    for (const cl of await self.clients.matchAll({ type: 'window' })) {
      cl.postMessage({ t: 'sw-updated' });
    }
  })());
});

/** 앱 코드인가 — 이건 절대 캐시에서 내주지 않는다. */
function isCode(url) {
  return url.pathname === '/'
      || url.pathname.endsWith('.js')
      || url.pathname.endsWith('.css')
      || url.pathname.endsWith('.html');
}

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  if (url.pathname === '/stats.json' || url.pathname.startsWith('/ws')) return;

  if (isCode(url)) return;   // 네트워크 전용 — 브라우저에게 그대로 넘긴다

  e.respondWith(
    fetch(e.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(e.request))
  );
});

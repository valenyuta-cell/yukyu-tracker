// Service Worker
//
// index.html / core.js / manifest は network-first。全部を cache-first にすると、
// 計算バグを直して再デプロイしても旧SWが旧 core.js を配り続ける。iOS の standalone は
// アプリスイッチャーに残っている限りクライアントが生きるため、アプリ内リロードでは復旧できず、
// 脱出のためにホーム画面アイコンを削除→再追加すると localStorage ごと消える。
// この事故を避けるため、更新が必ず届く側に倒す。オフライン起動はキャッシュへの
// フォールバックで担保する。

const CACHE_NAME = 'yukyu-1.0.0'; // core.js の VERSION と一致させること（テスト23が検査する）
const NETWORK_TIMEOUT_MS = 2500;

const SHELL = ['./', './index.html', './core.js', './manifest.webmanifest'];
const ICONS = ['./icons/icon-192.png', './icons/icon-512.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((c) => c.addAll([...SHELL, ...ICONS])).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

function timeout(ms) {
  return new Promise((_, reject) => setTimeout(() => reject(new Error('network timeout')), ms));
}

async function networkFirst(request) {
  const cache = await caches.open(CACHE_NAME);
  try {
    const res = await Promise.race([fetch(request, { cache: 'no-store' }), timeout(NETWORK_TIMEOUT_MS)]);
    if (res && res.ok) cache.put(request, res.clone());
    return res;
  } catch (e) {
    const hit = await cache.match(request, { ignoreSearch: true });
    if (hit) return hit;
    const shell = await cache.match('./index.html');
    if (shell && request.mode === 'navigate') return shell;
    throw e;
  }
}

async function cacheFirst(request) {
  const cache = await caches.open(CACHE_NAME);
  const hit = await cache.match(request, { ignoreSearch: true });
  if (hit) return hit;
  const res = await fetch(request);
  if (res && res.ok) cache.put(request, res.clone());
  return res;
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (url.pathname.includes('/icons/')) {
    event.respondWith(cacheFirst(request));
  } else {
    event.respondWith(networkFirst(request));
  }
});

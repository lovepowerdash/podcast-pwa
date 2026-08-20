// ---------------------------------------------------------------------------
// アプリシェルのみをキャッシュする Service Worker。
// エピソードのダウンロード/オフライン再生は非要件のため、音声とフィードは一切キャッシュしない。
// ---------------------------------------------------------------------------
const CACHE = 'podcast-pwa-v6';

const APP_SHELL = [
  '/',
  '/index.html',
  '/manifest.webmanifest',
  '/css/style.css',
  '/js/app.js',
  '/js/api.js',
  '/js/config.js',
  '/js/db.js',
  '/js/player.js',
  '/js/ui.js',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  // 音声ファイル・iTunes Search API は常にネットワークへ通す
  if (url.origin !== self.location.origin) return;
  // フィードの中継も同一オリジンだが、内容はアプリ側でキャッシュ管理するので触らない
  if (url.pathname.includes('/api/')) return;

  // GitHub Pages は max-age を付けて配信するため、素直に fetch すると Safari の
  // HTTPキャッシュが数分〜十数分ぶん古いコードを返す。更新の反映が遅れて原因の切り分けが
  // できなくなるので、同一オリジンの取得は常にサーバーへ確認しに行く（ETagで差分は出ない）。
  const revalidate = (req) => fetch(req.url, { cache: 'no-cache' });

  // 画面遷移はまずネットワーク、オフライン時のみキャッシュ済みシェルを返す
  if (request.mode === 'navigate') {
    event.respondWith(
      revalidate(request).catch(() => caches.match('/index.html')),
    );
    return;
  }

  // 静的アセットもネットワーク優先。オフライン再生は非要件で、キャッシュはあくまで
  // 「圏外でもアプリが開く」ための保険なので、更新の反映を遅らせないことを優先する。
  event.respondWith(
    revalidate(request)
      .then((response) => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(request, copy));
        }
        return response;
      })
      .catch(() => caches.match(request)),
  );
});

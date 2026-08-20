// ---------------------------------------------------------------------------
// アプリシェルのみをキャッシュする Service Worker。
// エピソードのダウンロード/オフライン再生は非要件のため、音声とフィードは一切キャッシュしない。
// ---------------------------------------------------------------------------
const CACHE = 'podcast-pwa-v2';

const APP_SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/style.css',
  './js/app.js',
  './js/api.js',
  './js/config.js',
  './js/db.js',
  './js/player.js',
  './js/ui.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
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
  // 音声ファイル・RSSプロキシ・iTunes Search API は常にネットワークへ通す
  if (url.origin !== self.location.origin) return;

  // 画面遷移はまずネットワーク、オフライン時のみキャッシュ済みシェルを返す
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).catch(() => caches.match('./index.html')),
    );
    return;
  }

  // 静的アセットもネットワーク優先。オフライン再生は非要件で、キャッシュはあくまで
  // 「圏外でもアプリが開く」ための保険なので、更新の反映を遅らせないことを優先する。
  event.respondWith(
    fetch(request)
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

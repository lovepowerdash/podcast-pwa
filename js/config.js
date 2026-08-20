// ---------------------------------------------------------------------------
// アプリ全体の設定値。外部サービス依存の値は必ずここに集約する。
// ---------------------------------------------------------------------------

// RSSフィードは配信元がCORSヘッダーを付けていないことが多いため、公開CORSプロキシ経由で取得する。
// プロキシは停止・仕様変更のリスクがあるので、ここ1箇所を書き換えれば差し替えられる形にしてある。
// 上から順に試し、失敗したら次のプロキシにフォールバックする。
export const CORS_PROXIES = [
  { name: 'allorigins', build: (url) => `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}` },
  { name: 'corsproxy.io', build: (url) => `https://corsproxy.io/?url=${encodeURIComponent(url)}` },
  { name: 'codetabs', build: (url) => `https://api.codetabs.com/v1/proxy/?quest=${encodeURIComponent(url)}` },
];

// iTunes Search APIはCORS許可済みなのでプロキシを通さず直接fetchする。
export const ITUNES_SEARCH_ENDPOINT = 'https://itunes.apple.com/search';
export const ITUNES_COUNTRY = 'JP';
export const ITUNES_LIMIT = 30;

export const DB_NAME = 'podcast_pwa_db';
export const DB_VERSION = 1;

// feedCacheの有効期限。毎回プロキシ経由で取りに行くと待ち時間がUXに直結するため、
// この秒数の間はキャッシュを使う（設計書 8. の未確定事項をここで確定）。
export const FEED_CACHE_TTL_SEC = 900; // 15分

export const SEEK_SECONDS = 15;              // ロック画面/フルプレイヤーのスキップ幅
export const POSITION_SAVE_INTERVAL_MS = 5000; // 再生位置をIndexedDBへ書き戻す間隔
export const READ_RATIO = 0.95;              // ここまで再生したら既読とみなす
export const PLAYBACK_RATES = [1, 1.25, 1.5, 1.75, 2];

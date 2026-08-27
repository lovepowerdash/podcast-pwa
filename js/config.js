// ---------------------------------------------------------------------------
// アプリ全体の設定値。外部サービス依存の値は必ずここに集約する。
// ---------------------------------------------------------------------------

// ホーム画面の下部に表示する版。端末に新しいコードが届いているかを目視で確かめるためのもの。
// 変更を配信するたびに更新する。
export const APP_VERSION = '2026-08-27 #41';

// RSSフィードの取得経路。全経路を同時に投げ、最初に成功したものを採用する。
//
// 公開CORSプロキシは「無料・登録不要」の代わりにレスポンスサイズ上限とレート制限があり、
// エピソード数の多い番組（RSSが数MB）では 413 や切断で失敗する。そのため本命は
// アプリと同じオリジンで動く中継（functions/api/feed.js）で、公開プロキシは保険。
// 同一オリジンの中継。相対パスなのでホスト名を持たず、配布先を変えても書き換え不要。
// 更新の有無だけを問い合わせる条件付き取得にも対応しているのはこの経路だけ。
export const RELAY_SOURCE = {
  name: '同一オリジン中継',
  build: (url) => `/api/feed?url=${encodeURIComponent(url)}`,
};

export const FEED_SOURCES = [
  RELAY_SOURCE,

  // 配信元がCORSを許可しているフィードはプロキシ不要。まずそのまま試す（失敗しても数百msで次へ進む）
  { name: '直接取得', build: (url) => url },

  { name: 'allorigins', build: (url) => `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}` },
  { name: 'codetabs', build: (url) => `https://api.codetabs.com/v1/proxy/?quest=${encodeURIComponent(url)}` },
  { name: 'corsproxy.io', build: (url) => `https://corsproxy.io/?url=${encodeURIComponent(url)}` },
];

// 応答の無いプロキシで待たされ続けないよう、1経路あたりの上限時間を決めておく。
// 全経路を同時に投げるので、これがそのまま最大待ち時間になる。
// 数MBのフィードをモバイル回線で受け切るには短すぎないほうがよい。
export const FEED_FETCH_TIMEOUT_MS = 40000;

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

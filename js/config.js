// ---------------------------------------------------------------------------
// アプリ全体の設定値。外部サービス依存の値は必ずここに集約する。
// ---------------------------------------------------------------------------

// RSSフィードの取得経路。上から順に試し、失敗したら次へフォールバックする。
//
// 公開CORSプロキシは「無料・登録不要」の代わりにレスポンスサイズ上限とレート制限がある。
// エピソード数の多い番組はRSSが数MBになり、上限に当たって 413 や切断で失敗する。
// 安定して使いたい場合は自前のCloudflare Workerを立てて FEED_SOURCES の先頭に置くこと
// （worker/cors-proxy.js とREADMEの手順を参照）。
export const FEED_SOURCES = [
  // 自前プロキシを立てたら、この行のコメントを外してURLを差し替える（最優先で使われる）
  // { name: 'my-worker', build: (url) => `https://<自分のworker>.workers.dev/?url=${encodeURIComponent(url)}` },

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

// ソースを書き換えずに端末側でプロキシを差し替えるための保存キー。
// ホーム画面の歯車から入力でき、設定されていれば FEED_SOURCES より優先される。
export const CUSTOM_PROXY_KEY = 'feedProxyTemplate';

export function customFeedSource() {
  let raw = '';
  try {
    raw = (localStorage.getItem(CUSTOM_PROXY_KEY) || '').trim();
  } catch { return null; } // プライベートブラウズ等でlocalStorageが使えない場合
  if (!raw) return null;
  return {
    name: '自前プロキシ',
    // `...?url={url}` のようなテンプレートでも、末尾に繋ぐだけの形でも受け付ける
    build: (url) => (raw.includes('{url}')
      ? raw.replace('{url}', encodeURIComponent(url))
      : raw + encodeURIComponent(url)),
  };
}

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

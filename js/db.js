// ---------------------------------------------------------------------------
// IndexedDB アクセス層（設計書 5. のスキーマ）
//   follows   : フォロー中の番組       keyPath = feedUrl
//   episodes  : 既読/未読・再生進捗    keyPath = episodeId, index: feedUrl
//   feedCache : RSSパース結果の一時キャッシュ keyPath = feedUrl
// ---------------------------------------------------------------------------
import { DB_NAME, DB_VERSION } from './config.js';

let dbPromise = null;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('follows')) {
        db.createObjectStore('follows', { keyPath: 'feedUrl' });
      }
      if (!db.objectStoreNames.contains('episodes')) {
        const store = db.createObjectStore('episodes', { keyPath: 'episodeId' });
        // 番組ごとのエピソード取得で全件走査しないためのインデックス（必須）
        store.createIndex('feedUrl', 'feedUrl', { unique: false });
      }
      if (!db.objectStoreNames.contains('feedCache')) {
        db.createObjectStore('feedCache', { keyPath: 'feedUrl' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(storeName, mode, fn) {
  return open().then((db) => new Promise((resolve, reject) => {
    const transaction = db.transaction(storeName, mode);
    const request = fn(transaction.objectStore(storeName));
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
    if (request) {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    } else {
      transaction.oncomplete = () => resolve();
    }
  }));
}

// ---- follows --------------------------------------------------------------

// 題名の比較は五十音順と同点処理の両方で使うので、照合器はひとつ作って使い回す
const collator = new Intl.Collator('ja');

/**
 * フォロー中の番組の並び順（設計書 8. の未確定事項をここで確定）。
 * 次の3つを持ち、ホームのトグルを1タップ押すごとにこの順で巡回する。既定は followed。
 *   followed : フォローした順（新しく追加したものが上）
 *   updated  : フィードの更新が新しい順。まだ開いていない番組は更新日を持たないので末尾
 *   title    : 題名の五十音順（漢字の題名は読みが無いため字の並び順になる）
 * 既定を followed にしてあるのは、選んでいないのに新着のある番組が上へ来ないようにするため。
 * 更新の新しい番組を把握したいときは updated を選ぶ。強調しないことと、知る手段を持つことは別。
 * どの順でも最後は followedAt → 題名 → feedUrl で決着させ、描き直しても同じ場所に落ち着かせる
 * （followedAt を持たない、この項目より前に追加した記録があるため）。
 */
const FOLLOW_ORDERS = {
  followed: () => 0,
  updated: (a, b) => (b.latestPubDate || 0) - (a.latestPubDate || 0),
  title: (a, b) => collator.compare(a.title || '', b.title || ''),
};

export const FOLLOW_ORDER_KEYS = Object.keys(FOLLOW_ORDERS);

export async function listFollows(order = getFollowOrder()) {
  const rows = (await tx('follows', 'readonly', (s) => s.getAll())) || [];
  const primary = FOLLOW_ORDERS[order] || FOLLOW_ORDERS.followed;
  return rows.sort((a, b) => primary(a, b)
    || (b.followedAt || 0) - (a.followedAt || 0)
    || collator.compare(a.title || '', b.title || '')
    || a.feedUrl.localeCompare(b.feedUrl));
}

// 端末ごとの設定が1つあるだけなので localStorage に置く。同期的に読み書きできるため、
// 描き直しの途中で画面を閉じられても書き込みが中断されない（番組ごとの設定と違う点）
const FOLLOW_ORDER_KEY = 'podflow.followOrder';

export function getFollowOrder() {
  try {
    const saved = localStorage.getItem(FOLLOW_ORDER_KEY);
    return FOLLOW_ORDERS[saved] ? saved : 'followed';
  } catch {
    return 'followed'; // 保存領域が使えない設定でも一覧は出す
  }
}

export function setFollowOrder(order) {
  try {
    localStorage.setItem(FOLLOW_ORDER_KEY, order);
  } catch { /* 覚えられなくても、その場の並び替えは効く */ }
}

export function getFollow(feedUrl) {
  return tx('follows', 'readonly', (s) => s.get(feedUrl));
}

export function putFollow(follow) {
  return tx('follows', 'readwrite', (s) => s.put(follow));
}

export async function addFollow({ feedUrl, title, artworkUrl = '' }) {
  const existing = await getFollow(feedUrl);
  if (existing) return existing;
  // 「フォロー」はRSSの仕様には存在しない、このアプリのローカル管理でしかない
  const follow = {
    feedUrl, title, artworkUrl, sortOrder: 'desc', hideRead: false, followedAt: Date.now(),
  };
  await putFollow(follow);
  return follow;
}

export async function removeFollow(feedUrl) {
  await tx('follows', 'readwrite', (s) => s.delete(feedUrl));
  await tx('feedCache', 'readwrite', (s) => s.delete(feedUrl));
  const states = await listEpisodeStates(feedUrl);
  for (const state of states) {
    await tx('episodes', 'readwrite', (s) => s.delete(state.episodeId));
  }
}

export async function setSortOrder(feedUrl, sortOrder) {
  await patchFollow(feedUrl, { sortOrder });
}

export async function setHideRead(feedUrl, hideRead) {
  await patchFollow(feedUrl, { hideRead });
}

export async function setArtwork(feedUrl, artworkUrl) {
  await patchFollow(feedUrl, { artworkUrl });
}

/**
 * 番組一覧に出す、フィードから分かること（更新日と全エピソード数）。
 * ホームはネットワークに触らないので、番組を開いたときに控えておく。
 */
export async function setFeedSummary(feedUrl, { latestPubDate, episodeCount }) {
  await patchFollow(feedUrl, { latestPubDate, episodeCount });
}

export async function setFollowTitle(feedUrl, title) {
  await patchFollow(feedUrl, { title });
}

async function patchFollow(feedUrl, patch) {
  const follow = await getFollow(feedUrl);
  if (!follow) return;
  await putFollow({ ...follow, ...patch });
}

// ---- episodes（既読/未読・再生進捗） ---------------------------------------

export function getEpisodeState(episodeId) {
  return tx('episodes', 'readonly', (s) => s.get(episodeId));
}

// feedUrl インデックス経由で番組単位に絞って取得する
export async function listEpisodeStates(feedUrl) {
  return (await tx('episodes', 'readonly', (s) => s.index('feedUrl').getAll(feedUrl))) || [];
}

/** 番組ごとの再生済み件数。番組一覧に出すのは件数だけなので中身は返さない */
export async function countReadEpisodes(feedUrl) {
  const rows = await listEpisodeStates(feedUrl);
  return rows.reduce((total, row) => total + (row.isRead ? 1 : 0), 0);
}

export async function episodeStateMap(feedUrl) {
  const rows = await listEpisodeStates(feedUrl);
  return new Map(rows.map((row) => [row.episodeId, row]));
}

export function putEpisodeState(state) {
  return tx('episodes', 'readwrite', (s) => s.put(state));
}

/** まだ再生記録が無いエピソードの初期状態 */
export function newEpisodeState(episode) {
  return {
    episodeId: episode.episodeId,
    feedUrl: episode.feedUrl,
    title: episode.title,
    pubDate: episode.pubDate,
    audioUrl: episode.audioUrl,
    isRead: false,
    position: 0,
    duration: episode.duration || 0,
    lastPlayedAt: 0,
  };
}

/** 既存レコードにパッチを当てて保存する（無ければ episode の情報から作る） */
export async function updateEpisodeState(episode, patch) {
  const current = (await getEpisodeState(episode.episodeId)) || newEpisodeState(episode);
  const next = { ...current, ...patch, title: episode.title, audioUrl: episode.audioUrl };
  await putEpisodeState(next);
  return next;
}

/**
 * 複数のエピソードの既読状態をまとめて切り替える。
 * 数百件を1件ずつ書くと遅いので、ひとつのトランザクションで処理する。
 */
export async function setEpisodesRead(episodes, isRead) {
  if (episodes.length === 0) return;
  const db = await open();
  await new Promise((resolve, reject) => {
    const transaction = db.transaction('episodes', 'readwrite');
    const store = transaction.objectStore('episodes');
    for (const episode of episodes) {
      const request = store.get(episode.episodeId);
      request.onsuccess = () => {
        const current = request.result || newEpisodeState(episode);
        // 既読/未再生のどちらに倒す場合も再生位置は先頭に戻す
        store.put({ ...current, isRead, position: 0 });
      };
    }
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

/** 取り消し用に、控えておいた状態をそのまま書き戻す */
export async function putEpisodeStates(states) {
  if (states.length === 0) return;
  const db = await open();
  await new Promise((resolve, reject) => {
    const transaction = db.transaction('episodes', 'readwrite');
    const store = transaction.objectStore('episodes');
    for (const state of states) store.put(state);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

// ---- feedCache ------------------------------------------------------------

export function getFeedCache(feedUrl) {
  return tx('feedCache', 'readonly', (s) => s.get(feedUrl));
}

export function putFeedCache(entry) {
  return tx('feedCache', 'readwrite', (s) => s.put(entry));
}

export function deleteFeedCache(feedUrl) {
  return tx('feedCache', 'readwrite', (s) => s.delete(feedUrl));
}

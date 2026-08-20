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

export async function listFollows() {
  const rows = (await tx('follows', 'readonly', (s) => s.getAll())) || [];
  return rows.sort((a, b) => (b.followedAt || 0) - (a.followedAt || 0));
}

export function getFollow(feedUrl) {
  return tx('follows', 'readonly', (s) => s.get(feedUrl));
}

export function putFollow(follow) {
  return tx('follows', 'readwrite', (s) => s.put(follow));
}

export async function addFollow({ feedUrl, title }) {
  const existing = await getFollow(feedUrl);
  if (existing) return existing;
  // 「フォロー」はRSSの仕様には存在しない、このアプリのローカル管理でしかない
  const follow = { feedUrl, title, sortOrder: 'desc', followedAt: Date.now() };
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
  const follow = await getFollow(feedUrl);
  if (!follow) return;
  follow.sortOrder = sortOrder;
  await putFollow(follow);
}

// ---- episodes（既読/未読・再生進捗） ---------------------------------------

export function getEpisodeState(episodeId) {
  return tx('episodes', 'readonly', (s) => s.get(episodeId));
}

// feedUrl インデックス経由で番組単位に絞って取得する
export async function listEpisodeStates(feedUrl) {
  return (await tx('episodes', 'readonly', (s) => s.index('feedUrl').getAll(feedUrl))) || [];
}

export async function episodeStateMap(feedUrl) {
  const rows = await listEpisodeStates(feedUrl);
  return new Map(rows.map((row) => [row.episodeId, row]));
}

export function putEpisodeState(state) {
  return tx('episodes', 'readwrite', (s) => s.put(state));
}

/** 既存レコードにパッチを当てて保存する（無ければ episode の情報から作る） */
export async function updateEpisodeState(episode, patch) {
  const current = (await getEpisodeState(episode.episodeId)) || {
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
  const next = { ...current, ...patch, title: episode.title, audioUrl: episode.audioUrl };
  await putEpisodeState(next);
  return next;
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

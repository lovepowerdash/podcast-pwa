// ---------------------------------------------------------------------------
// 外部データ取得: iTunes Search API（直接fetch）と RSSフィード（CORSプロキシ経由）
// ---------------------------------------------------------------------------
import {
  FEED_SOURCES, RELAY_SOURCE, FEED_FETCH_TIMEOUT_MS, ITUNES_SEARCH_ENDPOINT,
  ITUNES_COUNTRY, ITUNES_LIMIT, FEED_CACHE_TTL_SEC,
} from './config.js';
import { getFeedCache, putFeedCache } from './db.js';

/** iTunes Search API は CORS 許可済みなのでプロキシを通さない */
export async function searchPodcasts(term) {
  const params = new URLSearchParams({
    term, media: 'podcast', entity: 'podcast',
    country: ITUNES_COUNTRY, limit: String(ITUNES_LIMIT),
  });
  const res = await fetch(`${ITUNES_SEARCH_ENDPOINT}?${params}`);
  if (!res.ok) throw new Error(`iTunes Search API エラー (${res.status})`);
  const data = await res.json();
  return (data.results || [])
    .filter((r) => r.feedUrl)
    .map((r) => ({
      feedUrl: r.feedUrl,
      title: r.collectionName || r.trackName || '(タイトル不明)',
      author: r.artistName || '',
      trackCount: r.trackCount || 0,
      artworkUrl: artworkAt(r.artworkUrl100 || r.artworkUrl60 || '', 200),
    }));
}

/**
 * iTunesのアートワークURLは末尾で寸法を指定できる（例: .../100x100bb.jpg）。
 * 一覧の表示サイズに合わせて差し替える。想定と違う形式ならそのまま使う。
 */
function artworkAt(url, size) {
  return url ? url.replace(/\/\d+x\d+bb\.(jpg|png)$/, `/${size}x${size}bb.$1`) : '';
}

/** FNV-1a 32bit。<guid> を持たないフィードのフォールバック用 */
function hash(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}

/**
 * episodeId の生成規則（設計書 5.4）
 *   1. <guid> があれば  `${feedUrl}::${guid}`
 *   2. 無ければ         `${feedUrl}::${hash(audioUrl)}`
 */
export function buildEpisodeId(feedUrl, guid, audioUrl) {
  const key = guid && guid.trim() ? guid.trim() : hash(audioUrl || '');
  return `${feedUrl}::${key}`;
}

/** "3600" / "12:34" / "01:02:03" のいずれの表記も秒に正規化する */
function parseDuration(text) {
  if (!text) return 0;
  const raw = text.trim();
  if (/^\d+(\.\d+)?$/.test(raw)) return Math.round(Number(raw));
  const parts = raw.split(':').map((p) => Number(p) || 0);
  return parts.reduce((total, part) => total * 60 + part, 0);
}

function text(node, tagName) {
  const el = node.querySelector(tagName);
  return el ? el.textContent.trim() : '';
}

/** itunes:duration のような名前空間つきタグを取り出す */
function nsText(node, localName) {
  for (const child of node.children) {
    if (child.localName === localName) return child.textContent.trim();
  }
  return '';
}

function parseFeed(xmlText, feedUrl) {
  const doc = new DOMParser().parseFromString(xmlText, 'application/xml');
  if (doc.querySelector('parsererror')) throw new Error('RSSの解析に失敗しました');

  const channel = doc.querySelector('channel') || doc.documentElement;
  const feedTitle = text(channel, 'title') || '(番組名不明)';

  const items = Array.from(doc.querySelectorAll('item'));
  const episodes = [];
  for (const item of items) {
    const enclosure = item.querySelector('enclosure');
    const audioUrl = enclosure ? enclosure.getAttribute('url') : '';
    if (!audioUrl) continue; // 音声が無いアイテムは一覧に出さない

    const guidEl = item.querySelector('guid');
    const guid = guidEl ? guidEl.textContent.trim() : '';
    episodes.push({
      episodeId: buildEpisodeId(feedUrl, guid, audioUrl),
      // 差分取得のとき「どこまで持っているか」を中継へ伝える目印に使う
      guid,
      feedUrl,
      title: text(item, 'title') || '(無題)',
      pubDate: Date.parse(text(item, 'pubDate')) || 0,
      audioUrl,
      duration: parseDuration(nsText(item, 'duration')),
    });
  }
  return { feedTitle, episodes };
}

/** 応答が返らない経路で止まらないよう、タイムアウト付きでfetchする */
async function fetchWithTimeout(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FEED_FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { cache: 'no-store', signal: controller.signal, redirect: 'follow' });
  } finally {
    clearTimeout(timer);
  }
}

/** 一覧の中身が変わったかどうか。件数と各エピソードのIDで判定する */
function sameEpisodes(a, b) {
  return a.length === b.length && a.every((ep, i) => ep.episodeId === b[i].episodeId);
}

async function storeFeed(feedUrl, episodes, validators = {}) {
  await putFeedCache({
    feedUrl,
    rawEpisodes: episodes,
    cachedAt: Date.now(),
    ttl: FEED_CACHE_TTL_SEC,
    // 次回「変わったか」だけを問い合わせるための印。配信元が返さないこともある
    etag: validators.etag || '',
    lastModified: validators.lastModified || '',
  });
}

/**
 * フィードが更新されているかを確かめ、更新されていれば取り込む。
 *
 * 中継に ETag / Last-Modified を渡すと、変わっていない場合は配信元が本文を返さない。
 * 数MBのフィードを毎回落とさずに済むので、番組を開くたびに呼んでも負担にならない。
 * 印を返さない配信元もあるため、その場合は取得した中身を突き合わせて判定する。
 *
 * @returns {Promise<{changed: boolean, episodes?: Array, feedTitle?: string}>}
 */
export async function revalidateFeed(feedUrl) {
  const cache = await getFeedCache(feedUrl);
  const query = [];
  if (cache?.etag) query.push(`etag=${encodeURIComponent(cache.etag)}`);
  if (cache?.lastModified) query.push(`modified=${encodeURIComponent(cache.lastModified)}`);

  // 手持ちの中で一番新しい回を目印として渡すと、中継がそれより新しい分だけ返す
  const newest = newestEpisode(cache?.rawEpisodes || []);
  const marker = newest?.guid || newest?.audioUrl || '';
  if (marker) query.push(`after=${encodeURIComponent(marker)}`);

  let res;
  try {
    res = await fetchWithTimeout(RELAY_SOURCE.build(feedUrl) + (query.length ? `&${query.join('&')}` : ''));
  } catch {
    return { changed: false };
  }

  // 中継が使えない環境（静的ホスティングのみなど）では、期限切れのときだけ取り直す
  if (!res.ok && res.status !== 204) {
    if (!cache || Date.now() - cache.cachedAt < cache.ttl * 1000) return { changed: false };
    const { feedTitle, episodes } = await fetchAndStore(feedUrl);
    return { changed: !cache || !sameEpisodes(cache.rawEpisodes, episodes), episodes, feedTitle };
  }

  if (res.status === 204) return { changed: false }; // 配信元が「変わっていない」と答えた

  const validators = {
    etag: res.headers.get('x-feed-etag'),
    lastModified: res.headers.get('x-feed-modified'),
  };
  const { feedTitle, episodes } = parseFeed(await res.text(), feedUrl);

  // 差分が返ってきた場合は、手持ちに足す（全体は送られてきていない）
  if (res.headers.get('x-feed-partial') === '1' && cache) {
    if (episodes.length === 0) {
      await storeFeed(feedUrl, cache.rawEpisodes, validators);
      return { changed: false };
    }
    const known = new Set(cache.rawEpisodes.map((ep) => ep.episodeId));
    const added = episodes.filter((ep) => !known.has(ep.episodeId));
    const merged = [...added, ...cache.rawEpisodes];
    await storeFeed(feedUrl, merged, validators);
    return added.length > 0
      ? { changed: true, episodes: merged, feedTitle, added: added.length }
      : { changed: false };
  }

  await storeFeed(feedUrl, episodes, validators);
  if (cache && sameEpisodes(cache.rawEpisodes, episodes)) return { changed: false };
  return { changed: true, episodes, feedTitle };
}

/**
 * 手持ちの中で一番新しい回の公開日。フィードがどこまで更新されているかの目安として使う。
 * channel の lastBuildDate は取得のたびに現在時刻を返す配信元があり目安にならないため、
 * 回そのものの公開日を見る。
 */
export function newestPubDate(episodes) {
  return newestEpisode(episodes || [])?.pubDate || 0;
}

function newestEpisode(episodes) {
  return episodes.reduce((best, ep) => (!best || (ep.pubDate || 0) > (best.pubDate || 0) ? ep : best), null);
}

async function fetchFromSource(source, feedUrl) {
  const label = source.name;
  let res;
  try {
    res = await fetchWithTimeout(source.build(feedUrl));
  } catch (err) {
    throw new Error(`${label}: ${err.name === 'AbortError' ? 'タイムアウト' : err.message}`);
  }
  // 413 はプロキシのサイズ上限。エピソード数の多い番組で起きるので理由を明示する
  if (res.status === 413) throw new Error(`${label}: フィードが大きすぎます (413)`);
  if (!res.ok) throw new Error(`${label}: HTTP ${res.status}`);

  const body = await res.text();
  if (!body.trim()) throw new Error(`${label}: 空のレスポンス`);
  if (!body.includes('<item')) throw new Error(`${label}: RSSではない応答`);
  return body;
}

/**
 * 全経路を同時に投げ、最初に成功したものを採用する。
 * 数MBのフィードでは1経路あたり数十秒かかることがあり、直列に試すと待ち時間が積み上がるため。
 */
async function fetchFeedText(feedUrl) {
  try {
    return await Promise.any(FEED_SOURCES.map((source) => fetchFromSource(source, feedUrl)));
  } catch (aggregate) {
    const errors = (aggregate.errors || [aggregate]).map((err) => err.message);
    throw new Error(`フィードを取得できませんでした（${errors.join(' / ')}）`);
  }
}

/**
 * フィードを取得する。TTL内は feedCache を使い、プロキシへのアクセスを省く。
 * @param {object} [options] force:true でキャッシュを無視して再取得
 * @returns {Promise<{feedTitle:string|null, episodes:Array, cached:boolean}>}
 */
async function fetchAndStore(feedUrl) {
  const xml = await fetchFeedText(feedUrl);
  const { feedTitle, episodes } = parseFeed(xml, feedUrl);
  await storeFeed(feedUrl, episodes);
  return { feedTitle, episodes };
}

export async function fetchFeed(feedUrl, { force = false } = {}) {
  if (!force) {
    const cache = await getFeedCache(feedUrl);
    if (cache && Date.now() - cache.cachedAt < cache.ttl * 1000) {
      return { feedTitle: null, episodes: cache.rawEpisodes, cached: true };
    }
  }
  return { ...(await fetchAndStore(feedUrl)), cached: false };
}

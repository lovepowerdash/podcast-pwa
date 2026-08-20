// ---------------------------------------------------------------------------
// 外部データ取得: iTunes Search API（直接fetch）と RSSフィード（CORSプロキシ経由）
// ---------------------------------------------------------------------------
import {
  CORS_PROXIES, ITUNES_SEARCH_ENDPOINT, ITUNES_COUNTRY, ITUNES_LIMIT, FEED_CACHE_TTL_SEC,
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
    }));
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
    episodes.push({
      episodeId: buildEpisodeId(feedUrl, guidEl ? guidEl.textContent : '', audioUrl),
      feedUrl,
      title: text(item, 'title') || '(無題)',
      pubDate: Date.parse(text(item, 'pubDate')) || 0,
      audioUrl,
      duration: parseDuration(nsText(item, 'duration')),
    });
  }
  return { feedTitle, episodes };
}

async function fetchViaProxies(feedUrl) {
  const errors = [];
  for (const proxy of CORS_PROXIES) {
    try {
      const res = await fetch(proxy.build(feedUrl), { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.text();
      if (!body.trim()) throw new Error('空のレスポンス');
      return body;
    } catch (err) {
      errors.push(`${proxy.name}: ${err.message}`);
    }
  }
  throw new Error(`フィードを取得できませんでした（${errors.join(' / ')}）`);
}

/**
 * フィードを取得する。TTL内は feedCache を使い、プロキシへのアクセスを省く。
 * @param {object} [options] force:true でキャッシュを無視して再取得
 * @returns {Promise<{feedTitle:string|null, episodes:Array, cached:boolean}>}
 */
export async function fetchFeed(feedUrl, { force = false } = {}) {
  if (!force) {
    const cache = await getFeedCache(feedUrl);
    if (cache && Date.now() - cache.cachedAt < cache.ttl * 1000) {
      return { feedTitle: null, episodes: cache.rawEpisodes, cached: true };
    }
  }
  const xml = await fetchViaProxies(feedUrl);
  const { feedTitle, episodes } = parseFeed(xml, feedUrl);
  await putFeedCache({
    feedUrl,
    rawEpisodes: episodes,
    cachedAt: Date.now(),
    ttl: FEED_CACHE_TTL_SEC,
  });
  return { feedTitle, episodes, cached: false };
}

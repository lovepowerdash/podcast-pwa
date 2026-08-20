// ---------------------------------------------------------------------------
// 画面遷移とレンダリング。4画面（ホーム / エピソード一覧 / 番組検索 / プレイヤー）
// ---------------------------------------------------------------------------
import { searchPodcasts, fetchFeed } from './api.js';
import {
  listFollows, getFollow, addFollow, removeFollow, putFollow, setSortOrder, episodeStateMap,
} from './db.js';
import * as player from './player.js';
import { PLAYBACK_RATES } from './config.js';
import { $, escapeHtml, formatTime, formatDuration, formatDate, toast, spinner } from './ui.js';

// 現在のエピソード一覧画面が扱っている番組の状態
const show = {
  feedUrl: null,
  title: '',
  sortOrder: 'desc',
  episodes: [],
  states: new Map(),
};

let seeking = false;       // シークバー操作中は再生位置の自動反映を止める
let lastScreenHash = '#/'; // フルプレイヤーを閉じたときに戻る先

// ---- 画面切り替え ----------------------------------------------------------

function showScreen(name) {
  for (const key of ['home', 'show', 'search']) {
    $(`screen-${key}`).hidden = key !== name;
  }
}

function openFullPlayer(open) {
  $('player').hidden = !open;
  document.body.classList.toggle('player-open', open);
}

function route() {
  const hash = location.hash || '#/';

  if (hash === '#/player') {
    if (!player.getState().episode) { location.replace(lastScreenHash); return; }
    openFullPlayer(true);
    renderPlayer(player.getState());
    return;
  }

  openFullPlayer(false);
  lastScreenHash = hash;

  if (hash.startsWith('#/show/')) {
    showScreen('show');
    openShow(decodeURIComponent(hash.slice('#/show/'.length)));
  } else if (hash === '#/search') {
    showScreen('search');
    $('search-input').focus({ preventScroll: true });
  } else {
    showScreen('home');
    renderHome();
  }
}

// ---- ホーム（フォロー中番組一覧） -------------------------------------------

async function renderHome() {
  const list = $('home-list');
  const follows = await listFollows();

  if (follows.length === 0) {
    list.innerHTML = `
      <div class="empty">
        <p>フォロー中の番組はまだありません。</p>
        <a class="btn" href="#/search">番組を検索する</a>
      </div>`;
    return;
  }

  list.innerHTML = follows.map((f) => `
    <div class="row">
      <a class="row__main" href="#/show/${encodeURIComponent(f.feedUrl)}">
        <span class="row__title">${escapeHtml(f.title)}</span>
        <span class="row__meta">${f.sortOrder === 'asc' ? '古い順' : '新しい順'}で表示</span>
      </a>
      <button class="row__remove" type="button" data-unfollow="${escapeHtml(f.feedUrl)}" aria-label="フォローを解除">✕</button>
    </div>`).join('');
}

$('home-list').addEventListener('click', async (event) => {
  const button = event.target.closest('[data-unfollow]');
  if (!button) return;
  const feedUrl = button.dataset.unfollow;
  if (!confirm('この番組のフォローを解除しますか？（再生位置や既読も消えます）')) return;
  await removeFollow(feedUrl);
  renderHome();
});

// ---- エピソード一覧 ---------------------------------------------------------

function sortedEpisodes() {
  const sign = show.sortOrder === 'asc' ? 1 : -1;
  return [...show.episodes].sort((a, b) => sign * ((a.pubDate || 0) - (b.pubDate || 0)));
}

function renderSortToggle() {
  const asc = show.sortOrder === 'asc';
  $('sort-label').textContent = asc ? '公開日 古い順' : '公開日 新しい順';
  // 上向き/下向きの矢印だけを差し替える
  $('sort-arrow').setAttribute('points', asc ? '7 9 12 4 17 9' : '7 15 12 20 17 15');
  $('sort-toggle').setAttribute('aria-label', `並び替え: ${asc ? '古い順' : '新しい順'}。タップで反転`);
}

function renderEpisodes() {
  const list = $('episode-list');
  const episodes = sortedEpisodes();

  if (episodes.length === 0) {
    list.innerHTML = '<p class="placeholder">エピソードがありません。</p>';
    return;
  }

  const playingId = player.getState().episode?.episodeId;
  list.innerHTML = episodes.map((ep) => {
    const state = show.states.get(ep.episodeId);
    const duration = state?.duration || ep.duration;
    const progress = state && duration > 0 ? Math.min(1, (state.position || 0) / duration) : 0;
    const meta = [formatDate(ep.pubDate), formatDuration(duration)].filter(Boolean).join(' ・ ');
    return `
      <button class="ep ${state?.isRead ? 'is-read' : 'is-unread'} ${ep.episodeId === playingId ? 'is-playing' : ''}"
              type="button" data-episode="${escapeHtml(ep.episodeId)}">
        <span class="ep__dot" aria-hidden="true"></span>
        <span class="ep__body">
          <span class="ep__title">${escapeHtml(ep.title)}</span>
          <span class="ep__meta">${escapeHtml(meta)}${state?.isRead ? ' ・ 再生済み' : ''}</span>
          ${progress > 0.01 && !state?.isRead
            ? `<span class="ep__bar"><i style="width:${(progress * 100).toFixed(1)}%"></i></span>` : ''}
        </span>
      </button>`;
  }).join('');
}

async function openShow(feedUrl, { force = false } = {}) {
  const follow = await getFollow(feedUrl);
  if (!follow) { toast('フォローしていない番組です'); location.hash = '#/'; return; }

  show.feedUrl = feedUrl;
  show.title = follow.title;
  show.sortOrder = follow.sortOrder === 'asc' ? 'asc' : 'desc';
  $('show-title').textContent = follow.title;
  renderSortToggle();
  $('episode-list').innerHTML = spinner('エピソードを取得中…');

  try {
    const [{ feedTitle, episodes }, states] = await Promise.all([
      fetchFeed(feedUrl, { force }),
      episodeStateMap(feedUrl),
    ]);
    if (show.feedUrl !== feedUrl) return; // 取得中に別画面へ移動していたら破棄
    show.episodes = episodes;
    show.states = states;

    // 表示用キャッシュとしての番組名をフィードの内容で更新する
    if (feedTitle && feedTitle !== follow.title) {
      follow.title = feedTitle;
      await putFollow(follow);
      show.title = feedTitle;
      $('show-title').textContent = feedTitle;
    }
    renderEpisodes();
  } catch (err) {
    $('episode-list').innerHTML = `<p class="placeholder">${escapeHtml(err.message)}</p>`;
  }
}

// 1タップで並び順が反転する（メニューを開く操作を挟まない）
$('sort-toggle').addEventListener('click', async () => {
  show.sortOrder = show.sortOrder === 'asc' ? 'desc' : 'asc';
  renderSortToggle();
  renderEpisodes();
  $('episode-list').scrollTop = 0;
  if (show.feedUrl) await setSortOrder(show.feedUrl, show.sortOrder);
});

$('show-refresh').addEventListener('click', () => {
  if (show.feedUrl) openShow(show.feedUrl, { force: true });
});

// iOS ではユーザー操作のイベントハンドラ内で同期的に play() を呼ぶ必要があるため、
// 再生位置は描画時に読み込んだ show.states から同期的に取り出す（await を挟まない）
$('episode-list').addEventListener('click', (event) => {
  const button = event.target.closest('[data-episode]');
  if (!button) return;
  const episode = show.episodes.find((ep) => ep.episodeId === button.dataset.episode);
  if (!episode) return;
  const state = show.states.get(episode.episodeId);
  player.play(episode, show.title, state?.isRead ? 0 : (state?.position || 0));
  renderEpisodes(); // 再生中の行を強調（画面遷移はしない）
});

// ---- 番組検索 ---------------------------------------------------------------

let searchResults = [];

$('search-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const term = $('search-input').value.trim();
  if (!term) return;
  $('search-input').blur();
  $('search-list').innerHTML = spinner('検索中…');
  try {
    searchResults = await searchPodcasts(term);
    await renderSearchResults();
  } catch (err) {
    $('search-list').innerHTML = `<p class="placeholder">${escapeHtml(err.message)}</p>`;
  }
});

async function renderSearchResults() {
  const list = $('search-list');
  if (searchResults.length === 0) {
    list.innerHTML = '<p class="placeholder">該当する番組が見つかりませんでした。</p>';
    return;
  }
  const followed = new Set((await listFollows()).map((f) => f.feedUrl));
  list.innerHTML = searchResults.map((r) => `
    <div class="row">
      <span class="row__main">
        <span class="row__title">${escapeHtml(r.title)}</span>
        <span class="row__meta">${escapeHtml(r.author)}${r.trackCount ? ` ・ ${r.trackCount}本` : ''}</span>
      </span>
      <button class="btn btn--small" type="button" data-follow="${escapeHtml(r.feedUrl)}"
              ${followed.has(r.feedUrl) ? 'disabled' : ''}>
        ${followed.has(r.feedUrl) ? 'フォロー中' : 'フォロー'}
      </button>
    </div>`).join('');
}

$('search-list').addEventListener('click', async (event) => {
  const button = event.target.closest('[data-follow]');
  if (!button) return;
  const feedUrl = button.dataset.follow;
  const result = searchResults.find((r) => r.feedUrl === feedUrl);
  await addFollow({ feedUrl, title: result?.title || feedUrl });
  // フォロー後はそのままエピソード一覧へ移動する（設計書 8. の未確定事項をここで確定）
  location.hash = `#/show/${encodeURIComponent(feedUrl)}`;
});

// ---- プレイヤー（ミニ / フル） ----------------------------------------------

function renderPlayer(state) {
  const { episode, playing, position, duration, rate } = state;

  $('mini').hidden = !episode;
  if (!episode) {
    if (!$('player').hidden) history.back();
    return;
  }

  $('mini-title').textContent = episode.title;
  $('mini-show').textContent = episode.showTitle || '';
  $('mini-progress').style.width = duration > 0 ? `${(position / duration) * 100}%` : '0%';
  setPlayIcon($('mini-icon'), playing);

  if ($('player').hidden) return;
  $('player-title').textContent = episode.title;
  $('player-show').textContent = episode.showTitle || '';
  $('player-cur').textContent = formatTime(position);
  $('player-dur').textContent = formatTime(duration);
  if (!seeking) {
    $('player-seek').value = duration > 0 ? Math.round((position / duration) * 1000) : 0;
  }
  $('player-rate').textContent = `${rate.toFixed(2).replace(/0$/, '').replace(/\.$/, '.0')}x`;
  setPlayIcon($('player-icon'), playing);
}

function setPlayIcon(svg, playing) {
  svg.innerHTML = playing
    ? '<rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/>'
    : '<polygon points="7 4 20 12 7 20"/>';
}

$('mini-toggle').addEventListener('click', () => player.toggle());
$('player-toggle').addEventListener('click', () => player.toggle());
$('player-back').addEventListener('click', () => player.seekBy(-15));
$('player-fwd').addEventListener('click', () => player.seekBy(15));
$('player-rate').addEventListener('click', () => player.cycleRate());
$('player-close').addEventListener('click', () => {
  if (location.hash === '#/player') history.back();
  else openFullPlayer(false);
});

$('player-seek').addEventListener('input', () => { seeking = true; });
$('player-seek').addEventListener('change', () => {
  const { duration } = player.getState();
  if (duration > 0) player.seekTo((Number($('player-seek').value) / 1000) * duration);
  seeking = false;
});

let lastPlayingId = null;
player.subscribe((state) => {
  renderPlayer(state);
  // 再生中エピソードが変わったら一覧の強調表示を更新する
  const id = state.episode?.episodeId || null;
  if (id !== lastPlayingId) {
    lastPlayingId = id;
    if (!$('screen-show').hidden) renderEpisodes();
  }
});

// 再生位置の保存はプレイヤー側で行われるため、一覧の進捗表示は画面復帰時に取り直す
window.addEventListener('hashchange', route);
document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState === 'visible' && show.feedUrl && !$('screen-show').hidden) {
    show.states = await episodeStateMap(show.feedUrl);
    renderEpisodes();
  }
});

// ---- 起動 -------------------------------------------------------------------

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  });
}

// 再生速度の選択肢を1周ぶんだけ検証しておく（設定ミスの早期検出）
if (!PLAYBACK_RATES.includes(1)) console.warn('PLAYBACK_RATES に等倍速が含まれていません');

route();
renderPlayer(player.getState());

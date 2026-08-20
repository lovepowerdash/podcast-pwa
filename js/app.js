// ---------------------------------------------------------------------------
// 画面遷移とレンダリング。4画面（ホーム / エピソード一覧 / 番組検索 / プレイヤー）
// ---------------------------------------------------------------------------
import { searchPodcasts, fetchFeed } from './api.js';
import {
  listFollows, getFollow, addFollow, removeFollow, putFollow,
  setSortOrder, setHideRead, episodeStateMap,
} from './db.js';
import * as player from './player.js';
import { CUSTOM_PROXY_KEY } from './config.js';
import { $, escapeHtml, formatTime, formatDuration, formatDate, toast, spinner } from './ui.js';

// 現在のエピソード一覧画面が扱っている番組の状態
const show = {
  feedUrl: null,
  title: '',
  sortOrder: 'desc',
  hideRead: false,
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

// 公開プロキシが使えない番組向けに、自前プロキシのURLを端末側で差し替えられるようにする。
// （ソースを書き換えて再デプロイしなくても試せるようにするための逃げ道）
$('home-settings').addEventListener('click', () => {
  const current = localStorage.getItem(CUSTOM_PROXY_KEY) || '';
  const input = prompt(
    'フィード取得に使う自前プロキシのURLを入力してください。\n'
    + '例: https://xxxx.workers.dev/?url=\n'
    + '空欄にすると既定のプロキシに戻ります。',
    current,
  );
  if (input === null) return;
  const value = input.trim();
  if (value) {
    localStorage.setItem(CUSTOM_PROXY_KEY, value);
    toast('自前プロキシを設定しました');
  } else {
    localStorage.removeItem(CUSTOM_PROXY_KEY);
    toast('既定のプロキシに戻しました');
  }
});

$('home-list').addEventListener('click', async (event) => {
  const button = event.target.closest('[data-unfollow]');
  if (!button) return;
  const feedUrl = button.dataset.unfollow;
  if (!confirm('この番組のフォローを解除しますか？（再生位置や既読も消えます）')) return;
  await removeFollow(feedUrl);
  renderHome();
});

// ---- エピソード一覧 ---------------------------------------------------------

/** 並び替えとフィルタを適用した、いま画面に出ている順番のエピソード */
function visibleEpisodes() {
  const sign = show.sortOrder === 'asc' ? 1 : -1;
  const sorted = [...show.episodes].sort((a, b) => sign * ((a.pubDate || 0) - (b.pubDate || 0)));
  if (!show.hideRead) return sorted;
  const playingId = player.getState().episode?.episodeId;
  // 再生中のものは、既読になっても一覧から消さない
  return sorted.filter((ep) => !show.states.get(ep.episodeId)?.isRead || ep.episodeId === playingId);
}

/** 連続再生用のキュー。endedハンドラ内でDBを待てないので再開位置も持たせる */
function playbackQueue() {
  return visibleEpisodes().map((ep) => {
    const state = show.states.get(ep.episodeId);
    return { ...ep, resumeAt: state?.isRead ? 0 : (state?.position || 0) };
  });
}

function renderSortToggle() {
  const asc = show.sortOrder === 'asc';
  $('sort-label').textContent = asc ? '公開日 古い順' : '公開日 新しい順';
  // 上向き/下向きの矢印だけを差し替える
  $('sort-arrow').setAttribute('points', asc ? '7 9 12 4 17 9' : '7 15 12 20 17 15');
  $('sort-toggle').setAttribute('aria-label', `並び替え: ${asc ? '古い順' : '新しい順'}。タップで反転`);
}

function renderFilterToggle() {
  const hiding = show.hideRead;
  $('filter-label').textContent = hiding ? '未再生のみ' : 'すべて表示';
  // 目のアイコンに斜線を足して「隠している」ことを示す
  $('filter-icon').innerHTML = hiding
    ? '<path d="M2 12s3.6-6 10-6 10 6 10 6-3.6 6-10 6-10-6-10-6z"/><circle cx="12" cy="12" r="2.6"/><line x1="4" y1="20" x2="20" y2="4"/>'
    : '<path d="M2 12s3.6-6 10-6 10 6 10 6-3.6 6-10 6-10-6-10-6z"/><circle cx="12" cy="12" r="2.6"/>';
  $('filter-toggle').classList.toggle('is-on', hiding);
  $('filter-toggle').setAttribute('aria-label', `${hiding ? '再生済みを隠しています' : '再生済みも表示しています'}。タップで切り替え`);
}

function renderEpisodes() {
  const list = $('episode-list');
  const episodes = visibleEpisodes();

  if (episodes.length === 0) {
    list.innerHTML = show.hideRead && show.episodes.length > 0
      ? '<p class="placeholder">未再生のエピソードはありません。</p>'
      : '<p class="placeholder">エピソードがありません。</p>';
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
  show.hideRead = follow.hideRead === true;
  $('show-title').textContent = follow.title;
  renderSortToggle();
  renderFilterToggle();
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
    $('episode-list').innerHTML = `
      <div class="empty">
        <p>${escapeHtml(err.message)}</p>
        <button class="btn" type="button" id="episode-retry">再試行</button>
      </div>`;
    $('episode-retry').addEventListener('click', () => openShow(feedUrl, { force: true }));
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

// 再生済みを一覧から外す。並び替えと同じく1タップで切り替わり、番組ごとに保存される
$('filter-toggle').addEventListener('click', async () => {
  show.hideRead = !show.hideRead;
  renderFilterToggle();
  renderEpisodes();
  $('episode-list').scrollTop = 0;
  if (show.feedUrl) await setHideRead(show.feedUrl, show.hideRead);
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
  // 再生が終わったら一覧の次の回へ自動で進めるよう、いまの表示順をキューとして渡す
  player.play(episode, show.title, state?.isRead ? 0 : (state?.position || 0), playbackQueue());
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
let lastReadRevision = 0;
player.subscribe(async (state) => {
  renderPlayer(state);
  // 再生中エピソードが変わったとき（自動送りを含む）と、既読が書き込まれたときに
  // 一覧を読み直す。フィルタ表示が既読の反映を取りこぼさないようにするため。
  const id = state.episode?.episodeId || null;
  const changed = id !== lastPlayingId || state.readRevision !== lastReadRevision;
  lastPlayingId = id;
  lastReadRevision = state.readRevision;
  if (changed && !$('screen-show').hidden && show.feedUrl) {
    show.states = await episodeStateMap(show.feedUrl);
    renderEpisodes();
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
  // すでに旧Service Workerに制御されている場合、新しいものが引き継いだ時点で
  // 読み込み済みの古いコードを捨てるために一度だけ再読み込みする
  if (navigator.serviceWorker.controller) {
    let reloading = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (reloading) return;
      reloading = true;
      location.reload();
    });
  }
  // app.js は index.html から動的importされるため、この時点で load 済みのことがある
  const register = () => {
    navigator.serviceWorker.register('./sw.js')
      .then((registration) => registration.update())
      .catch(() => {});
  };
  if (document.readyState === 'complete') register();
  else window.addEventListener('load', register);
}

route();
renderPlayer(player.getState());

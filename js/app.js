// ---------------------------------------------------------------------------
// 画面遷移とレンダリング。4画面（ホーム / エピソード一覧 / 番組検索 / プレイヤー）
// ---------------------------------------------------------------------------
import { searchPodcasts, fetchFeed, revalidateFeed } from './api.js';
import {
  listFollows, getFollow, addFollow, removeFollow,
  setSortOrder, setHideRead, setArtwork, episodeStateMap, setEpisodesRead,
  putEpisodeStates, newEpisodeState, getFeedCache, setFollowTitle,
} from './db.js';
import * as player from './player.js';
import { APP_VERSION } from './config.js';
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
let lastScreenPath = '/';  // 重ねて出す画面を閉じたときに戻る先

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

function openHelp(open) {
  $('help').hidden = !open;
  document.body.classList.toggle('player-open', open);
}

/** 画面遷移。履歴に積んでから描き直す */
function navigate(path, { replace = false } = {}) {
  if (replace) history.replaceState(null, '', path);
  else history.pushState(null, '', path);
  route();
}

// アプリ内のリンクは、ページを読み直さずに画面を切り替える
document.addEventListener('click', (event) => {
  const link = event.target.closest('a[href^="/"]');
  if (!link || link.target || event.metaKey || event.ctrlKey || event.shiftKey) return;
  event.preventDefault();
  navigate(link.getAttribute('href'));
});

window.addEventListener('popstate', route);

function route() {
  const path = location.pathname;
  const params = new URLSearchParams(location.search);

  // 使い方は他の画面に重ねて出す。戻る操作でそのまま閉じられる
  if (path === '/help') {
    openFullPlayer(false);
    openHelp(true);
    return;
  }
  openHelp(false);

  if (path === '/player') {
    if (!player.getState().episode) { navigate(lastScreenPath, { replace: true }); return; }
    openFullPlayer(true);
    renderPlayer(player.getState());
    return;
  }

  openFullPlayer(false);
  lastScreenPath = path + location.search;

  if (path === '/show') {
    showScreen('show');
    openShow(params.get('feed') || '');
  } else if (path === '/search') {
    showScreen('search');
    $('search-input').focus({ preventScroll: true });
  } else {
    showScreen('home');
    renderHome();
  }
}

// ---- ホーム（フォロー中番組一覧） -------------------------------------------

/**
 * ホーム画面から起動されているか。
 * iOS は独自の navigator.standalone を持ち、display-mode に対応したのは比較的最近なので両方見る。
 */
function isStandalone() {
  return window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
}

// Android の Chrome などは、インストール可能になるとこのイベントを投げてくる。
// 受け取っておけば、案内文の代わりにボタン1つで追加してもらえる。
let installPrompt = null;
window.addEventListener('beforeinstallprompt', (event) => {
  event.preventDefault();
  installPrompt = event;
  if (!$('screen-home').hidden) renderHome();
});
window.addEventListener('appinstalled', () => {
  installPrompt = null;
  if (!$('screen-home').hidden) renderHome();
});

/** ホーム画面への追加を促す案内。追加方法は環境で違うので出し分ける */
function installTip() {
  if (isStandalone()) return '';

  if (installPrompt) {
    return `
      <div class="tip">
        <p class="tip__lead">ホーム画面に追加すると便利です</p>
        <p>アドレスバーの無い状態で起動でき、アプリのように扱えます。ロック画面からの操作もそのまま使えます。</p>
        <button class="btn tip__install" type="button" id="install">ホーム画面に追加</button>
      </div>`;
  }

  const android = /android/i.test(navigator.userAgent);
  const how = android
    ? 'ブラウザのメニュー（ ⋮ ）から「アプリをインストール」または「ホーム画面に追加」を選ぶと、'
    : 'Safariの共有ボタン<svg class="tip__icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v12"/><polyline points="8 7 12 3 16 7"/><path d="M6 12v7a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1v-7"/></svg>から「ホーム画面に追加」を選ぶと、';
  return `
      <div class="tip">
        <p class="tip__lead">ホーム画面に追加すると便利です</p>
        <p>${how}アドレスバーの無い状態で起動でき、アプリのように扱えます。ロック画面からの操作もそのまま使えます。</p>
      </div>`;
}

// 同じ内容で描き直すと画像の要素が作り直され、読み込みし直しでちらつく。
// 前回描いた内容と同じなら何もしない。
let homeSignature = null;

async function renderHome() {
  const list = $('home-list');
  const follows = await listFollows();

  const signature = JSON.stringify([
    follows.map((f) => [f.feedUrl, f.title, f.artworkUrl, f.sortOrder]),
    isStandalone(),
    Boolean(installPrompt),
  ]);
  if (signature === homeSignature) return;
  homeSignature = signature;

  // 端末に届いている版を確認できるようにしておく（タップで再生まわりの記録を表示）
  const footer = `<button class="version" type="button" id="version">${escapeHtml(APP_VERSION)}</button>`;

  if (follows.length === 0) {
    // 案内はブラウザの操作パネルに近い画面下端へ寄せる（共有ボタンへの動線を短くするため）
    list.classList.add('is-empty');
    list.innerHTML = `
      <div class="empty">
        <p>フォロー中の番組はまだありません。</p>
        <a class="btn" href="/search">番組を検索する</a>
      </div>
      <div class="home__bottom">${installTip()}${footer}</div>`;
    return;
  }
  list.classList.remove('is-empty');

  list.innerHTML = follows.map((f) => `
    <div class="row">
      <img class="row__art" src="${escapeHtml(f.artworkUrl || '')}" alt="" loading="lazy"
           onerror="this.removeAttribute('src')">
      <a class="row__main" href="/show?feed=${encodeURIComponent(f.feedUrl)}">
        <span class="row__title">${escapeHtml(f.title)}</span>
        <span class="row__meta">${f.sortOrder === 'asc' ? '古い順' : '新しい順'}で表示</span>
      </a>
      <button class="row__remove" type="button" data-unfollow="${escapeHtml(f.feedUrl)}" aria-label="フォローを解除">✕</button>
    </div>`).join('') + footer;

  backfillArtwork(follows);
}

// アートワークURLを持っていないフォロー（この機能より前に追加したもの）を後から補う。
// フィード本体は数MBあるので取りに行かず、軽いiTunes Search APIで番組名から引き当てる。
const artworkTried = new Set();

async function backfillArtwork(follows) {
  const missing = follows.filter((f) => !f.artworkUrl && !artworkTried.has(f.feedUrl));
  if (missing.length === 0) return;

  let found = false;
  for (const follow of missing) {
    artworkTried.add(follow.feedUrl);
    try {
      const results = await searchPodcasts(follow.title);
      const match = results.find((r) => r.feedUrl === follow.feedUrl);
      if (!match?.artworkUrl) continue;
      await setArtwork(follow.feedUrl, match.artworkUrl);
      found = true;
    } catch { /* 取れなければ画像なしのまま表示する */ }
  }
  if (found && !$('screen-home').hidden) renderHome();
}

$('home-list').addEventListener('click', async (event) => {
  if (event.target.closest('#install') && installPrompt) {
    const prompt = installPrompt;
    installPrompt = null;
    prompt.prompt();
    return;
  }

  // 実機で何が起きたかを確認するための記録（開発者コンソールが使えないため）
  if (event.target.closest('#version')) {
    alert(`版: ${APP_VERSION}\n\n再生まわりの記録:\n${player.diagnostics()}`);
    return;
  }

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

  // 並び替えやフィルタを変えたら、連続再生の送り先も画面の並びに合わせる
  player.setQueue(playbackQueue());

  const playingId = player.getState().episode?.episodeId;
  list.innerHTML = episodes.map((ep) => {
    const state = show.states.get(ep.episodeId);
    const duration = state?.duration || ep.duration;
    const progress = state && duration > 0 ? Math.min(1, (state.position || 0) / duration) : 0;
    const meta = [formatDate(ep.pubDate), formatDuration(duration)].filter(Boolean).join(' ・ ');
    return `
      <div class="ep ${state?.isRead ? 'is-read' : 'is-unread'} ${ep.episodeId === playingId ? 'is-playing' : ''}">
        <button class="ep__play" type="button" data-episode="${escapeHtml(ep.episodeId)}">
          <span class="ep__dot" aria-hidden="true"></span>
          <span class="ep__body">
            <span class="ep__title">${escapeHtml(ep.title)}</span>
            <span class="ep__meta">${escapeHtml(meta)}${state?.isRead ? ' ・ 再生済み' : ''}</span>
            ${progress > 0.01 && !state?.isRead
              ? `<span class="ep__bar"><i style="width:${(progress * 100).toFixed(1)}%"></i></span>` : ''}
          </span>
        </button>
        <button class="ep__menu" type="button" data-menu="${escapeHtml(ep.episodeId)}"
                aria-label="この回の操作メニュー"><i></i></button>
      </div>`;
  }).join('');
}

async function openShow(feedUrl, { force = false } = {}) {
  const follow = await getFollow(feedUrl);
  if (!follow) { toast('フォローしていない番組です'); navigate('/', { replace: true }); return; }

  show.feedUrl = feedUrl;
  show.title = follow.title;
  show.sortOrder = follow.sortOrder === 'asc' ? 'asc' : 'desc';
  show.hideRead = follow.hideRead === true;
  $('show-title').textContent = follow.title;
  renderSortToggle();
  renderFilterToggle();

  // 手持ちがあるなら読み込み表示を挟まずに一度で描く。
  // 差し込みが二段階になると、組み立ての過程が見えてしまうため。
  if (!force) {
    const [cache, states] = await Promise.all([getFeedCache(feedUrl), episodeStateMap(feedUrl)]);
    if (show.feedUrl !== feedUrl) return;
    if (cache) {
      show.episodes = cache.rawEpisodes;
      show.states = states;
      renderEpisodes();
      // 表示したあとで、裏で更新の有無だけ確かめる
      checkForNewEpisodes(feedUrl, follow);
      return;
    }
  }

  $('episode-list').innerHTML = spinner('エピソードを取得中…');

  try {
    const [{ feedTitle, episodes }, states] = await Promise.all([
      fetchFeed(feedUrl, { force }),
      episodeStateMap(feedUrl),
    ]);
    if (show.feedUrl !== feedUrl) return; // 取得中に別画面へ移動していたら破棄
    show.episodes = episodes;
    show.states = states;
    await applyFeedTitle(follow, feedTitle);
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

/**
 * 番組名は表示用のキャッシュなので、フィードの内容で追従させる。
 * 開いた時点の情報をそのまま書き戻すと、その後に変えた並び順やフィルタを
 * 巻き戻してしまうため、名前だけを書き換える。
 */
async function applyFeedTitle(follow, feedTitle) {
  if (!feedTitle || feedTitle === follow.title) return;
  follow.title = feedTitle;
  await setFollowTitle(follow.feedUrl, feedTitle);
  show.title = feedTitle;
  $('show-title').textContent = feedTitle;
}

/** 表示したあとに、フィードが新しくなっていれば一覧を差し替える */
async function checkForNewEpisodes(feedUrl, follow) {
  let result;
  try {
    result = await revalidateFeed(feedUrl);
  } catch {
    return; // 確かめられなくても、表示済みの内容はそのままでよい
  }
  if (!result.changed || show.feedUrl !== feedUrl) return;

  const added = result.added ?? (result.episodes.length - show.episodes.length);
  show.episodes = result.episodes;
  show.states = await episodeStateMap(feedUrl);
  await applyFeedTitle(follow, result.feedTitle);
  renderEpisodes();
  toast(added > 0 ? `新しいエピソードが ${added} 件あります` : 'エピソード一覧を更新しました');
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

/**
 * 下から出る操作メニュー。アイコンだけでは何が起きるか読み取れないので、
 * 実行するものは文言で並べる。番組とエピソードの両方で使い回す。
 */
function openSheet(title, items) {
  $('sheet-title').textContent = title;
  const container = $('sheet-items');
  container.innerHTML = '';
  for (const item of items) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'sheet__item';
    button.textContent = item.label;
    button.addEventListener('click', () => {
      closeSheet();
      item.run();
    });
    container.appendChild(button);
  }
  $('sheet').hidden = false;
}

function closeSheet() {
  $('sheet').hidden = true;
}

$('sheet').addEventListener('click', (event) => {
  if (event.target.closest('[data-close-sheet]')) closeSheet();
});

/** 取り消しで元通りにできるよう、変更前の状態を控えておく */
function snapshotStates(episodes) {
  return episodes.map((ep) => show.states.get(ep.episodeId) || newEpisodeState(ep));
}

async function applyBulkChange(episodes, isRead, doneMessage) {
  const before = snapshotStates(episodes);
  await setEpisodesRead(episodes, isRead);
  show.states = await episodeStateMap(show.feedUrl);
  renderEpisodes();
  toast(doneMessage, {
    label: '取り消す',
    run: async () => {
      // 既読かどうかだけでなく再生位置も含めて、そのまま書き戻す
      await putEpisodeStates(before);
      show.states = await episodeStateMap(show.feedUrl);
      renderEpisodes();
    },
  });
}

/**
 * 他のアプリから乗り換えた場合、どこまで聴いたかを引き継げない。
 * 「最初の回からこの回まで」をまとめて再生済みにして、続きから始められるようにする。
 */
async function markThrough(episode) {
  // 並び順に関係なく、公開日が対象の回以前のものを対象にする
  const targets = show.episodes.filter((ep) => (ep.pubDate || 0) <= (episode.pubDate || 0));
  const changing = targets.filter((ep) => !show.states.get(ep.episodeId)?.isRead);

  if (changing.length === 0) {
    toast('この回までは、すでに再生済みです');
    return;
  }
  if (!confirm(`「${episode.title}」までの ${changing.length} 件を再生済みにしますか？`)) return;
  await applyBulkChange(targets, true, `${changing.length} 件を再生済みにしました`);
}

/** 番組まるごと未再生に戻す（付け直したい場合や、間違えて一括既読にした場合の受け皿） */
async function resetShow() {
  const changing = show.episodes.filter((ep) => {
    const state = show.states.get(ep.episodeId);
    return state?.isRead || (state?.position || 0) > 0;
  });

  if (changing.length === 0) {
    toast('未再生に戻す回はありません');
    return;
  }
  if (!confirm(`「${show.title}」の ${changing.length} 件を未再生に戻しますか？\n再生途中の位置も消えます。`)) return;
  await applyBulkChange(changing, false, `${changing.length} 件を未再生に戻しました`);
}

$('show-menu').addEventListener('click', () => {
  if (!show.feedUrl) return;
  openSheet(show.title, [
    { label: '最新のエピソードを取得', run: () => openShow(show.feedUrl, { force: true }) },
    { label: '全て未再生に戻す', run: resetShow },
  ]);
});

// iOS ではユーザー操作のイベントハンドラ内で同期的に play() を呼ぶ必要があるため、
// 再生位置は描画時に読み込んだ show.states から同期的に取り出す（await を挟まない）
$('episode-list').addEventListener('click', (event) => {
  const menu = event.target.closest('[data-menu]');
  if (menu) {
    const target = show.episodes.find((ep) => ep.episodeId === menu.dataset.menu);
    if (target) openSheet(target.title, [{ label: 'ここまで再生済みにする', run: () => markThrough(target) }]);
    return;
  }

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
      <img class="row__art" src="${escapeHtml(r.artworkUrl || '')}" alt="" loading="lazy"
           onerror="this.removeAttribute('src')">
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
  await addFollow({ feedUrl, title: result?.title || feedUrl, artworkUrl: result?.artworkUrl || '' });
  // フォロー後はそのままエピソード一覧へ移動する（設計書 8. の未確定事項をここで確定）
  navigate(`/show?feed=${encodeURIComponent(feedUrl)}`);
});

// ---- プレイヤー（ミニ / フル） ----------------------------------------------

function renderPlayer(state) {
  const { episode, playing, position, duration, rate } = state;

  $('mini').hidden = !episode;
  // ミニプレイヤーの高さぶんの余白は、出ているときだけ確保する
  document.body.classList.toggle('is-playing', Boolean(episode));
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
  if (location.pathname === '/player') history.back();
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
let lastAutoAdvanceBlocked = null;
player.subscribe(async (state) => {
  renderPlayer(state);

  // 自動送りがブラウザに拒否されたときは黙って止まらず、理由を知らせる
  if (state.autoAdvanceBlocked && state.autoAdvanceBlocked !== lastAutoAdvanceBlocked) {
    toast(`次の回を自動再生できませんでした (${state.autoAdvanceBlocked})。再生ボタンで続けられます`);
  }
  lastAutoAdvanceBlocked = state.autoAdvanceBlocked;
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
document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState === 'visible' && show.feedUrl && !$('screen-show').hidden) {
    show.states = await episodeStateMap(show.feedUrl);
    renderEpisodes();
  }
});

// ---- 起動 -------------------------------------------------------------------

// 拡大の抑止。CSSの touch-action と viewport の指定だけでは Safari が拡大することが
// あるため、iOS 独自のピンチ操作イベントも止めておく。
for (const type of ['gesturestart', 'gesturechange', 'gestureend']) {
  document.addEventListener(type, (event) => event.preventDefault(), { passive: false });
}

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

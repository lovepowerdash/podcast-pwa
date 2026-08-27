// ---------------------------------------------------------------------------
// 画面遷移とレンダリング。4画面（ホーム / エピソード一覧 / 番組検索 / プレイヤー）
// ---------------------------------------------------------------------------
import { searchPodcasts, fetchFeed, revalidateFeed, newestPubDate } from './api.js';
import {
  listFollows, getFollow, addFollow, removeFollow,
  setSortOrder, setHideRead, setArtwork, episodeStateMap, setEpisodesRead,
  putEpisodeStates, newEpisodeState, getFeedCache, setFollowTitle, setFeedSummary,
  countReadEpisodes, getFollowOrder, setFollowOrder, FOLLOW_ORDER_KEYS,
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

/**
 * 画面を切り替える。
 * 隠している間の書き換えは描画されないので、中身を組み立て終えてから呼ぶこと。
 * 先に出してから埋めると、組み立ての過程がそのまま見えてしまう。
 */
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
    // 画面を出すのは openShow の中。中身が揃うまでは前の画面のままにする
    openShow(params.get('feed') || '');
  } else if (path === '/search') {
    // 他の画面から入り直したときは前回の検索を持ち越さない。
    // プレイヤーや使い方を重ねて閉じた場合は画面が出たままなので、そのまま残す
    if ($('screen-search').hidden) resetSearch();
    showScreen('search');
    $('search-input').focus({ preventScroll: true });
  } else {
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

/**
 * 番組行の1行目。並び順と、フィードの更新日（一番新しい回の公開日）を並べる。
 * 更新が新しいことを強調はしない。どの番組も同じ見た目で日付だけを置き、
 * 目立たせるかどうかの判断は見る側に任せる。
 */
function followMeta(follow) {
  // 「で表示」まで書くと幅320pxの端末で日付が2行目に落ちるため、順番の名前だけにする
  const order = follow.sortOrder === 'asc' ? '古い順' : '新しい順';
  const updated = follow.latestPubDate ? `更新 ${formatDate(follow.latestPubDate)}` : '';
  return [order, updated].filter(Boolean).join(' ・ ');
}

/**
 * 番組行の2行目。どこまで聴いたか（再生済み / 全件）。
 * 1行目に足すと幅320pxの端末で折り返すので行を分けている。
 * 全件がまだ分からない番組（一度も開いていない）では出さない。
 */
function followProgress(follow, readCount) {
  const total = follow.episodeCount || 0;
  if (total === 0) return '';
  // 配信が取り下げた回の記録が残っていることがあるので、全件を超えないようにする
  return `${Math.min(readCount, total)}/${total} 再生済み`;
}

// 更新日と全件数を持っていないフォロー（この機能より前に追加したもの）を後から補う。
// 番組を開けばそのとき入るが、それまでの間も一覧に出せるよう手持ちのキャッシュから拾う。
const summaryTried = new Set();

async function backfillFeedSummary(follows) {
  const missing = follows.filter((f) => !f.latestPubDate && !summaryTried.has(f.feedUrl));
  if (missing.length === 0) return;

  let found = false;
  for (const follow of missing) {
    summaryTried.add(follow.feedUrl);
    const cache = await getFeedCache(follow.feedUrl);
    const episodes = cache?.rawEpisodes || [];
    if (episodes.length === 0) continue; // まだ一度も開いていない番組。開いたときに入る
    await setFeedSummary(follow.feedUrl, {
      latestPubDate: newestPubDate(episodes),
      episodeCount: episodes.length,
    });
    found = true;
  }
  if (found && !$('screen-home').hidden) renderHome();
}

/**
 * 並び順の名前。押すたびに何になったかが文言で分かるようにする（アイコンだけにしない）。
 * 「更新が新しい順」は選んだときだけ効く。既定はフォローした順で、黙って新着が上へ来ることはない。
 */
const FOLLOW_ORDER_LABELS = {
  followed: 'フォローした順',
  updated: '更新が新しい順',
  title: '五十音順',
};

// 同じ内容で描き直すと画像の要素が作り直され、読み込みし直しでちらつく。
// 前回描いた内容と同じなら何もしない。
let homeSignature = null;

async function renderHome() {
  const list = $('home-list');
  const order = getFollowOrder();
  const follows = await listFollows(order);
  // 再生済み件数は再生や一括操作で変わるので、控えずに episodes の索引から数える
  const readCounts = await Promise.all(follows.map((f) => countReadEpisodes(f.feedUrl)));

  const signature = JSON.stringify([
    order,
    follows.map((f, i) => [
      f.feedUrl, f.title, f.artworkUrl, f.sortOrder, f.latestPubDate, f.episodeCount, readCounts[i],
    ]),
    isStandalone(),
    Boolean(installPrompt),
  ]);
  if (signature === homeSignature) { showScreen('home'); return; }
  homeSignature = signature;

  // 端末に届いている版を確認できるようにしておく（タップで再生まわりの記録を表示）
  const footer = `<button class="version" type="button" id="version">${escapeHtml(APP_VERSION)}</button>`;

  // 並べ替える相手がいないうちはトグルを出さない（押しても何も起きない操作を置かない）
  $('home-sortbar').hidden = follows.length === 0;
  $('home-sort-label').textContent = FOLLOW_ORDER_LABELS[order];

  if (follows.length === 0) {
    // 案内はブラウザの操作パネルに近い画面下端へ寄せる（共有ボタンへの動線を短くするため）
    list.classList.add('is-empty');
    list.innerHTML = `
      <div class="empty">
        <p>フォロー中の番組はまだありません。</p>
        <a class="btn" href="/search">番組を検索する</a>
      </div>
      <div class="home__bottom">${installTip()}${footer}</div>`;
    showScreen('home');
    return;
  }
  list.classList.remove('is-empty');

  list.innerHTML = follows.map((f, i) => `
    <div class="row">
      <img class="row__art" src="${escapeHtml(f.artworkUrl || '')}" alt="" loading="lazy"
           onerror="this.removeAttribute('src')">
      <a class="row__main" href="/show?feed=${encodeURIComponent(f.feedUrl)}">
        <span class="row__title">${escapeHtml(f.title)}</span>
        <span class="row__meta">${escapeHtml(followMeta(f))}</span>
        ${followProgress(f, readCounts[i])
          ? `<span class="row__meta">${escapeHtml(followProgress(f, readCounts[i]))}</span>` : ''}
      </a>
      <button class="row__remove" type="button" data-unfollow="${escapeHtml(f.feedUrl)}" aria-label="フォローを解除">✕</button>
    </div>`).join('') + footer;
  showScreen('home');

  backfillArtwork(follows);
  backfillFeedSummary(follows);
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

// 1タップで次の並び順へ送る（エピソード一覧の並び替えと同じ操作感にする）
$('home-sort').addEventListener('click', () => {
  const next = FOLLOW_ORDER_KEYS[(FOLLOW_ORDER_KEYS.indexOf(getFollowOrder()) + 1) % FOLLOW_ORDER_KEYS.length];
  // 保存は同期的に済ませてから描き直す（描き直しの途中で画面を閉じられても設定は残る）
  setFollowOrder(next);
  renderHome();
  $('home-list').scrollTop = 0;
});

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
      showScreen('show');
      rememberFeedSummary(follow, cache.rawEpisodes);
      // 表示したあとで、裏で更新の有無だけ確かめる
      checkForNewEpisodes(feedUrl, follow);
      return;
    }
  }

  $('episode-list').innerHTML = spinner('エピソードを取得中…');
  showScreen('show');

  try {
    const [{ feedTitle, episodes }, states] = await Promise.all([
      fetchFeed(feedUrl, { force }),
      episodeStateMap(feedUrl),
    ]);
    if (show.feedUrl !== feedUrl) return; // 取得中に別画面へ移動していたら破棄
    show.episodes = episodes;
    show.states = states;
    await applyFeedTitle(follow, feedTitle);
    await rememberFeedSummary(follow, episodes);
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

/**
 * フィードの更新日と全エピソード数を控えておく。ホームはネットワークに触らないので、
 * 番組を開いて分かった値を残しておかないと一覧に出せない。
 */
async function rememberFeedSummary(follow, episodes) {
  const latestPubDate = newestPubDate(episodes);
  const episodeCount = episodes.length;
  if (!latestPubDate && episodeCount === 0) return;
  if (latestPubDate === follow.latestPubDate && episodeCount === follow.episodeCount) return;
  follow.latestPubDate = latestPubDate;
  follow.episodeCount = episodeCount;
  try {
    await setFeedSummary(follow.feedUrl, { latestPubDate, episodeCount });
  } catch { /* 書けなくても表示は続く。次に開いたときに書き直す */ }
}

/**
 * 表示したあとに、フィードが新しくなっていれば一覧を差し替える。
 * 見つかっても知らせは出さない。増えた回は一覧に並ぶだけで、
 * 気づくかどうかは見る側に任せる（番組一覧の更新日も同じ考え）。
 */
async function checkForNewEpisodes(feedUrl, follow) {
  let result;
  try {
    result = await revalidateFeed(feedUrl);
  } catch {
    return; // 確かめられなくても、表示済みの内容はそのままでよい
  }
  if (!result.changed || show.feedUrl !== feedUrl) return;

  show.episodes = result.episodes;
  show.states = await episodeStateMap(feedUrl);
  await applyFeedTitle(follow, result.feedTitle);
  await rememberFeedSummary(follow, result.episodes);
  renderEpisodes();
}

// 1タップで並び順が反転する（メニューを開く操作を挟まない）
$('sort-toggle').addEventListener('click', async () => {
  show.sortOrder = show.sortOrder === 'asc' ? 'desc' : 'asc';
  renderSortToggle();
  // 保存を先に始める。描き直しに時間を取られている間に画面を閉じられると、
  // 書き込みが中断されて設定が失われるため
  const saved = show.feedUrl ? setSortOrder(show.feedUrl, show.sortOrder) : null;
  renderEpisodes();
  $('episode-list').scrollTop = 0;
  await saved;
});

// 再生済みを一覧から外す。並び替えと同じく1タップで切り替わり、番組ごとに保存される
$('filter-toggle').addEventListener('click', async () => {
  show.hideRead = !show.hideRead;
  renderFilterToggle();
  const saved = show.feedUrl ? setHideRead(show.feedUrl, show.hideRead) : null;
  renderEpisodes();
  $('episode-list').scrollTop = 0;
  await saved;
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

/** 入力があるときだけ消去ボタンを出す */
function syncSearchClear() {
  $('search-clear').hidden = $('search-input').value.length === 0;
}

/** 検索画面を初期状態に戻す */
function resetSearch() {
  $('search-input').value = '';
  searchResults = [];
  $('search-list').innerHTML = '';
  syncSearchClear();
}

$('search-input').addEventListener('input', syncSearchClear);

$('search-clear').addEventListener('click', () => {
  $('search-input').value = '';
  syncSearchClear();
  $('search-input').focus();
});

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
      // 音源を載せている間に読み直すと、その場で音が止まりロック画面の操作先も消える。
      // 新しいコードは次回の起動で当たるので、聴いている最中は読み直さない。
      if (player.hasLoadedAudio()) return;
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
// 前回の続きを読み戻す。iOS は背面のPWAを終了させることがあり、そのとき再生中だった回も
// ロック画面の操作先も消える。読み戻しておけばミニプレイヤーの再生ボタンで続きへ戻れる
player.restoreLast();

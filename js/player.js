// ---------------------------------------------------------------------------
// 再生制御。HTML <audio> + Media Session API。
// バックグラウンド／ロック画面からの操作はここで全部受ける。
// ---------------------------------------------------------------------------
import {
  SEEK_SECONDS, POSITION_SAVE_INTERVAL_MS, READ_RATIO, PLAYBACK_RATES,
  RESUME_RETRY_MS, STALL_CHECK_MS,
} from './config.js';
import { updateEpisodeState, getEpisodeState, lastPlayedEpisode, getFollow } from './db.js';

const audio = document.getElementById('audio');
const listeners = new Set();

let current = null;      // 再生中のエピソード（+ showTitle）
let queue = [];          // 連続再生の順番。一覧に表示されている順のスナップショット
let armed = false;       // current の音源を <audio> に載せてあるか（起動直後の復元では false）
let pendingSeek = 0;     // まだ <audio> に反映していない再生位置。メタデータ読み込み後に適用する
let lastSaved = 0;
let readRevision = 0;    // 既読フラグを書き込むたびに増える。一覧側の読み直しの合図
let autoAdvancing = false;   // いま自動送りの最中か
let autoAdvanceBlocked = null; // 自動送りがブラウザに拒否された理由（UIで知らせる）
let advancedFrom = null;     // 送り済みのepisodeId。二重に送らないための目印
let userPaused = false;      // 直前の一時停止が利用者の操作によるものか
let lastPosition = 0;        // 最後に確かに鳴っていた位置。音源を捨てられた後の載せ直しに使う
let resumeWatchdog = 0;      // 再開が実際に始まったかを見張るタイマー
let stallWatch = 0;          // 鳴らした後、位置が実際に進んでいるかを見張るタイマー
let stallNudges = 0;         // 止まったまま進まないのを立て直そうとした回数

// 実機（特にiOS）で何が起きたかを後から確認するための記録。
// 開発者コンソールを開けない端末で切り分けるための唯一の手段なので残しておく。
const eventLog = [];

/**
 * 手元にある音声が現在位置の何秒先まであるか。
 * 「鳴っているのに進まない」ときに、音源を捨てられたのか（0秒）、
 * データはあるのに出ていないのか（数十秒）を後から見分けるための手がかり。
 */
function bufferedSeconds() {
  try {
    const ranges = audio.buffered;
    if (!ranges || ranges.length === 0) return 0;
    return Math.max(0, ranges.end(ranges.length - 1) - audio.currentTime);
  } catch { return 0 }
}

function bufferedAhead() {
  try {
    const ranges = audio.buffered;
    if (!ranges || ranges.length === 0) return '-';
    return `${bufferedSeconds().toFixed(0)}`;
  } catch { return '?' }
}

function log(name, extra = '') {
  const at = new Date().toLocaleTimeString('ja-JP');
  const pos = Number.isFinite(audio.duration)
    ? ` ${audio.currentTime.toFixed(1)}/${audio.duration.toFixed(1)}s`
    : ` ${audio.currentTime.toFixed(1)}s`;
  // r=readyState（音声を持っているか） n=networkState（取りに行っているか） b=先読みの秒数
  const state = ` r${audio.readyState}n${audio.networkState}b${bufferedAhead()}`;
  eventLog.push(`${at} ${name}${pos}${state}${extra ? ` ${extra}` : ''}`);
  if (eventLog.length > 80) eventLog.shift();
}

export function diagnostics() {
  const session = navigator.audioSession
    ? `音声セッション: ${navigator.audioSession.type} / ${navigator.audioSession.state}`
    : '音声セッション: 未対応';
  const body = eventLog.length ? eventLog.join('\n') : '（まだ記録がありません）';
  return `${session}\n\n${body}`;
}

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function emit() {
  const snapshot = getState();
  listeners.forEach((fn) => fn(snapshot));
}

/** いま画面に出すべき再生位置。音源を載せる前は、まだ反映していない位置を返す */
function currentPosition() {
  if (!armed) return pendingSeek;
  // iOS は背面のPWAが持つ読み込み済みの音声を捨てることがあり、そのとき currentTime は 0 に戻る。
  // 覚えておいた位置を最後の頼りにして、載せ直しで頭から鳴らしてしまわないようにする。
  return audio.currentTime || pendingSeek || lastPosition || 0;
}

/**
 * 確かに鳴っていた位置を覚えておく。
 * 音源を持っているときだけ記録する。捨てられた後の 0 を覚えてしまうと、
 * 載せ直したときに頭から鳴ってしまうため。
 */
function remember() {
  if (armed && audio.readyState > HTMLMediaElement.HAVE_NOTHING) lastPosition = audio.currentTime;
}

export function getState() {
  return {
    episode: current,
    playing: armed ? !audio.paused && !audio.ended : false,
    position: currentPosition(),
    duration: Number.isFinite(audio.duration) ? audio.duration : (current?.duration || 0),
    rate: audio.playbackRate,
    readRevision,
    autoAdvanceBlocked,
  };
}

// ---- 永続化 ---------------------------------------------------------------

async function persist({ force = false } = {}) {
  // 音源を載せる前（起動直後の復元）は audio.currentTime が 0 なので、
  // ここで書き戻すと保存済みの再生位置を 0 で潰してしまう。載せるまでは触らない。
  if (!current || !armed) return;
  const now = Date.now();
  if (!force && now - lastSaved < POSITION_SAVE_INTERVAL_MS) return;
  lastSaved = now;

  const duration = Number.isFinite(audio.duration) ? audio.duration : (current.duration || 0);
  const position = audio.currentTime || 0;
  const finished = duration > 0 && position / duration >= READ_RATIO;
  await updateEpisodeState(current, {
    position: finished ? 0 : position,
    duration,
    isRead: finished ? true : undefined,
    lastPlayedAt: now,
  }).catch(() => {});
  if (finished) markReadWritten();
}

/** 既読の書き込みが終わったことを購読側へ知らせる（一覧のフィルタ表示がこれに追従する） */
function markReadWritten() {
  readRevision += 1;
  emit();
}

// ---- Media Session --------------------------------------------------------

function updateMetadata() {
  if (!('mediaSession' in navigator) || !current) return;
  // artwork は設定しない（不要要件、かつ iOS で表示不具合の報告あり）
  navigator.mediaSession.metadata = new MediaMetadata({
    title: current.title,
    artist: current.showTitle || '',
  });
}

function updatePlaybackState() {
  if (!('mediaSession' in navigator)) return;
  navigator.mediaSession.playbackState = getState().playing ? 'playing' : 'paused';
  try {
    if (Number.isFinite(audio.duration) && audio.duration > 0) {
      navigator.mediaSession.setPositionState({
        duration: audio.duration,
        playbackRate: audio.playbackRate,
        position: Math.min(audio.currentTime, audio.duration),
      });
    }
  } catch { /* 対応していない環境では黙って無視する */ }
}

/** 一覧の並び替えやフィルタが変わったときに、送り先の順番を追従させる */
export function setQueue(nextQueue) {
  queue = nextQueue;
}

/**
 * 再生位置が終端に達しているか。ended が発火しない環境の判定に使う。
 * MP3の duration は実際の長さとずれることがあるため、長い回ほど余裕を持たせる。
 */
function isAtEnd() {
  if (!current || !Number.isFinite(audio.duration) || audio.duration <= 0) return false;
  const remaining = audio.duration - audio.currentTime;
  return remaining <= Math.max(2, audio.duration * 0.01);
}

/** キュー内で現在の前後にあるエピソードを返す */
function neighbour(offset) {
  if (!current) return null;
  const index = queue.findIndex((ep) => ep.episodeId === current.episodeId);
  return index >= 0 ? (queue[index + offset] || null) : null;
}

/** ロック画面のスキップボタンから前後の回へ移動する */
function jump(offset) {
  const target = neighbour(offset);
  if (target) play(target, current.showTitle, target.resumeAt || 0);
}

/**
 * ロック画面・コントロールセンター・Bluetoothイヤホンからの再生。
 *
 * ここでは <audio> をそのまま鳴らすだけにして、音源の載せ直しは絶対にしない。
 *
 * src を代入すると WebKit は再生セッションを作り直す。前面ならそれでよいが、画面を
 * 消している間にやると「今再生中」の役目をその場で手放してしまい、イヤホンの再生ボタンが
 * 直前に鳴らしていた別のアプリ（ミュージックなど）へ渡ってしまう。こちらは鳴らないまま。
 *
 * 載せ直さなくても困らない。src を持ったまま音声だけ捨てられた状態なら、
 * play() を呼べばブラウザが自分で読み直す（セッションは保たれる）。
 * 込み入った復旧はアプリ内の再生ボタン（resume）に任せる。前面でしか押せないため安全。
 */
function playFromRemote() {
  if (!current) return;
  userPaused = false;
  claimPlaybackSession({ force: true });
  const promise = audio.play();
  if (promise) promise.catch((err) => { log('remote-play-rejected', err?.name || ''); emit(); });
  watchForProgress();
  emit();
}

/**
 * 音声の扱いを「再生用」だと宣言する（Audio Session API）。
 *
 * 既定は auto で、iOS ではこれが ambient（環境音）扱いになることがある。ambient は
 * 画面を消すと消音される種別なので、ロック中に鳴らし直すと
 * 「再生マークになり、シークバーも進むのに、音だけ出ない」という状態になる。
 * playback にしておくと画面を消しても消音されず、他アプリの再生も止めて自分が鳴る。
 *
 * 鳴らす前に宣言しておく必要があるため、起動時と、鳴らす操作のたびに呼ぶ
 * （すでに playback なら何もしない）。
 */
function claimPlaybackSession({ force = false } = {}) {
  const session = navigator.audioSession;
  if (!session) return;
  // 背面から鳴らすときは、すでに playback でも宣言し直す。
  // iOS は一時停止でオーディオセッションを落とすので、これで起き直さないかを試している
  // （Web にはセッションを自分で有効化する手段が無い。効かなければ打つ手は無い）。
  if (!force && session.type === 'playback') return;
  try {
    session.type = 'playback';
    log('audio-session', force ? 'playback(再宣言)' : 'playback');
  } catch { /* 未対応の環境では黙って無視する */ }
}

/** ロック画面・コントロールセンター・Bluetoothイヤホンからの操作を受け取る */
function setupMediaSession() {
  if (!('mediaSession' in navigator)) return;
  const handlers = {
    play: () => playFromRemote(),
    pause: () => { userPaused = true; audio.pause(); },
    seekbackward: (details) => seekBy(-(details?.seekOffset || SEEK_SECONDS)),
    seekforward: (details) => seekBy(details?.seekOffset || SEEK_SECONDS),
    seekto: (details) => { if (details?.seekTime != null) seekTo(details.seekTime); },
    nexttrack: () => jump(1),
    previoustrack: () => jump(-1),
  };
  for (const [action, handler] of Object.entries(handlers)) {
    try { navigator.mediaSession.setActionHandler(action, handler); } catch { /* 未対応アクション */ }
  }
}

// ---- 操作 -----------------------------------------------------------------

/**
 * current の音源を <audio> に載せる。
 * iOS では load() を呼ぶとユーザー操作で得た再生許可が外れ、自動送りの play() が
 * 拒否されることがある。src を代入すれば読み込みは始まるので load() は呼ばない。
 */
function arm(startAt = 0) {
  pendingSeek = startAt > 0 ? startAt : 0;
  lastPosition = pendingSeek;
  armed = true;
  audio.src = current.audioUrl;
  updateMetadata();
}

/**
 * <audio> が鳴らせる音源を持っていないか。
 *
 * iOS は画面を消している間、背面のPWAが読み込み済みの音声を error も付けずに捨てる。
 * その状態で play() を呼んでも、拒否すら返らないまま何も起きないため、
 * 鳴らす前に気づいて載せ直す必要がある。
 * 読み込みの最中（NETWORK_LOADING）は、まだ何も持っていなくても待てばよい。
 */
function hasLostAudio() {
  if (!armed || !audio.src || audio.error) return true;
  if (audio.networkState === HTMLMediaElement.NETWORK_EMPTY
    || audio.networkState === HTMLMediaElement.NETWORK_NO_SOURCE) return true;
  return audio.readyState === HTMLMediaElement.HAVE_NOTHING
    && audio.networkState !== HTMLMediaElement.NETWORK_LOADING;
}

/**
 * <audio> に鳴らすよう頼み、始まらなければ音源を載せ直して、もう一度だけ鳴らし直す。
 *
 * 拒否されたときだけでなく、返事が返らないまま止まったままのときも拾う。iOS は
 * 画面を消している間に読み込み済みの音声を捨てることがあり、そのときの play() は
 * error も拒否も返さずに握り潰されるため、拒否を待っているだけでは永久に鳴らない。
 *
 * play() は頼みを受け付けた時点で paused を false にする。読み込みが遅いだけなら
 * paused は false なので、少し待っても paused のままなら握り潰されたと判断できる。
 */
function startPlayback(targetId, allowRearm = true) {
  clearTimeout(resumeWatchdog);
  resumeWatchdog = 0;
  let settled = false;

  const rescue = () => {
    if (settled) return;
    settled = true;
    clearTimeout(resumeWatchdog);
    resumeWatchdog = 0;
    if (!allowRearm) return;              // 載せ直しは1回まで（際限なく繰り返さない）
    if (!current || current.episodeId !== targetId) return; // 別の回へ移った
    if (userPaused || !audio.paused) return; // 止め直された／もう鳴っている
    log('resume-retry');
    arm(currentPosition());
    startPlayback(targetId, false);
    emit();
  };

  const promise = audio.play();
  watchForProgress();
  if (promise) {
    promise.then(
      () => { settled = true; clearTimeout(resumeWatchdog); resumeWatchdog = 0; },
      (err) => {
        log('resume-rejected', err?.name || '');
        rescue();
        emit();
      },
    );
  }
  if (allowRearm) resumeWatchdog = setTimeout(rescue, RESUME_RETRY_MS);
  emit();
  return promise;
}

/**
 * 鳴らす操作のあと、再生位置が実際に進んでいるかを見張る。
 *
 * iOS は画面を消したまま一時停止すると、読み込み済みの音声を捨てることがある。その状態で
 * play() を呼ぶと「再生中」の扱いにはなるのに、データが届かないまま（stalled）位置が
 * 止まり、音も出ない。拒否も error も返らないので、待っていても何も起きない。
 *
 * ほんの少し位置を動かすと取得をやり直すことがあるので、それを試す。
 * 載せ直し（src の代入）はしない。背面でやると再生セッションを手放してしまうため。
 */
function watchForProgress() {
  clearTimeout(stallWatch);
  const startedAt = audio.currentTime;
  stallWatch = setTimeout(() => {
    stallWatch = 0;
    if (audio.paused || userPaused || !current) return;   // もう鳴らす気が無い
    if (audio.currentTime > startedAt + 0.05) { stallNudges = 0; return; }  // 進んでいる
    if (bufferedSeconds() > 1) {
      // データは手元にあるのに位置が進まない。取得ではなく音声の出口が動いていない
      // （iOS は背面ではオーディオセッションを起こし直せない）。動かしても意味が無いので何もしない。
      log('no-output', `b${bufferedAhead()}`);
      return;
    }
    if (stallNudges >= 2) { log('stall-give-up'); return; }
    stallNudges += 1;
    log('stall-nudge', `#${stallNudges}`);
    try { audio.currentTime = startedAt + 0.01; } catch { /* シークできない状態 */ }
    const promise = audio.play();
    if (promise) promise.catch((err) => log('nudge-rejected', err?.name || ''));
    watchForProgress();
  }, STALL_CHECK_MS);
}

/**
 * 一時停止からの再開。アプリ内の再生ボタン（ミニプレイヤー／フルプレイヤー）がここを通る。
 * 音源を載せ直すことがあるため、ロック画面やイヤホンからの再生はここを通さない
 * （背面での載せ直しは再生セッションを手放してしまう。playFromRemote を参照）。
 *
 * 押しても何も起きない状態が4つあるので、ここで拾って必ず音を出す。
 *   1. 起動直後 — 続きを読み戻しただけで、まだ音源を載せていない
 *   2. iOS が読み込み済みの音声を捨てた後 — src はあるが鳴らせない（error / 音源なし）
 *   3. 聴き終えた回で止まっている — 終端から play() しても進まない
 *   4. play() が握り潰された — 拒否も error も返らないまま鳴り始めない（startPlayback）
 */
export function resume() {
  if (!current) return undefined;
  userPaused = false;
  claimPlaybackSession();

  if (hasLostAudio()) {
    log('re-arm', audio.error ? `code=${audio.error.code}` : '');
    arm(currentPosition());
  } else if (isAtEnd()) {
    // 聴き終えた回。次があればそちらへ送り、無ければ頭から鳴らす（無反応にはしない）
    const next = neighbour(1);
    if (next) return play(next, current.showTitle, next.resumeAt || 0);
    log('replay-from-start');
    advancedFrom = null;
    audio.currentTime = 0;
    remember();
  }

  return startPlayback(current.episodeId);
}

/**
 * 再生を開始する。
 * iOS はユーザー操作を起点としないと再生できないため、
 * この関数はタップイベントのハンドラ内から同期的に呼ぶこと（await を挟まない）。
 *
 * @param nextQueue 終了後に続けて再生する順番。各要素に resumeAt（再開位置）を入れておくと、
 *                  自動送りのときも続きから再生できる（endedハンドラ内でDBを待てないため）。
 */
export function play(episode, showTitle, startAt = 0, nextQueue = null) {
  claimPlaybackSession();
  if (nextQueue) queue = nextQueue;
  clearTimeout(resumeWatchdog);
  resumeWatchdog = 0;
  clearTimeout(stallWatch);
  stallWatch = 0;
  stallNudges = 0;
  // 音源をまだ載せていないとき（起動直後の復元）は、同じ回でも載せ直しが要る
  const isSame = armed && current && current.episodeId === episode.episodeId;
  current = { ...episode, showTitle };

  if (!isSame) {
    advancedFrom = null;
    arm(startAt);
  }

  const auto = autoAdvancing;
  const promise = audio.play();
  if (promise) {
    promise.then(
      () => { if (auto) { autoAdvanceBlocked = null; emit(); } },
      (err) => {
        // 自動送りが拒否された場合は黙って止まらず、理由を画面に出す。
        // メタデータは次の回のままなので、ロック画面の再生ボタンで続きから再開できる。
        if (auto) autoAdvanceBlocked = err?.name || 'PlaybackError';
        log('play-rejected', err?.name || '');
        emit();
      },
    );
  }
  emit();
  return promise;
}

export function toggle() {
  if (!current) return;
  if (armed && !audio.paused) {
    userPaused = true;
    audio.pause();
    return;
  }
  resume();
}

export function seekBy(seconds) {
  if (!current) return;
  seekTo(currentPosition() + seconds);
}

export function seekTo(seconds) {
  if (!current) return;
  if (!armed) {
    // まだ音源を載せていない（起動直後の復元）。載せたときに適用する位置だけ動かす
    const limit = current.duration || 0;
    pendingSeek = Math.max(0, limit > 0 ? Math.min(seconds, limit) : seconds);
    emit();
    return;
  }
  const max = Number.isFinite(audio.duration) ? audio.duration : seconds;
  audio.currentTime = Math.max(0, Math.min(seconds, max));
  remember();
  persist({ force: true });
  updatePlaybackState();
  emit();
}

export function cycleRate() {
  const index = PLAYBACK_RATES.indexOf(audio.playbackRate);
  audio.playbackRate = PLAYBACK_RATES[(index + 1) % PLAYBACK_RATES.length];
  updatePlaybackState();
  emit();
  return audio.playbackRate;
}

/**
 * 最後に聴いていた回を、止まった状態で読み戻す（起動時に一度だけ呼ぶ）。
 *
 * iOS は PWA を背面で終了させることがあり、そのとき <audio> も Media Session も消える。
 * 読み戻しておかないと、再起動後はミニプレイヤーもロック画面の操作先も無くなり、
 * 「続きから」に一覧を開き直して探し当てる必要が出る。
 *
 * 音源はここでは載せない。載せると起動しただけで通信が始まるため、
 * 実際に再生ボタンが押された時点（resume）で載せる。
 */
export async function restoreLast() {
  if (current) return null; // すでに何か再生していれば触らない
  const state = await lastPlayedEpisode().catch(() => null);
  if (!state || !state.audioUrl) return null;
  const follow = await getFollow(state.feedUrl).catch(() => null);
  if (current) return null; // 読み出しを待つ間に利用者が再生を始めていたら、そちらを優先する
  current = {
    episodeId: state.episodeId,
    feedUrl: state.feedUrl,
    title: state.title,
    audioUrl: state.audioUrl,
    duration: state.duration || 0,
    showTitle: follow?.title || '',
  };
  armed = false;
  pendingSeek = state.position || 0;
  lastPosition = pendingSeek;
  log('restore', `${Math.round(pendingSeek)}s`);
  emit();
  return current;
}

/** 読み直すと音が途切れるか（Service Worker の更新をいつ当てるかの判定に使う） */
export function hasLoadedAudio() {
  return armed;
}

/** 中断した位置から再開するための保存済み再生位置 */
export async function savedPosition(episodeId) {
  const state = await getEpisodeState(episodeId);
  return state ? state.position || 0 : 0;
}

// ---- <audio> イベント ------------------------------------------------------

audio.addEventListener('loadedmetadata', () => {
  if (pendingSeek > 0 && Number.isFinite(audio.duration)) {
    audio.currentTime = Math.min(pendingSeek, audio.duration - 1);
  }
  pendingSeek = 0;
  remember();
  updatePlaybackState();
  emit();
});
audio.addEventListener('play', () => { log('play'); userPaused = false; updatePlaybackState(); emit(); });
audio.addEventListener('stalled', () => log('stalled'));
audio.addEventListener('waiting', () => log('waiting'));
audio.addEventListener('playing', () => log('playing'));
audio.addEventListener('suspend', () => log('suspend'));
audio.addEventListener('abort', () => log('abort'));
audio.addEventListener('emptied', () => log('emptied'));
audio.addEventListener('pause', () => {
  log('pause', userPaused ? '(操作)' : '(自動)');
  remember();
  persist({ force: true });
  updatePlaybackState();
  emit();
  // ended が発火しないまま終端で止まった場合の受け皿。
  // 利用者が押した一時停止と、再生し切って止まったものを区別する。
  if (!userPaused && isAtEnd()) finishAndAdvance('pause');
});
audio.addEventListener('timeupdate', () => {
  remember();
  persist();
  emit();
  if (audio.paused && !userPaused && isAtEnd()) finishAndAdvance('timeupdate');
});
/**
 * 1本を聴き終えたときの処理。既読にして次の回へ送る。
 *
 * iOS では末尾までシークした場合などに ended が発火せず pause で終わることがあるため、
 * ended だけに頼らず「終端に達した」状態からも呼ぶ。二重に送らないよう印を付ける。
 */
function finishAndAdvance(reason) {
  const finished = current;
  if (!finished || advancedFrom === finished.episodeId) return;
  advancedFrom = finished.episodeId;
  log('advance', `(${reason})`);

  updateEpisodeState(finished, { isRead: true, position: 0, lastPlayedAt: Date.now() })
    .then(markReadWritten, () => {});

  // 次の回へ自動で送る。ここは再生セッションが続いている間の同期処理なので、
  // DBの読み取りを待たずに queue に埋めておいた resumeAt を使う。
  const next = neighbour(1);
  if (next) {
    autoAdvancing = true;
    userPaused = false;
    try {
      play(next, finished.showTitle, next.resumeAt || 0);
    } finally {
      autoAdvancing = false;
    }
    return;
  }
  log('advance-skipped', `queue=${queue.length}`);
  updatePlaybackState();
  emit();
}

audio.addEventListener('ended', () => { log('ended'); finishAndAdvance('ended'); });
audio.addEventListener('error', () => { log('error', audio.error ? `code=${audio.error.code}` : ''); emit(); });

// アプリが背面に回る／閉じられる直前に取りこぼしなく保存する
window.addEventListener('pagehide', () => persist({ force: true }));
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    log('hidden');
    persist({ force: true });
    return;
  }
  log('visible');
  // 画面を消している間はJSの実行が止まることがある。戻ってきた時点で終端に達していたら送る。
  if (audio.paused && !userPaused && isAtEnd()) finishAndAdvance('visible');
});

claimPlaybackSession();
setupMediaSession();

// 音声セッションの状態（inactive / active / interrupted）も記録に残す。
// 「鳴っているのに音が出ない」ときの切り分けは、これが無いと実機で追えない。
if (navigator.audioSession) {
  navigator.audioSession.addEventListener?.('statechange', () => {
    log('audio-session', `${navigator.audioSession.type}/${navigator.audioSession.state}`);
  });
}

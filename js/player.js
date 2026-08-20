// ---------------------------------------------------------------------------
// 再生制御。HTML <audio> + Media Session API。
// バックグラウンド／ロック画面からの操作はここで全部受ける。
// ---------------------------------------------------------------------------
import { SEEK_SECONDS, POSITION_SAVE_INTERVAL_MS, READ_RATIO, PLAYBACK_RATES } from './config.js';
import { updateEpisodeState, getEpisodeState } from './db.js';

const audio = document.getElementById('audio');
const listeners = new Set();

let current = null;      // 再生中のエピソード（+ showTitle）
let queue = [];          // 連続再生の順番。一覧に表示されている順のスナップショット
let pendingSeek = 0;     // メタデータ読み込み後に適用する再生位置
let lastSaved = 0;
let readRevision = 0;    // 既読フラグを書き込むたびに増える。一覧側の読み直しの合図
let autoAdvancing = false;   // いま自動送りの最中か
let autoAdvanceBlocked = null; // 自動送りがブラウザに拒否された理由（UIで知らせる）

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function emit() {
  const snapshot = getState();
  listeners.forEach((fn) => fn(snapshot));
}

export function getState() {
  return {
    episode: current,
    playing: current ? !audio.paused && !audio.ended : false,
    position: audio.currentTime || 0,
    duration: Number.isFinite(audio.duration) ? audio.duration : (current?.duration || 0),
    rate: audio.playbackRate,
    readRevision,
    autoAdvanceBlocked,
  };
}

// ---- 永続化 ---------------------------------------------------------------

async function persist({ force = false } = {}) {
  if (!current) return;
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

function setupMediaSession() {
  if (!('mediaSession' in navigator)) return;
  const handlers = {
    play: () => { audio.play().catch(() => {}); },
    pause: () => audio.pause(),
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
 * 再生を開始する。
 * iOS はユーザー操作を起点としないと再生できないため、
 * この関数はタップイベントのハンドラ内から同期的に呼ぶこと（await を挟まない）。
 *
 * @param nextQueue 終了後に続けて再生する順番。各要素に resumeAt（再開位置）を入れておくと、
 *                  自動送りのときも続きから再生できる（endedハンドラ内でDBを待てないため）。
 */
export function play(episode, showTitle, startAt = 0, nextQueue = null) {
  if (nextQueue) queue = nextQueue;
  const isSame = current && current.episodeId === episode.episodeId;
  current = { ...episode, showTitle };

  if (!isSame) {
    pendingSeek = startAt > 0 ? startAt : 0;
    // iOS では load() を呼ぶとユーザー操作で得た再生許可が外れ、自動送りの play() が
    // 拒否されることがある。src を代入すれば読み込みは始まるので load() は呼ばない。
    audio.src = episode.audioUrl;
    updateMetadata();
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
        emit();
      },
    );
  }
  emit();
  return promise;
}

export function toggle() {
  if (!current) return;
  if (audio.paused) audio.play().catch(() => {});
  else audio.pause();
}

export function seekBy(seconds) {
  if (!current) return;
  seekTo((audio.currentTime || 0) + seconds);
}

export function seekTo(seconds) {
  if (!current) return;
  const max = Number.isFinite(audio.duration) ? audio.duration : seconds;
  audio.currentTime = Math.max(0, Math.min(seconds, max));
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
  updatePlaybackState();
  emit();
});
audio.addEventListener('play', () => { updatePlaybackState(); emit(); });
audio.addEventListener('pause', () => { persist({ force: true }); updatePlaybackState(); emit(); });
audio.addEventListener('timeupdate', () => { persist(); emit(); });
audio.addEventListener('ended', () => {
  const finished = current;
  if (finished) {
    updateEpisodeState(finished, { isRead: true, position: 0, lastPlayedAt: Date.now() })
      .then(markReadWritten, () => {});
  }

  // 次の回へ自動で送る。ここは再生セッションが続いている間の同期処理なので、
  // DBの読み取りを待たずに queue に埋めておいた resumeAt を使う。
  const next = neighbour(1);
  if (next) {
    autoAdvancing = true;
    try {
      play(next, finished.showTitle, next.resumeAt || 0);
    } finally {
      autoAdvancing = false;
    }
    return;
  }
  updatePlaybackState();
  emit();
});
audio.addEventListener('error', () => emit());

// アプリが背面に回る／閉じられる直前に取りこぼしなく保存する
window.addEventListener('pagehide', () => persist({ force: true }));
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') persist({ force: true });
});

setupMediaSession();

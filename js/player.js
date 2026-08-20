// ---------------------------------------------------------------------------
// 再生制御。HTML <audio> + Media Session API。
// バックグラウンド／ロック画面からの操作はここで全部受ける。
// ---------------------------------------------------------------------------
import { SEEK_SECONDS, POSITION_SAVE_INTERVAL_MS, READ_RATIO, PLAYBACK_RATES } from './config.js';
import { updateEpisodeState, getEpisodeState } from './db.js';

const audio = document.getElementById('audio');
const listeners = new Set();

let current = null;      // 再生中のエピソード（+ showTitle）
let pendingSeek = 0;     // メタデータ読み込み後に適用する再生位置
let lastSaved = 0;

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

function setupMediaSession() {
  if (!('mediaSession' in navigator)) return;
  const handlers = {
    play: () => { audio.play().catch(() => {}); },
    pause: () => audio.pause(),
    seekbackward: (details) => seekBy(-(details?.seekOffset || SEEK_SECONDS)),
    seekforward: (details) => seekBy(details?.seekOffset || SEEK_SECONDS),
    seekto: (details) => { if (details?.seekTime != null) seekTo(details.seekTime); },
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
 */
export function play(episode, showTitle, startAt = 0) {
  const isSame = current && current.episodeId === episode.episodeId;
  current = { ...episode, showTitle };

  if (!isSame) {
    pendingSeek = startAt > 0 ? startAt : 0;
    audio.src = episode.audioUrl;
    audio.load();
    updateMetadata();
  }
  const promise = audio.play();
  if (promise) promise.catch(() => emit());
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
audio.addEventListener('ended', async () => {
  if (current) await updateEpisodeState(current, { isRead: true, position: 0, lastPlayedAt: Date.now() });
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

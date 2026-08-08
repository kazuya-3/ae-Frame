/**
 * 触感のある操作音。
 *
 * 音声ファイルは一切持たず、すべて Web Audio API で合成する。
 * ねらいは「音楽」ではなく「触った感触」なので、どの音も
 *  - 20〜120ms と極端に短い
 *  - アタックが 1〜3ms（カチッと立ち上がる）
 *  - ノイズのクリック成分 + 短いピッチ落ちのトーン
 * という、指先で押した物体が鳴らす音の骨格をなぞっている。
 *
 * あわせて Vibration API を叩くので、対応端末では音と同時に指にも返る。
 */

export type SoundName =
  | 'tap' // 一般的なボタン
  | 'primary' // 主要ボタン（つぎへ・保存）
  | 'toggleOn'
  | 'toggleOff'
  | 'drop' // ファイルを置いた
  | 'done' // 処理が終わった
  | 'error'
  | 'tick' // スライダーの刻み
  | 'brush' // 手で消す/戻すの開始
  | 'back';

const STORAGE_KEY = 'aeframe.sound';
const HAPTICS_KEY = 'aeframe.haptics';

let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let noiseBuffer: AudioBuffer | null = null;
let unlocked = false;

let soundOn = readFlag(STORAGE_KEY, true);
let hapticsOn = readFlag(HAPTICS_KEY, true);

function readFlag(key: string, fallback: boolean): boolean {
  try {
    const v = localStorage.getItem(key);
    return v === null ? fallback : v === '1';
  } catch {
    return fallback;
  }
}

function writeFlag(key: string, value: boolean) {
  try {
    localStorage.setItem(key, value ? '1' : '0');
  } catch {
    /* プライベートモードなどでは黙って諦める */
  }
}

function ensureContext(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  if (ctx) return ctx;
  const Ctor =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  ctx = new Ctor();
  master = ctx.createGain();
  master.gain.value = 0.5;
  master.connect(ctx.destination);

  // クリック成分に使う短いホワイトノイズ
  const len = Math.floor(ctx.sampleRate * 0.12);
  noiseBuffer = ctx.createBuffer(1, len, ctx.sampleRate);
  const data = noiseBuffer.getChannelData(0);
  for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;

  return ctx;
}

/**
 * iOS/Android は「ユーザー操作の中」でしか音を鳴らせない。
 * 最初のタップ・キー入力で一度だけ解錠する。
 */
export function unlockAudio() {
  if (unlocked) return;
  const c = ensureContext();
  if (!c) return;
  unlocked = true;
  if (c.state === 'suspended') void c.resume();
}

/** ノイズによる「カチ」成分 */
function click(at: number, gain: number, freq: number, q = 1.2, dur = 0.03) {
  if (!ctx || !master || !noiseBuffer) return;
  const src = ctx.createBufferSource();
  src.buffer = noiseBuffer;
  const bp = ctx.createBiquadFilter();
  bp.type = 'bandpass';
  bp.frequency.value = freq;
  bp.Q.value = q;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, at);
  g.gain.exponentialRampToValueAtTime(gain, at + 0.002);
  g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
  src.connect(bp).connect(g).connect(master);
  src.start(at);
  src.stop(at + dur + 0.02);
}

/** ピッチが動く短いトーン成分 */
function tone(
  at: number,
  gain: number,
  from: number,
  to: number,
  dur: number,
  type: OscillatorType = 'triangle',
) {
  if (!ctx || !master) return;
  const osc = ctx.createOscillator();
  osc.type = type;
  osc.frequency.setValueAtTime(from, at);
  osc.frequency.exponentialRampToValueAtTime(Math.max(20, to), at + dur);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, at);
  g.gain.exponentialRampToValueAtTime(gain, at + 0.003);
  g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
  osc.connect(g).connect(master);
  osc.start(at);
  osc.stop(at + dur + 0.02);
}

let lastTickAt = 0;

export function play(name: SoundName) {
  if (!soundOn) {
    haptic(name);
    return;
  }
  const c = ensureContext();
  if (!c) {
    haptic(name);
    return;
  }
  if (c.state === 'suspended') void c.resume();
  const t = c.currentTime + 0.001;

  switch (name) {
    case 'tap':
      click(t, 0.16, 2200, 1.0, 0.022);
      tone(t, 0.06, 620, 430, 0.05);
      break;
    case 'primary':
      click(t, 0.2, 1800, 0.9, 0.026);
      tone(t, 0.1, 520, 780, 0.07);
      break;
    case 'toggleOn':
      click(t, 0.18, 2600, 1.4, 0.02);
      tone(t, 0.09, 560, 940, 0.06);
      break;
    case 'toggleOff':
      click(t, 0.14, 1500, 1.4, 0.024);
      tone(t, 0.08, 780, 380, 0.07);
      break;
    case 'drop':
      click(t, 0.12, 900, 0.7, 0.04);
      tone(t, 0.11, 300, 720, 0.1, 'sine');
      break;
    case 'done':
      tone(t, 0.075, 660, 660, 0.08, 'sine');
      tone(t + 0.075, 0.075, 880, 880, 0.08, 'sine');
      tone(t + 0.15, 0.085, 1320, 1320, 0.16, 'sine');
      click(t, 0.06, 3000, 1.2, 0.02);
      break;
    case 'error':
      tone(t, 0.09, 300, 190, 0.13, 'sawtooth');
      click(t, 0.1, 700, 0.8, 0.04);
      break;
    case 'tick': {
      // スライダーは連射されるので間引く（音が濁らない最小間隔）
      const now = performance.now();
      if (now - lastTickAt < 28) return;
      lastTickAt = now;
      click(t, 0.05, 3400, 2.0, 0.012);
      break;
    }
    case 'brush':
      click(t, 0.08, 1200, 0.6, 0.05);
      break;
    case 'back':
      click(t, 0.12, 1400, 1.0, 0.024);
      tone(t, 0.06, 500, 340, 0.06);
      break;
  }
  haptic(name);
}

function haptic(name: SoundName) {
  if (!hapticsOn) return;
  if (typeof navigator === 'undefined' || typeof navigator.vibrate !== 'function') return;
  const pattern: Record<SoundName, number | number[]> = {
    tap: 8,
    primary: 12,
    toggleOn: 10,
    toggleOff: 6,
    drop: [0, 10, 40, 14],
    done: [0, 12, 60, 12, 60, 20],
    error: [0, 24, 60, 24],
    tick: 3,
    brush: 5,
    back: 6,
  };
  try {
    navigator.vibrate(pattern[name]);
  } catch {
    /* 一部ブラウザは無音で失敗する */
  }
}

export function isSoundOn() {
  return soundOn;
}

export function setSoundOn(next: boolean) {
  soundOn = next;
  writeFlag(STORAGE_KEY, next);
  if (next) {
    unlockAudio();
    play('toggleOn');
  } else {
    // 音を切った瞬間も、触覚だけは返して「切れた」ことを伝える
    haptic('toggleOff');
  }
}

export function isHapticsOn() {
  return hapticsOn;
}

export function setHapticsOn(next: boolean) {
  hapticsOn = next;
  writeFlag(HAPTICS_KEY, next);
}

export function hasHapticsSupport() {
  return typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function';
}

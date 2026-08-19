/**
 * 「動画を受け取って、コマごとのマットを作る」ところ。
 *
 * 画面（StudioPage）はここを1回呼ぶだけでよく、
 * どの方法で消すか・どれくらい待つか・途中でやめられるか、は全部この中にある。
 *
 * ── 消しかたを2つ持っている理由 ──
 *
 *   色で消す … 背景が単色（グリーンバック・白ホリ・黒ホリ）のとき。
 *              1コマ 2〜3ミリ秒。240コマでも1秒かからない。
 *   AIで消す … 背景が単色でないとき。1コマ 60〜300ミリ秒。240コマで
 *              20秒〜2分。待たせるぶん、どんな背景でも抜ける。
 *
 * 速いほうで済むものを、わざわざ遅いほうに通す理由がない。
 * だから最初の1コマを見て自動で決める。決めた結果は画面に一言で出すが、
 * 選ばせはしない（選べる状態にはしてある。うまくいかなかった人だけが使う）。
 */
import {
  analyze,
  colorKeyAlpha,
  DEFAULT_SETTINGS,
  passthroughAlpha,
  type CutoutSettings,
} from '../cutout';
import { runMatting, type AiQuality } from '../ai';
import { createCanvas, fitWithin, get2d } from '../image';
import { openVideo, readFrames, seekTo, type OpenedVideo } from './source';
import { estimateBackgroundColor, stabilize, type Matte, type MatteTrack } from './matte';

/** マットを持つ解像度の上限。ここは見た目より、持てる重さで決まる（matte.ts の頭を参照） */
export const MATTE_MAX_EDGE = 640;

export type Engine = 'auto' | 'ai' | 'color';

/** 実際に使った消しかた。keep = もともと透明だったので、そのまま通した */
export type EngineUsed = 'ai' | 'color' | 'keep';

export type ProcessPhase = 'look' | 'model' | 'frames' | 'done';

export type ProcessProgress = {
  phase: ProcessPhase;
  /** 0..1 */
  value: number;
  label: string;
  /** 残り秒数の見積もり。分からないうちは null */
  etaSec: number | null;
  /** 途中経過の絵（フィルムに並べる） */
  thumb?: { index: number; bitmap: ImageBitmap };
};

export type ProcessOptions = {
  startSec: number;
  endSec: number;
  /** 1秒あたり何コマ処理するか */
  fps: number;
  engine: Engine;
  quality: AiQuality;
  /** 0..100 ゆれをおさえる強さ */
  stabilizeAmount: number;
  signal: { aborted: boolean };
  onProgress?: (p: ProcessProgress) => void;
  /** フィルムに並べる絵を、何枚もらうか */
  thumbCount?: number;
};

export type ProcessResult = {
  track: MatteTrack;
  /** フチの色抜きに使う背景色 */
  bgColor: [number, number, number];
  /** 自動で選ばれた消しかた */
  engine: EngineUsed;
  /** 色で消したときの設定（画面で見せる用） */
  colorSettings: CutoutSettings | null;
};

export { openVideo, seekTo };
export type { OpenedVideo };

/** 動画の1コマ（または画像1枚）を、作業用の ImageData にする。 */
export function frameToImageData(
  image: CanvasImageSource,
  width: number,
  height: number,
  maxEdge = MATTE_MAX_EDGE,
): ImageData {
  const fit = fitWithin({ width, height }, maxEdge);
  const canvas = createCanvas(fit.width, fit.height);
  const ctx = get2d(canvas, { willReadFrequently: true });
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(image, 0, 0, fit.width, fit.height);
  return ctx.getImageData(0, 0, fit.width, fit.height);
}

/** 背景が単色かどうかを見て、消しかたを決める。 */
export function decideEngine(probe: ImageData, requested: Engine) {
  const a = analyze(probe);
  const settings: CutoutSettings = {
    ...DEFAULT_SETTINGS,
    mode: 'color',
    keyColor: a.borderColor,
    tolerance: a.suggestedTolerance,
    softness: a.suggestedSoftness,
    /*
      「囲まれた背景色を守る」は、輪の内側の白を消さないための仕掛けで、
      アイコンフレーム向けのもの。動画で抜くのは人やぬいぐるみで、
      腕と体のあいだのように「囲まれているが、消えてほしい背景」がふつうにある。
      ここでは守らない。
    */
    protectEnclosed: false,
  };

  // 四辺がばらついている＝単色背景ではない。色で消しても穴だらけになる
  const solid = a.borderSpread < 0.055 && !a.hasAlpha;
  /*
    すでに透明を持っている素材（透過PNG・透過WebM）は、そのまま通す。
    「消す」を掛け直すと、せっかく持っていたきれいなフチを、
    こちらの推定で塗り替えてしまうことになる。
  */
  const engine: EngineUsed =
    requested === 'auto' ? (a.recommended === 'none' ? 'keep' : solid ? 'color' : 'ai') : requested;
  return { engine, settings, analysis: a, solid };
}

/**
 * コマごとのマットを作る。
 * 途中でやめられる（signal.aborted）。やめたときは、そこまでの結果を返す。
 */
export async function buildMatteTrack(
  video: OpenedVideo,
  opts: ProcessOptions,
): Promise<ProcessResult> {
  const report = (p: ProcessProgress) => opts.onProgress?.(p);
  const total = Math.max(1, Math.round((opts.endSec - opts.startSec) * opts.fps) + 1);
  const thumbEvery = Math.max(1, Math.floor(total / Math.max(1, opts.thumbCount ?? 14)));

  /* ── 1. どう消すかを決める ── */
  report({ phase: 'look', value: 0.02, label: '動画を見ています', etaSec: null });
  await seekTo(video.el, opts.startSec + (opts.endSec - opts.startSec) * 0.4);
  const probe = frameToImageData(video.el, video.width, video.height);
  const decided = decideEngine(probe, opts.engine);

  /* ── 2. AI なら、先にモデルを用意する ── */
  if (decided.engine === 'ai') {
    await runMatting(shrinkForWarmup(probe), opts.quality, (p) => {
      report({
        phase: 'model',
        value: 0.02 + p.progress * 0.1,
        label: p.phase === 'download' ? p.label : 'AIを起こしています',
        etaSec: null,
      });
    });
  }
  if (opts.signal.aborted) throw new AbortError();

  /* ── 3. コマを順に処理する ── */
  const frames: Matte[] = [];
  const times: number[] = [];
  let bgColor: [number, number, number] = decided.analysis.borderColor;
  let prev: Uint8ClampedArray | null = null;
  let index = 0;
  const t0 = performance.now();

  for await (const frame of readFrames(video, {
    startSec: opts.startSec,
    endSec: opts.endSec,
    fps: opts.fps,
    signal: opts.signal,
  })) {
    if (opts.signal.aborted) break;

    const data = frameToImageData(frame.image, frame.width, frame.height);
    let alpha: Uint8ClampedArray;
    if (decided.engine === 'keep') {
      alpha = passthroughAlpha(data);
    } else if (decided.engine === 'color') {
      alpha = colorKeyAlpha(data, decided.settings);
    } else {
      alpha = await runMatting(data, opts.quality);
    }

    if (index === 0) bgColor = estimateBackgroundColor(data, alpha);
    if (prev && prev.length === alpha.length) stabilize(prev, alpha, opts.stabilizeAmount);
    prev = alpha;

    frames.push({ width: data.width, height: data.height, data: alpha });
    times.push(frame.timeSec);

    /* 途中経過。フィルムに並ぶ絵は、切り抜いたあとの姿にする
       （進み具合と、仕上がりの良し悪しを、同じ1枚で見せられる） */
    let thumb: ProcessProgress['thumb'];
    if (index % thumbEvery === 0) {
      const bitmap = await thumbnailOf(data, alpha);
      if (bitmap) thumb = { index, bitmap };
    }

    index++;
    const elapsed = performance.now() - t0;
    const per = elapsed / index;
    const left = Math.max(0, total - index);
    report({
      phase: 'frames',
      value: 0.12 + (index / total) * 0.87,
      label: decided.engine === 'ai' ? '背景を消しています' : '背景を消しています',
      etaSec: index >= 2 ? (per * left) / 1000 : null,
      thumb,
    });
  }

  if (!frames.length) throw new Error('この動画からはコマを取り出せませんでした');

  report({ phase: 'done', value: 1, label: 'できました', etaSec: 0 });

  return {
    track: {
      frames,
      times,
      startSec: times[0] ?? opts.startSec,
      endSec: times[times.length - 1] ?? opts.endSec,
      fps: opts.fps,
      engine: decided.engine,
    },
    bgColor,
    engine: decided.engine,
    colorSettings: decided.engine === 'color' ? decided.settings : null,
  };
}

export class AbortError extends Error {
  constructor() {
    super('中断しました');
    this.name = 'AbortError';
  }
}

/** モデルの用意だけを先に済ませたいので、下見は小さい絵で通す */
function shrinkForWarmup(data: ImageData): ImageData {
  const fit = fitWithin({ width: data.width, height: data.height }, 192);
  const canvas = createCanvas(data.width, data.height);
  get2d(canvas).putImageData(data, 0, 0);
  const small = createCanvas(fit.width, fit.height);
  const ctx = get2d(small, { willReadFrequently: true });
  ctx.drawImage(canvas, 0, 0, fit.width, fit.height);
  return ctx.getImageData(0, 0, fit.width, fit.height);
}

/** フィルムに並べる小さな絵（切り抜き後） */
async function thumbnailOf(data: ImageData, alpha: Uint8ClampedArray): Promise<ImageBitmap | null> {
  try {
    const out = new ImageData(data.width, data.height);
    out.data.set(data.data);
    for (let i = 0; i < alpha.length; i++) out.data[i * 4 + 3] = alpha[i];
    const fit = fitWithin({ width: data.width, height: data.height }, 160);
    return await createImageBitmap(out, { resizeWidth: fit.width, resizeHeight: fit.height });
  } catch {
    return null;
  }
}

/**
 * 画像1枚ぶんのマットを作る。
 *
 * 動画と同じ入れ物（MatteTrack）に1コマだけ入れて返す。
 * こうしておくと、見せるところも書き出すところも、動画と画像で
 * 別々のコードを持たずに済む（＝画像だけ仕上がりが違う、が起きない）。
 */
export async function buildImageMatte(
  image: ImageBitmap,
  opts: {
    engine: Engine;
    quality: AiQuality;
    signal: { aborted: boolean };
    onProgress?: (p: ProcessProgress) => void;
  },
): Promise<ProcessResult> {
  const report = (p: ProcessProgress) => opts.onProgress?.(p);
  report({ phase: 'look', value: 0.05, label: '画像を見ています', etaSec: null });

  const data = frameToImageData(image, image.width, image.height, 1024);
  const decided = decideEngine(data, opts.engine);

  let alpha: Uint8ClampedArray;
  if (decided.engine === 'keep') {
    alpha = passthroughAlpha(data);
    report({ phase: 'frames', value: 0.9, label: 'もう透明でした', etaSec: null });
  } else if (decided.engine === 'color') {
    alpha = colorKeyAlpha(data, decided.settings);
    report({ phase: 'frames', value: 0.9, label: '背景を消しています', etaSec: null });
  } else {
    alpha = await runMatting(data, opts.quality, (p) => {
      report({
        phase: p.phase === 'download' ? 'model' : 'frames',
        value: 0.1 + p.progress * 0.85,
        label: p.label,
        etaSec: null,
      });
    });
  }
  if (opts.signal.aborted) throw new AbortError();

  report({ phase: 'done', value: 1, label: 'できました', etaSec: 0 });
  return {
    track: {
      frames: [{ width: data.width, height: data.height, data: alpha }],
      times: [0],
      startSec: 0,
      endSec: 0,
      fps: 1,
      engine: decided.engine,
    },
    bgColor: estimateBackgroundColor(data, alpha),
    engine: decided.engine,
    colorSettings: decided.engine === 'color' ? decided.settings : null,
  };
}

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
import {
  chromaChannel,
  estimateBackgroundColor,
  stabilize,
  type Matte,
  type MatteTrack,
} from './matte';
import {
  backgroundLuma,
  expandBox,
  glowAlpha,
  glowKeyFor,
  glowOutside,
  mergeGlow,
  subjectBox,
  type Box,
  type GlowKey,
} from './glow';
import { MATTE_MAX_EDGE, maxFrames } from './budget';

/*
  マットを持つ解像度と、いちどに持てる量は budget.ts に置いてある。
  算数しかしていない部分を分けておくと、ブラウザを起こさずに検証できる。
*/
export { MATTE_MAX_EDGE, maxSpanSec, maxFrames, clampRange } from './budget';

export type Engine = 'auto' | 'ai' | 'color' | 'glow';

/**
 * 実際に使った消しかた。
 *   keep = もともと透明だったので、そのまま通した
 *   glow = 明るさをそのまま透明度にした（黒い地の光もの専用）
 */
export type EngineUsed = 'ai' | 'color' | 'keep' | 'glow';

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
  /** 0..100 光をどこまで残すか。0 で足さない */
  glowAmount: number;
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
  /** 光を足したか（画面の言葉を決めるのに使う） */
  glowUsed: boolean;
  /** 光を足すべきだと気づいたか（つまみの既定値を決めるのに使う） */
  glowFound: boolean;
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

  /*
    地がクロマキー（緑・青）のときは、境目の幅を広く取る。

    ── なぜ広げるのか ──

    もとの見立ては「白い地のイラスト」向けに作ってある。そこでは地の色が
    はっきりしていて、境目は数画素で終わる。だから幅を狭く取ったほうが、
    絵を余計に削らずに済む。

    グリーンバックの動画は事情が違う。緑の地は光を反射して被写体のフチを染め、
    そのうえ動画の圧縮は色情報を間引く（4:2:0）ので、**緑と被写体が混ざった
    帯が数画素ぶん残る。** 幅を狭く取ると、その帯が「完全に不透明」と判定され、
    切り抜きの縁が緑に光る。実際、検証用の緑素材でそうなった。

    帯を半透明として拾えば、そのあとの「フチの色を抜く」が働いて緑が落ちる。
    つまり、広げること自体が目的ではなく、**引き算できる状態にする**のが目的。
  */
  const chroma = chromaChannel(a.borderColor) !== null;

  const settings: CutoutSettings = {
    ...DEFAULT_SETTINGS,
    mode: 'color',
    keyColor: a.borderColor,
    tolerance: chroma ? Math.max(a.suggestedTolerance, 0.06) : a.suggestedTolerance,
    softness: chroma ? Math.max(a.suggestedSoftness, 0.22) : a.suggestedSoftness,
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

  /*
    地が暗いかどうか。光ものは黒い地でしか作れないので、
    「光も残すか」を考える必要があるのは、この場合だけ。
  */
  const bgLuma = backgroundLuma(probe);
  return { engine, settings, analysis: a, solid, bgLuma, dark: bgLuma < 0.16 };
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
  /*
    光を足すかどうかは、1コマ目を見てから決める。

    使う人が「おまかせ」のままなら、こちらで気づいて足す。
    自分で決めた人（つまみを動かした人）の指示は、そのまま通す。
  */
  let glowAmount = opts.glowAmount;
  let glowFound = false;
  let glowKey = glowKeyFor(glowAmount, decided.bgLuma);
  /** 光を拾う範囲。被写体を囲む四角を、少し広げたもの */
  let glowBox: Box | null = null;
  /** 続けてしくじった回数。一時的なつまずきと、本当の故障を見分けるため */
  let misses = 0;
  const t0 = performance.now();

  /*
    最後の砦。

    画面の側でも受けられる長さに収めているが、それは「親切」であって
    「保証」ではない。設定を変えた直後や、こちらの計算が変わったときに、
    上限を超えた範囲がここへ来ることはありうる。
    メモリを使い切って落ちるのは、いちばん取り返しがつかない壊れかたなので、
    ここでも数えて止める。止まった結果は、短い出来上がりとして残る。
  */
  const hardLimit = maxFrames(video.width, video.height);

  for await (const frame of readFrames(video, {
    startSec: opts.startSec,
    endSec: opts.endSec,
    fps: opts.fps,
    signal: opts.signal,
  })) {
    if (opts.signal.aborted) break;
    if (frames.length >= hardLimit) break;

    const data = frameToImageData(frame.image, frame.width, frame.height);

    /*
      1コマしくじったくらいで、全部を捨てない。

      AI は端末の GPU を使う。長い処理の途中で他のアプリに GPU を取られる、
      画面を消したあいだに演算装置ごと落とされる、といったことが起きる。
      そこで例外を投げて終わると、**2分待った結果が丸ごと消える。**

      もう一度だけ試して、それでも駄目なら前のコマのマットで代える
      （動きの少ない素材なら、1コマぶんは目で分からない）。
      続けて何度も失敗するなら、それは一時的なつまずきではないので、諦めて伝える。
    */
    let alpha: Uint8ClampedArray;
    try {
      alpha = await matteOf(data, { ...decided, glowKey }, opts.quality);
      misses = 0;
    } catch (e) {
      if (opts.signal.aborted) break;
      try {
        alpha = await matteOf(data, { ...decided, glowKey }, opts.quality);
        misses = 0;
      } catch (again) {
        misses++;
        if (!prev || misses > 30) throw again;
        console.warn('このコマは飛ばしました', e);
        alpha = new Uint8ClampedArray(prev);
      }
    }

    if (index === 0) {
      bgColor = estimateBackgroundColor(data, alpha);

      /*
        1コマ目だけ、光ものが混じっていないかを見る。

        見るのは「消えた側に、明るいものが残っていないか」。
        ぬいぐるみの口の中の光や、宙に浮いた粒子は、AI から見れば
        被写体ではないので消える。消えた側が真っ暗ならそれでよく、
        光っているなら、それは残したかったものである可能性が高い。
      */
      if (decided.engine !== 'glow' && decided.dark) {
        const box = subjectBox(alpha, data.width, data.height);
        glowBox = box ? expandBox(box, data.width, data.height, 0.18) : null;
        glowFound = glowOutside(data, alpha, glowBox) > 0.0015;
        if (opts.glowAmount < 0) glowAmount = glowFound ? 55 : 0;
        glowKey = glowKeyFor(glowAmount, decided.bgLuma);
      } else if (opts.glowAmount < 0) {
        glowAmount = decided.engine === 'glow' ? 55 : 0;
        glowKey = glowKeyFor(glowAmount, decided.bgLuma);
      }
    }

    /* 光を足す。塊は塊のまま、まわりの光だけが増える */
    if (glowAmount > 0 && decided.engine !== 'glow') {
      mergeGlow(
        alpha,
        glowAlpha(data, glowKey),
        data.width,
        data.height,
        glowBox,
        Math.max(6, Math.round(Math.min(data.width, data.height) * 0.05)),
      );
    }

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
      glow: glowAmount > 0 || decided.engine === 'glow',
    },
    bgColor,
    engine: decided.engine,
    colorSettings: decided.engine === 'color' ? decided.settings : null,
    glowUsed: glowAmount > 0 || decided.engine === 'glow',
    glowFound,
  };
}

/** 1コマぶんのマットを作る。消しかたの違いは、ここだけに閉じている */
function matteOf(
  data: ImageData,
  decided: { engine: EngineUsed; settings: CutoutSettings; glowKey?: GlowKey },
  quality: AiQuality,
): Promise<Uint8ClampedArray> | Uint8ClampedArray {
  if (decided.engine === 'keep') return passthroughAlpha(data);
  if (decided.engine === 'glow') return glowAlpha(data, decided.glowKey ?? glowKeyFor(55, 0));
  if (decided.engine === 'color') return colorKeyAlpha(data, decided.settings);
  return runMatting(data, quality);
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
    /** 0..100。負の数なら、こちらで決める */
    glowAmount: number;
    signal: { aborted: boolean };
    onProgress?: (p: ProcessProgress) => void;
  },
): Promise<ProcessResult> {
  const report = (p: ProcessProgress) => opts.onProgress?.(p);
  report({ phase: 'look', value: 0.05, label: '画像を見ています', etaSec: null });

  const data = frameToImageData(image, image.width, image.height, 1024);
  const decided = decideEngine(data, opts.engine);

  let glowAmount = opts.glowAmount;
  let glowFound = false;
  let alpha: Uint8ClampedArray;
  if (decided.engine === 'keep') {
    alpha = passthroughAlpha(data);
    report({ phase: 'frames', value: 0.9, label: 'もう透明でした', etaSec: null });
  } else if (decided.engine === 'glow') {
    if (glowAmount < 0) glowAmount = 55;
    alpha = glowAlpha(data, glowKeyFor(glowAmount, decided.bgLuma));
    report({ phase: 'frames', value: 0.9, label: '光を残しています', etaSec: null });
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

  /* 画像でも、消えた側に光が残っていれば足す（動画と同じ考えかた） */
  if (decided.engine !== 'glow' && decided.dark) {
    const box = subjectBox(alpha, data.width, data.height);
    const glowBox = box ? expandBox(box, data.width, data.height, 0.18) : null;
    glowFound = glowOutside(data, alpha, glowBox) > 0.0015;
    if (glowAmount < 0) glowAmount = glowFound ? 55 : 0;
    if (glowAmount > 0) {
      mergeGlow(
        alpha,
        glowAlpha(data, glowKeyFor(glowAmount, decided.bgLuma)),
        data.width,
        data.height,
        glowBox,
        Math.max(6, Math.round(Math.min(data.width, data.height) * 0.05)),
      );
    }
  } else if (glowAmount < 0) {
    glowAmount = 0;
  }

  report({ phase: 'done', value: 1, label: 'できました', etaSec: 0 });
  return {
    track: {
      frames: [{ width: data.width, height: data.height, data: alpha }],
      times: [0],
      startSec: 0,
      endSec: 0,
      fps: 1,
      engine: decided.engine,
      glow: glowAmount > 0 || decided.engine === 'glow',
    },
    bgColor: estimateBackgroundColor(data, alpha),
    engine: decided.engine,
    colorSettings: decided.engine === 'color' ? decided.settings : null,
    glowUsed: glowAmount > 0 || decided.engine === 'glow',
    glowFound,
  };
}

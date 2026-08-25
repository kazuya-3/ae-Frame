/**
 * AI での切り抜き（マッティング）。
 *
 * transformers.js を使い、モデルをブラウザ内で直接動かす。画像は端末から出ない。
 * このファイルは動的 import 専用。初期表示に AI ランタイムを載せないための境界でもある。
 *
 * モデルは「試して駄目なら次」の順番リストにしてある。ハブ側の都合で1つ落ちても
 * ツール全体が使えなくなることはない（最終的にはアルゴリズム透過に落ちる）。
 */

import type { Tensor } from '@huggingface/transformers';

export type AiProgress = {
  phase: 'download' | 'run';
  /** 0..1 */
  progress: number;
  label: string;
};

export type AiQuality = 'balanced' | 'high';

/**
 * どちらの AI を先に試すか。
 *
 * ── なぜ選べるようにしたか ──
 *
 * どちらが上かは、**渡されるフレーム次第**で入れ替わる。
 * BiRefNet はうすい色やグローの境目を粘る。MODNet は人物の輪郭に強い。
 * 手もとには本物のフレームが1枚も無いので、こちらでどちらが良いとは決められない。
 *
 * 順番を黙って入れ替えることもできるが、それは「測っていないほうへ賭ける」だけで、
 * 良くなったかどうかは誰にも分からないままになる。
 * だから既定は変えず、**うまくいかなかった人がその場で試せる**ようにした。
 * 置き場所は「うまく消えないときは」の中で、普段の画面には出ない。
 */
export type AiModel = 'default' | 'alt';

type ModelSpec = {
  id: string;
  label: string;
  /** 前処理を明示指定する必要があるモデル（config を同梱していない）向け */
  modelOptions?: Record<string, unknown>;
  processorConfig?: Record<string, unknown>;
};

/*
  ── ここに RMBG-1.4 を置いていた（1番手だった）──

  切り抜きの質は良かったが、ライセンスが**非商用**の条件付きだった。
  無料で配っているだけなら関係が無い。お礼（チップ）を受け取る形にした時点で、
  「これは商用か」を自分で判断する立場になる。**争うより避けるほうが安い**ので外した。

  控えに残すこともしない。控えは「1番手が落ちたときに黙って動くもの」で、
  黙って動く場所に条件付きのものを置いたら、外した意味が無くなる。

  いま使う2つはどちらも制限なし：
    - BiRefNet  … MIT（ZhengPeng7/BiRefNet の LICENSE）
    - MODNet    … Apache-2.0（ZHKKKe/MODNet。コード・モデル・デモとも）
*/

const BIREFNET: ModelSpec = {
  id: 'onnx-community/BiRefNet_lite',
  label: 'BiRefNet-lite',
  modelOptions: {
    config: { model_type: 'custom', is_encoder_decoder: false },
  },
  processorConfig: {
    do_normalize: true,
    do_pad: false,
    do_rescale: true,
    do_resize: true,
    image_mean: [0.485, 0.456, 0.406],
    image_std: [0.229, 0.224, 0.225],
    resample: 2,
    rescale_factor: 1 / 255,
    size: { width: 1024, height: 1024 },
  },
};

const MODNET: ModelSpec = { id: 'Xenova/modnet', label: 'MODNet' };

/**
 * 上から順に試す。選んだほうを先頭にするだけで、残りは控えとして残す。
 * ハブ側の都合で1つ落ちても、ツール全体が使えなくならないようにするため。
 */
function order(pick: AiModel): ModelSpec[] {
  return pick === 'alt' ? [MODNET, BIREFNET] : [BIREFNET, MODNET];
}

type Loaded = {
  spec: ModelSpec;
  model: any;
  processor: any;
  backend: string;
};

let loaded: Loaded | null = null;
let loading: Promise<Loaded> | null = null;
/*
  いま持っているものが何か。画質だけでなく、どちらの AI を選んだかまで含める。
  画質だけで見ていると、AI を切り替えても前のモデルが返ってしまう。
*/
let loadedKey: string | null = null;

async function webgpuAvailable(): Promise<boolean> {
  const gpu = (navigator as unknown as { gpu?: { requestAdapter(): Promise<unknown> } }).gpu;
  if (!gpu) return false;
  try {
    return (await gpu.requestAdapter()) != null;
  } catch {
    return false;
  }
}

/** モデルとプロセッサを用意する。二重ロードは避け、結果は使いまわす。 */
export async function loadModel(
  quality: AiQuality,
  pick: AiModel = 'default',
  onProgress?: (p: AiProgress) => void,
): Promise<Loaded> {
  const key = `${quality}/${pick}`;
  if (loaded && loadedKey === key) return loaded;
  if (loading && loadedKey === key) return loading;

  loadedKey = key;
  loading = (async () => {
    const tf = await import('@huggingface/transformers');
    const { AutoModel, AutoProcessor, env } = tf;

    // ハブから取得する構成に固定（同一オリジンにモデルは置いていない）
    env.allowLocalModels = false;
    if (env.backends?.onnx?.wasm) {
      env.backends.onnx.wasm.numThreads = Math.min(4, navigator.hardwareConcurrency || 2);
    }

    const useGpu = await webgpuAvailable();
    // WebGPU なら精度を上げても実用速度。CPU(wasm) では量子化しないと待たされすぎる。
    const dtype = quality === 'high' ? 'fp32' : useGpu ? 'fp16' : 'q8';
    const device = useGpu ? 'webgpu' : 'wasm';

    // ファイルごとの進捗を足し合わせて、1本のバーに見せる
    const files = new Map<string, number>();
    const report = (label: string) => {
      if (!onProgress) return;
      const values = [...files.values()];
      const avg = values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
      onProgress({
        phase: 'download',
        progress: Math.min(0.99, avg / 100),
        label,
      });
    };
    const progress_callback = (info: any) => {
      if (info?.file && typeof info.progress === 'number') {
        files.set(info.file, info.progress);
        report('AIを準備しています');
      } else if (info?.status === 'ready') {
        report('もう少しです');
      }
    };

    const errors: string[] = [];
    for (const spec of order(pick)) {
      for (const dev of [device, 'wasm'] as const) {
        try {
          const model = await AutoModel.from_pretrained(spec.id, {
            ...(spec.modelOptions ?? {}),
            device: dev,
            dtype: dev === 'webgpu' ? dtype : quality === 'high' ? 'fp32' : 'q8',
            progress_callback,
          } as any);
          const processor = await AutoProcessor.from_pretrained(spec.id, {
            ...(spec.processorConfig ? { config: spec.processorConfig } : {}),
            progress_callback,
          } as any);
          loaded = { spec, model, processor, backend: dev };
          onProgress?.({
            phase: 'download',
            progress: 1,
            label: '準備できました',
          });
          return loaded;
        } catch (e) {
          errors.push(`${spec.label}/${dev}: ${(e as Error)?.message ?? e}`);
          if (dev === 'wasm') break; // このモデルは諦めて次へ
        }
      }
    }
    loading = null;
    loadedKey = null;
    throw new Error(`AIモデルを読み込めませんでした\n${errors.join('\n')}`);
  })();

  try {
    return await loading;
  } catch (e) {
    loading = null;
    throw e;
  }
}

/** 出力オブジェクトの中から、マスクらしいテンソルを1つ拾う。 */
function pickMaskTensor(result: any): Tensor {
  if (!result) throw new Error('AIの出力が空でした');
  const candidates: Tensor[] = [];
  const visit = (v: any, depth = 0) => {
    if (!v || depth > 2) return;
    if (Array.isArray(v)) {
      v.forEach((x) => visit(x, depth + 1));
      return;
    }
    if (v.dims && v.data) {
      candidates.push(v as Tensor);
      return;
    }
    if (typeof v === 'object') Object.values(v).forEach((x) => visit(x, depth + 1));
  };
  visit(result);

  // チャンネル数1（= マスク）で、面積が最大のものを選ぶ
  const masks = candidates.filter((t) => {
    const d = t.dims;
    return d.length >= 3 && (d[d.length - 3] === 1 || d.length === 3);
  });
  const pool = masks.length ? masks : candidates;
  if (!pool.length) throw new Error('AIの出力からマスクを取り出せませんでした');
  return pool.sort((a, b) => {
    const area = (t: Tensor) => t.dims[t.dims.length - 1] * t.dims[t.dims.length - 2];
    return area(b) - area(a);
  })[0];
}

function sigmoidInPlace(arr: Float32Array) {
  for (let i = 0; i < arr.length; i++) arr[i] = 1 / (1 + Math.exp(-arr[i]));
}

/**
 * 画像を切り抜き、アルファ（0..255・入力と同じ画素数）を返す。
 */
export async function runMatting(
  image: ImageData,
  quality: AiQuality,
  pick: AiModel,
  onProgress?: (p: AiProgress) => void,
): Promise<Uint8ClampedArray> {
  const { RawImage } = await import('@huggingface/transformers');
  const { model, processor } = await loadModel(quality, pick, onProgress);

  onProgress?.({ phase: 'run', progress: 0.15, label: '背景を見分けています' });

  const raw = new RawImage(new Uint8ClampedArray(image.data), image.width, image.height, 4);
  const { pixel_values } = await processor(raw);

  onProgress?.({ phase: 'run', progress: 0.5, label: '背景を消しています' });

  let result: any;
  try {
    result = await model({ input: pixel_values });
  } catch {
    result = await model({ pixel_values });
  }

  const tensor = pickMaskTensor(result);
  const dims = tensor.dims;
  const mw = dims[dims.length - 1];
  const mh = dims[dims.length - 2];

  // 値域を 0..1 に揃える。ロジットを返すモデルはここでシグモイドを通す。
  const values = Float32Array.from(tensor.data as ArrayLike<number>);
  let min = Infinity;
  let max = -Infinity;
  for (const v of values) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (min < -0.01 || max > 1.01) {
    sigmoidInPlace(values);
    min = Infinity;
    max = -Infinity;
    for (const v of values) {
      if (v < min) min = v;
      if (v > max) max = v;
    }
  }
  // 全体的に薄い/濃い出力になるモデルのためのコントラスト補正
  const span = max - min;
  const needsStretch = span > 0.2 && (max < 0.9 || min > 0.1);

  const mask = new Float32Array(mw * mh);
  for (let i = 0; i < mask.length; i++) {
    const v = values[i];
    mask[i] = needsStretch ? (v - min) / span : Math.max(0, Math.min(1, v));
  }

  onProgress?.({ phase: 'run', progress: 0.85, label: 'かたちを整えています' });

  const alpha = resampleBilinear(mask, mw, mh, image.width, image.height);

  // 元画像がすでに透過を持っていたら、それを超えないようにする
  const out = new Uint8ClampedArray(image.width * image.height);
  for (let i = 0; i < out.length; i++) {
    out[i] = Math.round(alpha[i] * 255 * (image.data[i * 4 + 3] / 255));
  }

  onProgress?.({ phase: 'run', progress: 1, label: 'できました' });
  return out;
}

/** マスクを入力サイズへバイリニア拡大。canvas 経由より境界がなめらかになる。 */
function resampleBilinear(
  src: Float32Array,
  sw: number,
  sh: number,
  dw: number,
  dh: number,
): Float32Array {
  if (sw === dw && sh === dh) return src;
  const out = new Float32Array(dw * dh);
  const xRatio = sw > 1 ? (sw - 1) / Math.max(1, dw - 1) : 0;
  const yRatio = sh > 1 ? (sh - 1) / Math.max(1, dh - 1) : 0;

  for (let y = 0; y < dh; y++) {
    const fy = y * yRatio;
    const y0 = Math.floor(fy);
    const y1 = Math.min(sh - 1, y0 + 1);
    const wy = fy - y0;
    for (let x = 0; x < dw; x++) {
      const fx = x * xRatio;
      const x0 = Math.floor(fx);
      const x1 = Math.min(sw - 1, x0 + 1);
      const wx = fx - x0;
      const a = src[y0 * sw + x0];
      const b = src[y0 * sw + x1];
      const c = src[y1 * sw + x0];
      const d = src[y1 * sw + x1];
      out[y * dw + x] =
        a * (1 - wx) * (1 - wy) + b * wx * (1 - wy) + c * (1 - wx) * wy + d * wx * wy;
    }
  }
  return out;
}

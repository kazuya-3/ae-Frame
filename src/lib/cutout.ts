/**
 * 背景透過の中身。
 *
 * 透過は「1回で当てにいく」のではなく、次の3層を重ねて最終アルファを作る。
 *
 *   1. ベースアルファ … 自動判定（すでに透過 / 単色背景キー / AI切り抜き）の結果
 *   2. 仕上げ処理   … フチ削り(erode)・ぼかし(feather)・フチの色抜き(decontaminate)
 *   3. 手描きマスク … 「ここは消す」「ここは戻す」の筆
 *
 * 3層を分けて保持しているので、しきい値を動かしても手描きは消えないし、
 * モードを切り替えてもやり直しにならない。
 */

export type CutoutMode = 'auto' | 'color' | 'ai' | 'none';

export type CutoutSettings = {
  mode: CutoutMode;
  /** 背景色とみなす色（color モードで使用） */
  keyColor: [number, number, number];
  /** 0..1 これ以下の色差は背景 */
  tolerance: number;
  /** 0..1 背景と前景の境目のなめらかさ */
  softness: number;
  /** 中央にある背景色は残す（人物写真向け。フレームでは false） */
  keepInterior: boolean;
  /** px フチを削る量 */
  shrink: number;
  /** px 境界のぼかし */
  feather: number;
  /** 0..1 半透明部分に残った背景色を抜く強さ */
  decontaminate: number;
};

export const DEFAULT_SETTINGS: CutoutSettings = {
  mode: 'auto',
  keyColor: [255, 255, 255],
  tolerance: 0.06,
  softness: 0.12,
  keepInterior: false,
  shrink: 0,
  feather: 0.6,
  decontaminate: 0.85,
};

export type Analysis = {
  /** 元画像にすでに意味のある透明部分があるか */
  hasAlpha: boolean;
  /** 四辺から推定した背景色 */
  borderColor: [number, number, number];
  /** 背景色のばらつき（小さいほど単色背景） */
  borderSpread: number;
  /** 自動判定の結論 */
  recommended: Exclude<CutoutMode, 'auto'>;
  /** 自動で決めたしきい値 */
  suggestedTolerance: number;
};

/** 知覚に近い重みづけの色距離（0..1 に正規化） */
function colorDistance(r: number, g: number, b: number, k: [number, number, number]): number {
  const dr = r - k[0];
  const dg = g - k[1];
  const db = b - k[2];
  return Math.sqrt(0.299 * dr * dr + 0.587 * dg * dg + 0.114 * db * db) / 255;
}

function smoothstep(t: number) {
  return t * t * (3 - 2 * t);
}

/**
 * 画像を眺めて「どのやり方が向いているか」を決める。
 * ここが当たるかどうかで、ユーザーが設定を触らずに済むかが決まる。
 */
export function analyze(data: ImageData): Analysis {
  const { width, height, data: px } = data;

  // --- すでに透過しているか ---
  let translucent = 0;
  const total = width * height;
  for (let i = 3; i < px.length; i += 4) {
    if (px[i] < 250) translucent++;
  }
  const hasAlpha = translucent / total > 0.02;

  // --- 四辺のリングから背景色を推定 ---
  const ring = Math.max(1, Math.round(Math.min(width, height) * 0.01));
  const samples: number[][] = [];
  const pushPixel = (x: number, y: number) => {
    const i = (y * width + x) * 4;
    if (px[i + 3] < 128) return; // すでに透明な縁は背景推定に使わない
    samples.push([px[i], px[i + 1], px[i + 2]]);
  };
  for (let y = 0; y < height; y++) {
    for (let k = 0; k < ring; k++) {
      if (y < ring || y >= height - ring) {
        for (let x = 0; x < width; x += 2) pushPixel(x, y);
        break;
      }
      pushPixel(k, y);
      pushPixel(width - 1 - k, y);
    }
  }

  if (samples.length === 0) {
    return {
      hasAlpha,
      borderColor: [255, 255, 255],
      borderSpread: 1,
      recommended: hasAlpha ? 'none' : 'ai',
      suggestedTolerance: DEFAULT_SETTINGS.tolerance,
    };
  }

  // 平均ではなく中央値。縁に少し被写体が写り込んでいても引っぱられない。
  const median = (idx: number) => {
    const arr = samples.map((s) => s[idx]).sort((a, b) => a - b);
    return arr[arr.length >> 1];
  };
  const borderColor: [number, number, number] = [median(0), median(1), median(2)];

  const dists = samples
    .map((s) => colorDistance(s[0], s[1], s[2], borderColor))
    .sort((a, b) => a - b);
  const p = (q: number) => dists[Math.min(dists.length - 1, Math.floor(dists.length * q))];
  const borderSpread = p(0.9);

  // 縁の 98% が収まる色差 + 余裕。JPEG のノイズやグラデを吸収する。
  const suggestedTolerance = Math.min(0.35, Math.max(0.03, p(0.98) + 0.035));

  let recommended: Exclude<CutoutMode, 'auto'>;
  if (hasAlpha) {
    recommended = 'none';
  } else if (borderSpread < 0.06) {
    // 縁がほぼ単色 → 色キーのほうが AI より輪郭がシャープに出る
    recommended = 'color';
  } else {
    recommended = 'ai';
  }

  return {
    hasAlpha,
    borderColor,
    borderSpread,
    recommended,
    suggestedTolerance,
  };
}

/** 単色背景キーでアルファを作る。 */
export function colorKeyAlpha(data: ImageData, s: CutoutSettings): Uint8ClampedArray {
  const { width, height, data: px } = data;
  const n = width * height;
  const alpha = new Uint8ClampedArray(n);
  const lo = s.tolerance;
  const hi = Math.max(lo + 0.004, s.tolerance + s.softness);

  for (let i = 0; i < n; i++) {
    const j = i * 4;
    const d = colorDistance(px[j], px[j + 1], px[j + 2], s.keyColor);
    let a: number;
    if (d <= lo) a = 0;
    else if (d >= hi) a = 1;
    else a = smoothstep((d - lo) / (hi - lo));
    // 元画像の透明度は常に上限として尊重する
    alpha[i] = Math.round(a * 255 * (px[j + 3] / 255));
  }

  if (s.keepInterior) keepInteriorOnly(alpha, width, height);
  return alpha;
}

/**
 * 「外側とつながっている背景」だけを透明にする。
 * ドーナツの穴のような内側の白は残るので、人物写真向け。
 */
function keepInteriorOnly(alpha: Uint8ClampedArray, width: number, height: number) {
  const n = width * height;
  const reachable = new Uint8Array(n);
  const stack = new Int32Array(n);
  let top = 0;

  const push = (i: number) => {
    if (alpha[i] < 250 && !reachable[i]) {
      reachable[i] = 1;
      stack[top++] = i;
    }
  };
  for (let x = 0; x < width; x++) {
    push(x);
    push((height - 1) * width + x);
  }
  for (let y = 0; y < height; y++) {
    push(y * width);
    push(y * width + width - 1);
  }
  while (top > 0) {
    const i = stack[--top];
    const x = i % width;
    if (x > 0) push(i - 1);
    if (x < width - 1) push(i + 1);
    if (i >= width) push(i - width);
    if (i < n - width) push(i + width);
  }
  for (let i = 0; i < n; i++) {
    if (!reachable[i]) alpha[i] = 255;
  }
}

/** 半径 r の最小値フィルタ（縦横に分離して近似）。フチを内側に削る。 */
export function erodeAlpha(
  alpha: Uint8ClampedArray,
  width: number,
  height: number,
  radius: number,
) {
  const r = Math.round(radius);
  if (r <= 0) return alpha;
  const tmp = new Uint8ClampedArray(alpha.length);

  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      let m = 255;
      for (let k = -r; k <= r; k++) {
        const xx = Math.min(width - 1, Math.max(0, x + k));
        const v = alpha[row + xx];
        if (v < m) m = v;
      }
      tmp[row + x] = m;
    }
  }
  for (let x = 0; x < width; x++) {
    for (let y = 0; y < height; y++) {
      let m = 255;
      for (let k = -r; k <= r; k++) {
        const yy = Math.min(height - 1, Math.max(0, y + k));
        const v = tmp[yy * width + x];
        if (v < m) m = v;
      }
      alpha[y * width + x] = m;
    }
  }
  return alpha;
}

/** 分離型ボックスぼかしを2回。境界のジャギーを取る。 */
export function blurAlpha(alpha: Uint8ClampedArray, width: number, height: number, radius: number) {
  const r = Math.round(radius);
  if (r <= 0) return alpha;
  const tmp = new Float32Array(alpha.length);
  const out = new Float32Array(alpha.length);

  for (let pass = 0; pass < 2; pass++) {
    // 横
    for (let y = 0; y < height; y++) {
      const row = y * width;
      let sum = 0;
      for (let k = -r; k <= r; k++) sum += alpha[row + Math.min(width - 1, Math.max(0, k))];
      const win = 2 * r + 1;
      for (let x = 0; x < width; x++) {
        tmp[row + x] = sum / win;
        const addX = Math.min(width - 1, x + r + 1);
        const subX = Math.max(0, x - r);
        sum += alpha[row + addX] - alpha[row + subX];
      }
    }
    // 縦
    for (let x = 0; x < width; x++) {
      let sum = 0;
      for (let k = -r; k <= r; k++) sum += tmp[Math.min(height - 1, Math.max(0, k)) * width + x];
      const win = 2 * r + 1;
      for (let y = 0; y < height; y++) {
        out[y * width + x] = sum / win;
        const addY = Math.min(height - 1, y + r + 1);
        const subY = Math.max(0, y - r);
        sum += tmp[addY * width + x] - tmp[subY * width + x];
      }
    }
    for (let i = 0; i < alpha.length; i++) alpha[i] = out[i];
  }
  return alpha;
}

export type PaintMask = {
  width: number;
  height: number;
  /** 0..255 消す強さ */
  erase: Uint8Array;
  /** 0..255 元に戻す強さ */
  keep: Uint8Array;
};

export function createPaintMask(width: number, height: number): PaintMask {
  return {
    width,
    height,
    erase: new Uint8Array(width * height),
    keep: new Uint8Array(width * height),
  };
}

export function clearPaintMask(mask: PaintMask) {
  mask.erase.fill(0);
  mask.keep.fill(0);
}

export function isPaintMaskEmpty(mask: PaintMask) {
  return !mask.erase.some(Boolean) && !mask.keep.some(Boolean);
}

/** やわらかい丸ブラシを1回押す。 */
export function stampBrush(
  mask: PaintMask,
  tool: 'erase' | 'keep',
  cx: number,
  cy: number,
  radius: number,
  hardness = 0.55,
  strength = 1,
) {
  const target = tool === 'erase' ? mask.erase : mask.keep;
  const other = tool === 'erase' ? mask.keep : mask.erase;
  const { width, height } = mask;
  const r = Math.max(1, radius);
  const x0 = Math.max(0, Math.floor(cx - r));
  const x1 = Math.min(width - 1, Math.ceil(cx + r));
  const y0 = Math.max(0, Math.floor(cy - r));
  const y1 = Math.min(height - 1, Math.ceil(cy + r));
  const inner = r * hardness;

  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const d = Math.hypot(x - cx, y - cy);
      if (d > r) continue;
      let f = d <= inner ? 1 : 1 - (d - inner) / Math.max(1e-3, r - inner);
      f = smoothstep(Math.max(0, Math.min(1, f))) * strength;
      const i = y * width + x;
      const v = Math.round(f * 255);
      if (v > target[i]) target[i] = v;
      // 反対の筆で塗った跡は打ち消す（塗り直しが素直に効く）
      if (other[i] > 0) other[i] = Math.max(0, other[i] - v);
    }
  }
}

/** 2点間をブラシで結ぶ。指の移動が速くても途切れない。 */
export function strokeBrush(
  mask: PaintMask,
  tool: 'erase' | 'keep',
  from: { x: number; y: number },
  to: { x: number; y: number },
  radius: number,
  hardness?: number,
) {
  const dist = Math.hypot(to.x - from.x, to.y - from.y);
  const step = Math.max(1, radius * 0.25);
  const steps = Math.max(1, Math.ceil(dist / step));
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    stampBrush(
      mask,
      tool,
      from.x + (to.x - from.x) * t,
      from.y + (to.y - from.y) * t,
      radius,
      hardness,
    );
  }
}

/**
 * ベースアルファに仕上げ（フチ削り・ぼかし）だけを適用する。
 *
 * 筆で塗っている最中に毎フレーム走らせると重いので、合成とは分けてある。
 * 設定を動かしたときだけ呼び、結果を使いまわす。
 */
export function finishAlpha(
  baseAlpha: Uint8ClampedArray,
  width: number,
  height: number,
  s: CutoutSettings,
): Uint8ClampedArray {
  const alpha = new Uint8ClampedArray(baseAlpha); // 元は壊さない
  if (s.shrink > 0) erodeAlpha(alpha, width, height, s.shrink);
  if (s.feather > 0) blurAlpha(alpha, width, height, s.feather);
  return alpha;
}

/**
 * 仕上げ済みアルファ + 手描きマスク を元画像に合成して RGBA を作る。
 * 1画素1パスなので、筆の追従に耐えられる。
 */
export function composite(
  source: ImageData,
  alpha: Uint8ClampedArray,
  paint: PaintMask | null,
  s: CutoutSettings,
  reuse?: ImageData | null,
): ImageData {
  const { width, height, data: src } = source;
  const n = width * height;

  // 筆を動かしている間は毎フレーム呼ばれる。1600px 角なら1枚 10MB になるので、
  // 呼び出し側から使い回しのバッファを受け取れるようにしてある。
  const out =
    reuse && reuse.width === width && reuse.height === height
      ? reuse
      : new ImageData(width, height);
  const dst = out.data;
  const [kr, kg, kb] = s.keyColor;
  const decon = s.mode === 'ai' ? s.decontaminate * 0.5 : s.decontaminate;

  for (let i = 0; i < n; i++) {
    const j = i * 4;
    let a = alpha[i];

    if (paint) {
      const e = paint.erase[i];
      if (e > 0) a = a * (1 - e / 255);
      const k = paint.keep[i];
      if (k > 0) a = Math.max(a, (src[j + 3] * k) / 255);
    }

    let r = src[j];
    let g = src[j + 1];
    let b = src[j + 2];

    // 半透明の画素に残った背景色を引き算する（白フチ・黒フチ対策）
    if (decon > 0 && a > 4 && a < 250) {
      const af = a / 255;
      const ur = (r - (1 - af) * kr) / af;
      const ug = (g - (1 - af) * kg) / af;
      const ub = (b - (1 - af) * kb) / af;
      r += (ur - r) * decon;
      g += (ug - g) * decon;
      b += (ub - b) * decon;
    }

    dst[j] = r;
    dst[j + 1] = g;
    dst[j + 2] = b;
    dst[j + 3] = a;
  }

  return out;
}

/** 元画像をそのまま通す（すでに透過済みの画像向け）。 */
export function passthroughAlpha(data: ImageData): Uint8ClampedArray {
  const n = data.width * data.height;
  const alpha = new Uint8ClampedArray(n);
  for (let i = 0; i < n; i++) alpha[i] = data.data[i * 4 + 3];
  return alpha;
}

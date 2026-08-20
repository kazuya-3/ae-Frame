/**
 * 光ものを、黒い地から抜く。
 *
 * ── なぜ専用の道が要るのか ──
 *
 * 光る素材（火花・きらめき・ネオン・口の中の光）は、**黒い地の上でしか作れない。**
 * 白い地に置くと光が見えないので、作る側は黒で作る。当然の選択なのだが、
 * そのあと切り抜こうとすると行き詰まる。
 *
 *   ・AI は「被写体はどれか」を見る。宙に浮いた粒子や、にじんだ光は
 *     被写体として扱われず、まるごと消える
 *   ・色キーは「この色を消す」なので、黒を消すと**光の裾（暗い側）も一緒に消える**。
 *     残るのは芯だけで、ふわっとした感じが死ぬ
 *
 * ── 光の正体は「足し算」 ──
 *
 * 黒い地に写っている光は、地の色に**足された**分そのもの。
 * だから明るさをそのまま透明度にして、色を割り戻せば、
 * どんな地の上でも「足し算」と同じ見えかたになる。
 *
 *   透明度 a = 明るさ
 *   色     c = 見えている色 ÷ a     ← 割り戻し（decontaminate が受け持つ）
 *
 * これで、粒子は粒子のまま、にじみはにじみのまま、別の背景に乗る。
 *
 * ── ただし、これだけでは足りない ──
 *
 * この方法は「明るいものを残す」ので、**ぬいぐるみのような塊には向かない。**
 * 実際に試すと、体の暗いところが透けてスカスカになった。
 *
 * だから片方だけでは足りない。塊は AI（または色）に任せ、
 * その結果に光を**足す**。max（濃いほうを採る）で重ねるだけで、
 * 塊は塊のまま、まわりの光も残る。
 */

export type GlowKey = {
  /** これ以下の明るさは、光とみなさない（0..1） */
  black: number;
  /** これ以上の明るさは、完全に不透明（0..1） */
  white: number;
};

export type Box = { x0: number; y0: number; x1: number; y1: number };

/** 明るさ（人の目の感じかたに合わせた重みづけ）。0..1 */
function luma(r: number, g: number, b: number) {
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

/**
 * 「光を残す」つまみ（0..100）から、しきい値の組を作る。
 *
 * 上げるほど暗いところまで光として拾う。地の明るさより下は決して拾わない
 * （拾うと、地そのものが薄く残って全体が曇る）。
 */
export function glowKeyFor(amount: number, backgroundLuma: number): GlowKey {
  const floor = Math.max(0.03, backgroundLuma + 0.025);
  const black = Math.max(floor, 0.34 - 0.3 * (Math.min(100, Math.max(0, amount)) / 100));
  return { black, white: Math.min(0.98, black + 0.34) };
}

/** 明るさをそのまま透明度にする。 */
export function glowAlpha(data: ImageData, key: GlowKey): Uint8ClampedArray {
  const { data: px } = data;
  const n = data.width * data.height;
  const out = new Uint8ClampedArray(n);
  const span = Math.max(0.001, key.white - key.black);
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    const l = luma(px[j], px[j + 1], px[j + 2]);
    let a = (l - key.black) / span;
    if (a <= 0) continue;
    if (a > 1) a = 1;
    // 角を立てない。光の裾は、なだらかに消えていくほうが本物に見える
    out[i] = (a * a * (3 - 2 * a) * 255) | 0;
  }
  return out;
}

/** 残っているところを囲む四角。何も残っていなければ null */
export function subjectBox(
  alpha: Uint8ClampedArray,
  width: number,
  height: number,
  threshold = 48,
): Box | null {
  let x0 = width;
  let y0 = height;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      if (alpha[row + x] < threshold) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  return x1 < 0 ? null : { x0, y0, x1, y1 };
}

/** 四角を、画面の短いほうの辺の割合ぶん広げる */
export function expandBox(box: Box, width: number, height: number, ratio: number): Box {
  const m = Math.round(Math.min(width, height) * ratio);
  return {
    x0: Math.max(0, box.x0 - m),
    y0: Math.max(0, box.y0 - m),
    x1: Math.min(width - 1, box.x1 + m),
    y1: Math.min(height - 1, box.y1 + m),
  };
}

/**
 * 光を、いまのマットに足す。
 *
 * ── なぜ四角で囲うのか ──
 *
 * 「明るいものを残す」は、画面のどこにあっても効いてしまう。
 * 実際の素材で試すと、右下に入っている生成AIの印まで残った。
 * 光は被写体のまわりに出るものなので、被写体を囲む四角の少し外まで、と決める。
 *
 * 四角の縁で急に切ると、そこに線が出る。外に向かってなだらかに弱める。
 */
export function mergeGlow(
  base: Uint8ClampedArray,
  glow: Uint8ClampedArray,
  width: number,
  height: number,
  box: Box | null,
  feather: number,
) {
  const soft = Math.max(1, feather);
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      const i = row + x;
      const g = glow[i];
      if (!g) continue;
      let w = 1;
      if (box) {
        const dx = Math.max(box.x0 - x, x - box.x1, 0);
        const dy = Math.max(box.y0 - y, y - box.y1, 0);
        const d = Math.max(dx, dy);
        if (d >= soft) continue;
        w = 1 - d / soft;
      }
      const v = g * w;
      if (v > base[i]) base[i] = v;
    }
  }
}

/**
 * 「消えた側に、光っているものが残っていないか」を見る。
 *
 * ここが当たると、使う人は何も選ばずに済む。外しても
 * 「光を残す」を 0 にすれば元どおりになるので、強く出て構わない。
 */
export function glowOutside(data: ImageData, alpha: Uint8ClampedArray, box: Box | null): number {
  const { width, height, data: px } = data;
  let found = 0;
  let looked = 0;
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      if (box && (x < box.x0 || x > box.x1 || y < box.y0 || y > box.y1)) continue;
      looked++;
      const i = row + x;
      if (alpha[i] >= 32) continue; // すでに残っているところは、光かどうかを問わない
      const j = i * 4;
      if (luma(px[j], px[j + 1], px[j + 2]) > 0.35) found++;
    }
  }
  return looked ? found / looked : 0;
}

/** 地の明るさ。四辺の中央値で見る（隅だけだと、口や影に当たると外す） */
export function backgroundLuma(data: ImageData): number {
  const { width, height, data: px } = data;
  const samples: number[] = [];
  const step = Math.max(1, Math.floor(width / 160));
  for (let x = 0; x < width; x += step) {
    for (const y of [0, 1, height - 2, height - 1]) {
      const j = (y * width + x) * 4;
      samples.push(luma(px[j], px[j + 1], px[j + 2]));
    }
  }
  if (!samples.length) return 0;
  samples.sort((a, b) => a - b);
  return samples[Math.floor(samples.length / 2)];
}

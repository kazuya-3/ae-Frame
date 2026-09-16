/**
 * フレームの「まん中の穴」を見つける。
 *
 * ── なぜ要るのか ──
 *
 * 写真を重ねる画面は、いままで写真を**画面いっぱい（cover）**から始めていた。
 * 穴が画面の7割しかないフレームだと、見えるのは写真の中央7割だけで、
 * 顔がはみ出る。だから利用者は毎回、指で動かして直す。
 *
 * **その「毎回ちがう直しかた」が、みんなでつけたときのバラつきそのもの。**
 * 直さなくていい場所から始めれば、動かす人が減り、結果がそろう。
 *
 * ── なぜ切り抜いたあとの絵から探すのか ──
 *
 * 背景をけす処理（cutout.ts）は、すでに中心から種を蒔いて穴を抜いている。
 * その途中経過を持ち回ることもできるが、そうすると
 * **背景けしを通らずに来たフレームでは穴が分からない。**
 *
 * フレームは3つの入口から来る。
 *
 *   1. その場で背景をけしたもの
 *   2. この端末に覚えてあるもの（けし終わったあとの PNG）
 *   3. 人からもらったもの（同じく、けし終わったあとの PNG）
 *
 * 3 がこれから増える。**出来上がりの絵だけを見て決める**なら、3つとも同じ道を通れる。
 */

/** フレーム画像に対する比（0..1）で表した穴 */
export type Hole = {
  /** 穴の中心 */
  cx: number;
  cy: number;
  /** 穴の半分の幅・高さ */
  rx: number;
  ry: number;
};

/**
 * これ未満のアルファは「向こうが見える」とみなす。
 *
 * 0 にしない。境目のぼかしや、フチの削りで、穴のふちには
 * 1〜数十の半端な値が残る。そこを不透明として扱うと、穴が実際より小さく出る。
 */
const CLEAR = 24;

/**
 * 画像全体に対して、これ未満しかない透明の島は穴とみなさない。
 *
 * 飾りの隙間（星の中、文字の "o" の中）を穴と間違えないための歯止め。
 * アイコンフレームの穴は、たいてい画像の3割以上ある。
 */
const MIN_AREA = 0.04;

/**
 * まん中の穴を探す。見つからなければ null。
 *
 * 手順は2段。
 *   1. **外側**の透明を、四辺から塗りつぶして覚える
 *   2. 残った透明（＝どこにも出られない透明）のうち、いちばん大きい島を穴とする
 *
 * 外につながっている透明は、穴ではなく「フレームの外」。
 * ここを分けないと、フレーム全体の外接矩形が返ってきてしまう。
 */
export function findHole(frame: ImageData): Hole | null {
  const { width, height, data } = frame;
  const n = width * height;
  if (n === 0) return null;

  const clear = (i: number) => data[i * 4 + 3] < CLEAR;

  // --- 1. 外側の透明を塗る ---
  const outside = new Uint8Array(n);
  const stack = new Int32Array(n);
  let top = 0;
  const push = (i: number) => {
    if (!outside[i] && clear(i)) {
      outside[i] = 1;
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

  // --- 2. 残った透明の島から、いちばん大きいものを選ぶ ---
  const seen = new Uint8Array(n);
  let best = { size: 0, x0: 0, y0: 0, x1: 0, y1: 0 };

  for (let start = 0; start < n; start++) {
    if (seen[start] || outside[start] || !clear(start)) continue;
    let size = 0;
    let x0 = width;
    let y0 = height;
    let x1 = -1;
    let y1 = -1;
    top = 0;
    seen[start] = 1;
    stack[top++] = start;
    while (top > 0) {
      const i = stack[--top];
      const x = i % width;
      const y = (i - x) / width;
      size++;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
      const visit = (j: number) => {
        if (!seen[j] && !outside[j] && clear(j)) {
          seen[j] = 1;
          stack[top++] = j;
        }
      };
      if (x > 0) visit(i - 1);
      if (x < width - 1) visit(i + 1);
      if (i >= width) visit(i - width);
      if (i < n - width) visit(i + width);
    }
    if (size > best.size) best = { size, x0, y0, x1, y1 };
  }

  if (best.size < n * MIN_AREA) return null;

  const w = best.x1 - best.x0 + 1;
  const h = best.y1 - best.y0 + 1;
  return {
    cx: (best.x0 + w / 2) / width,
    cy: (best.y0 + h / 2) / height,
    rx: w / 2 / width,
    ry: h / 2 / height,
  };
}

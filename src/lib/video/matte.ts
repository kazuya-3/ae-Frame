/**
 * コマごとの「どこが残ってどこが消えるか」（＝マット）を持ち、
 * それを使って絵を組み立てる。
 *
 * ── なぜマットだけを持つのか ──
 *
 * 10秒・24コマ/秒の動画は 240 枚ある。仕上がりの絵をそのまま全部持つと
 * 1280×720×4バイト×240 で 880MB になり、スマホでは即座に落ちる。
 *
 * そこで持つのは「濃さ1枚ぶん（1バイト）」だけ、しかも小さめの解像度にする。
 * 512×288 なら 1コマ 147KB、240 コマで 35MB。これなら持てる。
 *
 * 元の絵は、見せるときも書き出すときも <video> から取り直す。
 * マットは拡大して重ねる。輪郭は拡大でなめらかになるので、
 * 小さく持っていることは見た目の不利にならない（むしろジャギーが減る）。
 *
 * ── 仕上げを「あとから」かけている理由 ──
 *
 * フチを削る・ぼかす・フチの色を抜く、は AI の結果を書き換えるのではなく、
 * 見せる直前・書き出す直前にかける。だから、つまみを動かした瞬間に
 * 絵が変わる。もう一度 AI を走らせる必要がない（240コマぶんの待ち時間が
 * つまみ1つで発生する、ということが起きない）。
 */
import { blurAlpha, erodeAlpha } from '../cutout';

export type Matte = {
  width: number;
  height: number;
  /** 0..255。255 が残る側 */
  data: Uint8ClampedArray;
};

export type MatteTrack = {
  /** 時刻の順にならんだマット */
  frames: Matte[];
  /** frames[i] の時刻（秒） */
  times: number[];
  startSec: number;
  endSec: number;
  fps: number;
  /** 使った消しかた（画面に出す言葉を決めるのに使う） */
  engine: 'ai' | 'color' | 'keep' | 'glow';
  /** 光を残したか。渡す先での置きかたが変わるので、保存の画面まで持っていく */
  glow: boolean;
};

export type Refine = {
  /** 0..100 うっすら残ったところを、消すか残すか */
  threshold: number;
  /** -6..6 px フチを削る（＋）／太らせる（−） */
  choke: number;
  /** 0..6 px フチのぼかし */
  feather: number;
  /** 0..100 フチに残った背景の色を抜く */
  decontaminate: number;
};

export const DEFAULT_REFINE: Refine = {
  threshold: 50,
  choke: 0,
  feather: 0.8,
  decontaminate: 45,
};

export type BackdropKind = 'none' | 'green' | 'white' | 'black' | 'color' | 'blur' | 'image';

export type Backdrop = {
  kind: BackdropKind;
  /** color のときに使う */
  color: string;
  /** image のときに使う */
  image: CanvasImageSource | null;
};

export const GREEN = '#00b140'; // 放送で使われる標準的なグリーン

export type Look = {
  refine: Refine;
  backdrop: Backdrop;
  /** 影をうっすら落とす（重ねたときに浮かない） */
  shadow: number; // 0..100
  /** 背景を消す前の色かぶり（フチの色抜きに使う背景色） */
  bgColor: [number, number, number];
};

/* ---------------- マットの取り出し ---------------- */

/** その時刻にいちばん近いマットを返す。 */
export function matteAt(
  track: MatteTrack,
  timeSec: number,
): { matte: Matte; index: number } | null {
  if (!track.frames.length) return null;
  const rel = timeSec - track.startSec;
  const i = Math.round(rel * track.fps);
  const index = Math.max(0, Math.min(track.frames.length - 1, i));
  return { matte: track.frames[index], index };
}

/* ---------------- ゆれをおさえる ---------------- */

/**
 * 前のコマとくらべて、動いていないところの濃さをそろえる。
 *
 * AI は1コマずつ独立に見るので、止まっているはずのフチが
 * コマごとに 1〜2px 揺れる。静止画では気づかないが、動かすと
 * 輪郭がチリチリ震えて見える（これが「AI 切り抜きっぽさ」の正体）。
 *
 * 大きく変わったところ（本当に動いた場所）はそのまま通し、
 * わずかしか変わっていないところだけ前の値に寄せる。
 * 動きを鈍らせずに、震えだけを止められる。
 */
export function stabilize(prev: Uint8ClampedArray, cur: Uint8ClampedArray, strength: number) {
  if (strength <= 0) return cur;
  const k = Math.min(0.9, strength / 100) * 0.85;
  // ここを超える差は「動いた」とみなして手を付けない
  const moved = 26;
  for (let i = 0; i < cur.length; i++) {
    const d = cur[i] - prev[i];
    if (d < moved && d > -moved) cur[i] = prev[i] + d * (1 - k);
  }
  return cur;
}

/* ---------------- 仕上げ ---------------- */

/** しきい値・フチ削り・ぼかしを、小さいマットの上でかける。 */
export function refineMatte(matte: Matte, refine: Refine): Uint8ClampedArray {
  const out = new Uint8ClampedArray(matte.data);

  /*
    「のこす量」は、切る位置ではなく**曲線**で当てる。

    しきい値でばっさり切る作りにすると、髪・毛・光のふちが階段状になり、
    しかも「完全に残っているところ」まで一緒に薄くなってしまう。
    ここでは濃さ a を a^g に写すので、

      0 は 0 のまま、1 は 1 のまま、動くのは中間（＝ふち）だけ

    になる。50 のとき g=1（素通し）、上げると中間が濃く残り、
    下げると中間が消える。つまみの真ん中で何も起きないので、
    「触らなければ元のまま」が保証される。
  */
  const t = refine.threshold;
  if (t !== 50) {
    const g = Math.pow(2, (50 - t) / 25);
    const lut = new Uint8ClampedArray(256);
    for (let v = 0; v < 256; v++) lut[v] = Math.round(255 * Math.pow(v / 255, g));
    for (let i = 0; i < out.length; i++) out[i] = lut[out[i]];
  }

  if (refine.choke > 0) erodeAlpha(out, matte.width, matte.height, refine.choke);
  else if (refine.choke < 0) dilateAlpha(out, matte.width, matte.height, -refine.choke);
  if (refine.feather > 0) blurAlpha(out, matte.width, matte.height, refine.feather);

  return out;
}

/** erodeAlpha の逆。フチを外へ太らせる（消えすぎたときの戻し）。 */
function dilateAlpha(alpha: Uint8ClampedArray, width: number, height: number, radius: number) {
  const r = Math.round(radius);
  if (r <= 0) return alpha;
  const tmp = new Uint8ClampedArray(alpha.length);
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      let m = 0;
      for (let k = -r; k <= r; k++) {
        const v = alpha[row + Math.min(width - 1, Math.max(0, x + k))];
        if (v > m) m = v;
      }
      tmp[row + x] = m;
    }
  }
  for (let x = 0; x < width; x++) {
    for (let y = 0; y < height; y++) {
      let m = 0;
      for (let k = -r; k <= r; k++) {
        const v = tmp[Math.min(height - 1, Math.max(0, y + k)) * width + x];
        if (v > m) m = v;
      }
      alpha[y * width + x] = m;
    }
  }
  return alpha;
}

/* ---------------- 絵を組み立てる ---------------- */

/**
 * マットを「アルファだけの画像」にして canvas に載せる。
 * これを destination-in で重ねると、GPU 側で切り抜きが済む。
 */
export class MatteCanvas {
  private canvas = document.createElement('canvas');
  private ctx = this.canvas.getContext('2d')!;
  private key = '';

  get element() {
    return this.canvas;
  }

  update(matte: Matte, refine: Refine, cacheKey: string) {
    if (cacheKey && cacheKey === this.key) return this.canvas;
    this.key = cacheKey;
    if (this.canvas.width !== matte.width || this.canvas.height !== matte.height) {
      this.canvas.width = matte.width;
      this.canvas.height = matte.height;
    }
    const alpha = refineMatte(matte, refine);
    const img = this.ctx.createImageData(matte.width, matte.height);
    const px = img.data;
    for (let i = 0, j = 0; i < alpha.length; i++, j += 4) {
      // 色は使わない。透明度だけを持つ板をつくる
      px[j] = 255;
      px[j + 1] = 255;
      px[j + 2] = 255;
      px[j + 3] = alpha[i];
    }
    this.ctx.putImageData(img, 0, 0);
    return this.canvas;
  }
}

export type RenderOptions = {
  /** 切り抜き前の絵 */
  image: CanvasImageSource;
  matteCanvas: HTMLCanvasElement | null;
  look: Look;
  width: number;
  height: number;
};

/**
 * 切り抜いた絵を1枚組み立てる。
 * 画面の中も、書き出しも、通る道はここ1本にしてある
 * （見えている絵と保存される絵が食い違わないように）。
 */
export function renderComposite(ctx: CanvasRenderingContext2D, opts: RenderOptions) {
  const { image, matteCanvas, look, width, height } = opts;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = 1;
  ctx.filter = 'none';
  ctx.clearRect(0, 0, width, height);

  /* 1. 元の絵を置いて、マットで抜く */
  ctx.drawImage(image, 0, 0, width, height);
  if (matteCanvas) {
    ctx.globalCompositeOperation = 'destination-in';
    ctx.drawImage(matteCanvas, 0, 0, width, height);
    ctx.globalCompositeOperation = 'source-over';
  }

  /* 2. フチに残った背景の色を抜く */
  if (look.refine.decontaminate > 0 && matteCanvas) {
    decontaminate(ctx, width, height, look.bgColor, look.refine.decontaminate / 100);
  }

  /* 3. 影。うしろに敷くので、切り抜きの形を保ったまま置ける */
  if (look.shadow > 0) {
    const s = look.shadow / 100;
    const layer = ctx.canvas;
    // 1コマごとに canvas を作ると、書き出し中に何百枚も捨てることになる
    const shade = scratch(width, height);
    const sctx = shade.getContext('2d')!;
    sctx.clearRect(0, 0, width, height);
    sctx.globalCompositeOperation = 'source-over';
    sctx.drawImage(layer, 0, 0);
    // 影は「黒い自分自身」。ぼかして、少し下にずらす
    sctx.globalCompositeOperation = 'source-in';
    sctx.fillStyle = `rgba(0,0,0,${0.55 * s})`;
    sctx.fillRect(0, 0, width, height);

    ctx.globalCompositeOperation = 'destination-over';
    ctx.filter = `blur(${Math.max(2, Math.round(height * 0.02 * s))}px)`;
    ctx.drawImage(shade, 0, Math.round(height * 0.012 * s));
    ctx.filter = 'none';
    ctx.globalCompositeOperation = 'source-over';
  }

  /* 4. 背景。切り抜きのうしろに回して敷く */
  const bd = look.backdrop;
  if (bd.kind !== 'none') {
    ctx.globalCompositeOperation = 'destination-over';
    if (bd.kind === 'blur') {
      // 元の絵そのものをぼかして敷く。SNS にそのまま上げるときの定番
      ctx.filter = `blur(${Math.max(6, Math.round(Math.min(width, height) * 0.04))}px)`;
      const grow = 1.12; // ぼかしの端が白く抜けないよう、少し大きく描く
      ctx.drawImage(
        image,
        (width * (1 - grow)) / 2,
        (height * (1 - grow)) / 2,
        width * grow,
        height * grow,
      );
      ctx.filter = 'none';
    } else if (bd.kind === 'image' && bd.image) {
      drawCover(ctx, bd.image, width, height);
    } else {
      ctx.fillStyle = backdropColor(bd);
      ctx.fillRect(0, 0, width, height);
    }
    ctx.globalCompositeOperation = 'source-over';
  }
}

/** 影づくりに使う作業用の canvas。大きさが同じあいだは使いまわす */
let scratchCanvas: HTMLCanvasElement | null = null;
function scratch(width: number, height: number) {
  if (!scratchCanvas) scratchCanvas = document.createElement('canvas');
  if (scratchCanvas.width !== width || scratchCanvas.height !== height) {
    scratchCanvas.width = width;
    scratchCanvas.height = height;
  }
  return scratchCanvas;
}

export function backdropColor(bd: Backdrop) {
  switch (bd.kind) {
    case 'green':
      return GREEN;
    case 'white':
      return '#ffffff';
    case 'black':
      return '#000000';
    default:
      return bd.color;
  }
}

/** 縦横比を保ったまま、はみ出させて全面を埋める。 */
export function drawCover(
  ctx: CanvasRenderingContext2D,
  image: CanvasImageSource,
  width: number,
  height: number,
) {
  const iw = imgWidth(image);
  const ih = imgHeight(image);
  if (!iw || !ih) return;
  const scale = Math.max(width / iw, height / ih);
  const w = iw * scale;
  const h = ih * scale;
  ctx.drawImage(image, (width - w) / 2, (height - h) / 2, w, h);
}

function imgWidth(image: CanvasImageSource): number {
  const any = image as { width?: number; videoWidth?: number; displayWidth?: number };
  return any.displayWidth ?? any.videoWidth ?? any.width ?? 0;
}
function imgHeight(image: CanvasImageSource): number {
  const any = image as { height?: number; videoHeight?: number; displayHeight?: number };
  return any.displayHeight ?? any.videoHeight ?? any.height ?? 0;
}

/**
 * フチに残った背景の色を抜く。
 *
 * ── 2つのことを、ひとつのつまみでやっている ──
 *
 * (1) 半透明の画素から、背景の色を引き算する
 *
 * 半透明の画素は「前景 × a ＋ 背景 ×(1−a)」で出来ている。
 * 背景の色が分かっているなら、その分を引けば前景の色が戻る。
 *
 *   前景 =（見えている色 − 背景 ×(1−a)）÷ a
 *
 * これをやらないと、暗い場所で撮ったものは輪郭に黒いふちが残り、
 * 白い画面に置いたときだけ「切り抜きました」という顔になる。
 *
 * (2) 不透明な画素に乗った「色かぶり」を抑える
 *
 * グリーンバックでは、これだけでは足りなかった。
 * 緑の地は光を反射するので、**被写体のフチそのものが緑に染まる**。
 * そこは半透明ではなく不透明なので、(1) は手を出さない。
 * 動画では圧縮（色情報を間引く方式）がさらに緑をにじませる。
 *
 * 結果、切り抜きの縁だけ緑に光る。実際、検証用の緑素材で目に見えて出た。
 *
 * 放送の現場で使われている考えかたは単純で、
 * **「緑が、赤と青の平均を超えている分だけ削る」**。
 * 緑の服や緑のぬいぐるみは、赤と青も一緒に持っているので生き残る。
 *
 * ── 地が緑や青のときだけ働く ──
 *
 * 暗いスタジオ撮りのような無彩色の地では、削るべき色かぶりが無い。
 * そこで働かせると、ただ色を濁らせるだけになる。地の色を見て決める。
 */
export function decontaminate(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  bg: [number, number, number],
  strength: number,
) {
  const img = ctx.getImageData(0, 0, width, height);
  const px = img.data;
  const spill = spillChannel(bg);

  for (let j = 0; j < px.length; j += 4) {
    const a = px[j + 3] / 255;
    if (a <= 0.02) continue;

    if (a < 0.98) {
      for (let c = 0; c < 3; c++) {
        const v = px[j + c];
        const fixed = (v - bg[c] * (1 - a)) / a;
        px[j + c] = v + (fixed - v) * strength;
      }
    }

    if (spill !== null) {
      // 抜きたい色の「ほかの2色の平均より出っぱっている分」を削る
      const other = (px[j + spill.other[0]] + px[j + spill.other[1]]) / 2;
      const over = px[j + spill.index] - other;
      if (over > 0) px[j + spill.index] -= over * strength;
    }
  }
  ctx.putImageData(img, 0, 0);
}

/**
 * その地は「クロマキー」か。緑（グリーンバック）と青（ブルーバック）だけを見る。
 *
 * ここが分かると、扱いを2つ変えられる。
 *   ・境目の幅を広く取る（圧縮でにじんだフチを、半透明として拾うため）
 *   ・不透明な画素の色かぶりを削る（緑の照り返しを落とすため）
 *
 * 無彩色の地（暗いスタジオ撮り）では、どちらも要らない。
 */
export function chromaChannel(
  bg: [number, number, number],
): { index: number; other: [number, number] } | null {
  const [r, g, b] = bg;
  if (g > 60 && g > r * 1.3 && g > b * 1.3) return { index: 1, other: [0, 2] };
  if (b > 60 && b > r * 1.3 && b > g * 1.3) return { index: 2, other: [0, 1] };
  return null;
}

const spillChannel = chromaChannel;

/**
 * フチの色抜きに使う「背景の色」を、消えた側の画素から推定する。
 * 消えた側（マットがほぼ 0）の平均色が、そのまま背景の色になる。
 */
export function estimateBackgroundColor(
  frame: ImageData,
  matte: Uint8ClampedArray,
): [number, number, number] {
  let r = 0;
  let g = 0;
  let b = 0;
  let n = 0;
  const px = frame.data;
  for (let i = 0; i < matte.length; i++) {
    if (matte[i] > 12) continue;
    const j = i * 4;
    r += px[j];
    g += px[j + 1];
    b += px[j + 2];
    n++;
  }
  if (!n) return [0, 0, 0];
  return [Math.round(r / n), Math.round(g / n), Math.round(b / n)];
}

/** 仕上げの設定が同じかどうかを見分ける鍵。同じなら作り直さない */
export function refineKey(refine: Refine) {
  return `${refine.threshold}|${refine.choke}|${refine.feather}`;
}

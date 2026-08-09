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

import { cropImageData } from './image';

export type CutoutMode = 'auto' | 'color' | 'ai' | 'none';

export type CutoutSettings = {
  mode: CutoutMode;
  /** 背景色とみなす色（color モードで使用） */
  keyColor: [number, number, number];
  /** 0..1 これ以下の色差は背景 */
  tolerance: number;
  /** 0..1 背景と前景の境目のなめらかさ。広いほど、光のにじみが残る */
  softness: number;
  /**
   * 外につながっていない背景色を、デザインの一部として守る。
   * 提灯の白紙・狐面の白・泡の内側などが消えなくなるので既定は true。
   */
  protectEnclosed: boolean;
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
  // 境目は最小から始める。広げるのはグローがあると分かったときだけ（analyze を参照）。
  softness: 0.01,
  protectEnclosed: true,
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
  /** 自動で決めた境目の幅（グローや水彩のにじみがあるほど広い） */
  suggestedSoftness: number;
  /** 背景へ溶けていく階調（ネオンの光・水彩のぼかし）を含んでいるか */
  hasGlow: boolean;
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
      suggestedSoftness: DEFAULT_SETTINGS.softness,
      hasGlow: false,
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

  /*
    画像全体の「背景色からの距離」のヒストグラムを取る。
    しきい値も境目の幅も、ここから読む。

    以前は縁のばらつきに固定の余裕（+0.035）を足していたが、これが原因で
    うすい水色の水しぶき（白との差 0.056 ほど）を持つフレームが、初期状態で
    ごっそり消えていた。デザインの薄い色と、余裕の幅が同じくらいだったため。
  */
  const BINS = 256; // 1階級 = 0.0039
  const hist = new Int32Array(BINS);
  // 全画素を見る必要はない。3画素おきで形は十分わかる。
  let counted = 0;
  for (let i = 0; i < total; i += 3) {
    const j = i * 4;
    if (px[j + 3] < 128) continue;
    const d = colorDistance(px[j], px[j + 1], px[j + 2], borderColor);
    hist[Math.min(BINS - 1, Math.floor(d * BINS))]++;
    counted++;
  }

  /*
    背景の山がどこで終わるかを探す。

    背景は距離 0 付近に鋭い山を作る。そこから外へ歩いて、度数が山の 2% を
    下回ったところが「背景の終わり」。JPEG のノイズで山が広がっていれば
    しきい値も自然に広がるし、背景がきれいなら極端に小さくなる。
  */
  let peak = 0;
  for (let b = 0; b < 12; b++) peak = Math.max(peak, hist[b]);
  const floorCount = Math.max(peak * 0.02, counted * 0.00005);

  let end = 0;
  while (end < BINS && hist[end] > floorCount) end++;
  const bgEnd = end / BINS;

  /*
    しきい値は「背景の山の外」に置く。縁の実測（98パーセンタイル）も下回らせない。
    消え残りはスライダーでも筆でも直せるが、消えた絵は気づきにくく戻しにくいので、
    迷ったら小さい側に倒す。
  */
  const suggestedTolerance = Math.min(
    0.25,
    Math.max(0.008, Math.max(bgEnd + 0.004, p(0.98) + 0.004)),
  );

  /*
    グロー（背景へ溶けていく階調）があるかを、ヒストグラムの形で見分ける。

    ネオンの光や水彩のにじみは、距離が連続的に変化するので中間の階調が
    「広く薄く」散らばる。うすい色のベタ塗りは同じ距離に固まる。
    つまり "中間の階調がいくつの階級にまたがっているか" で両者を分けられる。
  */
  const loBin = Math.floor(suggestedTolerance * BINS) + 1;
  const hiBin = Math.floor(0.4 * BINS);
  let glowBins = 0;
  for (let b = loBin; b < hiBin; b++) {
    // ここを低くすると、輪郭のアンチエイリアスだけでグローと誤判定する。
    // 「面として広がっている」と言える量（画素の0.15%）を1階級の下限にする。
    if (hist[b] > counted * 0.0015) glowBins++;
  }
  // うすい色を何色か使ったデザインは、距離が数か所に固まるので階級は埋まらない。
  // グローは連続的に変化するので、広い範囲の階級が埋まる。
  const hasGlow = glowBins >= 32;

  /*
    境目の幅。

    グローがあるときだけ広く取って、光を階調のまま残す。それ以外は最小に固定する。

    以前は「背景の終わり」から「絵の色が始まる位置」までの隙間から計算していたが、
    実測すると線画・祭・金魚・スクショのどれもが上限（0.2）に張り付いていた。
    その範囲には画素が1つも無いので何も起きておらず、効いていないのに大きい値が
    出ている状態だった。そのうえ、たまたまその範囲に色があるデザインが来ると、
    理由もなく半透明にしてしまう。

    境目のギザギザは、別に用意した「フチのギザギザをとる」（feather）が均す。
    ここを広げて誤魔化す必要はない。
  */
  const suggestedSoftness = hasGlow ? 0.3 : 0.01;

  /*
    どの手法から始めるかは、縁の様子では決めない。

    以前は「縁の色がばらついていたら AI」にしていたが、これはネオンのグローで
    簡単に騙される。光が画像のふちまで届いていると、縁がばらついて見えるからだ。
    そのせいで、色キーできれいに抜けるフレームまで AI に回り、
    数十MBのダウンロードを強いたうえに、細い線は AI のほうが鈍る。

    いまは常に色キーから始め、"出した結果を検算して" 駄目なら AI に回す
    （measureQuality を参照）。推測より結果を見るほうが当たる。
  */
  const recommended: Exclude<CutoutMode, 'auto'> = hasAlpha ? 'none' : 'color';

  return {
    hasAlpha,
    borderColor,
    borderSpread,
    recommended,
    suggestedTolerance,
    suggestedSoftness,
    hasGlow,
  };
}

/**
 * 単色背景キーでアルファを作る。
 *
 * 素の色キーは「同じ色の画素を全部消す」なので、アイコンフレームには
 * そのままでは使えない。提灯の白紙、狐面の白、白い泡のような
 * "デザインの一部としての背景色" まで穴が開いてしまうため。
 * 既定では下の `protectEnclosed` で、外につながっていない背景色を守る。
 */
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

  if (s.protectEnclosed) protectEnclosed(alpha, width, height, expectsGradients(s));
  return alpha;
}

/**
 * このデザインは「背景へ溶けていく階調」を持っているか。
 *
 * 境目の幅そのものが、その答えになっている。analyze はグローを見つけたときだけ
 * 幅を広げるし、ユーザーが手で広げたのなら、それは「にじみを残したい」という意思表示。
 * どちらの場合も、囲まれた部分の扱いを控えめにする必要がある（protectEnclosed 参照）。
 */
function expectsGradients(s: CutoutSettings) {
  return s.softness >= 0.08;
}

/**
 * 背景の塗りつぶしが通れる不透明度の上限。
 *
 * ここを 250 のように高くすると、うすい水色のリング（消し残しアルファ 225 など）を
 * 塗りつぶしがすり抜けてしまい、その内側の白い泡まで背景と判定されて消える。
 * 「明らかに背景」と言える画素だけを通し、半分でも残っている絵は壁として扱う。
 */
const FLOOD_TRAVEL = 128;

/**
 * 背景の塗りつぶしが届く範囲を求める。
 *
 * 種は2か所から蒔く。
 *  - 画像の四辺 … 外側の背景
 *  - 画像の中心 … リング状フレームの「まん中の穴」。ここが抜けていないと
 *                 重ねたときにアイコン写真が隠れてしまう
 *
 * 中心の種は、中心付近がほんとうに背景色のときだけ蒔く。中心まで絵が
 * 詰まっているデザインを食い破らないための歯止め。
 */
function floodBackground(alpha: Uint8ClampedArray, width: number, height: number): Uint8Array {
  const n = width * height;
  const reachable = new Uint8Array(n);
  const stack = new Int32Array(n);
  let top = 0;

  const push = (i: number) => {
    if (alpha[i] < FLOOD_TRAVEL && !reachable[i]) {
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

  // --- 中心が「穴」かどうかを確かめてから種を蒔く ---
  const cx = width / 2;
  const cy = height / 2;
  const r = Math.min(width, height) * 0.07;
  let hole = 0;
  let total = 0;
  for (let y = Math.max(0, Math.floor(cy - r)); y < Math.min(height, cy + r); y++) {
    for (let x = Math.max(0, Math.floor(cx - r)); x < Math.min(width, cx + r); x++) {
      if (Math.hypot(x - cx, y - cy) > r) continue;
      total++;
      if (alpha[y * width + x] < 128) hole++;
    }
  }
  if (total > 0 && hole / total > 0.6) {
    for (let y = Math.max(0, Math.floor(cy - r)); y < Math.min(height, cy + r); y++) {
      for (let x = Math.max(0, Math.floor(cx - r)); x < Math.min(width, cx + r); x++) {
        if (Math.hypot(x - cx, y - cy) <= r) push(y * width + x);
      }
    }
  }

  while (top > 0) {
    const i = stack[--top];
    const x = i % width;
    if (x > 0) push(i - 1);
    if (x < width - 1) push(i + 1);
    if (i >= width) push(i - width);
    if (i < n - width) push(i + width);
  }
  return reachable;
}

/**
 * 外側にも中心の穴にもつながっていない背景色を、デザインの一部として復活させる。
 *
 * これがあるおかげで、提灯の白紙・狐面の白・泡の内側が残る。
 * 逆に、外周のグロー（白地に溶ける光のにじみ）は外につながっているので、
 * 色キーが付けたやわらかいアルファのまま残る＝光が死なない。
 */
export function applyProtectEnclosed(
  alpha: Uint8ClampedArray,
  width: number,
  height: number,
  preserveGradients = false,
): Uint8ClampedArray {
  const out = new Uint8ClampedArray(alpha);
  protectEnclosed(out, width, height, preserveGradients);
  return out;
}

function protectEnclosed(
  alpha: Uint8ClampedArray,
  width: number,
  height: number,
  preserveGradients: boolean,
) {
  /*
    どこまで戻すかは、そのデザインが階調を持っているかで変える。

    階調がない（線画・ベタ塗り）なら、囲まれた部分は迷わず完全な不透明に戻す。
    境目の幅を狭くすると、提灯の紙のような "背景色にごく近い色" は
    アルファ 0 ではなく中途半端な値（184 など）で止まる。ここで戻し切らないと、
    紙がうっすら透けたままになる。

    階調があるなら控えめにする。グローは外の背景とつながっているが、
    濃い側は塗りつぶしが入れないので「囲まれている」と判定される。
    そこを一律に戻すと、せっかくの光がのっぺりした輪に潰れる。
  */
  const restoreBelow = preserveGradients ? FLOOD_TRAVEL : 255;
  const reachable = floodBackground(alpha, width, height);
  for (let i = 0; i < alpha.length; i++) {
    if (!reachable[i] && alpha[i] < restoreBelow) alpha[i] = 255;
  }
}

/**
 * これを超える断片数は「粉々になった」とみなす。
 * うまく抜けたフレームは実測 1〜3 個、失敗したものは 110 個だった。
 * 飾りの多いデザインのために、健全側へ十分な余裕を取ってある。
 */
const FRAGMENT_LIMIT = 60;

export type CutoutQuality = {
  /** 残った絵の面積比 0..1 */
  coverage: number;
  /** ばらばらになった断片の数 */
  fragments: number;
  /** 四隅のうち、透明になりきらなかった数 0..4 */
  opaqueCorners: number;
  /** この結果は失敗している可能性が高い */
  suspicious: boolean;
};

/**
 * 出した結果を自分で検算する。
 *
 * 白いガラスを白地に描いたようなデザインは、色だけでは背景と区別できず、
 * 絵がほとんど消えるか、粉々の断片になる。そうなっていたら AI に回す。
 */
export function measureQuality(
  alpha: Uint8ClampedArray,
  width: number,
  height: number,
): CutoutQuality {
  const n = width * height;
  let opaque = 0;
  for (let i = 0; i < n; i++) if (alpha[i] > 128) opaque++;
  const coverage = opaque / n;

  // 不透明部分の連結成分を数える（小さすぎる粒は無視）
  const seen = new Uint8Array(n);
  const stack = new Int32Array(n);
  const minSize = Math.max(24, Math.round(n * 0.00004));
  let fragments = 0;

  for (let start = 0; start < n; start++) {
    if (seen[start] || alpha[start] <= 128) continue;
    let top = 0;
    let size = 0;
    seen[start] = 1;
    stack[top++] = start;
    while (top > 0) {
      const i = stack[--top];
      size++;
      const x = i % width;
      if (x > 0 && !seen[i - 1] && alpha[i - 1] > 128) {
        seen[i - 1] = 1;
        stack[top++] = i - 1;
      }
      if (x < width - 1 && !seen[i + 1] && alpha[i + 1] > 128) {
        seen[i + 1] = 1;
        stack[top++] = i + 1;
      }
      if (i >= width && !seen[i - width] && alpha[i - width] > 128) {
        seen[i - width] = 1;
        stack[top++] = i - width;
      }
      if (i < n - width && !seen[i + width] && alpha[i + width] > 128) {
        seen[i + width] = 1;
        stack[top++] = i + width;
      }
    }
    if (size >= minSize) fragments++;
  }

  /*
    いちばん素直な物差しは「四隅が透明になったか」。

    アイコンフレームは丸いので、四隅はまず間違いなく背景。そこが残っているなら、
    背景を消せていないと断言できる。ざらざらした背景や写真の上に置かれたフレームは、
    面積比も断片数も中途半端な値になって他の物差しをすり抜けるが、
    四隅を見れば一発で分かる。
  */
  const probe = Math.max(4, Math.round(Math.min(width, height) * 0.02));
  const cornerMean = (cx: number, cy: number) => {
    let sum = 0;
    let count = 0;
    for (let y = cy; y < cy + probe; y++) {
      for (let x = cx; x < cx + probe; x++) {
        sum += alpha[y * width + x];
        count++;
      }
    }
    return count ? sum / count : 0;
  };
  const corners = [
    cornerMean(0, 0),
    cornerMean(width - probe, 0),
    cornerMean(0, height - probe),
    cornerMean(width - probe, height - probe),
  ];
  const opaqueCorners = corners.filter((v) => v > 100).length;

  /*
    失敗している形。

    1. 四隅が残った … 背景を消せていない（背景が単色でない、写真の上、など）
    2. 絵がほぼ消えた … 白いガラスを白地に描いたようなデザイン
    3. 全部残った   … 何も消えていない
    4. 粉々になった … 絵と背景が入り混じって、断片だらけ

    細い線画は面積が小さいので、面積比だけで失敗と決めつけてはいけない
    （細くても「ひとつながり」なら、きれいに抜けている）。
    実測すると、うまくいったフレームの断片は 1〜3 個。
    ざらざらの背景で失敗したときは 110 個だった。境目はその間に置いている。
  */
  const suspicious =
    opaqueCorners >= 2 || coverage < 0.006 || coverage > 0.75 || fragments > FRAGMENT_LIMIT;
  return { coverage, fragments, opaqueCorners, suspicious };
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
  // AI の境界は色キーほど背景色を巻き込まないので、引き算も控えめでいい。
  // 'none'（すでに透過ずみ）では、初期値そのものを 0 にしてある。
  // 付いていない背景色を引き算すると、正しかったグローの色まで沈むため。
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

    /*
      半透明の画素に残った背景色を引き算する。
      観測色 C = a·F + (1-a)·背景 を F について解く、いわゆる逆合成。

      白フチが消えるだけでなく、ネオンのグローや水彩のにじみが
      「うすい水色」ではなく「本来の色を薄く重ねたもの」になるので、
      暗い写真の上に重ねても色がくすまない。

      ただし a が小さいほど割り算で誤差が暴れる。ごく薄いところでは
      効きを弱めて、ノイズが色として浮き上がるのを防ぐ。
    */
    if (decon > 0 && a > 3 && a < 250) {
      const af = a / 255;
      const taper = Math.min(1, a / 48);
      const k = decon * taper;
      const ur = (r - (1 - af) * kr) / af;
      const ug = (g - (1 - af) * kg) / af;
      const ub = (b - (1 - af) * kb) / af;
      r += (ur - r) * k;
      g += (ug - g) * k;
      b += (ub - b) * k;
    }

    dst[j] = r;
    dst[j + 1] = g;
    dst[j + 2] = b;
    dst[j + 3] = a;
  }

  return out;
}

/**
 * スクリーンショットから、フレームだけを切り出す。
 *
 * TikTok は透過を持てないので、フレームは動画や画像として配信され、
 * 受け取る側はスクショを撮る。そこには必ず余計なものが写り込む
 * ——時刻、ユーザー名、キャプション、右側のボタン列、上下の余白。
 *
 * そのまま透過すると、フレーム本体はキャンバスの片隅の小さな輪になり、
 * UI の文字やアイコンが点々と残った、使えない画像になる。
 *
 * ここでは「いちばん大きなかたまり＝フレーム本体」を見つけ、その近くにある
 * ものだけを残して切り出す。フレームに寄り添う飾り（きらめき、破片、提灯）は
 * 本体のすぐそばにあるので残り、画面の端にある UI は落ちる。
 */
export function findSubjectRect(
  alpha: Uint8ClampedArray,
  width: number,
  height: number,
): { x: number; y: number; width: number; height: number } | null {
  const n = width * height;
  const seen = new Uint8Array(n);
  const stack = new Int32Array(n);
  const minSize = Math.max(64, Math.round(n * 0.0002));

  type Box = { x0: number; y0: number; x1: number; y1: number; size: number };
  const boxes: Box[] = [];

  for (let start = 0; start < n; start++) {
    if (seen[start] || alpha[start] <= 128) continue;
    let top = 0;
    seen[start] = 1;
    stack[top++] = start;
    const b: Box = {
      x0: width,
      y0: height,
      x1: -1,
      y1: -1,
      size: 0,
    };
    while (top > 0) {
      const i = stack[--top];
      const x = i % width;
      const y = (i - x) / width;
      b.size++;
      if (x < b.x0) b.x0 = x;
      if (x > b.x1) b.x1 = x;
      if (y < b.y0) b.y0 = y;
      if (y > b.y1) b.y1 = y;
      if (x > 0 && !seen[i - 1] && alpha[i - 1] > 128) {
        seen[i - 1] = 1;
        stack[top++] = i - 1;
      }
      if (x < width - 1 && !seen[i + 1] && alpha[i + 1] > 128) {
        seen[i + 1] = 1;
        stack[top++] = i + 1;
      }
      if (i >= width && !seen[i - width] && alpha[i - width] > 128) {
        seen[i - width] = 1;
        stack[top++] = i - width;
      }
      if (i < n - width && !seen[i + width] && alpha[i + width] > 128) {
        seen[i + width] = 1;
        stack[top++] = i + width;
      }
    }
    if (b.size >= minSize) boxes.push(b);
  }

  if (!boxes.length) return null;

  const main = boxes.reduce((a, b) => (b.size > a.size ? b : a));
  // 本体が小さすぎるときは、たまたま残ったゴミを掴んでいる可能性が高い。触らない。
  if (main.size < n * 0.004) return null;

  const mainW = main.x1 - main.x0;
  const mainH = main.y1 - main.y0;

  /*
    どの塊を一緒に残すかを、2つの物差しで決める。

    1. 本体の近くにあること
       フレームに寄り添う飾り（きらめき、破片、提灯）は本体のすぐそばにある。
       距離は画像の大きさではなく "本体の大きさ" に対して測る。
       スクショは画像そのものが縦に長く、画像基準だと物差しが伸びすぎるため。

    2. 画面のふちに貼りついていないこと
       時刻・キャプション・右側のボタン列は、どれも画面の端に寄っている。
       一方フレームは真ん中にあり、端からは離れている。この差で UI を落とせる。
       （本体そのものは、端に触れていてもこの条件では落とさない）
  */
  const near = Math.max(mainW, mainH) * 0.15;
  const chrome = Math.min(width, height) * 0.06;

  // 落とすもの（画面のふちに貼りついた UI）だけを先に決める
  const dropped: Box[] = [];
  let x0 = main.x0;
  let y0 = main.y0;
  let x1 = main.x1;
  let y1 = main.y1;
  for (const b of boxes) {
    if (b === main) continue;
    const isNear =
      b.x0 <= main.x1 + near &&
      b.x1 >= main.x0 - near &&
      b.y0 <= main.y1 + near &&
      b.y1 >= main.y0 - near;
    const hugsEdge =
      b.x0 < chrome || b.y0 < chrome || b.x1 > width - 1 - chrome || b.y1 > height - 1 - chrome;
    if (!isNear || hugsEdge) {
      dropped.push(b);
      continue;
    }
    x0 = Math.min(x0, b.x0);
    y0 = Math.min(y0, b.y0);
    x1 = Math.max(x1, b.x1);
    y1 = Math.max(y1, b.y1);
  }

  /*
    ここまでは「濃い部分（不透明度128超）」だけで測った範囲。
    これをそのまま切ると、うすい水しぶきや細かい泡のような
    "薄いけれどデザインの一部" が枠の外に出て、見切れてしまう。

    そこで、落とすと決めた UI の矩形を避けながら、
    かすかにでも残っている画素（不透明度8超）まで範囲を広げ直す。
  */
  const inDropped = (x: number, y: number) =>
    dropped.some((b) => x >= b.x0 && x <= b.x1 && y >= b.y0 && y <= b.y1);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (alpha[y * width + x] <= 8) continue;
      if (x >= x0 && x <= x1 && y >= y0 && y <= y1) continue;
      if (inDropped(x, y)) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }

  // まわりに余白を足す。グローのような、薄すぎて塊に数えられなかった部分を巻き取るため。
  // ここも本体の大きさ基準。入力が何ピクセルでも、同じ見た目の余白になる。
  const pad = Math.max(x1 - x0, y1 - y0) * 0.045;
  x0 = Math.max(0, Math.floor(x0 - pad));
  y0 = Math.max(0, Math.floor(y0 - pad));
  x1 = Math.min(width - 1, Math.ceil(x1 + pad));
  y1 = Math.min(height - 1, Math.ceil(y1 + pad));

  return { x: x0, y: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 };
}

/** 元画像をそのまま通す（すでに透過済みの画像向け）。 */
export function passthroughAlpha(data: ImageData): Uint8ClampedArray {
  const n = data.width * data.height;
  const alpha = new Uint8ClampedArray(n);
  for (let i = 0; i < n; i++) alpha[i] = data.data[i * 4 + 3];
  return alpha;
}

/**
 * 読み込んだ画像から、フレームらしい部分だけを切り出す。
 *
 * 下読みの透過を一度かけて位置を掴み、切り出してから本番の処理に渡す。
 * 面積があまり変わらないときは「切り取る必要がなかった」とみなして触らない
 * （ふつうのフレーム画像では、ユーザーに何も起きていないように見える）。
 */
export function autoCropToSubject(data: ImageData): { data: ImageData; cropped: boolean } {
  const a = analyze(data);
  const probe: CutoutSettings = {
    ...DEFAULT_SETTINGS,
    mode: a.recommended === 'none' ? 'none' : 'color',
    keyColor: a.borderColor,
    tolerance: a.suggestedTolerance,
    softness: a.suggestedSoftness,
  };
  const alpha = probe.mode === 'none' ? passthroughAlpha(data) : colorKeyAlpha(data, probe);

  const rect = findSubjectRect(alpha, data.width, data.height);
  if (!rect) return { data, cropped: false };

  const ratio = (rect.width * rect.height) / (data.width * data.height);
  if (ratio > 0.72) return { data, cropped: false };

  return { data: cropImageData(data, rect), cropped: true };
}

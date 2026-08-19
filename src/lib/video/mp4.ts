/**
 * MP4 の中身をほどいて、映像のコマ（サンプル）の一覧を取り出す。
 *
 * ── なぜ自前で書いたか ──
 *
 * ブラウザで動画からコマを取り出す方法は2つある。
 *
 *   A. <video> を少しずつ進めて（seek）、そのつど canvas に描き写す
 *   B. WebCodecs の VideoDecoder に、MP4 から取り出したコマを直接わたす
 *
 * A はどこでも動くが、seek 1回につき数十ミリ秒かかるうえ、
 * 「指定した時刻ぴったりのコマ」が返る保証がない。同じコマが2回返ることも、
 * 1コマ飛ぶこともある。止め絵で見ると分からないが、書き出すとカクつく。
 *
 * B は正確で速い。ただし VideoDecoder は「コンテナ（MP4）をほどく」機能を
 * 持っていない。ほどく側は自分で用意することになる。
 * ライブラリを足すこともできたが、必要なのは
 *   ・映像トラックを1本みつける
 *   ・avcC（デコーダの初期化データ）を取り出す
 *   ・サンプルの位置・大きさ・時刻・キーフレームかどうかを並べる
 * の3つだけで、それはこのファイルの分量におさまる。
 *
 * 解けない形（分割された MP4、H.264 以外、そもそも MP4 でない）のときは
 * null を返す。呼ぶ側はそれを見て <video> の道（A）に落ちる。
 * 「解けなかった」は失敗ではなく、ふつうに起こることとして扱う。
 */

export type Mp4Sample = {
  /** ファイル先頭からの位置 */
  offset: number;
  size: number;
  /** 表示時刻（マイクロ秒）。WebCodecs はこの単位で受け取る */
  timestampUs: number;
  durationUs: number;
  /** ここから単独でデコードを始められるコマか */
  key: boolean;
};

export type Mp4Track = {
  /** VideoDecoder.configure にわたす文字列（例: avc1.640028） */
  codec: string;
  /** avcC の中身。H.264 はこれが無いとデコーダを初期化できない */
  description?: Uint8Array;
  width: number;
  height: number;
  durationSec: number;
  /** 復号順にならんだコマ */
  samples: Mp4Sample[];
};

/* ---------------- 箱（box）を歩く ---------------- */

type Box = { type: string; start: number; end: number; body: number };

/**
 * MP4 は「大きさ・名前・中身」の箱が入れ子になっているだけの形式。
 * ここでは、ある範囲の中にならぶ箱を順に返す。
 */
function* boxes(view: DataView, start: number, end: number): Generator<Box> {
  let p = start;
  while (p + 8 <= end) {
    let size = view.getUint32(p);
    const type = str(view, p + 4, 4);
    let body = p + 8;
    if (size === 1) {
      // 4GB を超える箱は 64bit の大きさが後ろに付く
      const hi = view.getUint32(p + 8);
      const lo = view.getUint32(p + 12);
      size = hi * 2 ** 32 + lo;
      body = p + 16;
    } else if (size === 0) {
      size = end - p; // 最後の箱は「残り全部」
    }
    if (size < 8 || p + size > end) return; // 壊れている
    yield { type, start: p, end: p + size, body };
    p += size;
  }
}

function find(view: DataView, start: number, end: number, type: string): Box | null {
  for (const b of boxes(view, start, end)) if (b.type === type) return b;
  return null;
}

function str(view: DataView, at: number, len: number) {
  let s = '';
  for (let i = 0; i < len; i++) s += String.fromCharCode(view.getUint8(at + i));
  return s;
}

/* ---------------- 本体 ---------------- */

export function parseMp4(buffer: ArrayBuffer): Mp4Track | null {
  try {
    return parse(buffer);
  } catch {
    // 途中で形が合わなくなったら、解けなかったものとして扱う
    return null;
  }
}

function parse(buffer: ArrayBuffer): Mp4Track | null {
  const view = new DataView(buffer);
  const end = buffer.byteLength;

  const moov = find(view, 0, end, 'moov');
  if (!moov) return null;

  /*
    分割された MP4（moof を持つもの）は、コマの一覧が moov ではなく
    各 moof の中に散らばっている。配信向けの形で、ここでは扱わない。
    見つけたら早めに諦めて <video> の道にわたす。
  */
  if (find(view, 0, end, 'moof')) return null;

  for (const trak of [...boxes(view, moov.body, moov.end)].filter((b) => b.type === 'trak')) {
    const track = readTrack(view, trak);
    if (track) return track;
  }
  return null;
}

function readTrack(view: DataView, trak: Box): Mp4Track | null {
  const mdia = find(view, trak.body, trak.end, 'mdia');
  if (!mdia) return null;

  const hdlr = find(view, mdia.body, mdia.end, 'hdlr');
  if (!hdlr || str(view, hdlr.body + 8, 4) !== 'vide') return null; // 映像トラックだけ

  const mdhd = find(view, mdia.body, mdia.end, 'mdhd');
  if (!mdhd) return null;
  const mdhdVer = view.getUint8(mdhd.body);
  // version 1 は時刻が 64bit。timescale の位置がずれる
  const timescale = mdhdVer === 1 ? view.getUint32(mdhd.body + 20) : view.getUint32(mdhd.body + 12);
  const duration =
    mdhdVer === 1
      ? view.getUint32(mdhd.body + 24) * 2 ** 32 + view.getUint32(mdhd.body + 28)
      : view.getUint32(mdhd.body + 16);
  if (!timescale) return null;

  const minf = find(view, mdia.body, mdia.end, 'minf');
  const stbl = minf && find(view, minf.body, minf.end, 'stbl');
  if (!stbl) return null;

  /* ── どのコーデックか ── */
  const stsd = find(view, stbl.body, stbl.end, 'stsd');
  if (!stsd) return null;
  const entry = [...boxes(view, stsd.body + 8, stsd.end)][0];
  if (!entry) return null;

  // 映像のサンプル記述は、先頭 78 バイトが固定の並び（幅・高さはその中）
  const width = view.getUint16(entry.body + 24);
  const height = view.getUint16(entry.body + 26);

  /*
    ここで受けるのは H.264（avc1 / avc3）だけにしている。
    HEVC は端末によって鍵の有無が分かれ、失敗の出かたも分かりにくい。
    受けられないものは <video> にまかせたほうが、結果として通る道が増える。
  */
  if (entry.type !== 'avc1' && entry.type !== 'avc3') return null;

  const avcC = find(view, entry.body + 78, entry.end, 'avcC');
  if (!avcC) return null;
  const description = new Uint8Array(view.buffer, avcC.body, avcC.end - avcC.body).slice();
  // avcC の 1〜3 バイト目が profile / constraint / level。codec 文字列はこれで作る
  const codec = `${entry.type}.${[...description.slice(1, 4)]
    .map((n) => n.toString(16).padStart(2, '0'))
    .join('')}`;

  /* ── コマの一覧を組み立てる ── */
  const samples = readSamples(view, stbl, timescale);
  if (!samples.length) return null;

  return {
    codec,
    description,
    width,
    height,
    durationSec: duration / timescale,
    samples,
  };
}

/**
 * stbl の中の表を突き合わせて、コマ1つずつの
 * 「どこに・何バイト・いつ・キーフレームか」を出す。
 *
 * 表が別々に置かれているのは容量のためで、意味は次のとおり。
 *   stts … 表示の長さ（同じ長さが続く分をまとめて持つ）
 *   ctts … 表示順と復号順のずれ（B フレームがあると出る）
 *   stsz … 1コマの大きさ
 *   stsc … 「何コマずつ塊（chunk）に入っているか」
 *   stco … 塊の位置（co64 なら 64bit）
 *   stss … キーフレームの番号（無いときは全部キーフレーム）
 */
function readSamples(view: DataView, stbl: Box, timescale: number): Mp4Sample[] {
  const stts = find(view, stbl.body, stbl.end, 'stts');
  const stsz = find(view, stbl.body, stbl.end, 'stsz');
  const stsc = find(view, stbl.body, stbl.end, 'stsc');
  const stco = find(view, stbl.body, stbl.end, 'stco') ?? find(view, stbl.body, stbl.end, 'co64');
  if (!stts || !stsz || !stsc || !stco) return [];
  const ctts = find(view, stbl.body, stbl.end, 'ctts');
  const stss = find(view, stbl.body, stbl.end, 'stss');

  /* 大きさ */
  const sizes: number[] = [];
  {
    const fixed = view.getUint32(stsz.body + 4);
    const count = view.getUint32(stsz.body + 8);
    for (let i = 0; i < count; i++) {
      sizes.push(fixed || view.getUint32(stsz.body + 12 + i * 4));
    }
  }
  const total = sizes.length;
  if (!total) return [];

  /* 表示の長さ（復号順にほどく） */
  const durations = new Float64Array(total);
  {
    const count = view.getUint32(stts.body + 4);
    let i = 0;
    for (let e = 0; e < count && i < total; e++) {
      const n = view.getUint32(stts.body + 8 + e * 8);
      const delta = view.getUint32(stts.body + 12 + e * 8);
      for (let k = 0; k < n && i < total; k++) durations[i++] = delta;
    }
    while (i < total) ((durations[i] = durations[i - 1] ?? 0), i++);
  }

  /* 表示順とのずれ */
  const offsets = new Float64Array(total);
  if (ctts) {
    const version = view.getUint8(ctts.body);
    const count = view.getUint32(ctts.body + 4);
    let i = 0;
    for (let e = 0; e < count && i < total; e++) {
      const n = view.getUint32(ctts.body + 8 + e * 8);
      // version 1 のずれは負になりうる（符号付き）
      const off =
        version === 1
          ? view.getInt32(ctts.body + 12 + e * 8)
          : view.getUint32(ctts.body + 12 + e * 8);
      for (let k = 0; k < n && i < total; k++) offsets[i++] = off;
    }
  }

  /* キーフレーム */
  const keys = new Set<number>();
  if (stss) {
    const count = view.getUint32(stss.body + 4);
    for (let i = 0; i < count; i++) keys.add(view.getUint32(stss.body + 8 + i * 4));
  }

  /* 塊の位置 */
  const is64 = str(view, stco.start + 4, 4) === 'co64';
  const chunkCount = view.getUint32(stco.body + 4);
  const chunkOffset = (i: number) =>
    is64
      ? view.getUint32(stco.body + 8 + i * 8) * 2 ** 32 + view.getUint32(stco.body + 12 + i * 8)
      : view.getUint32(stco.body + 8 + i * 4);

  /* 「塊ごとに何コマ入っているか」 */
  const runs: { first: number; perChunk: number }[] = [];
  {
    const count = view.getUint32(stsc.body + 4);
    for (let i = 0; i < count; i++) {
      runs.push({
        first: view.getUint32(stsc.body + 8 + i * 12), // 1 始まり
        perChunk: view.getUint32(stsc.body + 12 + i * 12),
      });
    }
  }
  if (!runs.length) return [];

  const out: Mp4Sample[] = [];
  let sample = 0;
  let dts = 0;
  const toUs = (v: number) => Math.round((v * 1_000_000) / timescale);

  for (let chunk = 0; chunk < chunkCount && sample < total; chunk++) {
    // この塊に何コマ入るかは、stsc の「ここから先はこう」を後ろから探す
    let perChunk = runs[0].perChunk;
    for (let r = runs.length - 1; r >= 0; r--) {
      if (chunk + 1 >= runs[r].first) {
        perChunk = runs[r].perChunk;
        break;
      }
    }
    let at = chunkOffset(chunk);
    for (let k = 0; k < perChunk && sample < total; k++) {
      const size = sizes[sample];
      out.push({
        offset: at,
        size,
        timestampUs: toUs(dts + offsets[sample]),
        durationUs: toUs(durations[sample]),
        // stss が無い動画は全コマがキーフレーム（前を必要としない）
        key: stss ? keys.has(sample + 1) : true,
      });
      at += size;
      dts += durations[sample];
      sample++;
    }
  }
  return out;
}

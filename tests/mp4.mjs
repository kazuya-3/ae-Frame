/**
 * MP4 をほどく部分（src/lib/video/mp4.ts）の検証。
 *
 * ── なぜブラウザではなく Node で見るのか ──
 *
 * ほどいた結果が正しいかどうかは、画面を見ても分からない。
 * ずれていても絵は出る（1コマ前が出る、同じコマが2回出る）ので、
 * 目で見て気づけるのは「動きが少しおかしい」という段階になってからになる。
 *
 * そのうえ、検証に使う Chromium には H.264 の鍵が入っていない。
 * つまり本物の MP4 を読ませても、ブラウザ側で確かめようがない。
 *
 * だからここでは、中身の分かっている MP4 を**その場で組み立てて**、
 * ほどいた結果が組み立てたとおりかを1つずつ突き合わせる。
 * コマの位置・大きさ・時刻・キーフレームは、すべて数字で答え合わせできる。
 */
import { parseMp4 } from '../src/lib/video/mp4.ts';

/* ---------------- 中身の分かっている MP4 を組み立てる ---------------- */

const u32 = (n) => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n >>> 0);
  return b;
};
const u16 = (n) => {
  const b = Buffer.alloc(2);
  b.writeUInt16BE(n);
  return b;
};
const box = (type, ...parts) => {
  const body = Buffer.concat(parts.map((p) => (Buffer.isBuffer(p) ? p : Buffer.from(p))));
  const head = Buffer.alloc(8);
  head.writeUInt32BE(8 + body.length);
  head.write(type, 4, 'ascii');
  return Buffer.concat([head, body]);
};
const full = (type, version, ...parts) => box(type, Buffer.from([version, 0, 0, 0]), ...parts);

/** avcC のはじめの4バイトが、そのまま codec 文字列になる */
const AVCC = Buffer.from([1, 0x64, 0x00, 0x1f, 0xff, 0xe1, 0x00, 0x00, 0x01, 0x00, 0x00]);

function visualSampleEntry(width, height, child) {
  const head = Buffer.concat([
    Buffer.alloc(6), // 予約
    u16(1), // データ参照の番号
    Buffer.alloc(16), // pre_defined / 予約
    u16(width),
    u16(height),
    u32(0x00480000), // 横の解像度 72dpi
    u32(0x00480000),
    u32(0),
    u16(1), // 1コマ
    Buffer.alloc(32), // 符号器の名前
    u16(0x0018), // 色の深さ
    u16(0xffff),
  ]);
  return box('avc1', head, child);
}

function buildMp4({ timescale = 600, sizes, deltas, chunkOffsets, stscRuns, syncs, ctts }) {
  const stbl = box(
    'stbl',
    full('stsd', 0, u32(1), visualSampleEntry(1280, 720, box('avcC', AVCC))),
    full(
      'stts',
      0,
      u32(deltas.length),
      ...deltas.flatMap(([count, delta]) => [u32(count), u32(delta)]),
    ),
    ...(syncs ? [full('stss', 0, u32(syncs.length), ...syncs.map(u32))] : []),
    ...(ctts
      ? [full('ctts', 0, u32(ctts.length), ...ctts.flatMap(([c, o]) => [u32(c), u32(o)]))]
      : []),
    full(
      'stsc',
      0,
      u32(stscRuns.length),
      ...stscRuns.flatMap(([first, per]) => [u32(first), u32(per), u32(1)]),
    ),
    full('stsz', 0, u32(0), u32(sizes.length), ...sizes.map(u32)),
    full('stco', 0, u32(chunkOffsets.length), ...chunkOffsets.map(u32)),
  );

  const duration = deltas.reduce((sum, [c, d]) => sum + c * d, 0);
  const moov = box(
    'moov',
    full('mvhd', 0, Buffer.alloc(96)),
    box(
      'trak',
      full('tkhd', 0, Buffer.alloc(80)),
      box(
        'mdia',
        full('mdhd', 0, u32(0), u32(0), u32(timescale), u32(duration), u16(0x55c4), u16(0)),
        full('hdlr', 0, u32(0), Buffer.from('vide', 'ascii'), Buffer.alloc(12)),
        box('minf', box('vmhd', Buffer.alloc(12)), stbl),
      ),
    ),
  );

  return Buffer.concat([
    box('ftyp', Buffer.from('isom', 'ascii'), u32(512), Buffer.from('isomavc1', 'ascii')),
    moov,
    box('mdat', Buffer.alloc(64)),
  ]);
}

const toArrayBuffer = (buf) => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);

/* ---------------- 検証 ---------------- */

export function runMp4Checks(check) {
  /*
    6コマ・3つの塊（chunk）に 2コマずつ。
    位置は塊の先頭からコマの大きさぶんずつ足していった場所になるはずで、
    そこが合っていれば「表をまたいだ突き合わせ」が出来ていることになる。
  */
  const sizes = [10, 20, 30, 40, 50, 60];
  const mp4 = buildMp4({
    sizes,
    deltas: [[6, 100]],
    chunkOffsets: [1000, 2000, 3000],
    stscRuns: [
      [1, 2],
      [3, 2],
    ],
    syncs: [1, 4],
  });

  const t = parseMp4(toArrayBuffer(mp4));
  check('MP4：映像トラックが1本見つかる', !!t);
  if (!t) return;

  check('MP4：コーデックの名前を組み立てる', t.codec === 'avc1.64001f', t.codec);
  check('MP4：初期化データ（avcC）を取り出す', t.description?.length === AVCC.length);
  check('MP4：大きさを読む', t.width === 1280 && t.height === 720, `${t.width}x${t.height}`);
  check('MP4：長さを秒で出す', Math.abs(t.durationSec - 1) < 1e-6, `${t.durationSec}`);
  check('MP4：コマの数が合う', t.samples.length === 6, `${t.samples.length}`);

  const offsets = t.samples.map((s) => s.offset);
  check(
    'MP4：塊をまたいで、コマの位置が合う',
    JSON.stringify(offsets) === JSON.stringify([1000, 1010, 2000, 2030, 3000, 3050]),
    offsets.join(','),
  );
  check(
    'MP4：コマの大きさが合う',
    JSON.stringify(t.samples.map((s) => s.size)) === JSON.stringify(sizes),
  );

  const times = t.samples.map((s) => s.timestampUs);
  check(
    'MP4：時刻を、時間の刻みからマイクロ秒に直す',
    times[0] === 0 && times[1] === 166667 && times[5] === 833333,
    times.join(','),
  );
  check(
    'MP4：キーフレームだけに印が付く',
    JSON.stringify(t.samples.map((s) => s.key)) ===
      JSON.stringify([true, false, false, true, false, false]),
  );

  /* 表示順のずれ（ctts）を持つもの。B フレームのある動画で必ず出てくる */
  const withCtts = parseMp4(
    toArrayBuffer(
      buildMp4({
        sizes,
        deltas: [[6, 100]],
        chunkOffsets: [1000, 2000, 3000],
        stscRuns: [
          [1, 2],
          [3, 2],
        ],
        syncs: [1],
        ctts: [[6, 50]],
      }),
    ),
  );
  check(
    'MP4：表示順のずれを、時刻に足す',
    withCtts?.samples[0].timestampUs === 83333,
    `${withCtts?.samples[0].timestampUs}`,
  );

  /* stss が無い動画は、全部のコマが単独で開ける（＝すべてキーフレーム） */
  const noStss = parseMp4(
    toArrayBuffer(
      buildMp4({
        sizes: [10, 20],
        deltas: [[2, 100]],
        chunkOffsets: [1000],
        stscRuns: [[1, 2]],
      }),
    ),
  );
  check('MP4：印の表が無いときは、全部キーフレーム', noStss?.samples.every((s) => s.key) === true);

  /* ほどけないものは、素直に諦める（<video> の道へ渡すため） */
  check('MP4：MP4 でないものは、null を返す', parseMp4(toArrayBuffer(Buffer.alloc(64))) === null);
  const fragmented = Buffer.concat([
    box('ftyp', Buffer.from('isom', 'ascii')),
    box('moov', full('mvhd', 0, Buffer.alloc(96))),
    box('moof', Buffer.alloc(16)),
  ]);
  check('MP4：分割された MP4 は、null を返す', parseMp4(toArrayBuffer(fragmented)) === null);
}

/* ---------------- いちどに引き受ける量 ---------------- */

import {
  clampRange,
  matteBytesPerFrame,
  maxFrames,
  maxSpanSec,
  MATTE_BUDGET_BYTES,
} from '../src/lib/video/budget.ts';

/**
 * 上限の計算。
 *
 * ここが狂うと、壊れかたが最悪になる（数分待たせたあとに、タブごと消える）。
 * しかも起きるのは「長い動画を渡した人の端末」だけなので、
 * こちらでは再現しにくい。だから算数のうちに確かめる。
 */
export function runBudgetChecks(check) {
  const budgetMB = MATTE_BUDGET_BYTES / 1024 / 1024;
  check('上限：予算がメモリの現実の範囲にある', budgetMB >= 64 && budgetMB <= 400, `${budgetMB}MB`);

  /* 大きい素材ほどマットも大きい、わけではない（長辺を 640 に揃えて持つため） */
  check(
    '上限：4K でも 720p でも、1コマの重さは同じ',
    matteBytesPerFrame(3840, 2160) === matteBytesPerFrame(1280, 720),
    `${matteBytesPerFrame(3840, 2160)} / ${matteBytesPerFrame(1280, 720)}`,
  );
  check(
    '上限：縦長でも同じ（向きで損をしない）',
    matteBytesPerFrame(1080, 1920) === matteBytesPerFrame(1920, 1080),
  );

  /* 予算を本当に超えないか */
  for (const [w, h] of [
    [1280, 720],
    [1080, 1920],
    [3840, 2160],
    [640, 480],
  ]) {
    check(
      `上限：${w}×${h} のコマ数が予算に収まる`,
      maxFrames(w, h) * matteBytesPerFrame(w, h) <= MATTE_BUDGET_BYTES,
      `${maxFrames(w, h)}コマ × ${Math.round(matteBytesPerFrame(w, h) / 1024)}KB`,
    );
  }

  /* コマが細かいほど、受けられる秒数は短くなる */
  const at30 = maxSpanSec(1280, 720, 30);
  const at15 = maxSpanSec(1280, 720, 15);
  check('上限：秒数が実用の範囲にある（30コマ/秒で15秒以上）', at30 >= 15, `${at30}秒`);
  check(
    '上限：コマを半分にすると、倍の長さを受けられる',
    Math.abs(at15 - at30 * 2) < 0.2,
    `${at30} → ${at15}`,
  );
  check(
    '上限：秒数は切り上げない（超える組み合わせを作らない）',
    at30 * 30 <= maxFrames(1280, 720),
  );

  /* 範囲の収めかた。動かしたほうの端が残る */
  check(
    '範囲：終わりを伸ばしすぎたら、終わりが戻る',
    JSON.stringify(clampRange({ start: 2, end: 90 }, 10, 'end')) ===
      JSON.stringify({ start: 2, end: 12 }),
  );
  check(
    '範囲：始まりを引っぱりすぎたら、始まりが戻る',
    JSON.stringify(clampRange({ start: 0, end: 40 }, 10, 'start')) ===
      JSON.stringify({ start: 30, end: 40 }),
  );
  check(
    '範囲：収まっているものは、そのまま通す',
    JSON.stringify(clampRange({ start: 1, end: 5 }, 10)) === JSON.stringify({ start: 1, end: 5 }),
  );
  check(
    '範囲：さかさまに渡されても壊れない',
    clampRange({ start: 9, end: 3 }, 10).end >= clampRange({ start: 9, end: 3 }, 10).start,
  );
}

/* ---------------- 黒い地から、光を抜く ---------------- */

import {
  backgroundLuma,
  expandBox,
  glowAlpha,
  glowKeyFor,
  glowOutside,
  mergeGlow,
  subjectBox,
} from '../src/lib/video/glow.ts';

/**
 * 光ものの扱い。
 *
 * ここは目で見て決めた仕組みだが、目で見るだけでは守れない。
 * 「粒子が残る」「地は残らない」「離れた明るいものは拾わない」は、
 * どれも数で言えることなので、数で見張る。
 *
 * 画像は、その場で小さく作る（黒い地・まん中の塊・そばの粒・遠くの印）。
 */
function scene() {
  const width = 64;
  const height = 40;
  const data = new Uint8ClampedArray(width * height * 4);
  const put = (x, y, v) => {
    const j = (y * width + x) * 4;
    data[j] = data[j + 1] = data[j + 2] = v;
    data[j + 3] = 255;
  };
  // 地：完全な黒ではなく、少しだけ持ち上げる（本物の撮影に近づける）
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) put(x, y, 12);
  // まん中の塊（被写体）
  for (let y = 12; y < 28; y++) for (let x = 20; x < 36; x++) put(x, y, 90);
  // そばの粒（光もの）
  for (const [x, y] of [
    [40, 16],
    [42, 20],
    [44, 18],
  ])
    put(x, y, 240);
  // 遠くの印（右下のすみ。生成AIの印を模したもの）
  put(61, 37, 200);
  put(62, 37, 200);
  return { width, height, data };
}

export function runGlowChecks(check) {
  const img = scene();

  check(
    '光：地の明るさを、四辺から読める',
    Math.abs(backgroundLuma(img) - 12 / 255) < 0.02,
    `${backgroundLuma(img).toFixed(3)}`,
  );

  /* つまみの向き。上げるほど、暗いところまで拾う */
  const low = glowKeyFor(10, 0.05);
  const high = glowKeyFor(100, 0.05);
  check(
    '光：つまみを上げると、暗いところまで拾う',
    high.black < low.black,
    `${high.black.toFixed(2)} < ${low.black.toFixed(2)}`,
  );
  check('光：地より下は、決して拾わない', high.black > 0.05, `${high.black.toFixed(3)}`);

  /* 明るさが、そのまま透明度になる */
  const alpha = glowAlpha(img, glowKeyFor(55, 12 / 255));
  const at = (x, y) => alpha[y * img.width + x];
  check('光：地は残らない', at(2, 2) === 0, `${at(2, 2)}`);
  check('光：粒はしっかり残る', at(40, 16) > 200, `${at(40, 16)}`);
  check(
    '光：塊は、明るさなりの半端な濃さになる',
    at(28, 20) > 10 && at(28, 20) < 250,
    `${at(28, 20)}`,
  );

  /* 被写体を囲む四角。塊だけを囲み、粒や印は入らない */
  const base = new Uint8ClampedArray(img.width * img.height);
  for (let y = 12; y < 28; y++) for (let x = 20; x < 36; x++) base[y * img.width + x] = 255;
  const box = subjectBox(base, img.width, img.height);
  check(
    '光：残っているところを囲める',
    box && box.x0 === 20 && box.x1 === 35 && box.y0 === 12 && box.y1 === 27,
    JSON.stringify(box),
  );

  const wide = expandBox(box, img.width, img.height, 0.18);
  check(
    '光：四角を、画面の短い辺の割合で広げる',
    wide.x1 - box.x1 === Math.round(40 * 0.18),
    `${wide.x1 - box.x1}`,
  );
  check('光：広げても、画面からはみ出さない', wide.x0 >= 0 && wide.y1 <= img.height - 1);

  /*
    いちばん確かめたいところ。

    そばの粒は足され、遠くの印は足されない。
    実際の素材（生成AIの印が右下に入っている）で、ここが効いた。
  */
  const merged = new Uint8ClampedArray(base);
  mergeGlow(merged, alpha, img.width, img.height, wide, 6);
  const m = (x, y) => merged[y * img.width + x];
  check('光：そばの粒は、足される', m(40, 16) > 200, `${m(40, 16)}`);
  check('光：遠くの印は、足さない', m(61, 37) === 0, `${m(61, 37)}`);
  check('光：もとの塊は、濃いまま', m(28, 20) === 255, `${m(28, 20)}`);
  check('光：地は、足したあとも残らない', m(2, 2) === 0, `${m(2, 2)}`);

  /* 四角の縁で、急に切らない（線が出ないこと） */
  const soft = new Uint8ClampedArray(img.width * img.height);
  const bright = new Uint8ClampedArray(img.width * img.height).fill(255);
  mergeGlow(soft, bright, img.width, img.height, { x0: 20, y0: 12, x1: 35, y1: 27 }, 6);
  const edge = [0, 1, 2, 3, 4, 5].map((d) => soft[20 * img.width + (35 + d)]);
  check(
    '光：四角の外へ、なだらかに弱まる',
    edge.every((v, i) => i === 0 || v <= edge[i - 1]) && edge[0] > edge[5],
    edge.join(','),
  );

  /* 気づく仕組み。消えた側に明るいものが残っているか */
  check(
    '光：消えた側の光に気づく',
    glowOutside(img, base, wide) > 0.0015,
    `${glowOutside(img, base, wide).toFixed(4)}`,
  );

  const dark = scene();
  for (const [x, y] of [
    [40, 16],
    [42, 20],
    [44, 18],
  ]) {
    const j = (y * dark.width + x) * 4;
    dark.data[j] = dark.data[j + 1] = dark.data[j + 2] = 12;
  }
  check(
    '光：光っていない素材では、気づかない（余計なことをしない）',
    glowOutside(dark, base, wide) < 0.0015,
  );
}

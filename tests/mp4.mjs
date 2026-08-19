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

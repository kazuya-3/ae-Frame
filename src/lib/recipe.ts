/**
 * フレームに「置きかた」を添えて配る。
 *
 * ── なぜ画像だけでは足りないのか ──
 *
 * 背景をけしたフレームのPNGは、いまでも人に渡せる。
 * けれど渡された人は、そこから**自由に動かす**。
 * 同じフレームを配っても、大きさも位置も人それぞれになる。
 * 「みんなでつけるとバラバラになる」の中身はこれ。
 *
 * だから、配る単位を「画像」から「**画像＋置きかた**」に変える。
 *
 * ── なぜ PNG の中に入れるのか ──
 *
 * 置き場所を借りずに、誰でも今すぐ配れるようにするため。
 * リンクで配ろうとすると、画像をどこかに置く必要が出てくる
 * （フレームは実測30〜270KB。base64にすると40〜360KBのURLになり、
 * Discord の2000文字にまるで入らない）。置き場所を持つというのは、
 * 他人の絵を預かるということで、話がまるごと変わる。
 *
 * ファイルそのものに入れてしまえば、置き場所は要らない。
 * 作った人が、いま使っている道（Discord・LINE）でそのまま配れる。
 *
 * PNG には `tEXt` という「絵に影響しない文字の置き場所」が決まっている。
 * 読めない道具から見れば、ただの透過PNGのまま。実測で +128 バイト。
 *
 * ── 消えることについて ──
 *
 * LINE などに「写真」として送ると再圧縮され、置きかたは消える。
 * ただし**そのときは透過も一緒に消える**ので、利用者に覚えてもらう決まりは増えない。
 * 画面にはもともと「そのまま渡したいときはファイルとして送る」と書いてある。
 */

import type { Hole } from './hole';

/** 受け取った人に、何を触らせるか */
export type RecipeLock = {
  /** 写真を動かせる範囲。hole＝穴の中だけ／free＝自由 */
  move: 'hole' | 'free';
  /** かたむきを触らせるか */
  rotate: boolean;
  /** すきまの色を決め打ちにする（null なら触らせる） */
  gap: 'none' | 'white' | 'black' | null;
  /** まるく切りぬくかを決め打ちにする（null なら触らせる） */
  round: boolean | null;
};

export type Recipe = {
  /** 形の版。読めない版は無視する（行き止まりにしない） */
  v: 1;
  /** 配った人がつけた名前。無くてよい */
  name?: string;
  /** 穴の位置。無ければ受け取った側で探す */
  hole?: Hole;
  lock?: RecipeLock;
};

/** PNG の中でこの置きかたを入れておく名前 */
const KEYWORD = 'aeframe';

/** PNG の決まりの先頭8バイト */
const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

const crcTable = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(bytes: Uint8Array): number {
  let c = -1;
  for (let i = 0; i < bytes.length; i++) c = crcTable[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function isPng(bytes: Uint8Array): boolean {
  return SIGNATURE.every((b, i) => bytes[i] === b);
}

/**
 * JSON を latin1 の範囲に収める。
 *
 * tEXt に置けるのは 1バイト文字だけ。名前に日本語が入ると、そのままでは置けない。
 * `JSON.stringify` は `\uXXXX` を吐けるので、ASCII 以外を全部その形に逃がす。
 * 読むときは `JSON.parse` が戻してくれるので、こちら側で戻す処理は要らない。
 */
function toLatin1Json(value: unknown): string {
  return JSON.stringify(value).replace(/[^\x20-\x7e]/g, (ch) => {
    const code = ch.charCodeAt(0).toString(16).padStart(4, '0');
    return `\\u${code}`;
  });
}

/**
 * PNG に置きかたを焼きこむ。元の絵には触らない。
 *
 * 同じ名前のものが先に入っていたら、それは落としてから入れる。
 * 落とさないと、読むときに古いほうが先に見つかる。
 */
export function embedRecipe(png: Uint8Array, recipe: Recipe): Uint8Array {
  if (!isPng(png)) return png;
  const stripped = stripRecipe(png);

  const text = toLatin1Json(recipe);
  const body = new Uint8Array(KEYWORD.length + 1 + text.length);
  for (let i = 0; i < KEYWORD.length; i++) body[i] = KEYWORD.charCodeAt(i);
  body[KEYWORD.length] = 0;
  for (let i = 0; i < text.length; i++) body[KEYWORD.length + 1 + i] = text.charCodeAt(i) & 0xff;

  const typed = new Uint8Array(4 + body.length);
  typed[0] = 0x74; // t
  typed[1] = 0x45; // E
  typed[2] = 0x58; // X
  typed[3] = 0x74; // t
  typed.set(body, 4);

  const chunk = new Uint8Array(12 + body.length);
  const view = new DataView(chunk.buffer);
  view.setUint32(0, body.length);
  chunk.set(typed, 4);
  view.setUint32(8 + body.length, crc32(typed));

  // IEND（最後の12バイト）の直前に差しこむ
  const cut = stripped.length - 12;
  const out = new Uint8Array(stripped.length + chunk.length);
  out.set(stripped.subarray(0, cut), 0);
  out.set(chunk, cut);
  out.set(stripped.subarray(cut), cut + chunk.length);
  return out;
}

/** チャンクを頭から順に見る。壊れていたら、そこで止める。 */
function* chunks(png: Uint8Array): Generator<{ start: number; end: number; type: string }> {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  let i = 8;
  while (i + 8 <= png.length) {
    const len = view.getUint32(i);
    const end = i + 12 + len;
    if (len < 0 || end > png.length) return;
    let type = '';
    for (let k = 0; k < 4; k++) type += String.fromCharCode(png[i + 4 + k]);
    yield { start: i, end, type };
    if (type === 'IEND') return;
    i = end;
  }
}

/**
 * 焼きこんである置きかたを読む。
 *
 * **読めなければ null。** 壊れていても、知らない版でも、行き止まりにしない。
 * そのときは「ただの透過PNG」として扱えばよく、いままでと同じことができる。
 */
export function readRecipe(png: Uint8Array): Recipe | null {
  if (!isPng(png)) return null;
  try {
    for (const { start, end, type } of chunks(png)) {
      if (type !== 'tEXt') continue;
      let s = '';
      for (let i = start + 8; i < end - 4; i++) s += String.fromCharCode(png[i]);
      const z = s.indexOf('\0');
      if (z < 0 || s.slice(0, z) !== KEYWORD) continue;
      const parsed = JSON.parse(s.slice(z + 1)) as Recipe;
      // 知らない版は、読めたことにしない
      if (!parsed || parsed.v !== 1) return null;
      return parsed;
    }
  } catch {
    /* 壊れた JSON、途切れたファイル。読めないものは無いのと同じ */
  }
  return null;
}

/** 焼きこんである置きかたを外す（自分用に保存し直すとき） */
export function stripRecipe(png: Uint8Array): Uint8Array {
  if (!isPng(png)) return png;
  const drop: { start: number; end: number }[] = [];
  try {
    for (const { start, end, type } of chunks(png)) {
      if (type !== 'tEXt') continue;
      let head = '';
      for (let i = start + 8; i < Math.min(end - 4, start + 8 + KEYWORD.length); i++) {
        head += String.fromCharCode(png[i]);
      }
      if (head === KEYWORD) drop.push({ start, end });
    }
  } catch {
    return png;
  }
  if (!drop.length) return png;

  const size = drop.reduce((s, d) => s + (d.end - d.start), 0);
  const out = new Uint8Array(png.length - size);
  let at = 0;
  let from = 0;
  for (const d of drop) {
    out.set(png.subarray(from, d.start), at);
    at += d.start - from;
    from = d.end;
  }
  out.set(png.subarray(from), at);
  return out;
}

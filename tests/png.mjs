/**
 * テスト画像を作るための、依存なしの PNG ライター。
 * 検証用の絵を毎回リポジトリに置かずに済むよう、その場で描き起こす。
 */
import { deflateSync } from 'node:zlib';

const CRC = [];
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  CRC[n] = c >>> 0;
}

function crc(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const cc = Buffer.alloc(4);
  cc.writeUInt32BE(crc(td));
  return Buffer.concat([len, td, cc]);
}

/** paint(x, y) が [r, g, b, a] を返す。 */
export function png(width, height, paint) {
  const raw = Buffer.alloc(height * (width * 4 + 1));
  for (let y = 0; y < height; y++) {
    const off = y * (width * 4 + 1);
    for (let x = 0; x < width; x++) {
      const p = paint(x, y);
      raw[off + 1 + x * 4] = p[0];
      raw[off + 2 + x * 4] = p[1];
      raw[off + 3 + x * 4] = p[2];
      raw[off + 4 + x * 4] = p[3];
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // ビット深度
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

export const clamp = (v) => Math.max(0, Math.min(255, Math.round(v)));

/** 不透明度 a で fg を bg の上に重ねる。 */
export const over = (fg, bg, a) => [
  clamp(fg[0] * a + bg[0] * (1 - a)),
  clamp(fg[1] * a + bg[1] * (1 - a)),
  clamp(fg[2] * a + bg[2] * (1 - a)),
];

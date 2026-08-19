/**
 * ZIP を組み立てる（無圧縮）。
 *
 * PNG 連番を1つのファイルにまとめて渡すためだけのもの。
 * ライブラリは入れていない。理由は2つ。
 *
 *  1. PNG はすでに圧縮済みで、ZIP でさらに縮めても 1〜2% しか減らない。
 *     つまり必要なのは「並べて包む」だけで、圧縮器は要らない。
 *  2. 中身をメモリに全部そろえずに済ませたい。ここでは各コマを Blob のまま
 *     配列に積み、最後に Blob として1つにする。実体はブラウザがディスクに
 *     逃がしてくれるので、240コマ・数百MBでも端末が落ちない。
 */

const table = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = table[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

type Entry = { name: Uint8Array; crc: number; size: number; offset: number };

/** 名前のような小さな配列を、そのまま Blob の材料にする */
function part(bytes: Uint8Array): BlobPart {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

export class ZipBuilder {
  private parts: BlobPart[] = [];
  private entries: Entry[] = [];
  private offset = 0;
  /** MS-DOS 形式の日時。展開したときに「いつ作ったか」が残る */
  private readonly time = dosTime(new Date());

  async add(filename: string, blob: Blob) {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const name = new TextEncoder().encode(filename);
    const crc = crc32(bytes);

    const header = new DataView(new ArrayBuffer(30));
    header.setUint32(0, 0x04034b50, true); // ローカルヘッダの目印
    header.setUint16(4, 20, true); // 必要なバージョン
    header.setUint16(6, 0, true); // フラグ
    header.setUint16(8, 0, true); // 0 = 無圧縮
    header.setUint32(10, this.time, true);
    header.setUint32(14, crc, true);
    header.setUint32(18, bytes.length, true);
    header.setUint32(22, bytes.length, true);
    header.setUint16(26, name.length, true);
    header.setUint16(28, 0, true);

    // 中身は Blob のまま積む（もう一度メモリに写さないため）
    this.parts.push(header.buffer, part(name), blob);
    this.entries.push({ name, crc, size: bytes.length, offset: this.offset });
    this.offset += 30 + name.length + bytes.length;
  }

  finish(): Blob {
    const start = this.offset;
    for (const e of this.entries) {
      const dir = new DataView(new ArrayBuffer(46));
      dir.setUint32(0, 0x02014b50, true);
      dir.setUint16(4, 20, true); // 作ったバージョン
      dir.setUint16(6, 20, true);
      dir.setUint16(8, 0, true);
      dir.setUint16(10, 0, true);
      dir.setUint32(12, this.time, true);
      dir.setUint32(16, e.crc, true);
      dir.setUint32(20, e.size, true);
      dir.setUint32(24, e.size, true);
      dir.setUint16(28, e.name.length, true);
      dir.setUint32(42, e.offset, true);
      this.parts.push(dir.buffer, part(e.name));
      this.offset += 46 + e.name.length;
    }

    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true);
    end.setUint16(8, this.entries.length, true);
    end.setUint16(10, this.entries.length, true);
    end.setUint32(12, this.offset - start, true);
    end.setUint32(16, start, true);
    this.parts.push(end.buffer);

    return new Blob(this.parts, { type: 'application/zip' });
  }
}

function dosTime(d: Date) {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return ((date << 16) | time) >>> 0;
}

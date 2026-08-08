/**
 * 検証用のフレーム画像を描き起こす。
 *
 * 実際に配布されているアイコンフレームの「難しいところ」だけを取り出して
 * 小さく再現したもの。見た目を似せることが目的ではなく、透過処理が
 * つまずく性質（グロー・囲まれた白・白地に白・うすい色）を再現するのが目的。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { png, over, clamp } from './png.mjs';

const OUT = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const S = 900;
const C = S / 2 - 0.5;

const write = (name, buf) => writeFileSync(join(OUT, name), buf);

export function build() {
  mkdirSync(OUT, { recursive: true });

  /* ── ネオン：外周のグローが白地へにじむ／まん中は穴 ──
     「光を階調のまま残せるか」を見る。ハードに切ると光が死ぬ。 */
  {
    const R = S * 0.38;
    const TH = S * 0.055;
    write(
      'neon.png',
      png(S, S, (x, y) => {
        const dy = y - C;
        const d = Math.hypot(x - C, dy);
        let col = [255, 255, 255];
        const gd = d - (R + TH / 2);
        if (gd > -TH) {
          const g = Math.exp(-(gd * gd) / (2 * Math.pow(S * 0.045, 2)));
          const t = (dy / R) * 0.5 + 0.5; // 上が水色、下がピンク
          const neon = [
            clamp(34 * (1 - t) + 255 * t),
            clamp(226 * (1 - t) + 45 * t),
            clamp(226 * (1 - t) + 110 * t),
          ];
          col = over(neon, col, Math.min(0.92, g * 0.95));
        }
        const rd = Math.abs(d - R);
        if (rd < TH / 2) col = over([16, 16, 22], col, Math.min(1, (TH / 2 - rd) / 2));
        return [...col, 255];
      }),
    );
  }

  /* ── 祭：提灯の紙・狐面のような「囲まれた白」を持つ ──
     素の色キーだと、この白まで消えて穴が開く。 */
  {
    const R = S * 0.38;
    const TH = S * 0.075;
    const spots = [
      [C + R * Math.cos(-0.6), C + R * Math.sin(-0.6)],
      [C + R * Math.cos(2.4), C + R * Math.sin(2.4)],
    ];
    write(
      'festival.png',
      png(S, S, (x, y) => {
        const d = Math.hypot(x - C, y - C);
        let col = [255, 255, 255];
        const rd = Math.abs(d - R);
        if (rd < TH / 2) col = over([28, 60, 175], col, Math.min(1, (TH / 2 - rd) / 2));
        for (const [px, py] of spots) {
          const pd = Math.hypot(x - px, y - py);
          if (pd < S * 0.026) col = over([252, 252, 248], col, Math.min(1, (S * 0.026 - pd) / 2));
        }
        return [...col, 255];
      }),
    );
  }

  /* ── クリスタル：白いガラスを白地に描いたもの ──
     色だけでは原理的に背景と区別できない。検算して AI に回せるかを見る。 */
  {
    const R = S * 0.37;
    const TH = S * 0.05;
    write(
      'glass.png',
      png(S, S, (x, y) => {
        const d = Math.hypot(x - C, y - C);
        let col = [255, 255, 255];
        const rd = Math.abs(d - R);
        if (rd < TH / 2) {
          const edge = 1 - Math.min(1, (TH / 2 - rd) / (TH * 0.2));
          col = over(
            [clamp(250 - 16 * edge), clamp(250 - 16 * edge), clamp(252 - 10 * edge)],
            col,
            Math.min(1, (TH / 2 - rd) / 2),
          );
        }
        return [...col, 255];
      }),
    );
  }

  /* ── 金魚：うすい水色のリング＋囲まれた白い泡 ──
     うすい色を半透明にせず残せるか、泡を守れるかを同時に見る。 */
  {
    const R = S * 0.37;
    const TH = S * 0.06;
    write(
      'water.png',
      png(S, S, (x, y) => {
        const d = Math.hypot(x - C, y - C);
        let col = [255, 255, 255];
        const rd = Math.abs(d - R);
        if (rd < TH / 2) col = over([150, 205, 242], col, Math.min(1, (TH / 2 - rd) / 2));
        for (let i = 0; i < 6; i++) {
          const a = (i / 6) * Math.PI * 2;
          const pd = Math.hypot(x - (C + R * Math.cos(a)), y - (C + R * Math.sin(a)));
          if (pd < S * 0.018) col = over([255, 255, 255], col, Math.min(1, (S * 0.018 - pd) / 2));
        }
        return [...col, 255];
      }),
    );
  }

  /* ── 線画：白地に黒い線だけ。いちばん素直なケース ── */
  {
    const R = S * 0.42;
    write(
      'lineart.png',
      png(S, S, (x, y) => {
        const d = Math.hypot(x - C, y - C);
        const ring = (r, w) => Math.max(0, Math.min(1, (w / 2 + 0.8 - Math.abs(d - r)) / 1.6));
        const v = Math.max(ring(R, 7), ring(R * 0.9, 3));
        const g = clamp(255 - v * 233);
        return [g, g, g, 255];
      }),
    );
  }

  /* ── すでに透過ずみの PNG。触らずに通すべきケース ── */
  {
    const R = S * 0.42;
    write(
      'already-transparent.png',
      png(S, S, (x, y) => {
        const d = Math.hypot(x - C, y - C);
        const ring = (r, w) => Math.max(0, Math.min(1, (w / 2 + 0.8 - Math.abs(d - r)) / 1.6));
        return [20, 20, 26, clamp(Math.max(ring(R, 7), ring(R * 0.9, 3)) * 255)];
      }),
    );
  }

  /* ── 重ねる相手。暗い写真ほど、グローの色が正しく出ているか分かる ── */
  write(
    'photo-dark.png',
    png(S, S, () => [10, 10, 14, 255]),
  );
  write(
    'photo-color.png',
    png(S, S, (x, y) => [
      clamp(80 + 120 * (x / S)),
      clamp(60 + 150 * (y / S)),
      clamp(200 - 90 * (x / S)),
      255,
    ]),
  );

  return OUT;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  console.log('検証用画像を作りました:', build());
}

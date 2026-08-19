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
          // 白との色差が 0.008 未満。どんなしきい値を置いても背景と分けられない。
          const edge = 1 - Math.min(1, (TH / 2 - rd) / (TH * 0.2));
          col = over(
            [clamp(253 - 3 * edge), clamp(253 - 3 * edge), clamp(254 - 2 * edge)],
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

  /*
    ── 透過ずみ、かつ半透明のグローを持つ PNG ──

    いちばん壊しやすい入力。すでに正しいアルファが付いているので、
    色にもアルファにも一切さわらずに通さなければならない。
    ここで背景色を引き算したりすると、グローの色が濁る／沈む。

    グローは「不透明度 a の水色」。RGB は乗算済みではなく本来の色を持つ。
    半径 GLOW_R の位置がちょうど a=0.5 になるようにしてある。
  */
  {
    const R = S * 0.36;
    const TH = S * 0.05;
    write(
      'transparent-glow.png',
      png(S, S, (x, y) => {
        const d = Math.hypot(x - C, y - C);
        const rd = Math.abs(d - R);
        if (rd < TH / 2) return [16, 16, 22, 255]; // リング本体
        // 外向きのグロー。半径 R+TH/2 から外へ、なめらかに 0 まで落ちる。
        const gd = d - (R + TH / 2);
        if (gd >= 0) {
          const a = Math.exp(-(gd * gd) / (2 * Math.pow(S * 0.05, 2)));
          return [34, 226, 226, clamp(a * 255)];
        }
        return [0, 0, 0, 0]; // まん中の穴
      }),
    );
  }

  /*
    ── 氷とベリー：ほぼ白い氷のリング＋端ぎりぎりの細い文字 ──

    2つの罠が同時にある。
    1. リング本体がほぼ白なので、色だけでは背景と紙一重
    2. "TEMP : -08°C" のような細い文字が、画像の端すれすれに置かれている

    2 は、スクショの UI を落とす仕組みと衝突しうる。UI も端に寄っているからだ。
    正方形のフレームでは切り取り自体が起きない（面積がほとんど変わらないため）
    ——という歯止めが効いているかを、ここで固定する。
  */
  {
    const R = S * 0.37;
    const TH = S * 0.075;
    const berries = [0.4, 0.9, 3.6, 4.0, 4.4].map((a) => [
      C + R * Math.cos(a),
      C + R * Math.sin(a),
    ]);
    const bar = (x, y, x0, y0, x1, y1) => x >= x0 && x <= x1 && y >= y0 && y <= y1;

    write(
      'ice-berry.png',
      png(S, S, (x, y) => {
        let col = [255, 255, 255];
        const d = Math.hypot(x - C, y - C);
        const rd = Math.abs(d - R);
        if (rd < TH / 2) {
          // ほぼ白い氷。フチだけ水色の線が入る。
          const edge = 1 - Math.min(1, (TH / 2 - rd) / (TH * 0.18));
          col = over(
            [clamp(247 - 97 * edge), clamp(250 - 70 * edge), clamp(253 - 38 * edge)],
            col,
            Math.min(1, (TH / 2 - rd) / 2),
          );
        }
        // 濃いベリー。ここは確実に残るはず。
        for (const [bx, by] of berries) {
          const pd = Math.hypot(x - bx, y - by);
          if (pd < S * 0.045) col = over([58, 68, 128], col, Math.min(1, (S * 0.045 - pd) / 2));
        }
        // 端ぎりぎりの細い文字（デザインの一部）
        if (bar(x, y, S * 0.028, S * 0.42, S * 0.036, S * 0.58)) col = [120, 120, 130];
        if (bar(x, y, S * 0.964, S * 0.4, S * 0.972, S * 0.6)) col = [120, 120, 130];
        return [...col, 255];
      }),
    );
  }

  /*
    ── うすい水彩：白にごく近い色でできたフレーム ──

    実機で最初に見つかった不具合の再現。金魚のフレームの水しぶきは
    白との色差が 0.02〜0.09 しかなく、初期しきい値（0.06）に飲み込まれて
    デザインごと消えていた。しかも薄い部分は切り出しの範囲からも外れ、
    絵が見切れていた。

    ここでは内側から外側へ、白にごく近い色から順に4本の輪を描く。
    いちばん薄い輪（色差 0.02）まで残ることを確かめる。
  */
  {
    // 白との色差がおよそ 0.02 / 0.04 / 0.06 / 0.09 になる、うすい水色
    const rings = [
      { r: 0.2, col: [244, 250, 254] },
      { r: 0.27, col: [232, 244, 252] },
      { r: 0.34, col: [219, 237, 250] },
      { r: 0.41, col: [199, 226, 247] },
    ];
    write(
      'pale-wash.png',
      png(S, S, (x, y) => {
        const d = Math.hypot(x - C, y - C);
        let col = [255, 255, 255];
        for (const { r, col: c } of rings) {
          const rd = Math.abs(d - S * r);
          const th = S * 0.028;
          if (rd < th / 2) col = over(c, col, Math.min(1, (th / 2 - rd) / 2));
        }
        // 外側に散らす、いちばん薄い泡。切り出しの範囲に入るかを見る。
        for (let i = 0; i < 8; i++) {
          const a = (i / 8) * Math.PI * 2 + 0.3;
          const pd = Math.hypot(x - (C + S * 0.46 * Math.cos(a)), y - (C + S * 0.46 * Math.sin(a)));
          if (pd < S * 0.02) col = over([244, 250, 254], col, Math.min(1, (S * 0.02 - pd) / 2));
        }
        return [...col, 255];
      }),
    );
  }

  /*
    ── ざらざらした背景の上のフレーム ──

    背景が単色でないので、色キーではどうにもならない。
    「消えなさすぎ（背景が残った）」を検算で捕まえて AI に回せるかを見る。
  */
  {
    const R = S * 0.4;
    const TH = S * 0.06;
    let seed = 1;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    write(
      'noisy-bg.png',
      png(S, S, (x, y) => {
        const d = Math.hypot(x - C, y - C);
        const n = rnd() * 255;
        let col = [clamp(n), clamp((n * 0.6 + x / 4) % 255), clamp(Math.sin(x / 23) * 90 + 140)];
        const rd = Math.abs(d - R);
        if (rd < TH / 2) col = over([16, 16, 22], col, Math.min(1, (TH / 2 - rd) / 2));
        return [...col, 255];
      }),
    );
  }

  /*
    ── スマホのスクリーンショット ──

    TikTok は透過を持てないので、フレームは動画・画像として流れ、
    受け取る側はスクショで持ってくる。これが実際にいちばん多い入力。
    時刻・ユーザー名・キャプション・右側のボタン列まで一緒に写り込む。
  */
  {
    const W = 780;
    const H = 1688;
    const cx = W / 2 - 0.5;
    const cy = H * 0.42;
    const R = W * 0.33;
    const TH = W * 0.05;
    const box = (x, y, x0, y0, x1, y1) => x >= x0 && x <= x1 && y >= y0 && y <= y1;

    write(
      'phone-screenshot.png',
      png(W, H, (x, y) => {
        let col = [255, 255, 255];
        const rd = Math.abs(Math.hypot(x - cx, y - cy) - R);
        if (rd < TH / 2) col = over([16, 16, 22], col, Math.min(1, (TH / 2 - rd) / 2));
        // 上：時刻と電池
        if (box(x, y, 40, 40, 150, 70) || box(x, y, W - 140, 42, W - 40, 66)) col = [20, 20, 20];
        // 右：プロフィール・ハート・コメントのボタン列
        for (let i = 0; i < 4; i++) {
          if (Math.hypot(x - (W - 60), y - (H * 0.55 + i * 90)) < 26) col = [35, 35, 40];
        }
        // 下：ユーザー名とキャプション
        if (
          box(x, y, 40, H - 230, 300, H - 205) ||
          box(x, y, 40, H - 180, W - 160, H - 158) ||
          box(x, y, 40, H - 140, W - 260, H - 118)
        ) {
          col = [35, 35, 35];
        }
        if (box(x, y, 0, H - 70, W, H)) col = [245, 245, 245];
        return [...col, 255];
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

  /*
    縦長で、どこが写っているか色だけで分かる写真。

    「どこを切りぬくか」の検証に使う。切りぬきは短いほうの辺にそろえるので、
    縦長でないと、そもそも選ぶ余地が生まれない（正方形なら動かせる幅が 0）。

    4つの帯にはっきり違う色を置いてある。窓の中の色を読めば、
    写真のどこが残っているかが機械的に分かる。
  */
  write(
    'photo-tall.png',
    png(400, 1600, (_x, y) => {
      const band = Math.min(3, Math.floor(y / 400));
      return [
        [232, 82, 63, 255], // 0〜400   いちばん上
        [240, 169, 59, 255], // 400〜800
        [75, 158, 106, 255], // 800〜1200
        [63, 111, 181, 255], // 1200〜1600 いちばん下
      ][band];
    }),
  );

  /*
    スタジオ（うごく素材の背景けし）用。単色の地に、はっきりした形をひとつ。

    ここで見たいのは「単色の背景だと気づけるか」「その背景だけが消えるか」の
    2点なので、地は完全な単色にしてある。フレームの検証用画像（白地）を
    使い回さないのは、あちらが**白**であるせいで「白い前景も消える」という
    別の話が混ざるため。
  */
  write(
    'studio-solid.png',
    png(480, 270, (x, y) => {
      const dx = x - 240;
      const dy = y - 135;
      // まん中の円だけが残る前景。地との差を大きくして、しきい値の話を持ち込まない
      if (Math.hypot(dx, dy) < 82) return [242, 88, 120, 255];
      return [11, 123, 212, 255];
    }),
  );

  return OUT;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  console.log('検証用画像を作りました:', build());
}

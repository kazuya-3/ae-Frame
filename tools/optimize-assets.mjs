/**
 * 応援ページの素材を、配信できる重さに落とす。
 *
 *   node tools/optimize-assets.mjs
 *
 * 元画像は assets-src/support/ に置いたまま触らない。
 * そこから読んで、公開される public/assets/support/ に webp を書き出す。
 * つまり「元は原寸で残し、配るのは軽いほう」という形。
 *
 *
 * ── なぜブラウザで変換するのか ──
 *
 * この環境には画像を扱うライブラリ（sharp や Pillow）が入っていない。
 * 入れることもできるが、そのためだけに依存を増やしたくない。
 * Chromium は検証ですでに使っていて、webp のエンコーダも
 * 縮小のときの補間も持っているので、それを借りる。
 *
 *
 * ── なぜ長辺 1200px なのか ──
 *
 * これらは飾りで、いちばん大きく出るところでも
 * 画面の幅いっぱい（スマホで 430px、パソコンで 620px）。
 * 画面の解像度が2倍の端末を見込んでも 1240px あれば足りる。
 * 元は 1536px なので、1200px にしても見た目は変わらない。
 *
 *
 * ── 透過について ──
 *
 * canvas を経由しても透過は保たれる。ただし「とうめい」と「白」は別物なので、
 * 元が白地なら白地のまま出てくる。そこは書き出しの側の問題で、ここでは直さない
 * （直すと、元と違うものを配ることになる）。
 */
import { chromium } from 'playwright';
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const SRC = join(root, 'assets-src', 'support');
const OUT = join(root, 'public', 'assets', 'support');

/** 長辺の上限。これ以上大きくても、画面では見分けがつかない。 */
const MAX_EDGE = 1200;

/*
  素材ごとの上限。出る大きさが違うので、1つの数字で揃えると無駄が出る。

  ハリネズミは .mascot-slot（min(180px, 44vw)）の中に出る。
  いちばん大きくて 180px なので、解像度が3倍の端末を見込んでも 540px で足りる。
  ここを 1200px のまま配っていて、お礼のページで 303KB 使っていた。
  560px にすると 3分の1以下になり、拡大しても違いは見て取れない。
*/
const MAX_EDGE_BY_FILE = {
  'hedgehog-support': 560,
  'hedgehog-thanks': 560,
};
/** webp の品質。0.82 で、飾りとしては元と見分けがつかなかった。 */
const QUALITY = 0.82;

const kb = (n) => `${Math.round(n / 1024)}KB`;

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined,
});
const page = await browser.newPage();
// data: URL から読むので、置き場所に依存しない
await page.goto('about:blank');

mkdirSync(OUT, { recursive: true });

/*
  配るものと、配らないものを分ける。

  ・見本（bfl04-ui-reference）はデザインを決めるときに見るだけのもの。
    サイトには一切出さないので、変換もしない。
  ・差し替え前の記録（.unused）も同じ。
  ・下書き（-draft）も配らない。

  配らないと決めたものをここに書いておくと、
  public/ に置いたまま誰も参照しないファイルが残らずに済む。
*/
const SKIP = [/-reference\./i, /\.unused$/i, /-draft\./i];

const files = readdirSync(SRC).filter(
  (f) => /\.(png|jpe?g|webp)$/i.test(f) && !SKIP.some((re) => re.test(f)),
);
let before = 0;
let after = 0;

console.log(`長辺 ${MAX_EDGE}px（素材によっては小さく）/ 品質 ${QUALITY} で webp にします\n`);

for (const file of files) {
  const srcPath = join(SRC, file);
  const raw = readFileSync(srcPath);
  const inSize = statSync(srcPath).size;
  const stem = file.replace(/\.[^.]+$/, '');
  const maxEdge = MAX_EDGE_BY_FILE[stem] ?? MAX_EDGE;

  const result = await page.evaluate(
    async ([b64, type, maxEdge, quality]) => {
      const img = new Image();
      img.src = `data:${type};base64,${b64}`;
      await img.decode();

      const scale = Math.min(1, maxEdge / Math.max(img.naturalWidth, img.naturalHeight));
      const w = Math.round(img.naturalWidth * scale);
      const h = Math.round(img.naturalHeight * scale);

      const c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      const x = c.getContext('2d');
      x.imageSmoothingEnabled = true;
      x.imageSmoothingQuality = 'high';
      x.drawImage(img, 0, 0, w, h);

      // 透過が保たれているかを、ここでも数えておく
      const d = x.getImageData(0, 0, w, h).data;
      let clear = 0;
      for (let i = 3; i < d.length; i += 4) if (d[i] < 8) clear++;

      return {
        from: [img.naturalWidth, img.naturalHeight],
        to: [w, h],
        clear: +((clear / (d.length / 4)) * 100).toFixed(1),
        data: c.toDataURL('image/webp', quality),
      };
    },
    [raw.toString('base64'), `image/${extname(file).slice(1).replace('jpg', 'jpeg')}`, maxEdge, QUALITY],
  );

  const out = Buffer.from(result.data.split(',')[1], 'base64');
  const outName = file.replace(/\.[^.]+$/, '.webp');
  writeFileSync(join(OUT, outName), out);

  before += inSize;
  after += out.length;
  const cut = Math.round((1 - out.length / inSize) * 100);
  console.log(
    `  ${file.padEnd(32)} ${String(result.from.join('×')).padStart(9)} → ${result.to.join('×')}` +
      `  ${kb(inSize).padStart(7)} → ${kb(out.length).padStart(6)}  (-${String(cut).padStart(2)}%)` +
      `  とうめい ${String(result.clear).padStart(5)}%`,
  );
}

console.log(`\n  合計 ${kb(before)} → ${kb(after)}  (-${Math.round((1 - after / before) * 100)}%)`);

await browser.close();

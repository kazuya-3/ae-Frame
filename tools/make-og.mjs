/**
 * リンクを貼ったときに出る絵（og:image）を作り直す。
 *
 *   node tools/make-og.mjs
 *
 * 版下は tools/og/og.html。Chromium で開いて 1200×630 をそのまま撮り、
 * public/og-image.jpg に書く。作り置きの画像ファイルを手で差し替えるのをやめて、
 * **書いてあることを読める形**にしておくための道具。
 *
 * ── なぜ JPEG か ──
 *
 * 前は 935KB の PNG だった。中身は写真とグラデーションで、PNG がいちばん
 * 苦手なもの。1200×630 の JPEG なら、見た目を落とさず1/10以下に入る。
 * 相手のサーバーが読む絵なので、対応形式のいちばん広いところに合わせる
 * （JPEG は主要な場所すべてで通る。WebP は通らないところが残る）。
 *
 * ── なぜフォントを取りにいくのか ──
 *
 * 本体の字は丸ゴシックで、この環境には入っていない。無いまま撮ると、
 * 別の字で出来た絵が公開まで気づかれずに進む。
 * 読めなかったら**撮らずに止める**。黙って違うものを出すよりいい。
 */
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { statSync } from 'node:fs';
import { chromium } from 'playwright';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const OUT = join(root, 'public', 'og-image.jpg');
const PORT = Number(process.env.PORT ?? 4188);

/** 実際に貼られる場所の実務上の上限。超えたら中身を疑う */
const MAX_KB = 300;

/*
  file:// で開くとウェブフォントの取得が同一生成元の扱いで弾かれることがある。
  版下を1枚配るだけの静的サーバーを立てて、http で開く。
*/
const server = spawn(
  process.execPath,
  [
    '-e',
    `
    const http=require('http'),fs=require('fs'),path=require('path');
    const root=${JSON.stringify(join(here, 'og'))};
    http.createServer((q,r)=>{
      let p=path.join(root, decodeURIComponent(q.url.split('?')[0]));
      if(q.url==='/') p=path.join(root,'og.html');
      if(!fs.existsSync(p)){ r.writeHead(404); return r.end(); }
      r.writeHead(200,{'Content-Type': p.endsWith('.html')?'text/html':'application/octet-stream'});
      fs.createReadStream(p).pipe(r);
    }).listen(${PORT});
    `,
  ],
  { stdio: 'ignore' },
);

await new Promise((r) => setTimeout(r, 600));

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
try {
  const page = await browser.newPage({
    viewport: { width: 1200, height: 630 },
    deviceScaleFactor: 1,
  });
  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'networkidle' });
  await page.evaluate(() => document.fonts.ready);

  const ok = await page.evaluate(() => document.fonts.check('700 60px "Zen Maru Gothic"'));
  if (!ok) {
    throw new Error(
      '丸ゴシックを読み込めませんでした（通信が要ります）。\n' +
        '別の字のまま撮ると、違う絵が公開まで進むので止めました。',
    );
  }

  await page.screenshot({ path: OUT, type: 'jpeg', quality: 86 });

  const kb = statSync(OUT).size / 1024;
  console.log(`og-image.jpg  ${kb.toFixed(1)} KB  (上限 ${MAX_KB} KB)`);
  if (kb > MAX_KB) {
    throw new Error(`重すぎます。quality を下げるか、中身を減らしてください。`);
  }
  console.log('できました。index.html の og:image と揃っているか確かめてください。');
} finally {
  await browser.close();
  server.kill();
}

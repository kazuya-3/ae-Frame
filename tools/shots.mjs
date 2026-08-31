/**
 * 実績紹介などに載せる画面の写真を撮る。
 *
 * 撮る先は **dist**（配っているものそのもの）。開発サーバーではない。
 * 公開URLを直接撮れれば早いが、この作業環境からは github.io へ出られないので、
 * 同じバイト列をここで配って撮る。
 *
 *   npm run build && node tools/shots.mjs
 *
 * 使う写真は、その場で描く「顔の無いアバター」。
 * 実在の人物の写真は使わない。OG画像と同じ描きかたにしてあるので、
 * 出来上がりの雰囲気もサイトの案内画像とそろう。
 */
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';

const DIST = resolve('dist');
const OUT = resolve(process.argv[2] ?? 'shots');
const FRAME = resolve('tests/fixtures/neon.png');
const PORT = 4183;
const VIEWPORT = { width: 1280, height: 900 };

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.wasm': 'application/wasm',
  '.json': 'application/json',
};

function serve() {
  const server = createServer(async (req, res) => {
    const url = decodeURIComponent((req.url ?? '/').split('?')[0]);
    let file = join(DIST, url.replace(/^\/ae-Frame/, ''));
    if (!existsSync(file) || url.endsWith('/')) file = join(DIST, 'index.html');
    try {
      const body = await readFile(file);
      res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' });
      res.end(body);
    } catch {
      res.writeHead(404).end('not found');
    }
  });
  return new Promise((ok) => server.listen(PORT, () => ok(server)));
}

/** 顔の無いアバターを1枚描いて PNG にする（OG画像と同じ描きかた）。 */
async function makeAvatar(page, file) {
  const dataUrl = await page.evaluate(() => {
    const S = 900;
    const C = S / 2;
    const c = document.createElement('canvas');
    c.width = S;
    c.height = S;
    const ctx = c.getContext('2d');
    const p = ctx.createLinearGradient(0, 0, S, S);
    p.addColorStop(0, '#6e7bd8');
    p.addColorStop(0.5, '#c58ec2');
    p.addColorStop(1, '#e8b48a');
    ctx.fillStyle = p;
    ctx.fillRect(0, 0, S, S);
    ctx.fillStyle = 'rgba(22,22,29,0.16)';
    ctx.beginPath();
    ctx.arc(C, C * 0.86, S * 0.135, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.ellipse(C, C * 1.62, S * 0.23, S * 0.2, 0, Math.PI, Math.PI * 2);
    ctx.fill();
    return c.toDataURL('image/png');
  });
  await writeFile(file, Buffer.from(dataUrl.split(',')[1], 'base64'));
}

/**
 * 中身の入っているところだけを、幅いっぱいで撮る。
 *
 * fullPage で撮ると、この道具は縦にとても長い（設定が全部出ているため）。
 * 実績の一覧に並べると、細長い帯になって何も読めない。
 * 逆に画面の高さで切ると、下に白場が大きく余る。
 * だから**中身の下端**を測って、そこで切る。
 */
const shot = async (name, maxHeight = 1000) => {
  const bottom = await page.evaluate(() => {
    const els = [...document.querySelectorAll('body *')];
    let y = 0;
    for (const el of els) {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) y = Math.max(y, r.bottom);
    }
    return Math.ceil(y + 16);
  });
  const height = Math.min(Math.max(bottom, 320), maxHeight);
  await page.screenshot({
    path: join(OUT, name),
    clip: { x: 0, y: 0, width: VIEWPORT.width, height },
  });
  console.log(`   ${name}  ${VIEWPORT.width}x${height}`);
};

const server = await serve();
await mkdir(OUT, { recursive: true });
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined,
});
const page = await browser.newPage({ viewport: VIEWPORT, deviceScaleFactor: 1 });
const BASE = `http://localhost:${PORT}/`;

console.log('撮っています…');

// ── はじめて開いた人が見る画面（3ステップの説明が出ている） ──
await page.goto(BASE, { waitUntil: 'networkidle' });
await page.waitForTimeout(1200);
await shot('works-ae-frame-steps.png', 940);

// ── トップ（説明を閉じた、何も入れていない状態） ──
await page.getByRole('button', { name: 'はじめる' }).click();
await page.waitForTimeout(700);
await shot('works-ae-frame-top.png', 940);

// ── フレームをえらぶ画面（持ちこんでもらう。品ぞろえは無い） ──
const avatar = join(OUT, '_avatar.png');
await makeAvatar(page, avatar);
await page.setInputFiles('input[type=file]', avatar);
await page.waitForTimeout(900);
await page.getByRole('button', { name: /つぎへ：フレームをえらぶ/ }).click();
await page.waitForTimeout(600);
await shot('works-ae-frame-frames.png', 940);

// ── 背景をけした直後（この道具の中心） ──
await page.setInputFiles('input[type=file]', FRAME);
await page.waitForTimeout(4500);
await shot('works-ae-frame-cutout.png', 1000);

// ── 完成後（重ねて位置をあわせる画面） ──
await page.getByRole('button', { name: /これでOK/ }).click();
await page.waitForTimeout(2500);
await shot('works-ae-frame-result.png', 1000);

await browser.close();
server.close();
console.log(`\n保存先: ${OUT}`);

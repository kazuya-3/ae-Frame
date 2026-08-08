/**
 * 実際のブラウザで通しに動かす検証。
 *
 *   npm run build && npm test
 *
 * 透過の良し悪しは目で見ないと分からない、と思われがちだけれど、
 * 「四隅が透明か」「囲まれた白が残っているか」「グローが階調で残っているか」は
 * 出力画素のアルファを読めば機械的に確かめられる。ここではそれをやっている。
 */
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { build } from './fixtures.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const FIXTURES = build();
const PORT = Number(process.env.PORT ?? 4180);
const BASE = `http://127.0.0.1:${PORT}/`;

const failures = [];
let checks = 0;

function check(name, ok, extra = '') {
  checks++;
  console.log(
    `  ${ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  ${name}${extra ? '  ' + extra : ''}`,
  );
  if (!ok) failures.push(name);
}

/* ---------------- 静的サーバー ---------------- */

function serve() {
  const child = spawn(
    process.execPath,
    [
      '-e',
      `
      const http=require('http'),fs=require('fs'),path=require('path');
      const root=${JSON.stringify(join(root, 'dist'))};
      const types={'.html':'text/html','.js':'text/javascript','.css':'text/css','.png':'image/png',
        '.svg':'image/svg+xml','.wasm':'application/wasm','.webmanifest':'application/manifest+json'};
      http.createServer((req,res)=>{
        let p=path.join(root, decodeURIComponent(req.url.split('?')[0]));
        if(!p.startsWith(root)) { res.writeHead(403); return res.end(); }
        if(fs.existsSync(p)&&fs.statSync(p).isDirectory()) p=path.join(p,'index.html');
        if(!fs.existsSync(p)) { res.writeHead(404); return res.end('not found'); }
        res.writeHead(200,{'Content-Type':types[path.extname(p)]||'application/octet-stream'});
        fs.createReadStream(p).pipe(res);
      }).listen(${PORT});
      `,
    ],
    { stdio: 'ignore' },
  );
  return child;
}

/* ---------------- 画面操作のヘルパー ---------------- */

async function openFrame(browser, frameFile, photoFile = 'photo-color.png') {
  const page = await browser.newPage({ viewport: { width: 390, height: 900 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e.message)));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));

  // AI モデルの取得は外部通信。検証では止めて、通信できない端末を再現する。
  let aiRequested = false;
  const blockAi = (r) => {
    aiRequested = true;
    r.abort();
  };
  await page.route('**huggingface.co/**', blockAi);
  await page.route('**cdn.jsdelivr.net/**', blockAi);

  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page
    .getByRole('button', { name: 'はじめる' })
    .click()
    .catch(() => {});
  await page.setInputFiles('input[type=file]', join(FIXTURES, photoFile));
  await page.waitForTimeout(500);
  await page.getByRole('button', { name: /つぎへ：フレームをえらぶ/ }).click();
  await page.waitForTimeout(250);
  await page.setInputFiles('input[type=file]', join(FIXTURES, frameFile));
  await page.waitForTimeout(4000);

  return { page, errors, aiRequested: () => aiRequested };
}

/** プレビュー上の相対座標(0..1)のアルファ */
const alphaAt = (page, fx, fy) =>
  page.evaluate(
    ([fx, fy]) => {
      const c = document.querySelector('.preview canvas');
      const d = c.getContext('2d');
      return d.getImageData(Math.round(c.width * fx), Math.round(c.height * fy), 1, 1).data[3];
    },
    [fx, fy],
  );

const alphaHistogram = (page) =>
  page.evaluate(() => {
    const c = document.querySelector('.preview canvas');
    const px = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let opaque = 0;
    let semi = 0;
    let clear = 0;
    for (let i = 3; i < px.length; i += 4) {
      const a = px[i];
      if (a > 240) opaque++;
      else if (a < 10) clear++;
      else semi++;
    }
    const n = c.width * c.height;
    return { opaque: opaque / n, semi: semi / n, clear: clear / n };
  });

/* ---------------- 本体 ---------------- */

const server = serve();
await new Promise((r) => setTimeout(r, 900));
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });

try {
  console.log('\n■ 線画（白地に黒い線）');
  {
    const { page, errors } = await openFrame(browser, 'lineart.png');
    check('四隅が透明になる', (await alphaAt(page, 0.01, 0.01)) < 10);
    check('まん中の穴が透明になる', (await alphaAt(page, 0.5, 0.5)) < 10);
    check('線そのものは残る', (await alphaAt(page, 0.5, 0.08)) > 240);
    check('AIを使わずに済む', errors.length === 0);
    await page.close();
  }

  console.log('\n■ すでに透過ずみの PNG');
  {
    const { page } = await openFrame(browser, 'already-transparent.png');
    check('もとの透過をそのまま通す', (await alphaAt(page, 0.01, 0.01)) < 10);
    check('絵は消さない', (await alphaAt(page, 0.5, 0.08)) > 240);
    await page.close();
  }

  console.log('\n■ ネオン（外周のグローが白地へにじむ）');
  {
    const { page } = await openFrame(browser, 'neon.png');
    const h = await alphaHistogram(page);
    check('四隅が透明になる', (await alphaAt(page, 0.01, 0.01)) < 10);
    check('まん中の穴が透明になる', (await alphaAt(page, 0.5, 0.5)) < 10);
    check('リング本体は完全に不透明', (await alphaAt(page, 0.5, 0.119)) > 240);
    // ここが肝。半透明の画素が十分あれば、光が階調のまま生きている。
    check('グローが階調のまま残る', h.semi > 0.04, `半透明 ${(h.semi * 100).toFixed(1)}%`);
    await page.close();
  }

  console.log('\n■ 祭（提灯の紙・狐面のような囲まれた白）');
  {
    const { page } = await openFrame(browser, 'festival.png');
    check('四隅が透明になる', (await alphaAt(page, 0.01, 0.01)) < 10);
    check('まん中の穴が透明になる', (await alphaAt(page, 0.5, 0.5)) < 10);
    for (const [label, ang] of [
      ['提灯の紙', -0.6],
      ['狐面の白', 2.4],
    ]) {
      const a = await alphaAt(page, 0.5 + 0.38 * Math.cos(ang), 0.5 + 0.38 * Math.sin(ang));
      check(`囲まれた白（${label}）に穴が開かない`, a > 240, `alpha=${a}`);
    }
    await page.close();
  }

  console.log('\n■ 金魚（うすい水色＋囲まれた白い泡）');
  {
    const { page } = await openFrame(browser, 'water.png');
    check('四隅が透明になる', (await alphaAt(page, 0.01, 0.01)) < 10);
    check('まん中の穴が透明になる', (await alphaAt(page, 0.5, 0.5)) < 10);
    const ring = await alphaAt(page, 0.5, 0.13);
    check('うすい色が半透明にならない', ring > 240, `alpha=${ring}`);
    const bubble = await alphaAt(page, 0.87, 0.5);
    check('囲まれた白い泡が残る', bubble > 240, `alpha=${bubble}`);
    await page.close();
  }

  console.log('\n■ クリスタル（白いガラスを白地に＝色では判別不能）');
  {
    const { page, aiRequested } = await openFrame(browser, 'glass.png');
    check('自分で検算して AI に切り替える', aiRequested());
    check(
      'AIが使えなくても次へ進める',
      await page.getByRole('button', { name: /これでOK/ }).isEnabled(),
    );
    await page.close();
  }

  console.log('\n■ 暗い写真に重ねたときの発色');
  {
    const { page } = await openFrame(browser, 'neon.png', 'photo-dark.png');
    await page.getByRole('button', { name: /これでOK/ }).click();
    await page.waitForTimeout(1500);
    const c = await page.evaluate(() => {
      const cv = document.querySelector('.stage canvas');
      const d = cv.getContext('2d');
      const g = (fx, fy) => [
        ...d.getImageData(Math.round(cv.width * fx), Math.round(cv.height * fy), 1, 1).data,
      ];
      return { top: g(0.5, 0.045), bottom: g(0.5, 0.955) };
    });
    // 逆合成が効いていれば、暗い背景の上でもグローは色を保つ。
    // 効いていないと、白と混ざったままの灰色に見える。
    check(
      '上のグローが水色に見える',
      c.top[1] > c.top[0] + 15 && c.top[2] > c.top[0] + 15,
      `rgb=${c.top.slice(0, 3)}`,
    );
    check(
      '下のグローがピンクに見える',
      c.bottom[0] > c.bottom[1] + 15,
      `rgb=${c.bottom.slice(0, 3)}`,
    );
    await page.close();
  }

  console.log('\n■ 手なおしと、画面を移動しても消えないこと');
  {
    const { page, errors } = await openFrame(browser, 'lineart.png');
    const opaque = () =>
      page.evaluate(() => {
        const c = document.querySelector('.preview canvas');
        const px = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
        let n = 0;
        for (let i = 3; i < px.length; i += 4) if (px[i] > 200) n++;
        return n;
      });
    const stroke = async () => {
      const cv = page.locator('.preview canvas');
      await cv.scrollIntoViewIfNeeded();
      await page.waitForTimeout(250);
      const b = await cv.boundingBox();
      await page.mouse.move(b.x + b.width * 0.5, b.y + b.height * 0.06);
      await page.mouse.down();
      await page.mouse.move(b.x + b.width * 0.5, b.y + b.height * 0.4, { steps: 15 });
      await page.mouse.up();
      await page.waitForTimeout(500);
    };

    await page.getByRole('button', { name: /うまく消えないときは/ }).click();
    await page.waitForTimeout(250);
    const base = await opaque();

    await page.getByRole('button', { name: '消しのこりを消す', exact: true }).click();
    await stroke();
    const erased = await opaque();
    check('筆でなぞると消える', erased < base, `${base} → ${erased}`);

    await page.getByRole('button', { name: /1つ前/ }).click();
    await page.waitForTimeout(400);
    check('「1つ前」で取り消せる', Math.abs((await opaque()) - base) < base * 0.02);

    // 筆は「消す」のまま。ここで押し直すとトグルで解除され、
    // 何も編集していない状態を「保たれた」と誤判定してしまう。
    await stroke();
    const edited = await opaque();
    check('取り消したあと、もう一度なぞれる', edited < base, `${base} → ${edited}`);

    await page.getByRole('button', { name: /これでOK/ }).click();
    await page.waitForTimeout(1200);
    await page.getByRole('button', { name: /背景けしにもどる/ }).click();
    await page.waitForTimeout(800);
    check(
      '画面を行き来しても手なおしが残る',
      (await opaque()) === edited,
      `${edited} → ${await opaque()}`,
    );
    check(
      '「くわしい設定」も開いたまま',
      (await page.evaluate(() => document.querySelector('.disclosure')?.dataset.open)) === 'true',
    );
    check('コンソールエラーなし', errors.length === 0, errors.slice(0, 2).join(' | '));
    await page.close();
  }

  console.log('\n■ 書き出し');
  {
    const { page } = await openFrame(browser, 'neon.png');
    await page.getByRole('button', { name: /これでOK/ }).click();
    await page.waitForTimeout(1200);
    const dl = page.waitForEvent('download', { timeout: 20000 }).catch(() => null);
    await page.getByRole('button', { name: /画像をほぞんする|ほぞん・シェアする/ }).click();
    const d = await dl;
    check('PNG が保存できる', !!d, d ? d.suggestedFilename() : '');
    await page.close();
  }
} finally {
  await browser.close();
  server.kill();
}

console.log(
  failures.length
    ? `\n\x1b[31m${failures.length} 件 失敗\x1b[0m（全 ${checks} 件）\n${failures.map((f) => '  - ' + f).join('\n')}\n`
    : `\n\x1b[32m全 ${checks} 件 合格\x1b[0m\n`,
);
process.exit(failures.length ? 1 : 0);

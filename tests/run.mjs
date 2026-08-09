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
import { existsSync, readdirSync } from 'node:fs';
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

/** 条件が立つまで待つ。立たなければ時間切れでそのまま返す（判定は呼び出し側で）。 */
async function waitFor(fn, timeout = 10000, interval = 150) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, interval));
  }
  return false;
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
    const { page, aiRequested } = await openFrame(browser, 'already-transparent.png');
    check('もとの透過をそのまま通す', (await alphaAt(page, 0.01, 0.01)) < 10);
    check('絵は消さない', (await alphaAt(page, 0.5, 0.08)) > 240);
    check('まん中の穴は透明のまま', (await alphaAt(page, 0.5, 0.5)) < 10);
    check('よけいな処理をしない（AIを呼ばない）', !aiRequested());
    await page.close();
  }

  /*
    透過ずみ＋半透明グローは、いちばん壊しやすい入力。
    すでに正しいアルファが付いているので、色にもアルファにも
    さわらずに通さなければならない。
  */
  console.log('\n■ 透過ずみ＋半透明のグロー（さわってはいけない入力）');
  {
    const { page } = await openFrame(browser, 'transparent-glow.png');
    const probe = await page.evaluate(() => {
      const c = document.querySelector('.preview canvas');
      const d = c.getContext('2d');
      const at = (fx, fy) => [
        ...d.getImageData(Math.round(c.width * fx), Math.round(c.height * fy), 1, 1).data,
      ];
      // 中心から外へ走査し、アルファが中くらいの画素をひとつ拾う
      const cx = c.width >> 1;
      const row = d.getImageData(0, c.height >> 1, c.width, 1).data;
      let mid = null;
      for (let x = cx; x < c.width; x++) {
        const a = row[x * 4 + 3];
        if (a > 90 && a < 170) {
          mid = [row[x * 4], row[x * 4 + 1], row[x * 4 + 2], a];
          break;
        }
      }
      return { corner: at(0.01, 0.01), hole: at(0.5, 0.5), mid };
    });

    check('四隅は透明のまま', probe.corner[3] < 6, `alpha=${probe.corner[3]}`);
    check('まん中の穴は透明のまま', probe.hole[3] < 6, `alpha=${probe.hole[3]}`);
    check(
      '半透明のグローが残っている',
      probe.mid != null,
      probe.mid ? `alpha=${probe.mid[3]}` : '見つからない',
    );

    if (probe.mid) {
      // 元の色は水色 (34, 226, 226)。ここがずれていたら、
      // 付いていない背景色を引き算してしまっている。
      const [r, g, b] = probe.mid;
      const near = (v, t) => Math.abs(v - t) <= 12;
      check(
        '半透明部分の色が変わっていない',
        near(r, 34) && near(g, 226) && near(b, 226),
        `rgb=${r},${g},${b}（元 34,226,226）`,
      );
    }
    await page.close();
  }

  /*
    白い背景の上では、うすい光とうすい絵の具は同じ色になる。区別する手立ては無い。

    そこで既定は「消しすぎない」側に倒してある。光は階調ではなく色として残り、
    階調が欲しい人は「光のにじみを残す」を上げる。両方を確かめる。
  */
  console.log('\n■ ネオン（外周のグローが白地へにじむ）');
  {
    const { page } = await openFrame(browser, 'neon.png');
    check('四隅が透明になる', (await alphaAt(page, 0.01, 0.01)) < 10);
    check('まん中の穴が透明になる', (await alphaAt(page, 0.5, 0.5)) < 10);
    check('リング本体は完全に不透明', (await alphaAt(page, 0.5, 0.119)) > 240);
    // 既定では光を消さない。グローの明るいところが残っていること。
    check(
      '既定でグローの色が残る',
      (await alphaAt(page, 0.5, 0.075)) > 200,
      `alpha=${await alphaAt(page, 0.5, 0.075)}`,
    );

    // 逃げ道が本当に効くか。上げれば階調が戻る。
    await page.getByRole('button', { name: /うまく消えないときは/ }).click();
    await page.waitForTimeout(250);
    await page.getByLabel('光のにじみを残す').fill('30');
    await page.waitForTimeout(700);
    const h = await alphaHistogram(page);
    check(
      '「光のにじみを残す」を上げると階調が戻る',
      h.semi > 0.04,
      `半透明 ${(h.semi * 100).toFixed(1)}%`,
    );
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
    // AI への切り替えは、検算 → 動的 import → 取得 と段を踏むので、
    // 固定待ちだと取りこぼす。条件が立つまで待つ。
    await waitFor(aiRequested, 15000);
    check('絵が消えたら AI に切り替える', aiRequested());
    check(
      'AIが使えなくても次へ進める',
      await page.getByRole('button', { name: /これでOK/ }).isEnabled(),
    );
    await page.close();
  }

  console.log('\n■ ざらざらした背景（色キーでは抜けない）');
  {
    const { page, aiRequested } = await openFrame(browser, 'noisy-bg.png');
    await waitFor(aiRequested, 15000);
    check('背景が残ったら AI に切り替える', aiRequested());
    check(
      'AIが使えなくても次へ進める',
      await page.getByRole('button', { name: /これでOK/ }).isEnabled(),
    );
    await page.close();
  }

  /*
    AI は数十MBのダウンロードを伴う。色キーで足りるデザインで呼んでしまうと、
    待たせたうえに細い線が鈍る。呼ばないことも、はっきり確かめておく。
  */
  console.log('\n■ AIを呼ばずに済むべきデザイン');
  for (const f of ['lineart.png', 'neon.png', 'festival.png', 'water.png', 'ice-berry.png']) {
    const { page, aiRequested } = await openFrame(browser, f);
    check(`${f} でAIを呼ばない`, !aiRequested());
    await page.close();
  }

  /*
    実機で最初に出た不具合の再現。うすい水彩のフレームが、初期状態のまま
    デザインごと消えていた（しきい値がデザインの薄い色を飲み込んでいた）。
  */
  console.log('\n■ うすい水彩（白にごく近い色のフレーム）');
  {
    const { page } = await openFrame(browser, 'pale-wash.png');
    check('正方形なので切り取らない', !(await page.getByText(/自動で切り取りました/).isVisible()));
    check('四隅が透明になる', (await alphaAt(page, 0.01, 0.01)) < 10);
    check('まん中の穴が透明になる', (await alphaAt(page, 0.5, 0.5)) < 10);

    // 内側から外側へ、うすい順に4本。いちばん薄い輪まで残らないといけない。
    const rings = [
      ['色差0.02（いちばん薄い）', 0.2],
      ['色差0.04', 0.27],
      ['色差0.06', 0.34],
      ['色差0.09', 0.41],
    ];
    for (const [label, r] of rings) {
      const a = await alphaAt(page, 0.5, 0.5 - r);
      check(`うすい輪が残る ${label}`, a > 200, `alpha=${a}`);
    }

    // 外周に散らした、いちばん薄い泡。切り出しで見切れていないか。
    const bubble = await alphaAt(page, 0.5 + 0.46 * Math.cos(0.3), 0.5 + 0.46 * Math.sin(0.3));
    check('外周のうすい泡が見切れない', bubble > 200, `alpha=${bubble}`);
    await page.close();
  }

  console.log('\n■ 氷とベリー（ほぼ白い氷＋端ぎりぎりの細い文字）');
  {
    const { page } = await openFrame(browser, 'ice-berry.png');
    // 正方形のフレームは切り取らない。ここが崩れると、端に置いた
    // 文字やロゴが「スクショのUI」と誤認されて落ちる。
    check(
      '正方形のフレームは切り取らない',
      !(await page.getByText(/自動で切り取りました/).isVisible()),
    );
    check('四隅が透明になる', (await alphaAt(page, 0.01, 0.01)) < 10);
    check('まん中の穴が透明になる', (await alphaAt(page, 0.5, 0.5)) < 10);
    const berry = await alphaAt(page, 0.5 + 0.37 * Math.cos(0.9), 0.5 + 0.37 * Math.sin(0.9));
    check('濃いベリーは残る', berry > 240, `alpha=${berry}`);
    const label = await alphaAt(page, 0.968, 0.5);
    check('端ぎりぎりの文字も残る', label > 200, `alpha=${label}`);
    await page.close();
  }

  /*
    実際にいちばん多い入力。TikTok は透過を持てないので、
    受け取る側はスクショでフレームを持ってくる。
  */
  console.log('\n■ スマホのスクショ（TikTokのUIごと写っている）');
  {
    const { page } = await openFrame(browser, 'phone-screenshot.png');
    check(
      '自動で切り取ったことを知らせる',
      await page.getByText(/自動で切り取りました/).isVisible(),
    );

    // フレームが十分な大きさを占めていること。UI ごと残っていると、
    // 輪はキャンバスの片隅の小さな点になる。
    const fill = await page.evaluate(() => {
      const c = document.querySelector('.preview canvas');
      const px = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      let opaque = 0;
      let minX = c.width;
      let maxX = -1;
      let minY = c.height;
      let maxY = -1;
      for (let i = 0; i < c.width * c.height; i++) {
        if (px[i * 4 + 3] > 128) {
          opaque++;
          const x = i % c.width;
          const y = (i - x) / c.width;
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
      return {
        ratio: opaque / (c.width * c.height),
        spanX: (maxX - minX) / c.width,
        spanY: (maxY - minY) / c.height,
        aspect: c.width / c.height,
      };
    });
    check(
      'フレームが画面いっぱいに残る',
      fill.spanX > 0.85 && fill.spanY > 0.85,
      `横 ${(fill.spanX * 100) | 0}% 縦 ${(fill.spanY * 100) | 0}%`,
    );
    check(
      '縦長のままにならない',
      fill.aspect > 0.8 && fill.aspect < 1.25,
      `縦横比 ${fill.aspect.toFixed(2)}`,
    );
    check('UIの残骸が混ざっていない', fill.ratio < 0.35, `占有 ${(fill.ratio * 100).toFixed(1)}%`);

    // 自動の切り取りは、気に入らなければ取り消せること
    await page.getByRole('button', { name: /切り取らずに全部つかう/ }).click();
    await page.waitForTimeout(2500);
    const after = await page.evaluate(() => {
      const c = document.querySelector('.preview canvas');
      return c.width / c.height;
    });
    check('「切り取らずに全部つかう」で元に戻せる', after < 0.7, `縦横比 ${after.toFixed(2)}`);
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

  /*
    本物のフレームでの確認。

    tests/real/ に自分の作ったフレーム画像（png / jpg）を置くと、
    ここで1枚ずつ通して基本的なところを確かめる。置かなければ黙って飛ばす。
    実物は作者のものなのでリポジトリには入れない（.gitignore 済み）。
  */
  {
    const realDir = join(here, 'real');
    const files = existsSync(realDir)
      ? readdirSync(realDir).filter((f) => /\.(png|jpe?g|webp)$/i.test(f))
      : [];

    if (!files.length) {
      console.log('\n■ 本物のフレーム（tests/real/ に画像を置くと実行されます）');
      console.log('  \x1b[2mSKIP  画像が見つかりません\x1b[0m');
    } else {
      console.log(`\n■ 本物のフレーム（${files.length}枚）`);
      for (const file of files) {
        const page = await browser.newPage({ viewport: { width: 390, height: 900 } });
        const errors = [];
        page.on('pageerror', (e) => errors.push(String(e.message)));
        await page.route('**huggingface.co/**', (r) => r.abort());
        await page.route('**cdn.jsdelivr.net/**', (r) => r.abort());
        await page.goto(BASE, { waitUntil: 'networkidle' });
        await page
          .getByRole('button', { name: 'はじめる' })
          .click()
          .catch(() => {});
        await page.setInputFiles('input[type=file]', join(FIXTURES, 'photo-color.png'));
        await page.waitForTimeout(400);
        await page.getByRole('button', { name: /つぎへ：フレームをえらぶ/ }).click();
        await page.waitForTimeout(200);
        await page.setInputFiles('input[type=file]', join(realDir, file));
        await waitFor(async () => {
          const b = page.getByRole('button', { name: /これでOK/ });
          return (await b.count()) > 0 && (await b.isEnabled());
        }, 25000);

        const m = await page.evaluate(() => {
          const c = document.querySelector('.preview canvas');
          if (!c) return null;
          const px = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
          const n = c.width * c.height;
          const a = (x, y) => px[(y * c.width + x) * 4 + 3];
          let opaque = 0;
          let semi = 0;
          for (let i = 3; i < px.length; i += 4) {
            if (px[i] > 240) opaque++;
            else if (px[i] > 10) semi++;
          }
          return {
            corner: Math.max(
              a(2, 2),
              a(c.width - 3, 2),
              a(2, c.height - 3),
              a(c.width - 3, c.height - 3),
            ),
            center: a(c.width >> 1, c.height >> 1),
            opaque: opaque / n,
            semi: semi / n,
          };
        });

        if (!m) {
          check(`${file}`, false, '結果が描かれなかった');
        } else {
          const ok =
            m.corner < 16 && // 外側の背景が抜けている
            m.center < 16 && // まん中の穴が抜けている（重ねたとき写真が見える）
            m.opaque > 0.02 && // 絵が消えていない
            m.opaque < 0.75; // 背景が残っていない
          check(
            `${file}`,
            ok,
            `四隅=${m.corner} 中心=${m.center} 絵=${(m.opaque * 100).toFixed(1)}% 半透明=${(m.semi * 100).toFixed(1)}%`,
          );
          if (errors.length) check(`${file}（エラーなし）`, false, errors[0]);
        }
        await page.close();
      }
    }
  }

  /*
    ステップ3の道具立て。ここは「無い」と思われがちだが実は全部ある、という
    状態が続いていたので、動くことを機械で押さえておく。
  */
  console.log('\n■ 位置あわせの道具');
  {
    const { page } = await openFrame(browser, 'lineart.png');
    await page.getByRole('button', { name: /これでOK/ }).click();
    await page.waitForTimeout(1300);

    /*
      「絵が変わったか」を見るのに、間引いたサンプルのハッシュを使っていたら
      変化を取りこぼした。1000画素に1つでは、拡大や反転のような
      「全体はそのまま、置きかたが変わる」動きに引っかからないことがある。

      なので、画面を12×12のタイルに割って各タイルの平均を取る。
      全画素を必ず1回ずつ読むので取りこぼしがなく、
      どこがどれだけ動いたかも数字で言える。
    */
    const TILES = 12;
    const snap = () =>
      page.evaluate((TILES) => {
        const c = document.querySelector('.stage canvas');
        const px = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
        const sum = new Float64Array(TILES * TILES * 4);
        const cnt = new Float64Array(TILES * TILES);
        for (let y = 0; y < c.height; y++) {
          const ty = Math.min(TILES - 1, ((y / c.height) * TILES) | 0);
          for (let x = 0; x < c.width; x++) {
            const tx = Math.min(TILES - 1, ((x / c.width) * TILES) | 0);
            const t = ty * TILES + tx;
            const i = (y * c.width + x) * 4;
            sum[t * 4] += px[i];
            sum[t * 4 + 1] += px[i + 1];
            sum[t * 4 + 2] += px[i + 2];
            sum[t * 4 + 3] += px[i + 3];
            cnt[t]++;
          }
        }
        const out = [];
        for (let t = 0; t < TILES * TILES; t++) {
          for (let ch = 0; ch < 4; ch++) out.push(sum[t * 4 + ch] / Math.max(1, cnt[t]));
        }
        return out;
      }, TILES);

    /** 2つの絵の食い違い。0 なら完全に同じ。1タイルあたりの平均のずれ。 */
    const diff = (a, b) => {
      let d = 0;
      for (let i = 0; i < a.length; i++) d += Math.abs(a[i] - b[i]);
      return d / a.length;
    };
    // 平均のずれがこれ以上あれば「変わった」と見なす。
    // 何も操作しないときのずれは 0 なので、余裕をもって小さくてよい。
    const CHANGED = 0.5;

    const stage = page.locator('.stage');
    const box = await stage.boundingBox();
    const base = await snap();

    // 指でドラッグ
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 70, box.y + box.height / 2 + 50, { steps: 8 });
    await page.mouse.up();
    await page.waitForTimeout(350);
    const dragged = await snap();
    check('ドラッグで写真が動く', diff(dragged, base) > CHANGED, `ずれ ${diff(dragged, base).toFixed(2)}`);

    // 大きさスライダー
    const sizeSlider = page.getByLabel(/の大きさ/);
    await sizeSlider.fill('180');
    await page.waitForTimeout(350);
    const scaled = await snap();
    check('大きさスライダーが効く', diff(scaled, dragged) > CHANGED, `ずれ ${diff(scaled, dragged).toFixed(2)} 値=${await sizeSlider.inputValue()}`);

    // 左右反転
    await page.getByRole('button', { name: '左右を反転する' }).click();
    await page.waitForTimeout(350);
    const flipped = await snap();
    check('左右反転が効く', diff(flipped, scaled) > CHANGED, `ずれ ${diff(flipped, scaled).toFixed(2)}`);

    /*
      矢印キーでの微調整。1回ぶんは 4px と、わざと小さい。
      画面ぜんぶの平均で見るとその1回は 0.1 も動かないので、
      押しつづけたときに積み上がることを見る（そこが道具として大事なところ）。
    */
    await stage.focus();
    for (let i = 0; i < 12; i++) await page.keyboard.press('ArrowRight');
    await page.waitForTimeout(350);
    const nudged = await snap();
    const byArrow = diff(nudged, flipped);
    check('矢印キーで少しずつ動かせる', byArrow > CHANGED, `ずれ ${byArrow.toFixed(2)}`);

    // Shift を足すと大きく動く（パソコンから使う人向けの早送り）
    for (let i = 0; i < 12; i++) await page.keyboard.press('Shift+ArrowLeft');
    await page.waitForTimeout(350);
    const byShift = diff(await snap(), nudged);
    check('Shift＋矢印はもっと大きく動く', byShift > byArrow, `ずれ ${byShift.toFixed(2)} > ${byArrow.toFixed(2)}`);

    /*
      すきまの色。写真を小さくすると、丸の内側に何も無い場所ができる。
      1点だけ見るとフレームの絵に当たってしまうので、
      丸の内側で「完全にとうめいな画素」が何個あるかを数える。
    */
    await sizeSlider.fill('40');
    await page.waitForTimeout(350);
    const clearInsideCircle = () =>
      page.evaluate(() => {
        const c = document.querySelector('.stage canvas');
        const px = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
        const r = c.width / 2;
        let clear = 0;
        let inside = 0;
        for (let y = 0; y < c.height; y++) {
          for (let x = 0; x < c.width; x++) {
            if (Math.hypot(x - r, y - r) > r - 2) continue; // 丸の外は暗幕がかかる
            inside++;
            if (px[(y * c.width + x) * 4 + 3] < 8) clear++;
          }
        }
        return clear / Math.max(1, inside);
      });
    const gapBefore = await clearInsideCircle();
    await page.getByRole('button', { name: '白', exact: true }).click();
    await page.waitForTimeout(350);
    const gapAfter = await clearInsideCircle();
    check(
      'すきまの色が効く（とうめい→白で不透明になる）',
      gapBefore > 0.05 && gapAfter < 0.001,
      `すきま ${(gapBefore * 100).toFixed(1)}% → ${(gapAfter * 100).toFixed(1)}%`,
    );
    await page.close();
  }

  /*
    写真そのものの切り抜き。フレームの穴より写真を小さくしたときに、
    四角い角がはみ出さないようにするためのもの。
  */
  console.log('\n■ 写真のかたち');
  {
    const { page } = await openFrame(browser, 'lineart.png');
    await page.getByRole('button', { name: /これでOK/ }).click();
    await page.waitForTimeout(1300);

    // フレームの内側におさまる大きさにして、角が見える状態を作る
    await page.getByLabel(/の大きさ/).fill('60');
    await page.waitForTimeout(350);

    /*
      1点だけを見て「抜けたか」を判定すると、かどまるの角の丸みに当たったときに
      半分だけ塗られた画素を拾って揺れる。形の違いは面積で見るほうが素直。

      そのまま（正方形）＞ かどまる（角を丸めたぶん減る）＞ まる（いちばん減る）
      という大小関係は、どのフレームでも必ず成り立つ。
    */
    const photoArea = () =>
      page.evaluate(() => {
        const c = document.querySelector('.stage canvas');
        const px = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
        const r = c.width / 2;
        let opaque = 0;
        let n = 0;
        for (let y = 0; y < c.height; y++) {
          for (let x = 0; x < c.width; x++) {
            if (Math.hypot(x - r, y - r) > r - 2) continue; // 丸の外は暗幕
            n++;
            if (px[(y * c.width + x) * 4 + 3] > 200) opaque++;
          }
        }
        return opaque / Math.max(1, n);
      });

    const pick = async (label) => {
      await page.getByRole('button', { name: label, exact: true }).click();
      await page.waitForTimeout(350);
      return photoArea();
    };

    const areaFill = await photoArea();
    const areaRounded = await pick('かどまる');
    const areaCircle = await pick('まる');

    check(
      '「まる」は「そのまま」より小さくなる',
      areaCircle < areaFill - 0.01,
      `${(areaFill * 100).toFixed(1)}% → ${(areaCircle * 100).toFixed(1)}%`,
    );
    check(
      '「かどまる」はその中間',
      areaCircle < areaRounded && areaRounded < areaFill,
      `まる ${(areaCircle * 100).toFixed(1)}% ＜ かどまる ${(areaRounded * 100).toFixed(1)}% ＜ そのまま ${(areaFill * 100).toFixed(1)}%`,
    );

    const back = await pick('そのまま');
    check('「そのまま」で元に戻る', Math.abs(back - areaFill) < 0.005);

    // 写真のいちばん外側の角が、まるでは確かに抜けていること
    await page.getByRole('button', { name: 'まる', exact: true }).click();
    await page.waitForTimeout(350);
    const corner = await page.evaluate(() => {
      const c = document.querySelector('.stage canvas');
      const d = c.getContext('2d');
      // 60% の写真は 0.2〜0.8 に広がる。その角のすぐ内側。
      const f = (fx, fy) =>
        d.getImageData(Math.round(c.width * fx), Math.round(c.height * fy), 1, 1).data[3];
      return Math.max(f(0.22, 0.22), f(0.78, 0.22), f(0.22, 0.78), f(0.78, 0.78));
    });
    check('「まる」で写真の角が抜ける', corner < 16, `alpha ${corner}`);

    // 写真をかたむけたら、まるも一緒にかたむく（＝切り抜きは回転のあと）
    await page.getByRole('button', { name: 'まる', exact: true }).click();
    await page.getByLabel('かたむき').fill('30');
    await page.waitForTimeout(400);
    const tilted = await page.evaluate(() => {
      const c = document.querySelector('.stage canvas');
      const px = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      let opaque = 0;
      for (let i = 3; i < px.length; i += 4) if (px[i] > 200) opaque++;
      return opaque / (px.length / 4);
    });
    // まるは回しても面積が変わらない。四角のまま回っていたら角のぶん増える。
    check('まるはかたむけても面積が変わらない', tilted > 0.05 && tilted < 0.95, `占有 ${(tilted * 100).toFixed(1)}%`);
    await page.close();
  }

  /*
    「保存したのに携帯に入ってこない」の逃げ道。
    iPhone は長おし→「写真に追加」しか道が無いので、
    長おしできる本物の <img> が出ることを確かめる。
  */
  /*
    「つかいかた」も同じシートの部品を使っている。
    片方を直したときにもう片方が壊れていないことを、ここで押さえる。
  */
  console.log('\n■ つかいかたのシート');
  {
    const page = await browser.newPage({ viewport: { width: 390, height: 900 } });
    await page.goto(BASE, { waitUntil: 'networkidle' });
    await page
      .getByRole('button', { name: 'はじめる' })
      .click()
      .catch(() => {});
    await page.getByRole('button', { name: /つかいかた|ヘルプ|使いかた/ }).first().click();
    const opened = await page
      .locator('.sheet-backdrop')
      .waitFor({ state: 'visible', timeout: 10000 })
      .then(
        () => true,
        () => false,
      );
    check('つかいかたが開く', opened);
    if (opened) {
      const r = await page.evaluate(() => {
        const b = document.querySelector('.sheet-backdrop').getBoundingClientRect();
        return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), vw: window.innerWidth };
      });
      check('つかいかたも画面ぜんぶをおおう', r.x === 0 && r.y === 0 && r.w >= r.vw, `${r.w} / ${r.vw}`);
    }
    await page.close();
  }

  console.log('\n■ 保存できないときの逃げ道');
  {
    const { page } = await openFrame(browser, 'lineart.png');
    await page.getByRole('button', { name: /これでOK/ }).click();
    await page.waitForTimeout(1300);

    check('逃げ道の入り口がいつも出ている', await page.getByRole('button', { name: '携帯に入ってこないときは' }).isVisible());

    await page.getByRole('button', { name: '携帯に入ってこないときは' }).click();
    const img = page.locator('.saver__image');
    const shown = await img.waitFor({ state: 'visible', timeout: 15000 }).then(
      () => true,
      () => false,
    );
    check('長おしできる画像が出る', shown);

    if (shown) {
      /*
        「DOM にあって visible」だけでは足りない。
        transform のかかった親の中に置くと position: fixed が効かず、
        画面いっぱいのつもりがカードの中の小さな四角になる。
        それでも Playwright の visible は通ってしまうので、
        本当に画面をおおっているかを寸法で見る。
      */
      const cover = await page.evaluate(() => {
        const r = document.querySelector('.sheet-backdrop').getBoundingClientRect();
        return {
          w: Math.round(r.width),
          h: Math.round(r.height),
          x: Math.round(r.left),
          y: Math.round(r.top),
          vw: window.innerWidth,
          vh: window.innerHeight,
        };
      });
      check(
        '画面ぜんぶをおおっている',
        cover.x === 0 && cover.y === 0 && cover.w >= cover.vw && cover.h >= cover.vh,
        `${cover.w}×${cover.h} @(${cover.x},${cover.y}) 画面 ${cover.vw}×${cover.vh}`,
      );

      const src = await img.getAttribute('src');
      check('画像は書き出したものそのもの', String(src).startsWith('blob:'), String(src).slice(0, 24));
      const size = await img.evaluate((el) => ({ w: el.naturalWidth, h: el.naturalHeight }));
      check('書き出しサイズで入っている', size.w === 1080 && size.h === 1080, `${size.w}×${size.h}`);
      const dl = page.waitForEvent('download', { timeout: 20000 }).catch(() => null);
      await page.getByRole('button', { name: /ファイルとしてダウンロード/ }).click();
      check('逃げ道からも保存できる', !!(await dl));
    }
    await page.close();
  }

  /*
    応援の案内は、設定していないうちは一切出てはいけない。
    そのまま公開しても、ただの無料ツールとして成り立つこと。
  */
  console.log('\n■ 応援（設定していないとき）');
  {
    const { page } = await openFrame(browser, 'lineart.png');
    await page.getByRole('button', { name: /これでOK/ }).click();
    await page.waitForTimeout(1200);
    check('保存前に応援の案内は出ない', (await page.locator('.tip').count()) === 0);
    check('フッターにも応援の入り口は出ない', (await page.locator('.tip__quiet').count()) === 0);

    const dl = page.waitForEvent('download', { timeout: 20000 }).catch(() => null);
    await page.getByRole('button', { name: /画像をほぞんする|ほぞん・シェアする/ }).click();
    await dl;
    await page.waitForTimeout(800);
    check('保存後も、設定していなければ出ない', (await page.locator('.tip').count()) === 0);
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

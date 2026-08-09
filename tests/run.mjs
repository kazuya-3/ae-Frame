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
    // AI への切り替えは、検算 → 動的 import → 取得 と段を踏むので、
    // 固定待ちだと取りこぼす。条件が立つまで待つ。
    await waitFor(aiRequested, 15000);
    check('自分で検算して AI に切り替える', aiRequested());
    check(
      'AIが使えなくても次へ進める',
      await page.getByRole('button', { name: /これでOK/ }).isEnabled(),
    );
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

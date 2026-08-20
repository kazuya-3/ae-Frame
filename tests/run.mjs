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
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { build } from './fixtures.mjs';
import { runBudgetChecks, runMp4Checks } from './mp4.mjs';
import { checkDist, checkRepoWords, checkRepoSecrets } from '../tools/check-dist.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const FIXTURES = build();
const PORT = Number(process.env.PORT ?? 4180);
const BASE = `http://127.0.0.1:${PORT}/`;
/*
  ここには「応援のリンクを設定した版」をもう1本ビルドする仕掛けがあった。

  応援（チップ）は、設定を空にすれば消える作りにしてあり、
  本番は空・臨時ビルドは入り、という二重の状態を検証していた。

  2026-08 の Stripe の審査を通したあと、決済まわりを丸ごと外した。
  設定そのものが無いので、二重に持つ状態も無い。配るものは1本だけになった。

  戻すときは、この仕掛けから作り直すことになる。
  そのとき何を満たす必要があるかは docs/stripe-compliance.md に書いてある。
*/

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
        /*
          お試しリンクのような「枠の中で開かれた状態」を再現する。
          allow-downloads を渡さないのがこの再現の要で、
          このときブラウザは <a download> を例外も出さずに黙って捨てる。
        */
        if(req.url.split('?')[0]==='/__embed') {
          res.writeHead(200,{'Content-Type':'text/html'});
          return res.end('<!doctype html><meta charset=utf-8>'
            + '<style>html,body{margin:0;height:100%}iframe{border:0;width:100%;height:100%}</style>'
            + '<iframe sandbox="allow-scripts allow-same-origin allow-forms allow-popups" src="/"></iframe>');
        }
        let url=decodeURIComponent(req.url.split('?')[0]);
        let p=path.join(root, url);
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

/*
  文字と地の明るさの比（WCAG のコントラスト比）。

  色の名前で見張ると、色を変えるたびに検証も直すことになり、
  そのうち「検証のほうを合わせる」になる。比で見張れば、
  選びかたを間違えたときだけ落ちる。

  地は、その要素自身が透明なら親をさかのぼって探す。
  文字側に透明度が付いていたら、地に重ねた見えかたの色に直してから測る。
*/
async function contrastOf(page, fgSel, bgSel) {
  return page.evaluate(
    ([fgSel, bgSel]) => {
      const parse = (s) => (s.match(/[\d.]+/g) || []).map(Number);

      /* 透明でない地に当たるまでさかのぼる */
      const solidBg = (el) => {
        for (let n = el; n; n = n.parentElement) {
          const c = parse(getComputedStyle(n).backgroundColor);
          if (c.length >= 3 && (c[3] === undefined || c[3] > 0.99)) return c.slice(0, 3);
        }
        return [255, 255, 255];
      };

      const lum = ([r, g, b]) => {
        const f = (v) => {
          const x = v / 255;
          return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
        };
        return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
      };

      const fgEl = document.querySelector(fgSel);
      const bgEl = bgSel ? document.querySelector(bgSel) : fgEl;
      if (!fgEl || !bgEl) return 0;

      const bg = solidBg(bgEl);
      const fgRaw = parse(getComputedStyle(fgEl).color);
      const a = fgRaw[3] === undefined ? 1 : fgRaw[3];
      /* 文字が半透明なら、地に重ねた見えかたの色で測る */
      const fg = [0, 1, 2].map((i) => fgRaw[i] * a + bg[i] * (1 - a));

      const [hi, lo] = [lum(fg), lum(bg)].sort((x, y) => y - x);
      return (hi + 0.05) / (lo + 0.05);
    },
    [fgSel, bgSel],
  );
}

/* ---------------- 画面操作のヘルパー ---------------- */

async function openFrame(browser, frameFile, photoFile = 'photo-color.png', opts = {}) {
  const origin = opts.origin ?? BASE;
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

  await page.goto(origin, { waitUntil: 'networkidle' });
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
    await page.getByRole('slider', { name: '光のにじみを残す' }).fill('30');
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
    check(
      'ドラッグで写真が動く',
      diff(dragged, base) > CHANGED,
      `ずれ ${diff(dragged, base).toFixed(2)}`,
    );

    // 大きさスライダー
    const sizeSlider = page.getByRole('slider', { name: /の大きさ/ });
    await sizeSlider.fill('180');
    await page.waitForTimeout(350);
    const scaled = await snap();
    check(
      '大きさスライダーが効く',
      diff(scaled, dragged) > CHANGED,
      `ずれ ${diff(scaled, dragged).toFixed(2)} 値=${await sizeSlider.inputValue()}`,
    );

    // 左右反転
    await page.getByRole('button', { name: '左右を反転する' }).click();
    await page.waitForTimeout(350);
    const flipped = await snap();
    check(
      '左右反転が効く',
      diff(flipped, scaled) > CHANGED,
      `ずれ ${diff(flipped, scaled).toFixed(2)}`,
    );

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
    check(
      'Shift＋矢印はもっと大きく動く',
      byShift > byArrow,
      `ずれ ${byShift.toFixed(2)} > ${byArrow.toFixed(2)}`,
    );

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
    /*
      はじめは「白」。とうめいのまま保存すると SNS 側で黒く塗られることがあるので、
      選ばなかった人が損をする既定値にしない、という判断（ComposeStudio 参照）。
      既定を変えたときに気づけるよう、ここで固定しておく。
    */
    const gapDefault = await clearInsideCircle();
    check(
      'はじめから、すきまが塗られている（既定は白）',
      gapDefault < 0.001,
      `とうめいな画素 ${(gapDefault * 100).toFixed(1)}%`,
    );

    await page.getByRole('button', { name: 'とうめい', exact: true }).click();
    await page.waitForTimeout(350);
    const gapClear = await clearInsideCircle();
    check(
      'とうめいを選ぶと、すきまが空く',
      gapClear > 0.05,
      `とうめいな画素 ${(gapClear * 100).toFixed(1)}%`,
    );

    await page.getByRole('button', { name: '白', exact: true }).click();
    await page.waitForTimeout(350);
    const gapWhite = await clearInsideCircle();
    check(
      '白に戻すと、また塗られる',
      gapWhite < 0.001,
      `とうめいな画素 ${(gapWhite * 100).toFixed(1)}%`,
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
    await page.getByRole('slider', { name: /の大きさ/ }).fill('60');
    await page.waitForTimeout(350);

    /*
      すきまの色を「とうめい」にしてから測る。

      既定を白にしたので、そのままだと丸の内側が白で埋まり、
      写真をどの形に切っても不透明な画素は 100% のまま動かない。
      形が変わったことを見たいなら、切り落とした先が透けている必要がある。
      （既定を変えたときに、この3件がまとめて落ちて気づいた）
    */
    await page.getByRole('button', { name: 'とうめい', exact: true }).click();
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
    await page.getByRole('slider', { name: 'かたむき' }).fill('30');
    await page.waitForTimeout(400);
    const tilted = await page.evaluate(() => {
      const c = document.querySelector('.stage canvas');
      const px = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      let opaque = 0;
      for (let i = 3; i < px.length; i += 4) if (px[i] > 200) opaque++;
      return opaque / (px.length / 4);
    });
    // まるは回しても面積が変わらない。四角のまま回っていたら角のぶん増える。
    check(
      'まるはかたむけても面積が変わらない',
      tilted > 0.05 && tilted < 0.95,
      `占有 ${(tilted * 100).toFixed(1)}%`,
    );
    await page.close();
  }

  /*
    いちばん大きいボタンは、その端末で「ほんとうに保存できる道」でなければならない。

    Android の共有シートには保存の項目が無い（Gmail・Instagram・コピー等だけ）ので、
    共有を主役にすると、押しても1枚も保存できない。
    iPhone はその逆で、写真アプリに入れる道は共有シートしかない。
  */
  console.log('\n■ 保存ボタンの出し分け');
  {
    // ここは共有そのものが無い環境（＝パソコン）。ダウンロードが主役になる。
    const { page } = await openFrame(browser, 'lineart.png');
    await page.getByRole('button', { name: /これでOK/ }).click();
    await page.waitForTimeout(1300);
    const primary = await page.locator('.btn--primary').last().innerText();
    check(
      '共有できない端末では「ほぞんする」が主役',
      /画像をほぞんする/.test(primary),
      primary.replace(/\s+/g, ' '),
    );
    check(
      '保存でないものを保存のように出さない',
      (await page.getByRole('button', { name: /写真アプリにほぞんする/ }).count()) === 0,
    );
    await page.close();
  }

  {
    /*
      iPhone のふり（UA を差し替え、共有できる端末として振る舞わせる）。
      実機を並べられないので、判定の分かれ目だけをここで押さえる。
    */
    const page = await browser.newPage({
      viewport: { width: 390, height: 900 },
      userAgent:
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
    });
    await page.route('**huggingface.co/**', (r) => r.abort());
    await page.route('**cdn.jsdelivr.net/**', (r) => r.abort());
    // 共有できる端末に見せる
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'share', { value: () => Promise.resolve() });
      Object.defineProperty(navigator, 'canShare', { value: () => true });
    });
    await page.goto(BASE, { waitUntil: 'networkidle' });
    await page
      .getByRole('button', { name: 'はじめる' })
      .click()
      .catch(() => {});
    await page.setInputFiles('input[type=file]', join(FIXTURES, 'photo-color.png'));
    await page.waitForTimeout(500);
    await page.getByRole('button', { name: /つぎへ：フレームをえらぶ/ }).click();
    await page.waitForTimeout(250);
    await page.setInputFiles('input[type=file]', join(FIXTURES, 'lineart.png'));
    await page.waitForTimeout(4200);
    await page.getByRole('button', { name: /これでOK/ }).click();
    await page.waitForTimeout(1300);

    const primary = await page.locator('.btn--primary').last().innerText();
    check(
      'iPhone では「写真アプリにほぞんする」が主役',
      /写真アプリにほぞんする/.test(primary),
      primary.replace(/\s+/g, ' '),
    );
    check(
      'ダウンロードは下に残しておく',
      (await page.getByRole('button', { name: /ファイルとしてダウンロード/ }).count()) >= 1,
    );
    await page.close();
  }

  /*
    「保存したのに携帯に入ってこない」の逃げ道。
    iPhone は長おし→「写真に追加」しか道が無いので、
    長おしできる本物の <img> が出ることを確かめる。
  */
  /*
    どれを押せばいいかが、見て分かること。

    ── なぜ崩れたか ──

    機能を足すたびに、ステップ3の下へボタンが1本ずつ積まれていった。
    最後には6本以上が同じ見た目で縦に並び、境目が消えた。

    並んでいたのは、じつは3つの別々の用事だった。
    「できたアイコンを持ち帰る」「フレームを人にわたす」「つぎにどうする」。
    見出しと区切りで塊に分ける。

    ── 強調色は1か所 ──

    この道具の決まり（styles.css の冒頭）に「強調色は**いま押すところ**
    1か所にしか出さない」とある。ところが、とうめいが消える注意書きを
    強調色の地（.note--warn）で置いてしまい、赤い保存ボタンの真下で
    もう1つ目を引くものを作っていた。**自分で決めた規約を自分で破っていた。**

    規約は書いてあるだけだと守られない。数えられる形にして置いておく。
  */
  console.log('\n■ どれを押せばいいか');
  {
    const { page } = await openFrame(browser, 'neon.png');
    await page.getByRole('button', { name: /これでOK/ }).click();
    await page.waitForTimeout(1400);

    const card = () =>
      page.evaluate(() => {
        /* ステップ2のカードにも台が付いたので、合成キャンバス（.stage）で見分ける */
        const c = [...document.querySelectorAll('.card')].find((x) => x.querySelector('.stage'));
        if (!c) return null;
        return {
          loud: c.querySelectorAll('.btn--primary, .note--warn').length,
          groups: [...c.querySelectorAll('.group__title')].map((g) => g.textContent.trim()),
          buttons: c.querySelectorAll('.btn').length,
        };
      });

    const seen = await card();
    check(
      '目を引くものは1つだけ（強調色は「いま押すところ」に限る）',
      seen && seen.loud === 1,
      `${seen ? seen.loud : '?'} 個`,
    );
    check(
      'ボタンが用事ごとに分かれている',
      seen && seen.groups.length >= 2,
      seen ? seen.groups.join(' / ') : '',
    );

    /*
      塊に分けても、押すところが減ったわけではない。
      増えすぎたら分けかたのほうを見直す合図にする。
    */
    check(
      'ボタンが増えすぎていない',
      seen && seen.buttons <= 14,
      `${seen ? seen.buttons : '?'} 本`,
    );
    await page.close();
  }

  /*
    同じフレームで、写真だけ差し替えられること。

    ── なぜ効くのか ──

    フレームを作るのがこのツールでいちばん手間のかかる工程。
    「同じフレームで、もう1枚」はいちばん自然な次の行動なので、
    そこに最短の道が要る。

    ── 何が足りなかったか ──

    機能そのものは前からあった。上のステップの丸から1へ戻れば、
    写真だけ選び直せる（フレームは消えない）。
    足りなかったのは**押すところ**で、保存し終わって下まで来た人に
    見えていたのは「背景けしにもどる」と「さいしょから」だけだった。

    しかも「さいしょから」はフレームを捨てる。同じフレームで作りたい人が
    それを押すと、いちばん重い背景けしからやり直しになる。
    **できることに押すところが無く、見えているボタンがいちばん高くつく道**だった。

    ── 何を見張るか ──

    ボタンがあること、押すと写真選びに戻ること、そして戻った先の「つぎへ」が
    **背景けしを飛ばして位置あわせへ行くこと**。ここを飛ばさないと、
    やることの無い画面を1枚はさんで「これでOK」を押させることになる。
  */
  console.log('\n■ 写真だけ差し替える');
  {
    const { page } = await openFrame(browser, 'neon.png', 'photo-tall.png');
    await page.getByRole('button', { name: /これでOK/ }).click();
    await page.waitForTimeout(1400);

    /* 写真を動かして、あとで初期に戻ることを見られるようにする */
    await page.getByRole('button', { name: /^大きくする$/ }).click();
    await page.getByRole('button', { name: /^大きくする$/ }).click();
    await page.waitForTimeout(400);
    const zoomed = await page.evaluate(() => {
      const el = document.querySelector('input[type=range]');
      return el ? el.value : null;
    });
    check('写真を大きくした', zoomed !== '100', `${zoomed}%`);

    const change = page.getByRole('button', { name: /写真だけ変える/ });
    check('「写真だけ変える」がある', (await change.count()) === 1);
    await change.click();
    await page.waitForTimeout(700);

    check(
      '写真をえらぶところに戻る',
      (await page.getByRole('heading', { name: /アイコンにする写真をえらぶ/ }).count()) === 1,
    );
    check('べつの写真にする入口がある', (await page.getByText('べつの写真にする').count()) >= 1);

    /*
      フレームは残っているので、背景けしを通さずに位置あわせへ行ける。
      ラベル自体が行き先を名乗っていることまで見る。
    */
    const next = page.getByRole('button', { name: /つぎへ：位置をあわせる/ });
    check('つぎへが「位置をあわせる」になっている', (await next.count()) === 1);
    await next.click();
    await page.waitForTimeout(900);
    check(
      '背景けしを通らずに位置あわせへ着く',
      (await page.getByRole('heading', { name: /位置をあわせる/ }).count()) >= 1,
    );

    /*
      写真を差し替えたら、写真の位置と切りぬきは初期に戻す。
      前の写真に合わせた位置が次の写真に乗ると、顔があった場所には何も無い。
      ここでは同じ写真を選び直しているが、扱いは差し替えと同じ。
    */
    await page.getByRole('button', { name: 'アイコン写真' }).click();
    await page.waitForTimeout(500);
    await page.setInputFiles('input[type=file]', join(FIXTURES, 'photo-color.png'));
    await page.waitForTimeout(900);
    await page.getByRole('button', { name: /つぎへ：位置をあわせる/ }).click();
    await page.waitForTimeout(900);
    const afterSwap = await page.evaluate(() => {
      const el = document.querySelector('input[type=range]');
      return el ? el.value : null;
    });
    check('差し替えたら、写真の大きさは初期に戻る', afterSwap === '100', `${afterSwap}%`);

    /*
      そして**フレームは残っていること**。ここがこの機能の全部。
      消えていたら背景けしからやり直しで、押すところを足した意味が無い。

      フレームは「そのまま」では中身が読めない（合成された絵しか見えない）ので、
      とうめいなフレームを渡す道から中身を取り出して確かめる。
      書き出しサイズでないこと＝合成アイコンではなく、フレームそのもの。
    */
    const frameStill = await page.evaluate(async () => {
      const c = document.querySelector('.stage canvas');
      if (!c) return null;
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      let ink = 0;
      for (let i = 3; i < d.length; i += 4) if (d[i] > 8) ink++;
      return +((ink / (d.length / 4)) * 100).toFixed(1);
    });
    check(
      'フレームは残っている（絵が描かれている）',
      frameStill !== null && frameStill > 5,
      `${frameStill}%`,
    );
    check(
      'フレームを渡す道も残っている',
      (await page
        .getByRole('button', {
          name: /とうめいにしたフレームだけを保存する|とうめいなフレームを送る/,
        })
        .count()) >= 1,
    );

    await page.close();
  }

  /*
    とうめいにしたフレームを、そのまま人に渡せること。

    ── なぜ「保存」だけでは足りなかったか ──

    ここは端末に落とすことしかできなかった。だがフレームは**人に渡したくなるもの**で、
    せっかく背景を抜いたのだから友だちにも使ってほしい、というのは自然な流れ。

    しかも iPhone では、ダウンロードは「写真」ではなく「ファイル」アプリに入る。
    そこから人に送るには、ファイルアプリを開いて探して共有し直すことになる。

    ── 何を見張るか ──

    渡るのが**フレームそのもの**であること。ここを取り違えて、合成したアイコンを
    渡してしまうと、受け取った人はフレームとして使えない（写真が焼き込まれている）。
    だから中身を読んで、とうめいな画素があることまで見る。
  */
  console.log('\n■ フレームだけを渡す');
  {
    /* まず、共有できない端末（いまの Chromium がそう）。落とす道が残っていること */
    {
      const { page } = await openFrame(browser, 'neon.png');
      await page.getByRole('button', { name: /これでOK/ }).click();
      await page.waitForTimeout(1200);

      const btn = page.getByRole('button', { name: /とうめいにしたフレームだけを保存する/ });
      check('共有できない端末では、保存ボタンが出る', (await btn.count()) === 1);

      /*
        とうめいが消える経路を、渡す前に伝えていること。

        こちらが渡すのはアルファチャンネル付きの PNG そのもので、バイト列は加工されない。
        壊れるのは受け取ったアプリの中。多くの SNS・メッセージアプリは受け取った画像を
        JPEG に変換し、JPEG にアルファチャンネルは無いので、とうめいは白や黒で埋まる。

        受け取り側は制御できないし、API も無い。できるのは渡す前に伝えることだけ。
        しかも「消えることがあります」だけでは行き止まりなので、
        **どうすれば消えないか**まで書いてあることを見る。
      */
      const warn = await page.evaluate(() => document.body.innerText);
      check(
        'とうめいが消えることを、渡す前に伝えている',
        warn.includes('とうめいは、送りかたで消えます'),
      );
      check(
        '消さない渡しかたまで書いてある',
        warn.includes('「ファイル」として送る') || warn.includes('保存してから渡して'),
      );
      const dl = page.waitForEvent('download', { timeout: 20000 }).catch(() => null);
      await btn.click();
      const got = await dl;
      check(
        'フレームだけを保存できる',
        !!got && /^frame_toka_/.test(got.suggestedFilename()),
        got ? got.suggestedFilename() : '',
      );
      await page.close();
    }

    /*
      次に、共有できる端末を作って確かめる。

      Chromium は navigator.share を持たないので、差し替えて渡されたものを記録する。
      見たいのは「共有シートが開くか」ではなく「**何が渡るか**」なので、
      本物のシートは要らない。
    */
    {
      const page = await browser.newPage({ viewport: { width: 390, height: 900 } });
      await page.addInitScript(() => {
        window.__shared = [];
        navigator.canShare = (d) => !!d && Array.isArray(d.files) && d.files.length > 0;
        navigator.share = async (d) => {
          const f = d.files[0];
          window.__shared.push({
            name: f.name,
            type: f.type,
            size: f.size,
            bytes: [...new Uint8Array(await f.arrayBuffer())],
          });
        };
      });
      await page.route('**huggingface.co/**', (r) => r.abort());
      await page.goto(BASE, { waitUntil: 'networkidle' });
      await page
        .getByRole('button', { name: 'はじめる' })
        .click()
        .catch(() => {});
      await page.setInputFiles('input[type=file]', join(FIXTURES, 'photo-color.png'));
      await page.waitForTimeout(500);
      await page.getByRole('button', { name: /つぎへ：フレームをえらぶ/ }).click();
      await page.waitForTimeout(250);
      await page.setInputFiles('input[type=file]', join(FIXTURES, 'neon.png'));
      await page.waitForTimeout(4000);
      await page.getByRole('button', { name: /これでOK/ }).click();
      await page.waitForTimeout(1600);

      const send = page.getByRole('button', { name: /とうめいなフレームを送る/ });
      check('共有できる端末では、送るボタンが出る', (await send.count()) === 1);
      await send.click();
      await page.waitForTimeout(900);

      const shared = await page.evaluate(() =>
        window.__shared.map((s) => ({ ...s, bytes: undefined })),
      );
      check('押すと1枚だけ渡される', shared.length === 1, `${shared.length} 枚`);
      if (shared.length === 1) {
        check('PNG で渡される', shared[0].type === 'image/png', shared[0].type);
        check(
          'フレームだと分かる名前で渡される',
          /^frame_toka_.*\.png$/.test(shared[0].name),
          shared[0].name,
        );
      }

      /*
        渡ったのが「合成したアイコン」ではなく「とうめいなフレーム」であること。
        取り違えると、受け取った人はフレームとして使えない。
      */
      const look = await page.evaluate(async () => {
        const s = window.__shared[0];
        if (!s) return null;
        const blob = new Blob([new Uint8Array(s.bytes)], { type: 'image/png' });
        const bmp = await createImageBitmap(blob);
        const c = document.createElement('canvas');
        c.width = bmp.width;
        c.height = bmp.height;
        const g = c.getContext('2d');
        g.drawImage(bmp, 0, 0);
        const d = g.getImageData(0, 0, c.width, c.height).data;
        let clear = 0;
        for (let i = 3; i < d.length; i += 4) if (d[i] < 8) clear++;
        return { w: bmp.width, h: bmp.height, clear: +((clear / (d.length / 4)) * 100).toFixed(1) };
      });
      check(
        'とうめいな部分が残っている',
        !!look && look.clear > 5,
        look ? `とうめい ${look.clear}%` : '',
      );
      /*
        とうめいなだけでは足りない。合成したアイコンも、まるく切りぬいてあれば
        四隅がとうめいで、2割ほど抜けている。実際それで一度、
        合成したほうを渡しても通ってしまう検証を書いた。

        決め手は大きさ。合成したアイコンは必ず書き出しサイズ（1080×1080）になる。
        フレームのほうはそうならない —— ステップ2が透明な余白を切り詰めるので、
        元の 900×900 ですらなく、抜いた結果しだいの半端な寸法になる
        （この見本では 876×892）。だから「1080 でないこと」で見る。
        寸法を決め打ちすると、切り詰めの結果が少し変わるたびに落ちてしまう。
      */
      check(
        '書き出しサイズではない＝合成したアイコンではない',
        !!look && !(look.w === 1080 && look.h === 1080),
        look ? `${look.w}×${look.h}` : '',
      );
      await page.close();
    }
  }

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
    await page
      .getByRole('button', { name: /つかいかた|ヘルプ|使いかた/ })
      .first()
      .click();
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
        return {
          x: Math.round(b.x),
          y: Math.round(b.y),
          w: Math.round(b.width),
          vw: window.innerWidth,
        };
      });
      check(
        'つかいかたも画面ぜんぶをおおう',
        r.x === 0 && r.y === 0 && r.w >= r.vw,
        `${r.w} / ${r.vw}`,
      );
    }
    await page.close();
  }

  console.log('\n■ 保存できないときの逃げ道');
  {
    const { page } = await openFrame(browser, 'lineart.png');
    await page.getByRole('button', { name: /これでOK/ }).click();
    await page.waitForTimeout(1300);

    check(
      '逃げ道の入り口がいつも出ている',
      await page.getByRole('button', { name: '携帯に入ってこないときは' }).isVisible(),
    );

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
      check(
        '画像は書き出したものそのもの',
        String(src).startsWith('blob:'),
        String(src).slice(0, 24),
      );
      const size = await img.evaluate((el) => ({ w: el.naturalWidth, h: el.naturalHeight }));
      check(
        '書き出しサイズで入っている',
        size.w === 1080 && size.h === 1080,
        `${size.w}×${size.h}`,
      );
      const dl = page.waitForEvent('download', { timeout: 20000 }).catch(() => null);
      await page.getByRole('button', { name: /ファイルとしてダウンロード/ }).click();
      check('逃げ道からも保存できる', !!(await dl));
    }
    await page.close();
  }

  console.log('\n■ SNSに貼られたときの見た目');
  {
    const page = await browser.newPage();
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    const meta = await page.evaluate(() => {
      const get = (sel) => document.querySelector(sel)?.getAttribute('content') ?? null;
      return {
        type: get('meta[property="og:type"]'),
        title: get('meta[property="og:title"]'),
        desc: get('meta[property="og:description"]'),
        url: get('meta[property="og:url"]'),
        image: get('meta[property="og:image"]'),
        card: get('meta[name="twitter:card"]'),
        tTitle: get('meta[name="twitter:title"]'),
        tDesc: get('meta[name="twitter:description"]'),
        tImage: get('meta[name="twitter:image"]'),
        canonical: document.querySelector('link[rel=canonical]')?.getAttribute('href') ?? null,
      };
    });

    check('og:type がある', meta.type === 'website', String(meta.type));
    check('og:title がある', !!meta.title, String(meta.title));
    check('og:description がある', !!meta.desc);
    check('og:url がある', !!meta.url, String(meta.url));
    check('og:image がある', !!meta.image, String(meta.image));
    check('twitter:card は大きい画像', meta.card === 'summary_large_image', String(meta.card));
    check(
      'twitter の title / description / image がある',
      !!(meta.tTitle && meta.tDesc && meta.tImage),
    );
    check('canonical がある', !!meta.canonical);

    /*
      ここがいちばん間違えやすい。相手のサーバーが読みにくるので、
      相対パス（./og-image.png）では解決できない。
    */
    const absolute = (v) => typeof v === 'string' && /^https:\/\//.test(v);
    check('og:image は絶対URL', absolute(meta.image), String(meta.image));
    check('og:url は絶対URL', absolute(meta.url), String(meta.url));
    check('twitter:image は絶対URL', absolute(meta.tImage), String(meta.tImage));
    check(
      'og と twitter で食い違っていない',
      meta.title === meta.tTitle && meta.desc === meta.tDesc && meta.image === meta.tImage,
    );
    await page.close();
  }

  /*
    決済から戻ってくる道。

    ここは自分たちだけで完結しない。Stripe が戻り先に session_id を足したり、
    末尾のスラッシュが付いたりする。完全一致で見ていると、そのどれか1つで
    「お礼のページのはずが、つくる画面が出る」ことになる。
    決済した直後にそれが起きるのが、いちばん体験が悪い。
  */
  console.log('\n■ 数字を直接打つ／もどす');
  {
    const { page } = await openFrame(browser, 'lineart.png');
    await page.getByRole('button', { name: /うまく消えないときは/ }).click();
    await page.waitForTimeout(400);

    const box = page.getByRole('textbox', { name: /どこまで消すか/ });
    const slider = page.getByRole('slider', { name: 'どこまで消すか' });
    /*
      exact を付けないと「消えすぎをもどす」（手なおしの取り消し）にも当たる。
      部分一致のまま書いていて、実際にここで1回ひっかかった。
    */
    const reset = () => page.getByRole('button', { name: 'もどす', exact: true });

    const opened = await slider.inputValue();
    check('はじめは「もどす」が出ていない', (await reset().count()) === 0);

    // 数字を打つ → つまみも一緒に動く
    await box.fill('42');
    await box.press('Enter');
    await page.waitForTimeout(400);
    check(
      '打った数字がつまみに入る',
      (await slider.inputValue()) === '42',
      await slider.inputValue(),
    );
    check('変えたら「もどす」が出る', (await reset().count()) === 1, String(await reset().count()));

    // 範囲の外は、範囲の内側に収める（max は 60）
    await box.fill('999');
    await box.press('Enter');
    await page.waitForTimeout(400);
    check(
      '大きすぎる数字は上限で止まる',
      (await slider.inputValue()) === '60',
      await slider.inputValue(),
    );

    await box.fill('-5');
    await box.press('Enter');
    await page.waitForTimeout(400);
    check(
      '小さすぎる数字は下限で止まる',
      (await slider.inputValue()) === '1',
      await slider.inputValue(),
    );

    // 数字でないものを打っても壊れない（1 のまま）
    await box.fill('あ');
    await box.press('Enter');
    await page.waitForTimeout(400);
    check(
      '数字でないものは無視する',
      (await slider.inputValue()) === '1',
      await slider.inputValue(),
    );

    /*
      もどす → 開いたときの値へ。
      いまは下限で止まったあとなので、開いたときの値と同じかもしれない。
      それだと「戻った」ことを確かめられないので、必ず違う値にしてから押す。
    */
    await box.fill('37');
    await box.press('Enter');
    await page.waitForTimeout(400);
    check(
      '戻す前は、開いたときと違う値',
      (await slider.inputValue()) !== opened,
      await slider.inputValue(),
    );
    await reset().click();
    await page.waitForTimeout(600);
    check(
      '「もどす」で開いたときの値に戻る',
      (await slider.inputValue()) === opened,
      `${await slider.inputValue()} / 開いたとき ${opened}`,
    );
    check('戻したら「もどす」は消える', (await reset().count()) === 0);

    await page.close();
  }

  /*
    つくる側のハリネズミは「飾り」ではなく「場面」であること。

    この道具の画面には、これまで絵を一切置いてこなかった。
    とくにステップ2（背景をけす）は、とうめいになったかを目で判定する画面で、
    横に色のついた絵があると判断が鈍る。市松の下じきをテーマに
    追随させなかったのと同じ理由。

    絵を足すと、この線がなし崩しになりやすい。
    「出っぱなしになっていないか」を機械で見張る。
  */
  console.log('\n■ つくる側のハリネズミは、場面のときだけ');
  {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await page.goto(BASE, { waitUntil: 'networkidle' });
    await page
      .getByRole('button', { name: 'はじめる' })
      .click()
      .catch(() => {});
    await page.waitForTimeout(500);

    const count = () => page.locator('.sprite').count();

    // まだ何も選んでいない：空っぽの枠にだけ出る
    check('写真をえらぶ前は、1匹だけ出る', (await count()) === 1, String(await count()));

    // 写真を選んだら、その場は用済み
    await page.setInputFiles('input[type=file]', join(FIXTURES, 'photo-color.png'));
    await page.waitForTimeout(600);
    check('写真をえらんだら消える', (await count()) === 0, String(await count()));

    // ステップ2（背景をけす）には出さない
    await page.getByRole('button', { name: /つぎへ：フレームをえらぶ/ }).click();
    await page.waitForTimeout(250);
    await page.setInputFiles('input[type=file]', join(FIXTURES, 'lineart.png'));
    await page.waitForTimeout(4000);
    check('背景をけす画面には出さない', (await count()) === 0, String(await count()));

    await page.close();
  }

  /*
    開いただけで重いものを落とさないこと。

    AI の実行環境（transformers + onnxruntime）は 850KB ある。
    切り抜きが色キーで足りなかったときにだけ要るもので、
    ふつうに開いただけ・応援ページを見ただけでは要らない。

    ここは一度こわれていた。ビルドの設定で「AI を1つの塊にまとめる」と
    書いたところ、動的 import 用の小さな補助関数まで同じ塊に入り、
    入口がその塊を静的に参照する形になって、**どのページでも** 850KB を
    先に落としていた。ページは正しく動くので、見ても分からない。
    測って初めて分かる種類のこわれかたなので、ここで見張る。
  */
  console.log('\n■ 開いただけで重いものを落とさない');
  {
    for (const [name, hash] of [
      ['つくる', ''],
      ['知らせる', '#/share'],
    ]) {
      const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
      const got = [];
      page.on('requestfinished', async (r) => {
        try {
          const f = new URL(r.url()).pathname.split('/').pop();
          const s = await r.sizes();
          got.push([f, s.responseBodySize || 0]);
        } catch {}
      });
      await page.goto(BASE + hash, { waitUntil: 'networkidle' });
      await page.waitForTimeout(900);

      const heavy = got.filter(([, s]) => s > 400 * 1024);
      check(
        `${name}：400KB を超えるものを先に落とさない`,
        heavy.length === 0,
        heavy.map(([f, s]) => `${f} ${Math.round(s / 1024)}KB`).join(' / '),
      );

      const total = got.reduce((s, r) => s + r[1], 0);
      // 飾りのいちばん多い応援ページでも 1MB を超えない
      check(
        `${name}：最初に落ちてくる合計が 1MB 未満`,
        total < 1024 * 1024,
        `${(total / 1024 / 1024).toFixed(2)}MB`,
      );
      await page.close();
    }
  }

  /*
    どの幅でも、横にはみ出さないこと。
    スマホは 390px を基準にしているが、実際にはもっと狭い端末も、
    折りたたみを開いた広い端末もある。
  */
  console.log('\n■ いろいろな画面幅');
  {
    for (const width of [320, 375, 390, 430, 768, 1280]) {
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      const bad = [];
      for (const [name, hash] of [['知らせる', '#/share']]) {
        await page.goto(BASE + hash, { waitUntil: 'networkidle' });
        await page.waitForTimeout(400);
        const m = await page.evaluate(() => {
          const doc = document.documentElement;
          // 文字やボタンが箱からはみ出していないかも、いっしょに見る
          const over = [...document.querySelectorAll('.support *')].filter(
            (el) =>
              el.scrollWidth > el.clientWidth + 2 && getComputedStyle(el).overflowX === 'visible',
          ).length;
          return { w: doc.scrollWidth, v: window.innerWidth, over };
        });
        if (m.w > m.v + 1) bad.push(`${name} ${m.w}>${m.v}`);
      }
      check(`${width}px で横スクロールが出ない`, bad.length === 0, bad.join(' / '));
      await page.close();
    }
  }

  /*
    飾りが主役にならないこと。

    ここは何度か踏んでいる。素材が届くたびに濃く・大きく置いてしまい、
    パソコンの画面で見ると、道具の画面ではなく広告の画面になっていた。
    見た目の good / bad は測れないが、そうなる手前の条件なら測れる。

    ・画面いっぱいに敷く画像を置かない（お礼のページ）
      → 地の生成りとグリッドが消え、飾りだけの画面になる入口がこれ
    ・端の飾りは、画面の面積のうち少しだけ
    ・動きを減らす設定の人には動かさない
  */
  console.log('\n■ 飾りが主役にならないこと');
  {
    for (const [name, hash] of [['知らせる', '#/share']]) {
      const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
      await page.goto(BASE + hash, { waitUntil: 'networkidle' });
      await page.waitForTimeout(600);

      const layers = await page.evaluate(() => {
        const vw = window.innerWidth * window.innerHeight;
        return [...document.querySelectorAll('.decor > *')].map((el) => {
          const s = getComputedStyle(el);
          const r = el.getBoundingClientRect();
          return {
            cls: el.className,
            // グラデーションは url() を持たない。画像の層だけを見たい
            image: /url\(/.test(s.backgroundImage),
            share: +((r.width * r.height) / vw).toFixed(2),
            opacity: +s.opacity,
          };
        });
      });

      // 画像を敷いた層のうち、画面をほぼ覆うもの
      const full = layers.filter((l) => l.image && l.share > 0.6);
      // 覆う1枚は「地」だけ許す。それも薄いこと（生成りが透けていること）
      const tooStrong = full.filter((l) => !/decor__bg/.test(l.cls) || l.opacity > 0.25);
      check(
        `${name}：画面を覆う飾りは、薄い地の1枚まで`,
        tooStrong.length === 0,
        tooStrong.map((l) => `${l.cls} ${l.share} opacity:${l.opacity}`).join(' / '),
      );

      // 端の飾り（地でも輪でもないもの）は、面積のうちわずかであること
      const edge = layers.filter((l) => l.image && !/decor__bg|decor__celebration/.test(l.cls));
      const fat = edge.filter((l) => l.share > 0.2);
      check(
        `${name}：端の飾りは画面の2割まで`,
        fat.length === 0,
        fat.map((l) => `${l.cls} ${l.share}`).join(' / '),
      );

      await page.close();
    }

    /*
      ここには「お礼のページは地の画像を取りに行かない」があった。

      応援ページ（画像で地を敷く）とお礼ページ（CSS だけで描く）の2枚があり、
      軽いほうが本当に軽いことを見ていた。決済を外してお礼ページごと
      無くなったので、比べる相手が居ない。

      いま飾りのあるページは「知らせる」1枚だけで、その重さは
      「開いただけで重いものを落とさない」で見ている。二重に見張らない。

      代わりに、もう使わない素材を取りに行っていないことだけ見る。
      お礼まわりの2枚（水の輪・お礼のハリネズミ）は参照を外したので、
      通信が発生したら外し漏れがある。
    */
    const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
    const asked = [];
    page.on('request', (r) => asked.push(r.url().split('/').pop()));
    await page.goto(BASE + '#/share', { waitUntil: 'networkidle' });
    await page.waitForTimeout(600);
    const gone = asked.filter((f) => /celebration|hedgehog-thanks/.test(f));
    check('もう使わない素材を取りに行かない', gone.length === 0, gone.join(','));
    await page.close();
  }

  /*
    お礼ページの水の輪だけの決まりごと。

    この素材は一度「使えない」と判断して外し、あとで置きかたのほうが
    間違っていたと分かって戻した。戻すときに決めた2つの条件を、ここで固定する。

    1. 画面ではなく**本文の列**に合わせること
       画面幅に連動させると、広い画面ほど輪が余白へ散らばる。それが最初の失敗。
    2. ステップ表示（1・2・3）より下から始まること
       輪のいちばん濃いところがちょうど「完了」に重なり、文字が泡に埋まっていた。
  */
  /*
    ここは応援を**設定してある**版で見る。

    このかたまりの本命は「輪がステップ表示にかからない」で、
    ぶつかる相手のステップは、受け付けを止めているあいだは出さなくなった。
    止めた版で測ると相手が居らず、当たりようがないので素通りする。
    素通りする検証は、通っていないのと同じ。

    輪そのものの置きかたは応援の設定と関係ないので、
    どちらの版で測っても同じ絵が出る。ぶつかる相手が居るほうで測る。
  */
  console.log('\n■ 動きを減らす設定');
  {
    const page = await browser.newPage({
      viewport: { width: 390, height: 900 },
      reducedMotion: 'reduce',
    });
    await page.goto(BASE + '#/share', { waitUntil: 'networkidle' });
    await page.waitForTimeout(500);
    const moving = await page.evaluate(() =>
      [...document.querySelectorAll('.decor > *')]
        .filter((el) => getComputedStyle(el).animationName !== 'none')
        .map((el) => el.className),
    );
    check('飾りを動かさない', moving.length === 0, moving.join(','));
    await page.close();
  }

  /*
    お試しリンク（別サイトの枠の中）で開かれたとき。

    実機で「保存できましたと出るのに、1枚も落ちてこない」が起きた。
    枠の中ではダウンロードが止められるが、<a download> は例外を投げないので、
    こちらからは成功したように見えてしまう。いちばん質の悪い嘘なので、
    「言い切らない」ことと「その場で保存できる形を出すこと」を機械で押さえる。
  */
  console.log('\n■ 枠の中で開かれたとき（お試しリンク）');
  {
    const page = await browser.newPage({ viewport: { width: 390, height: 900 } });
    await page.route('**huggingface.co/**', (r) => r.abort());
    await page.route('**cdn.jsdelivr.net/**', (r) => r.abort());
    await page.goto(BASE + '__embed', { waitUntil: 'networkidle' });

    const app = page.frameLocator('iframe');
    await app
      .getByRole('button', { name: 'はじめる' })
      .click()
      .catch(() => {});
    await app.locator('input[type=file]').first().setInputFiles(join(FIXTURES, 'photo-color.png'));
    await page.waitForTimeout(600);
    await app.getByRole('button', { name: /つぎへ：フレームをえらぶ/ }).click();
    await page.waitForTimeout(300);
    await app.locator('input[type=file]').first().setInputFiles(join(FIXTURES, 'lineart.png'));
    await page.waitForTimeout(4200);
    await app.getByRole('button', { name: /これでOK/ }).click();
    await page.waitForTimeout(1400);

    await app.getByRole('button', { name: /画像をほぞんする|写真アプリにほぞんする/ }).click();
    await page.waitForTimeout(1800);

    // ここで「保存できました」と言い切ってはいけない
    const claimed = await app.locator('.note--ok').count();
    check('枠の中では「保存できました」と言わない', claimed === 0, `緑の案内 ${claimed} 個`);

    // かわりに、その場で保存できる形が出ていること
    const img = app.locator('.saver__image');
    const shown = await img.waitFor({ state: 'visible', timeout: 10000 }).then(
      () => true,
      () => false,
    );
    check('かわりに長おしできる画像を出す', shown);
    check('枠の中だと分かる説明を出す', (await app.locator('.saver__warn').count()) === 1);
    await page.close();
  }

  /*
    小さいときの見えかた。

    この機能の値打ちは「実寸で出していること」ただ1つ。
    見た目を整えようとして全部同じ大きさに揃えたり、拡大して見せたりすると、
    その瞬間に何の情報も無くなる（大きいプレビューの縮小コピーになるだけ）。

    だから、出ている大きさそのものを測って見張る。
  */
  console.log('\n■ 小さいときの見えかた');
  {
    const { page } = await openFrame(browser, 'lineart.png');
    await page.getByRole('button', { name: /これでOK/ }).click();
    await page.waitForTimeout(1600);

    const shot = () =>
      page.evaluate(() =>
        [...document.querySelectorAll('.scenes__canvas')].map((c) => {
          const r = c.getBoundingClientRect();
          const g = c.getContext('2d');
          const d = g.getImageData(0, 0, c.width, c.height).data;
          let ink = 0;
          let sum = 0;
          for (let i = 0; i < d.length; i += 4) {
            if (d[i + 3] > 8) ink++;
            // 位置で重みを変えて足す。色が同じでも配置が変われば値が動く
            sum += (d[i] + d[i + 1] * 2 + d[i + 2] * 3) * ((i % 97) + 1);
          }
          return {
            css: Math.round(r.width),
            buf: c.width,
            // 何か描かれているか（真っ白のままではないか）
            inked: +((ink / (d.length / 4)) * 100).toFixed(1),
            // 絵そのものの指紋。中身が変われば必ず変わる
            sig: sum % 1000000007,
          };
        }),
      );

    const before = await shot();
    check('3つのシーンが出ている', before.length === 3, String(before.length));

    // 実寸であること。SCENES の 96 / 48 / 40 に一致する
    check(
      '出ている大きさが実寸（96 / 48 / 40px）',
      before.map((s) => s.css).join(',') === '96,48,40',
      before.map((s) => s.css).join(','),
    );

    // 大きさが違うこと自体が情報。同じにされたら意味がない
    check(
      '3つとも大きさが違う',
      new Set(before.map((s) => s.css)).size === 3,
      before.map((s) => s.css).join(','),
    );

    // 端末の解像度ぶんの画素を持っていること（ぼやけていないか）
    check(
      '解像度ぶんの画素で描いている',
      before.every((s) => s.buf >= s.css),
      before.map((s) => `${s.buf}/${s.css}`).join(' '),
    );

    check(
      'ちゃんと絵が描かれている',
      before.every((s) => s.inked > 5),
      before.map((s) => `${s.inked}%`).join(' '),
    );

    /*
      他の人と並んだとき。

      主役は大きさの比較なので、これは既定で畳んである。
      畳んだまま中身が生きていないか（＝開いても空のままではないか）まで見る。
    */
    check(
      'はじめは畳まれている',
      (await page.locator('.feed').count()) === 0,
      `列 ${await page.locator('.feed').count()} 個`,
    );

    const more = page.getByRole('button', { name: /他の人と並べてみる/ });
    check('畳んでいても、問いは読める', (await more.count()) === 1);
    await more.click();
    await page.waitForTimeout(600);
    check('押すと開く', (await page.locator('.feed').count()) === 1);

    check('自分のアイコンが1つ描かれている', (await page.locator('.feed__icon--me').count()) === 1);
    check('隣に並ぶ人がいる', (await page.locator('.feed__icon--peer').count()) >= 2);
    const rowSizes = await page.evaluate(() => {
      const me = document.querySelector('.feed__icon--me').getBoundingClientRect();
      const peer = document.querySelector('.feed__icon--peer').getBoundingClientRect();
      return [Math.round(me.width), Math.round(peer.width)];
    });
    check(
      '自分も隣も、コメント欄と同じ 40px',
      rowSizes[0] === 40 && rowSizes[1] === 40,
      `自分 ${rowSizes[0]}px / 隣 ${rowSizes[1]}px`,
    );
    const meInk = await page.evaluate(() => {
      const c = document.querySelector('.feed__icon--me');
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      let ink = 0;
      for (let i = 3; i < d.length; i += 4) if (d[i] > 8) ink++;
      return +((ink / (d.length / 4)) * 100).toFixed(1);
    });
    check('並んだときの自分にも、ちゃんと絵が描かれている', meInk > 5, `${meInk}%`);

    /*
      縦に積まれていて、自分が挟まれていること。

      横一列に戻されたら落ちる。コメント欄は縦に流れるので、
      そこが合っていないと「並んだとき」を見ていることにならない。
      さらに、自分が先頭だと上に誰も居らず、挟まれた状態にならない。
    */
    const geom = await page.evaluate(() => {
      const rows = [...document.querySelectorAll('.feed__row')];
      const icons = rows.map((r) => r.querySelector('.feed__icon').getBoundingClientRect());
      const meAt = rows.findIndex((r) => r.querySelector('.feed__icon--me'));
      return {
        n: rows.length,
        meAt,
        sameX: new Set(icons.map((b) => Math.round(b.left))).size === 1,
        descending: icons.every((b, i) => i === 0 || b.top > icons[i - 1].top),
      };
    });
    check('縦に積まれている', geom.sameX && geom.descending);
    check(
      '自分は先頭ではない（上にも下にも人がいる）',
      geom.meAt > 0 && geom.meAt < geom.n - 1,
      `${geom.n} 人中 ${geom.meAt + 1} 番目`,
    );

    /*
      文字の場所があること。

      丸しか並んでいないと、自分のアイコンは実際より目立って見える。
      本物のコメント欄では、アイコンは文字と注意を奪い合っている。
      「埋もれるか」を見たいのに、埋もれさせる当のものが無いのでは判定できない。
      帯を消されたら落ちるように、行ごとに数える。
    */
    const bars = await page.evaluate(() =>
      [...document.querySelectorAll('.feed__row')].map(
        (r) => r.querySelectorAll('.feed__bar').length,
      ),
    );
    check(
      'どの行にも文字の場所がある',
      bars.length > 0 && bars.every((n) => n >= 2),
      bars.join(' / '),
    );

    /*
      ただし、文字そのものは書かない。
      名前や台詞を書いた時点で、どこかの画面の再現になる。
    */
    const feedText = await page.evaluate(
      () => document.querySelector('.feed').textContent.trim().length,
    );
    check('文字は書かれていない（無地の帯のまま）', feedText === 0, `${feedText} 文字`);

    /*
      隣にも、ちゃんと絵が描いてあること。

      はじめ隣は無地の丸だった。丸が並んでいても目には「余白に点がある」
      としか映らず、肝心の「この中で自分は埋もれるか、浮きすぎるか」が
      判定できない。相手が無地だと自分のアイコンは必ず勝ってしまうので、
      見比べる意味そのものが無くなる。

      無地に戻されたら落ちるように、中身そのものを測る。
    */
    const peers = await page.evaluate(() =>
      [...document.querySelectorAll('.feed__icon--peer')].map((c) => {
        const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
        let lo = 255;
        let hi = 0;
        let sum = 0;
        for (let i = 0; i < d.length; i += 4) {
          if (d[i + 3] < 8) continue;
          const v = (d[i] + d[i + 1] + d[i + 2]) / 3;
          if (v < lo) lo = v;
          if (v > hi) hi = v;
          // 位置で重みを変えて足す。色が同じでも配置が変われば値が動く
          sum += (d[i] + d[i + 1] * 2 + d[i + 2] * 3) * ((i % 97) + 1);
        }
        return { spread: hi - lo, sig: sum % 1000000007 };
      }),
    );
    check('隣は3人ぶんある', peers.length === 3, String(peers.length));
    check(
      '隣が無地ではない（絵が描いてある）',
      peers.every((p) => p.spread > 40),
      peers.map((p) => Math.round(p.spread)).join(' / '),
    );
    check(
      '隣どうしが同じ絵ではない',
      new Set(peers.map((p) => p.sig)).size === peers.length,
      `${new Set(peers.map((p) => p.sig)).size} 種類`,
    );

    // 地を切り替えられること（コメント欄は暗く、しかも動画の上なので）
    const strip = page.locator('.scenes');
    const swap = page.getByRole('button', { name: /^地：/ });
    check('はじめは明るい地', (await strip.getAttribute('data-bg')) === 'light');
    await swap.click();
    await page.waitForTimeout(400);
    check('押すと暗い地になる', (await strip.getAttribute('data-bg')) === 'dark');

    /*
      暗い地で、ラベルが沈んでいないこと。

      目で見て気づけなかった種類の壊れかた。
      `.scenes[data-bg='dark'], .scenes[data-bg='photo'] .scenes__label` と
      まとめて書いてあり、コンマの左が「.scenes 自身」で切れていたので、
      くらい地のときだけ子の指定が当たらず、var(--ink-soft) のままだった。

      たちが悪いのは、端末の設定で症状が変わるところ。
      --ink-soft は OS が暗いと #a5a4b0（比 7.5、たまたま読める）、
      OS が明るいと #5f5f6b（比 2.9、#14141a の上でほぼ沈む）。
      直す側が暗い設定で見ていれば、一生気づかない。

      色の名前ではなく、地との比そのものを見張る。
      これなら色を変えても、選びかたを間違えたときだけ落ちる。
    */
    check(
      '暗い地でも、ラベルが地から浮いている',
      (await contrastOf(page, '.scenes__label', '.scenes')) >= 4.5,
      `比 ${(await contrastOf(page, '.scenes__label', '.scenes')).toFixed(1)}`,
    );
    check(
      '暗い地でも、地の切り替えボタンが読める',
      (await contrastOf(page, '.scenes__swap', '.scenes')) >= 4.5,
      `比 ${(await contrastOf(page, '.scenes__swap', '.scenes')).toFixed(1)}`,
    );

    await swap.click();
    await page.waitForTimeout(500);
    check('もう一度押すと写真の上になる', (await strip.getAttribute('data-bg')) === 'photo');
    check('写真の地が描かれている', (await page.locator('.scenes__bg').count()) === 1);
    // 敷いた写真が真っ黒・真っ白ではないこと（模様がある地であること）
    const spread = await page.evaluate(() => {
      const c = document.querySelector('.scenes__bg');
      if (!c) return 0;
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      let lo = 255;
      let hi = 0;
      for (let i = 0; i < d.length; i += 4 * 37) {
        const v = (d[i] + d[i + 1] + d[i + 2]) / 3;
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
      return hi - lo;
    });
    check('地に模様がある（平らな色ではない）', spread > 10, `明暗の幅 ${Math.round(spread)}`);

    /*
      写真の上では、文字の後ろに影が要る。

      地は、この人が選んだ写真そのもの。何が写っているかは分からないので、
      「明るい色にすれば読める」が成り立たない。白い服や空が来れば
      明るい文字ほど消える。地をぼかせば済む話ではある —— が、
      ぼかした瞬間にこの帯の目的（模様のある地で輪郭が立つか）が失われる。
      だから文字の側で解決してあることを見張る。
    */
    const shadowed = await page.evaluate(() =>
      ['.scenes__title', '.scenes__label', '.scenes__swap'].every((sel) => {
        const el = document.querySelector(sel);
        const s = el && getComputedStyle(el).textShadow;
        return !!s && s !== 'none';
      }),
    );
    check('写真の上では、文字の後ろに影が敷いてある', shadowed);

    /*
      写真の地に、並べて見るところが隠されていないこと。

      2つを合流させたときに出る穴。「写真の上」の地は帯いっぱいに敷く
      canvas で、中身より後ろ（z-index 0）に置いてある。後ろに回すには
      中身の側に z-index 1 が要るが、それは合流前にあった要素
      （見出しと大きさの列）にしか書かれていない。

      あとから足した「並べてみる」は指定を持たないので、地の canvas が
      そのまま上に乗る —— 開いているのに何も見えない、という壊れかたをする。
      しかも暗い地では地が真っ黒なので、畳んでいるのと区別がつかない。

      重なりは目で見ても分からないので、その点に本当に何があるかを聞く。
    */
    // elementFromPoint は画面上の座標で聞くので、画面の外にあると答えが返らない
    await page.locator('.feed__icon--me').scrollIntoViewIfNeeded();
    await page.waitForTimeout(200);
    const onTop = await page.evaluate(() => {
      const icon = document.querySelector('.feed__icon--me');
      if (!icon) return 'アイコンが無い';
      const b = icon.getBoundingClientRect();
      const hit = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
      if (!hit) return '取れない';
      return hit.classList.contains('scenes__bg') ? '地に隠れている' : 'ok';
    });
    check('写真の上でも、並べて見るところが隠れない', onTop === 'ok', onTop);

    await swap.click();
    await page.waitForTimeout(400);
    check('もう一度押すと明るい地に戻る', (await strip.getAttribute('data-bg')) === 'light');

    // 動かしたら、小さいほうも一緒に変わること（1フレーム遅れて古い絵が残らないか）
    /*
      はじめ「不透明な画素の割合」で見ていたが、写真が円を埋めきるので
      どう動かしても 100% のままで、何も測れていなかった。
      絵の指紋（位置で重みを変えた合計）に替えて、中身の変化そのものを見る。
    */
    const sigBefore = (await shot())[2].sig;
    await page.getByRole('slider', { name: /の大きさ/ }).fill('220');
    await page.waitForTimeout(700);
    const sigAfter = (await shot())[2].sig;
    check(
      '本体を動かすと、小さいほうも一緒に変わる',
      sigAfter !== sigBefore,
      `${sigBefore} → ${sigAfter}`,
    );

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

  /*
    つまみを触りながら、結果が見えること。

    「どこを切りぬくか」を足して分かったことがある。つまみは画面の下のほうに
    あるので、動かす → 見に上へ戻る → また下へ降りる、という往復が起きる。
    顔が丸に入ったかは一目で分かるのに、その一目のたびにスクロールしていた。

    つまみの置き場所を変えても、直るのは1つだけ。大きさもかたむきも同じ往復を
    している。だからプレビューのほうを画面に貼り付けた。

    見張るのは見た目ではなく、**同時に見えるかどうか**。
    プレビューが全部出ていて、なおかつつまみ一式が台の下に収まる位置が
    存在すること。画面の短い端末ほど厳しいので、そちらでも見る。
  */
  console.log('\n■ 見ながら調整できること');
  {
    for (const [name, w, h] of [
      ['ふつうの端末', 390, 844],
      ['短い端末', 390, 667],
    ]) {
      const page = await browser.newPage({ viewport: { width: w, height: h } });
      await page.route('**huggingface.co/**', (r) => r.abort());
      await page.goto(BASE, { waitUntil: 'networkidle' });
      await page
        .getByRole('button', { name: 'はじめる' })
        .click()
        .catch(() => {});
      await page.setInputFiles('input[type=file]', join(FIXTURES, 'photo-tall.png'));
      await page.waitForTimeout(500);
      await page.getByRole('button', { name: /つぎへ：フレームをえらぶ/ }).click();
      await page.waitForTimeout(250);
      await page.setInputFiles('input[type=file]', join(FIXTURES, 'neon.png'));
      await page.waitForTimeout(4000);
      await page.getByRole('button', { name: /これでOK/ }).click();
      await page.waitForTimeout(1400);
      await page.getByRole('button', { name: 'まる', exact: true }).click();
      await page.waitForTimeout(500);

      /* 台の下へ来るまで寄せる。人が指で合わせるのと同じこと */
      const fit = await page.evaluate(() => {
        const el = [...document.querySelectorAll('input[type=range]')].pop();
        const field = el.closest('.field');
        field.scrollIntoView({ block: 'center' });
        const dock = document.querySelector('.stage-dock');
        let d = dock.getBoundingClientRect();
        let r = field.getBoundingClientRect();
        if (r.top < d.bottom + 10) scrollBy(0, r.top - d.bottom - 10);
        d = dock.getBoundingClientRect();
        r = field.getBoundingClientRect();
        const s = document.querySelector('.stage').getBoundingClientRect();
        return {
          knob: r.top >= d.bottom - 1 && r.bottom <= innerHeight + 1,
          preview: s.top >= -1 && s.bottom <= innerHeight + 1,
          spare: Math.round(innerHeight - d.bottom - r.height),
        };
      });

      check(`${name}：つまみ一式が、台の下に収まる`, fit.knob, `あまり ${fit.spare}px`);
      check(`${name}：そのときプレビューも全部見えている`, fit.preview);
      await page.close();
    }
  }

  /*
    どこを切りぬくか。

    ── 直したのは「選べなかった」こと ──

    切りぬきは短いほうの辺にそろえるので、縦長の写真ではまん中の帯が残る。
    全身の写真なら、残るのは胴体で顔は落ちる。そこまでは仕様として正しい。

    問題は直す方法が無かったこと。窓は写真の中心に固定されていて、写真と
    一緒に動いていた。指で動かしても窓の中身は1画素も変わらず、動くのは
    切りぬかれた円のほう。フレームの穴からはみ出て、穴にすきまの色が出るだけ。
    顔を丸に入れる手段が1つも無かった。

    ── 何を見張るか ──

    色の帯を4本置いた縦長の写真を使う。窓の中の色を読めば、
    写真のどこが残っているかが機械的に分かる。「動かせること」だけでなく、
    **端まで動かしても写真の外が入らないこと**まで見る。
    そこが崩れると、丸の中に空白が出る。
  */
  console.log('\n■ どこを切りぬくか');
  {
    const { page } = await openFrame(browser, 'neon.png', 'photo-tall.png');
    await page.getByRole('button', { name: /これでOK/ }).click();
    await page.waitForTimeout(1500);

    const labels = () =>
      page.evaluate(() =>
        [...document.querySelectorAll('.field__label')].map((e) => e.textContent),
      );

    check(
      '切りぬかないうちは、つまみを出さない',
      !(await labels()).some((l) => l.includes('どこを切りぬくか')),
    );

    await page.getByRole('button', { name: 'まる', exact: true }).click();
    await page.waitForTimeout(600);

    const after = await labels();
    check(
      'まるにすると、たてのつまみが出る',
      after.some((l) => l.includes('どこを切りぬくか（たて）')),
    );
    /*
      動かせるのは、長いほうの辺が余っている向きだけ。
      縦長の写真で よこ のつまみを出すと、動かしても何も起きない目盛りになる。
      動かないものを置くと、壊れていると思われる。
    */
    check(
      '縦長の写真では、よこのつまみは出さない',
      !after.some((l) => l.includes('どこを切りぬくか（よこ）')),
    );

    /* 丸の中を広めに読んで、出ている色を数える */
    const inside = () =>
      page.evaluate(() => {
        const c = document.querySelector('.stage canvas');
        const g = c.getContext('2d');
        const r = Math.round(Math.min(c.width, c.height) * 0.18);
        const cx = Math.round(c.width / 2);
        const cy = Math.round(c.height / 2);
        const d = g.getImageData(cx - r, cy - r, r * 2, r * 2).data;
        const seen = new Set();
        let clear = 0;
        for (let i = 0; i < d.length; i += 4) {
          if (d[i + 3] < 8) clear++;
          else seen.add(`${d[i] >> 4},${d[i + 1] >> 4},${d[i + 2] >> 4}`);
        }
        return { colors: [...seen].sort().join(' '), clear };
      });

    const range = page.locator('input[type=range]').last();
    const middle = await inside();

    await range.fill('-100');
    await page.waitForTimeout(600);
    const top = await inside();

    await range.fill('100');
    await page.waitForTimeout(600);
    const bottom = await inside();

    check('つまみを動かすと、窓の中身が変わる', middle.colors !== top.colors);
    check(
      '上の端と下の端で、別のところが残る',
      top.colors !== bottom.colors,
      `${top.colors} ／ ${bottom.colors}`,
    );

    /*
      端まで動かしても、写真の外が入らないこと。

      つまみの ±1 は「窓が写真の端に着いたところ」に合わせてある。
      ここを画素数で持つと、写真の大きさによっては行きすぎて、
      丸の中に空白（とうめい）が出る。比で持っているのはそのため。
    */
    check(
      '端まで動かしても、丸の中に空白が出ない',
      top.clear === 0 && bottom.clear === 0,
      `上 ${top.clear} 画素 ／ 下 ${bottom.clear} 画素`,
    );

    /* そのままに戻したら、つまみごと引っ込む */
    await page.getByRole('button', { name: 'そのまま', exact: true }).click();
    await page.waitForTimeout(500);
    check(
      'そのままに戻すと、つまみも引っ込む',
      !(await labels()).some((l) => l.includes('どこを切りぬくか')),
    );

    /*
      指でも合わせられること。

      つまみだけだと、動かす → 上へ見に行く → また下へ、という往復が起きる。
      プレビューを貼り付けてそこは楽になったが、**プレビューの上で直接
      合わせられる**のがいちばん短い。このアプリは「指1本で動かす」を
      いちばん先に覚えてもらう作りなので、そこに乗せる。

      見張るのは2つ。窓の中身が変わること、そして**写真そのものは動かないこと**。
      後者を外すと、切りぬきを合わせたつもりで構図までずれる。
    */
    await page.getByRole('button', { name: 'まる', exact: true }).click();
    await page.waitForTimeout(500);
    check(
      'かたちを選ぶと「切りぬく場所」が出る',
      (await page.getByRole('button', { name: '切りぬく場所', exact: true }).count()) === 1,
    );

    await page.getByRole('button', { name: '切りぬく場所', exact: true }).click();
    await page.waitForTimeout(300);

    /*
      1点だけ読むと、判定できないことがある。
      直前の検証が窓を下端に置いたままなので、そこから少し動かしても
      同じ帯の中に留まり、色が変わらない（実際それで一度、
      動いているのに落ちる検証を書いた）。

      いったんまん中に戻してから動かし、丸の中の色ぜんぶで見くらべる。
    */
    const readRange = () =>
      page.evaluate(() => {
        const el = [...document.querySelectorAll('input[type=range]')].pop();
        return el ? Number(el.value) : null;
      });

    await page.locator('input[type=range]').last().fill('0');
    await page.waitForTimeout(500);
    const beforeDrag = (await inside()).colors;
    const posBefore = await readRange();

    const stage = page.locator('.stage');
    await stage.scrollIntoViewIfNeeded();
    await page.waitForTimeout(200);
    const box = await stage.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    for (let k = 1; k <= 8; k++) {
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 + k * 12);
      await page.waitForTimeout(20);
    }
    await page.mouse.up();
    await page.waitForTimeout(600);

    const afterDrag = (await inside()).colors;
    const posAfter = await readRange();

    check(
      '指で動かすと、窓の中身が変わる',
      beforeDrag !== afterDrag,
      `${beforeDrag} → ${afterDrag}`,
    );
    check(
      'つまみも一緒に動く（同じものを指している）',
      posBefore !== null && posAfter !== null && posBefore !== posAfter,
      `${posBefore} → ${posAfter}`,
    );

    /*
      写真そのものは動かないこと。
      ここが崩れると、切りぬきを合わせたつもりで構図までずれる。
    */
    await page.getByRole('button', { name: '写真', exact: true }).click();
    await page.waitForTimeout(300);
    const photoPos = await page.evaluate(() => {
      const el = [...document.querySelectorAll('input[type=range]')];
      return el.length ? el[0].value : null;
    });
    check('切りぬきを動かしても、写真の大きさは変わらない', photoPos === '100', String(photoPos));

    /* かたちを戻したら、指の相手も写真に戻る */
    await page.getByRole('button', { name: 'そのまま', exact: true }).click();
    await page.waitForTimeout(400);
    check(
      'そのままに戻すと、「切りぬく場所」も消える',
      (await page.getByRole('button', { name: '切りぬく場所', exact: true }).count()) === 0,
    );

    await page.close();
  }

  /*
    お金に触れる要素が、画面のどこにも無いこと。

    ── いまの状態 ──

    2026-08 の Stripe の審査を通したあと、決済まわりを丸ごと外した。
    金額の選択も、決済への導線も、決済の順路も、応援ページもお礼ページも無い。
    残っているのは「つくる」と「知らせる」の2つだけ。

    ── なぜ画面から数えるのか ──

    以前ここで一度しくじっている。文言を消してまわったのに、ページの
    いちばん上に「支援をえらぶ → 決済する → 完了」という帯が残っていた。
    公開後のスクリーンショットで見つかった。

    検証も画面を見ていたのに捕まらなかったのは、**「何が出ていないか」を
    一度も数えていなかった**から。出ているものばかり数えていた。
    だからここは、出ていてはいけないものを名指しで数える。
  */
  /*
    ■ うごく素材のスタジオ

    ここで確かめたいのは、ただ1つ。
    **「背景がなくなった状態で、他のアプリに渡せるか」**

    画面に出ている絵がきれいでも、渡した先で背景が黒く塗られていたら
    このツールは何もしていないのと同じになる。だから見るのは
    「舞台の画素」だけでなく、**書き出したファイルを読み直したときの画素**。

    ── 検証用の動画を、その場で作っている理由 ──

    リポジトリに動画を置くと、それだけで数百KB〜数MBが増える。
    しかも検証に使う Chromium には H.264 の鍵が入っていないので、
    ふつうの MP4 を置いても、この環境では開けない。
    ブラウザ自身に WebM を録らせれば、置かずに済み、必ず開ける。

    ── AI は動かせない ──

    検証中はモデルの取得を止めてある（通信できない端末の再現）。
    そのため、ここで通るのは「色で消す」道だけ。AI の道は
    src/lib/ai.ts の側で、つくる画面の検証が見ている。
  */
  console.log('\n■ うごく素材のスタジオ');
  {
    const page = await browser.newPage({ viewport: { width: 1180, height: 940 } });
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e.message)));
    page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
    await page.route('**huggingface.co/**', (r) => r.abort());

    const asked = [];
    page.on('request', (r) => asked.push(r.url()));

    await page.goto(BASE, { waitUntil: 'networkidle' });
    await page.waitForTimeout(400);
    check(
      'つくる画面では、スタジオの中身を落としてこない',
      !asked.some((u) => /StudioPage/.test(u)),
      asked.filter((u) => /StudioPage/.test(u)).join(' '),
    );
    check('つくる画面に、動画への入口がある', (await page.locator('.hop').count()) === 1);

    await page.goto(BASE + '#/studio', { waitUntil: 'networkidle' });
    await page.waitForTimeout(700);
    check('スタジオが開く', (await page.locator('.st-hero').count()) === 1);
    check(
      '開いたときだけ、スタジオの中身を取りにいく',
      asked.some((u) => /StudioPage/.test(u)),
    );

    /* 置き場所が、この画面でいちばん大きい面であること（視線の起点） */
    {
      const drop = await page.locator('.st-drop .drop').boundingBox();
      check(
        '置き場所が、指で外しようのない大きさ',
        drop.height >= 200,
        `${Math.round(drop.height)}px`,
      );
    }

    /* ── 画像1枚：単色の地が消え、まん中の形だけが残る ── */
    await page.setInputFiles('.st-drop input[type=file]', join(FIXTURES, 'studio-solid.png'));
    await page.waitForTimeout(900);

    check('置くと舞台が出る', (await page.locator('.st-stage__canvas').count()) === 1);
    check(
      '単色の地は「色で消す」と、先に言う',
      /単色/.test(await page.locator('.st-plan').innerText()),
      await page.locator('.st-plan').innerText(),
    );
    check('消す前は、見くらべのつまみを出さない', (await page.locator('.st-wipe').count()) === 0);

    await page.getByRole('button', { name: '背景をけす' }).click();
    // 消し終わったあと、一度だけ右から左へ拭う演出が入る。その終わりまで待つ
    await page.waitForTimeout(2800);

    check(
      'けし終わると、次は保存だと分かる',
      (await page.getByRole('button', { name: 'ほぞんする' }).count()) === 1,
    );

    const stagePixel = (fx, fy) =>
      page.evaluate(
        ([fx, fy]) => {
          const c = document.querySelector('.st-stage__canvas');
          const d = c.getContext('2d', { willReadFrequently: true });
          const x = Math.min(c.width - 1, Math.round(c.width * fx));
          const y = Math.min(c.height - 1, Math.round(c.height * fy));
          return [...d.getImageData(x, y, 1, 1).data];
        },
        [fx, fy],
      );

    {
      const corner = await stagePixel(0.02, 0.05);
      const center = await stagePixel(0.5, 0.5);
      check('地は透明になる', corner[3] < 12, `alpha ${corner[3]}`);
      check('前景は残る', center[3] > 240, `alpha ${center[3]}`);
    }

    check('消したあとは、見くらべの入口が出る', (await page.locator('.st-compare').count()) === 1);

    /*
      見くらべ。押すと境目が出て、左側だけが「消す前」に戻る。

      ここは目でしか確かめられないと思われがちだが、
      「左は元の地の色・右は透明」を読めば、機械でも確かめられる。
    */
    {
      await page.locator('.st-compare').click();
      await page.waitForTimeout(250);
      const stage = await page.locator('.st-stage').boundingBox();
      const grip = await page.locator('.st-wipe__grip').boundingBox();
      await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
      await page.mouse.down();
      await page.mouse.move(stage.x + stage.width * 0.62, grip.y + grip.height / 2, { steps: 8 });
      await page.mouse.up();
      await page.waitForTimeout(300);

      const left = await stagePixel(0.1, 0.06);
      const right = await stagePixel(0.92, 0.06);
      check(
        'つまみの左には、消す前の地が出る',
        left[3] > 250 && left[2] > 150 && left[0] < 90,
        left.join(','),
      );
      check('つまみの右は、消したあとのまま', right[3] < 12, `alpha ${right[3]}`);

      // 端まで戻すと、つまみは引っ込んで「くらべる」に戻る
      await page.mouse.move(stage.x + stage.width * 0.62, grip.y + grip.height / 2);
      await page.mouse.down();
      await page.mouse.move(stage.x + 1, grip.y + grip.height / 2, { steps: 8 });
      await page.mouse.up();
      await page.waitForTimeout(300);
      check(
        '端まで戻すと、つまみは引っ込む',
        (await page.locator('.st-wipe').count()) === 0 &&
          (await page.locator('.st-compare').count()) === 1,
      );
    }

    /* ── 背景チップ：うしろに敷いたものが、その場で舞台に出る ── */
    await page.getByRole('button', { name: 'グリーン' }).click();
    await page.waitForTimeout(350);
    {
      const corner = await stagePixel(0.02, 0.05);
      check(
        'グリーンを選ぶと、うしろが緑で埋まる',
        corner[3] > 250 && corner[1] > 120 && corner[0] < 90,
        corner.join(','),
      );
    }
    await page.getByRole('button', { name: 'とうめい' }).click();
    await page.waitForTimeout(350);
    check('とうめいに戻せる', (await stagePixel(0.02, 0.05))[3] < 12);

    /* ── 動画：録って、置いて、消して、書き出して、読み直す ── */
    await page.locator('.st-clip__x').click();
    await page.waitForTimeout(400);
    check('素材を外すと、はじめの画面に戻る', (await page.locator('.st-hero').count()) === 1);

    const made = await page.evaluate(async () => {
      const c = document.createElement('canvas');
      c.width = 320;
      c.height = 180;
      const x = c.getContext('2d');
      const stream = c.captureStream(25);
      const rec = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp8' });
      const chunks = [];
      rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
      const stopped = new Promise((r) => (rec.onstop = r));
      rec.start();
      const t0 = performance.now();
      await new Promise((done) => {
        const draw = () => {
          const p = (performance.now() - t0) / 1400;
          x.fillStyle = '#00b140';
          x.fillRect(0, 0, 320, 180);
          x.fillStyle = '#e2384f';
          // まん中は動かさない（どの時刻でも「前景」が居ることを確かめたいので）
          x.fillRect(104 + Math.sin(p * 6) * 6, 44, 112, 92);
          if (performance.now() - t0 > 1400) done();
          else requestAnimationFrame(draw);
        };
        draw();
      });
      rec.stop();
      await stopped;
      const blob = new Blob(chunks, { type: 'video/webm' });
      const file = new File([blob], 'test-clip.webm', { type: 'video/webm' });
      const dt = new DataTransfer();
      dt.items.add(file);
      document
        .querySelector('.st-drop .drop')
        .dispatchEvent(
          new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }),
        );
      return blob.size;
    });
    check('検証用の動画を録れた', made > 1000, `${made} バイト`);

    await page.waitForTimeout(2500);
    check('動画を置くと、フィルムが出る', (await page.locator('.st-film__track').count()) === 1);
    check(
      '長さが書かれていない動画でも、コマ数を数えられる',
      /コマ/.test(await page.locator('.st-clip__meta').innerText()) &&
        !/^0コマ/.test(await page.locator('.st-clip__meta').innerText()),
      await page.locator('.st-clip__meta').innerText(),
    );

    await page.getByRole('button', { name: '背景をけす' }).click();
    await page.waitForTimeout(6000);
    check(
      '動画も、けし終わって保存に進める',
      (await page.getByRole('button', { name: 'ほぞんする' }).count()) === 1,
    );
    {
      const corner = await stagePixel(0.03, 0.06);
      const center = await stagePixel(0.5, 0.5);
      check('動画でも、地が透明になる', corner[3] < 20, `alpha ${corner[3]}`);
      check('動画でも、前景が残る', center[3] > 230, `alpha ${center[3]}`);
    }

    /*
      緑の地から抜いたとき、被写体のフチに緑が残っていないこと。

      緑の地は光を反射するので、フチそのものが緑に染まる。そこは半透明ではなく
      不透明なので、「半透明から背景色を引く」処理では手が届かない。
      動画の圧縮（色を間引く方式）がさらに緑をにじませる。

      放送の現場と同じ考えかたで、「緑が赤と青の平均を超えている分」を削っている。
      ここでは、いちばん外側の不透明な画素を拾って、その色を読む。
    */
    {
      const edge = await page.evaluate(() => {
        const c = document.querySelector('.st-stage__canvas');
        const d = c
          .getContext('2d', { willReadFrequently: true })
          .getImageData(0, 0, c.width, c.height).data;
        const y = Math.round(c.height * 0.5);
        for (let x = 0; x < c.width; x++) {
          const i = (y * c.width + x) * 4;
          if (d[i + 3] > 200) return [d[i], d[i + 1], d[i + 2]];
        }
        return null;
      });
      check(
        '緑の地から抜いても、フチが緑に光らない',
        !!edge && edge[1] <= (edge[0] + edge[2]) / 2 + 12,
        edge ? `フチの色 rgb(${edge.join(',')})` : '見つからない',
      );
    }

    check(
      'フィルムに、切り抜いたあとのコマが並ぶ',
      (await page.locator('.st-film__img').count()) >= 3,
      `${await page.locator('.st-film__img').count()} 枚`,
    );

    /* 保存：行き先で選ばせているか */
    await page.getByRole('button', { name: 'ほぞんする' }).click();
    await page.waitForTimeout(700);
    const cards = await page.locator('.st-card__title').allInnerTexts();
    check('行き先の名前で選ばせている（形式名ではなく）', cards.length >= 3, cards.join(' / '));
    check('配信ソフト向けが、いちばん上にある', /配信ソフト/.test(cards[0] ?? ''), cards[0]);

    /* 透過WebM を実際に書き出して、透明が残っているかを読み直す */
    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 60_000 }),
      page.getByRole('button', { name: /配信ソフトに、そのまま置く/ }).click(),
    ]);
    const savedPath = await download.path();
    const savedName = download.suggestedFilename();
    const bytes = readFileSync(savedPath);
    check(
      '透過の動画が書き出される',
      savedName.endsWith('.webm') && bytes.length > 2000,
      `${savedName} / ${bytes.length}バイト`,
    );
    /*
      書き出したものは、渡す前にこちらで開いて確かめている（export.ts の inspect）。
      その確かめが**正しいものに難癖をつけていない**ことを、ここで見ておく。
      せっかく良い出来のものに毎回「怪しい」と出たら、警告そのものが読まれなくなる。
    */
    check(
      '正しく録れたものには、注意書きを出さない',
      (await page.locator('.st-save__done .note--warn').count()) === 0,
      await page.locator('.st-save__done').innerText(),
    );

    check(
      '中身がちゃんと WebM になっている',
      bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3,
    );

    const back = await page.evaluate(async (b64) => {
      const bin = atob(b64);
      const arr = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
      const v = document.createElement('video');
      v.muted = true;
      v.playsInline = true;
      v.src = URL.createObjectURL(new Blob([arr], { type: 'video/webm' }));
      await new Promise((res, rej) => {
        v.onloadeddata = res;
        v.onerror = () => rej(new Error('読み直せない'));
        setTimeout(() => rej(new Error('時間切れ')), 10_000);
      });
      v.currentTime = 0.4;
      await new Promise((res) => {
        v.onseeked = res;
        setTimeout(res, 3000);
      });
      const c = document.createElement('canvas');
      c.width = v.videoWidth;
      c.height = v.videoHeight;
      const x = c.getContext('2d', { willReadFrequently: true });
      x.clearRect(0, 0, c.width, c.height);
      x.drawImage(v, 0, 0);
      const at = (fx, fy) => [
        ...x.getImageData(Math.round(c.width * fx), Math.round(c.height * fy), 1, 1).data,
      ];
      return { size: [c.width, c.height], corner: at(0.04, 0.08), center: at(0.5, 0.5) };
    }, bytes.toString('base64'));

    check('書き出したものを開き直せる', back.size[0] > 0, back.size.join('x'));
    check(
      '**渡した先でも、背景が無いまま**',
      back.corner[3] < 30,
      `すみの不透明度 ${back.corner[3]}`,
    );
    check(
      '渡した先でも、前景は残っている',
      back.center[3] > 200,
      `まん中の不透明度 ${back.center[3]}`,
    );

    /*
      グリーン背景：透過を読めないアプリへ渡すための道。

      ここで確かめたいのは「本当にその形式で録れるか」。
      MediaRecorder.isTypeSupported は、符号器を持っていなくても
      対応していると答えることがある（この Chromium がまさにそれで、
      video/mp4 に「はい」と答えるのに H.264 を持っていない）。
      実際に押して、ファイルが出てくるところまで見る。
    */
    await page.getByRole('button', { name: 'べつの形でも保存する' }).click();
    await page.waitForTimeout(500);
    const [green] = await Promise.all([
      page.waitForEvent('download', { timeout: 60_000 }),
      page.getByRole('button', { name: /CapCut などの編集アプリで使う/ }).click(),
    ]);
    const greenBytes = readFileSync(await green.path());
    check(
      'グリーン背景の動画が書き出される',
      greenBytes.length > 2000,
      `${green.suggestedFilename()} / ${greenBytes.length}バイト`,
    );

    const greenBack = await page.evaluate(async (b64) => {
      const bin = atob(b64);
      const arr = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
      const v = document.createElement('video');
      v.muted = true;
      v.src = URL.createObjectURL(new Blob([arr]));
      await new Promise((res, rej) => {
        v.onloadeddata = res;
        v.onerror = () => rej(new Error('読み直せない'));
        setTimeout(() => rej(new Error('時間切れ')), 10_000);
      });
      v.currentTime = 0.4;
      await new Promise((res) => {
        v.onseeked = res;
        setTimeout(res, 3000);
      });
      const c = document.createElement('canvas');
      c.width = v.videoWidth;
      c.height = v.videoHeight;
      const x = c.getContext('2d', { willReadFrequently: true });
      x.drawImage(v, 0, 0);
      return [
        ...x.getImageData(Math.round(c.width * 0.04), Math.round(c.height * 0.08), 1, 1).data,
      ];
    }, greenBytes.toString('base64'));
    check(
      '渡した先では、地がグリーンで塗られている',
      greenBack[3] > 250 && greenBack[1] > 120 && greenBack[0] < 90,
      greenBack.join(','),
    );

    /*
      書き出しの途中で、画面を離れられたとき。

      これは「起きるかもしれない」ではなく、**必ず起きる**。
      実時間で録るので、10秒の素材なら10秒待つことになり、
      人はそのあいだに別のタブを見にいく。通知に応える。画面を消す。

      ブラウザは、見えていない画面のコマ送りを止める。
      止まったことに気づかずに録り続けると、途中から止め絵の動画ができあがり、
      **本人は最後まで録れたと思ったまま**配信で使うことになる。

      ここでは、その状況を作って確かめる。
      画面が隠れたら止まること・止まっているあいだ進まないこと・
      戻ったら続きから録れて、最後まで透過が残っていること。
    */
    await page.getByRole('button', { name: 'べつの形でも保存する' }).click();
    await page.waitForTimeout(400);

    const setHidden = (hidden) =>
      page.evaluate((h) => {
        Object.defineProperty(document, 'hidden', { configurable: true, get: () => h });
        Object.defineProperty(document, 'visibilityState', {
          configurable: true,
          get: () => (h ? 'hidden' : 'visible'),
        });
        document.dispatchEvent(new Event('visibilitychange'));
      }, hidden);

    const percent = () =>
      page.evaluate(() => document.querySelector('.st-ring span')?.textContent ?? '');

    {
      const pending = page.waitForEvent('download', { timeout: 60_000 });
      await page.getByRole('button', { name: /配信ソフトに、そのまま置く/ }).click();
      await page.waitForSelector('.st-save__busy', { timeout: 10_000 });
      await setHidden(true);
      await page.waitForTimeout(350);

      check(
        '離れたら、止めたと画面に出る',
        (await page.locator('.st-save__busy[data-paused="true"]').count()) === 1,
        await page.locator('.st-save__busyLabel').innerText(),
      );
      check(
        '離れたら、動画そのものも止まっている',
        await page.evaluate(() => document.querySelector('video')?.paused === true),
      );

      const before = await percent();
      await page.waitForTimeout(900);
      const after = await percent();
      check('離れているあいだ、進まない', before === after, `${before} → ${after}`);

      await setHidden(false);
      await page.waitForTimeout(300);
      check(
        '戻ったら、また動き出す',
        (await page.locator('.st-save__busy[data-paused="true"]').count()) === 0,
      );

      const resumed = await pending;
      const resumedBytes = readFileSync(await resumed.path());
      check(
        '離席をはさんでも、最後まで書き出せる',
        resumedBytes.length > 2000,
        `${resumed.suggestedFilename()} / ${resumedBytes.length}バイト`,
      );

      const stillClear = await page.evaluate(async (b64) => {
        const bin = atob(b64);
        const arr = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
        const v = document.createElement('video');
        v.muted = true;
        v.src = URL.createObjectURL(new Blob([arr], { type: 'video/webm' }));
        await new Promise((res, rej) => {
          v.onloadeddata = res;
          v.onerror = () => rej(new Error('読み直せない'));
          setTimeout(() => rej(new Error('時間切れ')), 10_000);
        });
        /*
          離席をはさんだ後半のコマを見る（前半だけ正しい、を見逃さないため）。

          録りながら書き出した WebM には長さが書かれていないので、
          duration は Infinity のまま。ここでは「あり得ないほど先」へ飛ばして
          終わりに着地させる（アプリ側が長さを確かめるのと同じやりかた）。
        */
        v.currentTime = 1e101;
        await new Promise((res) => {
          v.onseeked = res;
          setTimeout(res, 3000);
        });
        const c = document.createElement('canvas');
        c.width = v.videoWidth;
        c.height = v.videoHeight;
        const x = c.getContext('2d', { willReadFrequently: true });
        x.clearRect(0, 0, c.width, c.height);
        x.drawImage(v, 0, 0);
        const at = (fx, fy) => [
          ...x.getImageData(Math.round(c.width * fx), Math.round(c.height * fy), 1, 1).data,
        ];
        return { corner: at(0.04, 0.08), center: at(0.5, 0.5) };
      }, resumedBytes.toString('base64'));

      check(
        '再開したあとのコマも、背景が無いまま',
        stillClear.corner[3] < 30,
        `すみの不透明度 ${stillClear.corner[3]}`,
      );
      check(
        '再開したあとのコマに、前景が残っている',
        stillClear.center[3] > 200,
        `まん中の不透明度 ${stillClear.center[3]}`,
      );
    }

    /* PNG連番：ひとまとめの箱として渡せるか */
    await page.getByRole('button', { name: 'べつの形でも保存する' }).click();
    await page.waitForTimeout(500);
    const [zip] = await Promise.all([
      page.waitForEvent('download', { timeout: 60_000 }),
      page.getByRole('button', { name: /いちばんきれいに残す/ }).click(),
    ]);
    const zipBytes = readFileSync(await zip.path());
    check(
      'PNG連番が ZIP として書き出される',
      zip.suggestedFilename().endsWith('.zip') &&
        zipBytes[0] === 0x50 &&
        zipBytes[1] === 0x4b &&
        zipBytes.length > 3000,
      `${zip.suggestedFilename()} / ${zipBytes.length}バイト`,
    );
    check(
      'ZIP の中に、コマと読みかたの紙が入っている',
      zipBytes.includes(Buffer.from('0001.png')) &&
        zipBytes.includes(Buffer.from('このフォルダについて.txt')),
    );

    check('通しで、エラーが1件も出ていない', errors.length === 0, errors.slice(0, 3).join(' / '));
    await page.close();
  }

  /*
    ■ iPhone から使ったとき

    ここは端末ごとに正反対のことが起きる場所で、しかも実機でしか確かめられない
    と思われがちなところ。だが「どちらの道を主役にしたか」「何と書いたか」
    「押したら何を渡したか」は、名乗りを変えるだけで確かめられる。

    iPhone で起きること（一次情報にあたって確かめた事実）
      ・Safari の録画は MP4（H.264/AAC）だけ。MP4 は透明を持てない
        → 透過WebM の行き先は出せない。**出せない理由と代わりの道**を出す
      ・写真アプリに入れる道は共有シートだけ。ダウンロードは「ファイル」行き
        → いちばん大きいボタンを共有に入れ替える
      ・共有シートは、指が離れてすぐでないと開けない
        → 書き出しの直後に自分から開かず、押してもらう
  */
  console.log('\n■ iPhone から使ったとき');
  {
    const page = await browser.newPage({
      viewport: { width: 390, height: 844 },
      userAgent:
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
    });
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e.message)));
    await page.route('**huggingface.co/**', (r) => r.abort());

    /*
      iPhone の振るまいのうち、こちらの分岐に効くものだけを置き換える。

        ・透過（WebM）は録れない … isTypeSupported に webm を否と言わせる
        ・共有シートは持っている … share / canShare を、呼ばれた記録に差し替える

      端末そのものを再現するのではなく、**分かれ道の入口だけ**を再現している。
      ここで見たいのは「どちらへ行くか」であって、Safari の中身ではない。
    */
    await page.addInitScript(() => {
      const original = MediaRecorder.isTypeSupported.bind(MediaRecorder);
      MediaRecorder.isTypeSupported = (type) =>
        /webm/i.test(type) ? false : original('video/webm;codecs=vp8') && !/webm/i.test(type);
      window.__shared = [];
      navigator.canShare = (data) => !!data?.files?.length;
      navigator.share = (data) => {
        window.__shared.push((data.files || []).map((f) => ({ name: f.name, type: f.type })));
        return Promise.resolve();
      };
    });

    await page.goto(BASE + '#/studio', { waitUntil: 'networkidle' });
    await page.waitForTimeout(700);
    await page.setInputFiles('.st-drop input[type=file]', join(FIXTURES, 'studio-solid.png'));
    await page.waitForTimeout(800);
    await page.getByRole('button', { name: '背景をけす' }).click();
    await page.waitForTimeout(2600);
    await page.getByRole('button', { name: 'ほぞんする' }).click();
    await page.waitForTimeout(600);

    const cards = await page.locator('.st-card__title').allInnerTexts();
    check('iPhone：画像の行き先はそのまま出る', cards.length >= 2, cards.join(' / '));

    /* 画像を保存 → 共有が主役になっているか */
    const beforeDownloads = [];
    page.on('download', (d) => beforeDownloads.push(d.suggestedFilename()));
    await page.getByRole('button', { name: /背景のない画像として保存する/ }).click();
    await page.waitForTimeout(1200);

    const primary = await page.locator('.st-save__actions .btn').first().innerText();
    check('iPhone：いちばん大きいボタンが「保存する」になる', /保存する/.test(primary), primary);
    check(
      'iPhone：写真に入れる道だと書いてある',
      /写真アプリ/.test(await page.locator('.st-save__done .note').first().innerText()),
      await page.locator('.st-save__done .note').first().innerText(),
    );
    check(
      'iPhone：勝手にダウンロードを始めない',
      beforeDownloads.length === 0,
      beforeDownloads.join(' / '),
    );

    await page.locator('.st-save__actions .btn').first().click();
    await page.waitForTimeout(400);
    const shared = await page.evaluate(() => window.__shared);
    check(
      'iPhone：押すと、ファイルそのものを共有シートに渡す',
      shared.length === 1 && shared[0].length === 1 && /\.png$/.test(shared[0][0].name),
      JSON.stringify(shared),
    );

    /* 動画のとき：出せない行き先の理由と、代わりの道が出るか */
    await page.getByRole('button', { name: 'べつの形でも保存する' }).click();
    await page.waitForTimeout(300);
    await page.getByRole('button', { name: 'とじる' }).click();
    await page.waitForTimeout(300);
    await page.locator('.st-clip__x').click();
    await page.waitForTimeout(400);

    await page.evaluate(async () => {
      const c = document.createElement('canvas');
      c.width = 240;
      c.height = 135;
      const x = c.getContext('2d');
      const stream = c.captureStream(25);
      const rec = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp8' });
      const chunks = [];
      rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
      const stopped = new Promise((r) => (rec.onstop = r));
      rec.start();
      const t0 = performance.now();
      await new Promise((done) => {
        const draw = () => {
          x.fillStyle = '#00b140';
          x.fillRect(0, 0, 240, 135);
          x.fillStyle = '#e2384f';
          x.fillRect(80, 30, 80, 70);
          if (performance.now() - t0 > 1200) done();
          else requestAnimationFrame(draw);
        };
        draw();
      });
      rec.stop();
      await stopped;
      const file = new File([new Blob(chunks, { type: 'video/webm' })], 'clip.webm', {
        type: 'video/webm',
      });
      const dt = new DataTransfer();
      dt.items.add(file);
      document
        .querySelector('.st-drop .drop')
        .dispatchEvent(
          new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }),
        );
    });
    await page.waitForTimeout(2600);
    await page.getByRole('button', { name: '背景をけす' }).click();
    await page.waitForTimeout(5000);
    await page.getByRole('button', { name: 'ほぞんする' }).click();
    await page.waitForTimeout(700);

    const titles = await page.locator('.st-card__title').allInnerTexts();
    check(
      'iPhone：いちばん上は「できること」になっている',
      /配信ソフト・編集アプリで使う/.test(titles[0] ?? ''),
      titles.join(' / '),
    );
    check(
      'iPhone：透明を持てない事情が、その場に書いてある',
      /MP4 は透明を持てません/.test(await page.locator('.st-card__note').first().innerText()),
      await page.locator('.st-card__note').first().innerText(),
    );
    check(
      'iPhone：緑で渡すことと、その外しかたが書いてある',
      /クロマキー/.test(await page.locator('.st-card__note').first().innerText()),
    );
    check(
      'iPhone：透過のまま渡す道（PNG連番）も残っている',
      titles.some((t) => /いちばんきれいに残す/.test(t)),
      titles.join(' / '),
    );
    check(
      'iPhone：押せない行き先を並べない',
      (await page.locator('.st-card:disabled').count()) <= 1,
    );

    check('iPhone：通しでエラーが出ていない', errors.length === 0, errors.slice(0, 3).join(' / '));
    await page.close();
  }

  /* MP4 をほどく部分は、中身の分かるファイルを組み立てて Node 側で見る */
  console.log('\n■ MP4 をほどく');
  runMp4Checks(check);

  /* いちどに引き受ける量。落ちかたが最悪なので、算数のうちに確かめる */
  console.log('\n■ いちどに引き受ける量');
  runBudgetChecks(check);

  console.log('\n■ お金に触れる要素が無いこと');
  {
    for (const [name, hash] of [
      ['つくる', ''],
      ['知らせる', '#/share'],
    ]) {
      const page = await browser.newPage({ viewport: { width: 390, height: 900 } });
      await page.goto(BASE + hash, { waitUntil: 'networkidle' });
      await page.waitForTimeout(500);

      check(`${name}：決済の順路を出さない`, (await page.locator('.steps--static').count()) === 0);

      /*
        つくる画面は隠れているだけで DOM には残っているので、.app は2つある。
        innerText は隠れているものを外すので、body から取れば見えている分だけになる。
      */
      const text = await page.evaluate(() => document.body.innerText);
      const words = ['支援をえらぶ', '決済する', '寄付', '募金', '応援する', '円'].filter((w) =>
        text.includes(w),
      );
      check(`${name}：お金の言いかたが出ない`, words.length === 0, words.join(' / '));

      check(
        `${name}：決済リンクが1本も無い`,
        (await page.locator('a[href*="stripe.com"]').count()) === 0,
      );
      await page.close();
    }
  }

  /*
    古いURLで来た人が、迷子にならないこと。

    #/support と #/support/thanks は配ってしまったあとに消したURL。
    ブックマークも、貼られたリンクも、こちらの都合では消えてくれない。
    開いたときに「つくる画面」が出るのは、行き先を間違えたように見える。

    共有ページへ送ったうえで、**URL も置き換える**。置き換えないと、
    次に「戻る」を押したときにまた古いURLへ戻り、送り返されて、
    戻れないループになる。だから履歴は足さずに差し替える。
  */
  console.log('\n■ 古いURLの行き先');
  {
    for (const [name, hash] of [
      ['応援ページ', '#/support'],
      ['お礼ページ', '#/support/thanks'],
      ['決済からの戻り先', '?thanks=1'],
    ]) {
      const page = await browser.newPage({ viewport: { width: 390, height: 900 } });
      await page.goto(BASE + hash, { waitUntil: 'networkidle' });
      await page.waitForTimeout(600);

      const seen = await page.evaluate(() => ({
        hash: location.hash,
        search: location.search,
        share: !!document.querySelector('.support__share'),
      }));
      check(`${name}：知らせるページが開く`, seen.share);
      check(
        `${name}：URL も新しいものに置き換わる`,
        seen.hash === '#/share' && seen.search === '',
        `${seen.hash}${seen.search}`,
      );
      await page.close();
    }
  }

  /*
    配るものを、そのまま読んで確かめる。

    中身は tools/check-dist.mjs にある。ここから呼ぶのは、
    「npm test を通した」と言うときに、この点検も通っていてほしいから。
    公開の直前にだけ単体で走らせることもできる（node tools/check-dist.mjs）。

    一度しくじっているので画面ではなくファイルを読む。文言を消したつもりで
    条件分岐の向こうに置いたとき、描画はされないのに文字列は配られる JS に
    そのまま入っていた。画面を見る検証では永久に捕まえられない壊れかた。
  */
  console.log('\n■ 配るものの点検');
  for (const r of [...checkDist(join(root, 'dist')), checkRepoWords(), checkRepoSecrets()]) {
    check(r.name, r.ok, r.detail);
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

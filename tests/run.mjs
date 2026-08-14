/**
 * 実際のブラウザで通しに動かす検証。
 *
 *   npm run build && npm test
 *
 * 透過の良し悪しは目で見ないと分からない、と思われがちだけれど、
 * 「四隅が透明か」「囲まれた白が残っているか」「グローが階調で残っているか」は
 * 出力画素のアルファを読めば機械的に確かめられる。ここではそれをやっている。
 */
import { spawn, spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { build } from './fixtures.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const FIXTURES = build();
const PORT = Number(process.env.PORT ?? 4180);
const BASE = `http://127.0.0.1:${PORT}/`;
/*
  応援のリンクを**設定した**版。同じサーバーの別の場所に置く。

  2026-08-13 に Stripe の照会を受けて、本番の設定は空にした。
  つまり「設定していない状態」が既定になったので、臨時に作るほうが逆になった。
  応援まわりの検証は消していない。戻すときに、壊れていないことをすぐ確かめられる。
*/
const TIPS_DIR = join(root, 'dist-tips');
const TIPS_BASE = `${BASE}__tips/`;

/*
  「設定してあるときは、応援の案内がちゃんと出る」を確かめるための版を作る。

  bundle の中の文字列を差し替えて確かめることはできない。ビルドの時点で
  `TIP_CUSTOM_URL.trim() !== ''` が定数に畳み込まれてしまい、
  あとから文字列を変えても分岐が動かないため（`.some(...)||!0` と出ていた）。

  なので、URL を入れた tip-config.ts で本当にもう1本ビルドする。
  ビルドが終わったら、元のファイルを必ず戻す。
*/
function buildWithTips() {
  const config = join(root, 'src', 'tip-config.ts');
  const backup = join(root, 'src', 'tip-config.ts.bak');
  copyFileSync(config, backup);
  try {
    // 検証だけのための、実在しない URL。決済まで進める検証はしていない
    let n = 0;
    const filled = readFileSync(config, 'utf8')
      .replace(/url: ''/g, () => `url: 'https://buy.stripe.com/test_dummy${++n}'`)
      .replace(
        /export const TIP_CUSTOM_URL = '';/,
        "export const TIP_CUSTOM_URL = 'https://buy.stripe.com/test_dummy_custom';",
      );
    writeFileSync(config, filled);
    const r = spawnSync(
      'npx',
      ['vite', 'build', '--outDir', TIPS_DIR, '--emptyOutDir', '--logLevel', 'error'],
      { cwd: root, encoding: 'utf8' },
    );
    if (r.status !== 0) {
      console.log('  （応援あり版のビルドに失敗）', r.stderr?.slice(0, 300));
      return false;
    }
    return true;
  } finally {
    copyFileSync(backup, config);
    rmSync(backup, { force: true });
  }
}

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
      const withTips=${JSON.stringify(TIPS_DIR)};
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
        // 応援のリンクを設定した版は、同じサーバーの別の場所から配る
        let base=root;
        if(url.startsWith('/__tips/')) { base=withTips; url=url.slice('/__tips'.length); }
        let p=path.join(base, url);
        if(!p.startsWith(base)) { res.writeHead(403); return res.end(); }
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

  /*
    応援の案内は、設定していないうちは一切出てはいけない。
    そのまま公開しても、ただの無料ツールとして成り立つこと。
  */
  /*
    応援のリンクを設定していないとき。

    tip-config.ts の URL が空なら、応援の案内は画面のどこにも出てはいけない。
    そのまま公開しても、ただの無料ツールとして成り立つこと。

    いまは本番の Stripe リンクが入っているので、空の設定でもう1本ビルドして
    そちらを開く。配信物の文字列を後から差し替える手も試したが、
    それでは確かめられない。ビルド時に
    `TIP_CUSTOM_URL.trim() !== ''` が定数の true に畳み込まれるので、
    URL を空にしても分岐は動かない（実際そこで一度、通らない検証を書いた）。
  */
  console.log('\n■ 応援（設定していないとき＝いまの本番）');
  {
    // 応援「あり」の版は、このあとの節で使う。先に作っておく
    const built = buildWithTips();
    check('URL を入れた版がビルドできる', built);
    if (!built) throw new Error('応援あり版をビルドできませんでした');

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

  /*
    設定してあるとき。ここからが本番の並び。

    大事なのは「保存できたあとにだけ出る」ことと、
    「そこで金額の話を始めない」こと。保存できた直後の画面は
    本来「できた！」を味わう場所なので、会計の画面にしない。
  */
  console.log('\n■ 応援（設定してあるとき＝戻したあと）');
  {
    const { page } = await openFrame(browser, 'lineart.png', 'photo-color.png', {
      origin: TIPS_BASE,
    });
    check('フッターに応援の入り口が出る', (await page.locator('.tip__quiet').count()) >= 1);
    await page.getByRole('button', { name: /これでOK/ }).click();
    await page.waitForTimeout(1200);
    check('保存前は応援の案内を出さない', (await page.locator('.tip--celebrate').count()) === 0);

    const dl = page.waitForEvent('download', { timeout: 20000 }).catch(() => null);
    await page.getByRole('button', { name: /画像をほぞんする|ほぞん・シェアする/ }).click();
    await dl;
    await page.waitForTimeout(900);
    check('保存できたら応援の案内が出る', (await page.locator('.tip--celebrate').count()) === 1);
    check(
      'ここでは金額を並べない',
      (await page.locator('.tip .plan').count()) === 0 &&
        !/300円|500円|1,000円/.test(await page.locator('.tip').innerText()),
    );

    await page
      .getByRole('button', { name: /制作活動を応援する/ })
      .first()
      .click();
    await page.waitForTimeout(500);
    check('そこから応援ページへ移動できる', /#\/support$/.test(page.url()), page.url().slice(-24));

    // 閉じたら、そのセッションではもう出さない（既存の約束）
    await page.goBack();
    await page.waitForTimeout(500);
    await page.locator('.tip__close').click();
    await page.waitForTimeout(400);
    check('閉じたら引っ込む', (await page.locator('.tip--celebrate').count()) === 0);
    await page.close();
  }

  /*
    応援ページ。ここはお金の話をする唯一の場所。

    いちばん守りたいのは「カードを選んだだけでは、どこへも飛ばない」こと。
    指が当たっただけで決済ページに飛ぶのは、やってはいけない類の事故なので。
  */
  console.log('\n■ 応援ページ');
  {
    const page = await browser.newPage({ viewport: { width: 390, height: 900 } });
    /*
      飾りの素材が置かれていないうちは 404 が出る。これは想定どおりなので、
      スクリプトの誤りとは分けて数える。ページが使えるかどうかは別に見ている。
    */
    const errors = [];
    const missing = [];
    const isAssetMiss = (t) => /assets\/support\//.test(t) || /404 \(Not Found\)/.test(t);
    page.on('pageerror', (e) => errors.push(String(e.message)));
    page.on('console', (m) => {
      if (m.type() !== 'error') return;
      (isAssetMiss(m.text()) ? missing : errors).push(m.text());
    });
    page.on('requestfailed', (r) => {
      if (!/assets\/support\//.test(r.url())) errors.push(`${r.url()} が読めない`);
    });
    await page.goto(TIPS_BASE + '#/support', { waitUntil: 'networkidle' });
    await page.waitForTimeout(600);

    const cta = page.locator('.support__cta');
    check('応援ページが開く', (await page.locator('.support').count()) === 1);
    check(
      'はじめは 500円 がえらばれている',
      /500円で応援する/.test(await cta.innerText()),
      (await cta.innerText()).replace(/\s+/g, ' '),
    );
    check(
      'えらばれているものが読み上げにも出る',
      (await page.getByRole('radio', { checked: true }).innerText()).includes('500円'),
    );

    // 金額を変えると、押す前のボタンの文字も変わる
    const pick = async (name) => {
      await page.getByRole('radio', { name: new RegExp(name) }).click();
      await page.waitForTimeout(250);
      return {
        label: (await cta.innerText()).replace(/\s+/g, ' '),
        href: await cta.getAttribute('href'),
      };
    };

    /*
      リンク先は、本物の URL を書き写して照らし合わせていた。
      設定を空にした（Stripe の照会で止めた）ときに、ここが4件まとめて落ちた。

      本当に守りたいのは「選んだカードと、飛ぶ先が食い違わないこと」で、
      URL の中身そのものではない。書き写した値を持たない形に直す。
      こうしておけば、URL を入れ替えても検証は書き換えずに済む。
    */
    const seen = new Map();
    for (const [name, label] of [
      ['300円', /300円で応援する/],
      ['500円', /500円で応援する/],
      ['1,000円', /1,000円で応援する/],
      ['自由入力', /好きな金額で応援する/],
    ]) {
      const r = await pick(name);
      check(`${name}でボタンの文字が変わる`, label.test(r.label), r.label);
      check(
        `${name}のリンクが決済ページを向いている`,
        typeof r.href === 'string' && r.href.startsWith('https://buy.stripe.com/'),
        String(r.href),
      );
      seen.set(name, r.href);
    }

    // 4つとも別の飛び先であること（取り違えていたら、ここで落ちる）
    check(
      'えらんだ金額ごとに、飛び先が別になっている',
      new Set(seen.values()).size === seen.size,
      [...seen.entries()].map(([k, v]) => `${k}→${String(v).slice(-12)}`).join(' '),
    );

    /*
      カードを押しただけで決済ページへ飛ばないこと。
      新しいタブが開かないこと、URL が変わらないことの両方で見る。
    */
    const before = page.url();
    let opened = 0;
    page.context().on('page', () => opened++);
    await page.getByRole('radio', { name: /300円/ }).click();
    await page.getByRole('radio', { name: /1,000円/ }).click();
    await page.waitForTimeout(500);
    check(
      'カードを押しただけでは決済へ飛ばない',
      page.url() === before && opened === 0,
      `新しいタブ ${opened} 枚`,
    );

    check('主CTAだけが決済ページへの入口', (await cta.getAttribute('target')) === '_blank');
    check(
      'カード番号の入力欄をこのサイトに作らない',
      (await page
        .locator('input[type=text], input[type=tel], input[type=number], input[autocomplete*=cc-]')
        .count()) === 0,
    );

    // 390px で横にはみ出さない
    const overflow = await page.evaluate(() => ({
      w: document.documentElement.scrollWidth,
      v: window.innerWidth,
    }));
    check(
      '390px で横スクロールが出ない',
      overflow.w <= overflow.v + 1,
      `${overflow.w} / ${overflow.v}`,
    );

    /*
      素材の画像がまだ置かれていなくても、ページはそのまま使えること。
      いまはまさにその状態なので、ここで確かめられる。
    */
    check(
      '画像が無くてもページは使える',
      (await cta.isVisible()) && (await page.locator('.plan').count()) >= 3,
    );

    // Web Share が無い端末（この Chromium がそれ）でも、リンクは配れる
    await page
      .context()
      .grantPermissions(['clipboard-read', 'clipboard-write'])
      .catch(() => {});
    await page.getByRole('button', { name: /リンクをコピー/ }).click();
    await page.waitForTimeout(400);
    check(
      '共有が使えなくてもリンクをコピーできる',
      (await page.getByText('コピーしました').count()) >= 1,
    );

    check('スクリプトのエラーが出ない', errors.length === 0, errors[0] ?? '');
    // 素材を置いたら 0 になる。置く前でもページが使えることは、上で確かめている。
    console.log(`  \x1b[2m素材がまだ無いための 404: ${missing.length} 件\x1b[0m`);
    await page.close();
  }

  /*
    お礼のページ。決済のあとに Stripe から戻ってくる場所。
    ここを「ありがとうございました」で終わらせず、作る画面へ返す。
  */
  console.log('\n■ お礼のページ');
  {
    const page = await browser.newPage({ viewport: { width: 390, height: 900 } });
    await page.goto(TIPS_BASE + '#/support/thanks', { waitUntil: 'networkidle' });
    await page.waitForTimeout(600);

    check('お礼のページが開く', (await page.getByText('応援ありがとう！').count()) >= 1);
    check(
      '3つめのステップが光っている',
      (
        await page
          .locator(".steps--static .steps__item[data-state='current'] .steps__label")
          .innerText()
      ).includes('完了'),
    );

    const overflow = await page.evaluate(() => ({
      w: document.documentElement.scrollWidth,
      v: window.innerWidth,
    }));
    check(
      '390px で横スクロールが出ない',
      overflow.w <= overflow.v + 1,
      `${overflow.w} / ${overflow.v}`,
    );

    await page.getByRole('button', { name: /もう1個つくる/ }).click();
    await page.waitForTimeout(600);
    check(
      '「もう1個つくる」で作る画面へ戻れる',
      (await page.getByText('アイコンにする写真をえらぶ').count()) >= 1,
    );
    await page.close();
  }

  /*
    SNS に貼られたときの見た目。

    サイトの中に「X で伝える」「LINE で送る」を自分で置いているので、
    貼られたときの絵が無いのは片手落ちになる。
    タグそのものと、絶対URLで書けているか（相対では相手のサーバーが解決できない）を見る。
  */
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
  console.log('\n■ 決済から戻ってくる道');
  {
    const page = await browser.newPage({ viewport: { width: 390, height: 900 } });
    const arrivals = [
      ['session_id が足されても', '#/support/thanks?session_id=cs_live_a1b2c3'],
      ['末尾にスラッシュが付いても', '#/support/thanks/'],
      ['大文字で入力されても', '#/Support/Thanks'],
      ['ハッシュが落ちても（?thanks=1）', '?thanks=1'],
    ];
    for (const [name, suffix] of arrivals) {
      await page.goto(TIPS_BASE + suffix, { waitUntil: 'networkidle' });
      await page.waitForTimeout(500);
      check(`${name}お礼のページが出る`, (await page.getByText('応援ありがとう！').count()) >= 1);
    }

    // ?thanks=1 で来たら、以後ふつうに動くようハッシュの形へ直しておく
    await page.goto(TIPS_BASE + '?thanks=1', { waitUntil: 'networkidle' });
    await page.waitForTimeout(500);
    check(
      '?thanks=1 はハッシュの形に直る',
      /#\/support\/thanks$/.test(page.url()),
      page.url().slice(-30),
    );

    // 応援ページ側も同じ扱い
    await page.goto(TIPS_BASE + '#/support?utm_source=tiktok', { waitUntil: 'networkidle' });
    await page.waitForTimeout(400);
    check('応援ページも余計な文字を無視する', (await page.locator('.support .plan').count()) >= 3);
    await page.close();
  }

  /*
    数字を直接打てること、変えたものだけ「もどす」が出ること。

    つまみだけだと、狙った値でぴたりと止められない。
    「1にしたい」のに 1 と 2 のあいだで往復する、というのが実機で起きる。
    幅の狭いスマホでは 1px の差が数値の 2〜3 になるので、なおさら。

    「もどす」は、触った項目にだけ出す。触っていないものに付いていても
    押すところが増えるだけで助けにならないし、出ていること自体が
    「ここを触った」という印になる。
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
    await page.goto(TIPS_BASE, { waitUntil: 'networkidle' });
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
      ['応援', '#/support'],
      ['お礼', '#/support/thanks'],
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
      await page.goto(TIPS_BASE + hash, { waitUntil: 'networkidle' });
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
      for (const [name, hash] of [
        ['応援', '#/support'],
        ['お礼', '#/support/thanks'],
      ]) {
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
    for (const [name, hash] of [
      ['応援', '#/support'],
      ['お礼', '#/support/thanks'],
    ]) {
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

    // お礼のページは、地を画像で持たない（CSS のグラデーションで描く）
    const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
    const asked = [];
    page.on('request', (r) => asked.push(r.url().split('/').pop()));
    await page.goto(BASE + '#/support/thanks', { waitUntil: 'networkidle' });
    await page.waitForTimeout(600);
    const heavy = asked.filter((f) => /support-bg|fruit/.test(f));
    check('お礼のページは地の画像を取りに行かない', heavy.length === 0, heavy.join(','));
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
  console.log('\n■ お礼ページの水の輪');
  {
    const seen = [];
    for (const [label, w] of [
      ['ふつうの画面', 1280],
      ['とても広い画面', 1920],
    ]) {
      const page = await browser.newPage({ viewport: { width: w, height: 900 } });
      await page.goto(TIPS_BASE + '#/support/thanks', { waitUntil: 'networkidle' });
      await page.waitForTimeout(600);
      const m = await page.evaluate(() => {
        const el = document.querySelector('.decor__celebration');
        if (!el) return null;
        const r = el.getBoundingClientRect();
        /*
          ステップ行は「.steps」だけで引くと、つくる側の（隠れている）ほうを
          拾ってしまい、下端 0px として素通りする。応援まわりのものを名指しする。
        */
        const steps = document.querySelector('.steps--static');
        // カードも同じ理由で名指しする（.card はつくる側にもある）
        const card = document.querySelector('.card.support');
        return {
          width: Math.round(r.width),
          top: Math.round(r.top),
          stepsBottom: steps ? Math.round(steps.getBoundingClientRect().bottom) : null,
          cardWidth: card ? Math.round(card.getBoundingClientRect().width) : null,
        };
      });
      check(`${label}：輪が置かれている`, m !== null && m.stepsBottom !== null);
      if (m && m.stepsBottom !== null) {
        seen.push([label, m.width]);
        /*
          本文の列（カード）から左右へ出るぶんの上限。

          360px は、いまの形（カード 512px に対して輪 844px）に
          少しだけ余裕を足した値。ここを緩めた経緯を書いておく。

          はじめは 200px にしていた。そのときの輪は列に寄せすぎていて、
          中央がカードに隠れ、左右に水の塊が2つ浮いて見えた。
          輪だと分からない大きさなら、輪として置く意味がない。
          広げて薄くする（0.46 → 0.34）ほうを選んだ。

          この数字は「画面いっぱいに戻さない」ための歯止めで、
          本命の歯止めは下の「画面の広さで変わらない」のほう。
        */
        check(
          `${label}：輪が本文の列からはみ出しすぎない`,
          m.width <= m.cardWidth + 360,
          `輪 ${m.width}px / カード ${m.cardWidth}px`,
        );
        check(
          `${label}：輪がステップ表示にかからない`,
          m.top >= m.stepsBottom,
          `輪 ${m.top}px / ステップの下端 ${m.stepsBottom}px`,
        );
      }
      await page.close();
    }

    /*
      これがいちばん効く1件。

      最初の失敗は「画面いっぱいに敷いた」ことだった。画面幅に連動していると、
      広い画面ほど輪が大きくなり、余白へ散らばっていく。
      幅が画面によって変わらなければ、その失敗は再現しない。
    */
    check(
      '輪の大きさが画面の広さで変わらない',
      seen.length === 2 && seen[0][1] === seen[1][1],
      seen.map(([l, w]) => `${l} ${w}px`).join(' / '),
    );
  }

  /*
    動きを減らす設定にしている人には、飾りを動かさない。
  */
  console.log('\n■ 動きを減らす設定');
  {
    const page = await browser.newPage({
      viewport: { width: 390, height: 900 },
      reducedMotion: 'reduce',
    });
    await page.goto(BASE + '#/support/thanks', { waitUntil: 'networkidle' });
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
    受け付けを止めているあいだ、決済の順路を見せないこと。

    文言をいくら消しても、これが残っていると意味が無かった。
    本文が「受け付けを止めています」と言っているすぐ上で、

      支援をえらぶ → 決済する → 完了

    という帯が動いていた。**決済の順路そのもの**が出ている。
    しかも「支援」は「応援」より寄付に寄った語で、審査中に見せたいものではない。

    条件分岐の向こうにあった文言と違って、これは実際に表示されていた。
    検証も画面を見ていたのに捕まらなかったのは、止めた状態の応援ページで
    「何が出ていないか」を一度も見ていなかったから。出ているものばかり
    数えていて、出ていてはいけないものを数えていなかった。
  */
  console.log('\n■ 受け付けを止めているあいだの見えかた');
  {
    for (const [name, hash] of [
      ['応援', '#/support'],
      ['お礼', '#/support/thanks'],
    ]) {
      const page = await browser.newPage({ viewport: { width: 390, height: 900 } });
      await page.goto(BASE + hash, { waitUntil: 'networkidle' });
      await page.waitForTimeout(500);

      check(
        `${name}：決済の順路を出さない`,
        (await page.locator('.steps--static').count()) === 0,
        `${await page.locator('.steps--static').count()} 本`,
      );

      /*
        つくる画面は隠れているだけで DOM には残っているので、.app は2つある。
        innerText は隠れているものを外すので、body から取れば見えている分だけになる。
      */
      const text = await page.evaluate(() => document.body.innerText);
      const words = ['支援をえらぶ', '決済する', '寄付', '募金'].filter((w) => text.includes(w));
      check(`${name}：募っている言いかたが出ない`, words.length === 0, words.join(' / '));

      check(
        `${name}：決済リンクが1本も無い`,
        (await page.locator('a[href*="stripe.com"]').count()) === 0,
      );

      await page.close();
    }
  }

  /*
    資金集めに読める文言が、配るものに入っていないこと。

    ── なぜブラウザではなくファイルを見るのか ──

    2026-08-13 の照会のあと、募集の文言は条件分岐の向こうに置いた。
    画面には出ないので、それで済んだと思っていた。済んでいなかった。

    条件分岐が止めるのは**描画だけ**で、文字列は配られる JS に入ったまま
    だった。審査を受けている当のアカウントで、引っかかった当の文言が
    公開物から読み出せる状態だったことになる。

    だからここは画面ではなく、**出来上がったファイルそのもの**を見る。
    画面を見る検証では、この壊れかたは永久に捕まえられない。

    ── 何を見張っているか ──

    「これから作るもののために、先にお金を集める」と読める言いかた。
    Stripe がチップに求めるのは、すでに提供したものへの任意の支払いであること。
    将来の成果物に触れた瞬間、それは資金調達になる。

    戻すときは、この一覧を消すのではなく、**この一覧に当たらない文章を書く**。
  */
  console.log('\n■ 資金集めに読める文言');
  {
    const banned = [
      '次のフレームになります',
      '新しいアイコンフレームの制作',
      '新しい表現を試すための制作',
      'まだ決めていません',
      '制作活動を続けていけます',
      '制作活動を応援していただき',
    ];
    const dist = join(root, 'dist');
    const files = [
      join(dist, 'index.html'),
      ...readdirSync(join(dist, 'assets'))
        .filter((f) => f.endsWith('.js') || f.endsWith('.css'))
        .map((f) => join(dist, 'assets', f)),
    ].filter((f) => existsSync(f));

    check('配るファイルが見つかる', files.length > 0, `${files.length} 個`);

    const hits = [];
    for (const f of files) {
      const text = readFileSync(f, 'utf8');
      for (const word of banned) if (text.includes(word)) hits.push(`${word}`);
    }
    check(
      '配るものに、資金集めに読める文言が入っていない',
      hits.length === 0,
      hits.length ? [...new Set(hits)].join(' / ') : `${banned.length} 語ぶん確認`,
    );
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

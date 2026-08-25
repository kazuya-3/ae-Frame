/**
 * 配るものを、そのまま読んで確かめる。
 *
 *   node tools/check-dist.mjs          … dist を見る
 *   node tools/check-dist.mjs dist-demo
 *
 * ── なぜブラウザではなくファイルなのか ──
 *
 * 一度しくじっている。Stripe の照会を受けて募集の文言を消したとき、
 * 「画面に出さない」ところで止めてしまった。条件分岐の向こうに置けば
 * 描画はされないが、**文字列は配られる JS にそのまま入っている**。
 * 審査を受けている当のアカウントで、引っかかった当の文言が
 * 公開物から読み出せる状態だった。
 *
 * 画面を見る検証では、この壊れかたは永久に捕まえられない。
 * だからここは、出来上がったファイルそのものを読む。
 *
 * ── 何を見ているか ──
 *
 *   1. 資金集めに読める文言が入っていないか
 *   2. 決済リンク（buy.stripe.com）が入っていないか
 *   3. 秘密鍵らしきものが入っていないか
 *   4. 誰からも参照されていない古いハッシュ付きファイルが残っていないか
 *   5. リンクを貼ったときに出る絵が、実在して、申告どおりの大きさか
 *   6. 配る画像が重すぎないか（1枚ごと・合計）
 *   7. お礼（チップ）の文言が、出すと決めた状態と合っているか
 *
 * 7 は「入っていない」と「そろっている」の両方を見る。VITE_TIP_URL を
 * 渡さずに走らせたときは「1つも入っていないこと」、渡したときは
 * 「全部そろっていて、送り先もその1本だけであること」。
 *
 * 4 は中身ではなく残りかすの話。--emptyOutDir を付け忘れたビルドや、
 * 手で足したファイルがあると、古い JS が公開先に残る。中身が古いだけに、
 * 消したはずの文言がそこから生き返る。
 *
 * ── 戻すときは ──
 *
 * この一覧を消して通すのではなく、**この一覧に当たらない文章を書く**。
 * 経緯と条件は docs/stripe-compliance.md にある。
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { dirname, extname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(here, '..');

/**
 * 資金集めに読める言いかた。
 *
 * Stripe がチップに求めるのは「すでに提供したものへの任意の支払い」であること。
 * 将来の成果物に触れた瞬間、それは資金調達になる。
 */
export const BANNED_WORDS = [
  '制作活動応援',
  '制作活動を応援',
  '制作活動を続けていけます',
  '応援が、次のフレームになります',
  '次のフレームになります',
  '新しいアイコンフレームの制作',
  '新しい表現を試すための制作',
  'このツールの改善に活用',
  'まだ決めていません',
  'creator_support',
];

/**
 * お礼（チップ）まわりでしか出てこない言葉。
 *
 * 送り先が空のビルドには、**1つも入っていてはいけない**。
 * 前回そこで踏んだ。募集の文言を条件分岐の向こうに置いて「画面に出ない」で
 * 止めたが、文字列は配られる JS にそのまま残っていた。
 * 画面を見る検証では永久に捕まえられない壊れかたなので、ここで実物を読む。
 *
 * 逆に、送り先が入っているビルドには**全部入っていないといけない**。
 * 入口を出すと決めたのに、束ねる側の都合で文が落ちていたら、
 * 「払っても何も変わらない」という肝心の断りが消える。
 */
export const TIP_MARKERS = [
  '作った人にお礼を送る',
  'お礼を送る',
  '送っても、送らなくても',
  'お返しするものもありません',
];

/** 決済への入口。1本でも残っていたら「決済なし」ではない */
export const BANNED_LINKS = ['buy.stripe.com', 'checkout.stripe.com', 'donate.stripe.com'];

/**
 * 秘密鍵らしきもの。
 * 公開鍵（pk_）は配ってよいものなので見ない。ここに並べるのは漏れたら困るものだけ。
 */
export const SECRET_PATTERNS = [
  /\bsk_(live|test)_[A-Za-z0-9]/,
  /\brk_(live|test)_[A-Za-z0-9]/,
  /\bwhsec_[A-Za-z0-9]/,
];

/** 中身を読む価値のある拡張子。画像やフォントは読まない */
const TEXTY = new Set([
  '.html',
  '.js',
  '.mjs',
  '.css',
  '.json',
  '.webmanifest',
  '.txt',
  '.svg',
  '.map',
]);

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

/**
 * 配るものを調べる。
 * @returns {{name: string, ok: boolean, detail: string}[]}
 */
export function checkDist(distDir, { tipUrl = '' } = {}) {
  const results = [];
  const add = (name, ok, detail = '') => results.push({ name, ok, detail });

  if (!existsSync(distDir)) {
    add('配るものがある', false, `${distDir} が無い（先に npm run build）`);
    return results;
  }

  const all = walk(distDir);
  const texty = all.filter((f) => TEXTY.has(extname(f)));
  add(
    '配るファイルが見つかる',
    texty.length > 0,
    `読めるもの ${texty.length} / 全 ${all.length} 個`,
  );

  const bodies = new Map(texty.map((f) => [f, readFileSync(f, 'utf8')]));
  const where = (hit) => [...new Set(hit)].join(' / ');

  /* 1. 資金集めに読める文言 */
  const wordHits = [];
  for (const [f, text] of bodies) {
    for (const w of BANNED_WORDS)
      if (text.includes(w)) wordHits.push(`${w}（${relative(distDir, f)}）`);
  }
  add(
    '資金集めに読める文言が入っていない',
    wordHits.length === 0,
    wordHits.length ? where(wordHits) : `${BANNED_WORDS.length} 語ぶん確認`,
  );

  /*
    2. 決済リンク。

    ── なぜ「0本」で固定できないのか ──

    お礼を入れると、送り先が1本だけ配るものに入る。そのとき「0本」を
    数え続けると、この点検はただ落ちるだけになり、上限を緩めて黙らせたくなる。
    緩めた瞬間、**2本目が入っても気づけなくなる**。

    だから数えかたを、期待する状態で切り替える。
    送り先が空なら0本。入っているなら「その1本だけ」。
    どちらの状態でも「意図しない決済への入口が無い」を言い続けられる。
  */
  const allowedDomain = tipUrl ? BANNED_LINKS.find((l) => tipUrl.includes(l)) : null;
  const linkHits = [];
  for (const [f, text] of bodies) {
    for (const l of BANNED_LINKS) {
      if (l === allowedDomain) continue;
      if (text.includes(l)) linkHits.push(`${l}（${relative(distDir, f)}）`);
    }
  }
  add(
    tipUrl ? '決済リンクが、決めた1本のほかに無い' : '決済リンクが入っていない',
    linkHits.length === 0,
    linkHits.length ? where(linkHits) : `${BANNED_LINKS.length} 種ぶん確認`,
  );

  /* 2b. お礼まわりの文言。空のビルドには1つも、入りのビルドには全部 */
  {
    const found = TIP_MARKERS.filter((m) => [...bodies.values()].some((t) => t.includes(m)));
    if (tipUrl) {
      const missing = TIP_MARKERS.filter((m) => !found.includes(m));
      add(
        'お礼の文言が、配るものにそろっている',
        missing.length === 0,
        missing.length ? `足りない：${missing.join(' / ')}` : `${TIP_MARKERS.length} 語ぶん確認`,
      );
      const hasUrl = [...bodies.values()].some((t) => t.includes(tipUrl));
      add('お礼の送り先が、配るものに入っている', hasUrl, tipUrl);
    } else {
      add(
        'お礼の文言が、配るものに1つも入っていない',
        found.length === 0,
        found.length ? where(found) : `${TIP_MARKERS.length} 語ぶん確認`,
      );
    }
  }

  /* 3. 秘密鍵らしきもの */
  const secretHits = [];
  for (const [f, text] of bodies) {
    for (const re of SECRET_PATTERNS) if (re.test(text)) secretHits.push(relative(distDir, f));
  }
  add('秘密鍵らしきものが入っていない', secretHits.length === 0, where(secretHits));

  /*
    4. 誰からも参照されていない、古いハッシュ付きファイル。

    index.html から辿れないものが残っていたら、前のビルドの残りかす。
    中身が古いので、消したはずの文言がそこから生き返る。
  */
  const entry = join(distDir, 'index.html');
  if (!existsSync(entry)) {
    add('入口の index.html がある', false, '');
  } else {
    const hashed = all.filter((f) => /-[A-Za-z0-9_]{8,}\.(js|css)$/.test(f));
    const haystack = [...bodies.entries()];
    const orphans = hashed.filter((f) => {
      const base = f.split('/').pop();
      // 自分以外のどこかに名前が出てくれば、参照されている
      return !haystack.some(([g, text]) => g !== f && text.includes(base));
    });
    add(
      '参照されていない古いファイルが残っていない',
      orphans.length === 0,
      orphans.length
        ? orphans.map((f) => relative(distDir, f)).join(' / ')
        : `ハッシュ付き ${hashed.length} 個ぜんぶ参照あり`,
    );
  }

  /*
    5. リンクを貼ったときに出る絵（og:image）。

    ── なぜファイルの側から見るのか ──

    ここは**この道具が外から見える唯一の場所**で、しかも本人の画面には出ない。
    TikTok のプロフィールから来る人も、LINE で回ってくる人も、
    最初に見るのはこの1枚。壊れても、作った人は気づけない。

    通しの検証は「タグがある」「絶対URLである」までしか見ていなかった。
    それだと、**指した先のファイルが無くても通る**。実際、画像を
    差し替えたときに拡張子が変わって、タグだけ古いまま、が起きうる。

    実物が在ること、そして宣言した大きさが実物と合っていることまで見る。
    幅と高さの申告がずれていると、貼られた先で切れたり余白が出たりする。
  */
  if (existsSync(entry)) {
    const html = readFileSync(entry, 'utf8');
    const meta = (key, attr = 'property') =>
      html.match(new RegExp(`${attr}="${key}"[^>]*content="([^"]+)"`))?.[1] ??
      html.match(new RegExp(`content="([^"]+)"[^>]*${attr}="${key}"`))?.[1] ??
      null;

    const base = meta('og:url');
    const shots = [
      ['og:image', meta('og:image')],
      ['twitter:image', meta('twitter:image', 'name')],
    ];

    for (const [key, url] of shots) {
      if (!url || !base) {
        add(`${key} の指す先が配るものの中にある`, false, url ? 'og:url が無い' : 'タグが無い');
        continue;
      }
      // 公開URL上の位置を、配るものの中の位置に読み替える
      const rel = new URL(url).pathname.replace(new URL(base).pathname, '');
      const file = join(distDir, rel);
      add(`${key} の指す先が配るものの中にある`, existsSync(file), rel);
    }

    const imgUrl = shots[0][1];
    const imgFile =
      imgUrl && base
        ? join(distDir, new URL(imgUrl).pathname.replace(new URL(base).pathname, ''))
        : null;
    if (imgFile && existsSync(imgFile)) {
      const got = imageSize(readFileSync(imgFile));
      const want = { w: Number(meta('og:image:width')), h: Number(meta('og:image:height')) };
      add(
        'og:image の大きさが、申告と実物で合っている',
        !!got && got.w === want.w && got.h === want.h,
        got ? `実物 ${got.w}×${got.h} / 申告 ${want.w}×${want.h}` : '大きさを読めない形式',
      );
    }
  }

  /*
    6. 配る画像の重さ。

    JS と CSS には上限があったが、画像には無かった。
    その隙に 935KB の PNG（写真の中身を PNG で持っていた）が
    リンクの絵として入り、誰も気づかないまま配られていた。
    数字を出す場所が無いと、画像は際限なく増える。

    gzip では測らない。画像はもう圧縮済みで、gzip してもほぼ縮まない。
    回線を流れるのは生のバイト数そのもの。
  */
  const images = all.filter((f) => IMAGE_EXT.has(extname(f)));
  if (images.length) {
    const sized = images
      .map((f) => [relative(distDir, f), statSync(f).size / 1024])
      .sort((a, b) => b[1] - a[1]);
    const total = sized.reduce((s, [, kb]) => s + kb, 0);
    const [heaviestName, heaviestKb] = sized[0];

    add(
      '画像が1枚も重すぎない',
      heaviestKb <= IMAGE_BUDGET_KB.each,
      `いちばん重いのは ${heaviestName} ${heaviestKb.toFixed(1)} KB / 上限 ${IMAGE_BUDGET_KB.each} KB`,
    );
    add(
      '配る画像の合計が上限に収まっている',
      total <= IMAGE_BUDGET_KB.total,
      `${total.toFixed(1)} KB / 上限 ${IMAGE_BUDGET_KB.total} KB（${images.length} 枚）`,
    );
  }

  /* 7. 重さ。実際に回線を流れる量（gzip したあと）で見る */
  const gzipKb = (f) => gzipSync(readFileSync(f)).length / 1024;
  for (const [kind, re, label] of [
    ['js', /index-[^/]*\.js$/, '本体の JS'],
    ['css', /index-[^/]*\.css$/, '本体の CSS'],
  ]) {
    const files = all.filter((f) => re.test(f));
    if (!files.length) continue;
    const kb = files.reduce((sum, f) => sum + gzipKb(f), 0);
    const cap = WEIGHT_BUDGET_KB[kind];
    add(`${label} が上限に収まっている`, kb <= cap, `${kb.toFixed(1)} KB / 上限 ${cap} KB（gzip）`);
  }

  return results;
}

/*
  配るものの重さの上限（gzip したあとの KB）。

  ── なぜ gzip で見るのか ──

  サーバーは gzip して送るので、利用者の回線を実際に流れるのはこちらの数字。
  生のバイト数で見ていると、実感より2〜3倍大きい数を見張ることになり、
  「まだ余裕がある／もう限界だ」の感覚がずれる。

  ── なぜ上限を置くのか ──

  このツールは「スマホしか持っていない人」が前提。1回の機能追加で
  数KB ずつ増えるのは気づかないが、10回で見過ごせない量になる。
  1回ごとに気づける場所を作っておく。

  いまの実測に少し余裕を足した値にしてある。**超えたら、上限を上げる前に
  まず中身を疑う**。上げるときは、なぜ必要かをコミットに書く。
*/
const WEIGHT_BUDGET_KB = { js: 95, css: 12 };

/**
 * 配る画像の上限（生のバイト数の KB）。
 *
 * each  … 1枚あたり。リンクの絵の実務上の天井が 300KB あたりなので、そこに合わせる。
 * total … 全部の合計。いまの実測は 8割ほどが「知らせるページ」の飾り。
 *          飾りを軽くすれば、そのぶん余裕が戻る。
 *
 * **超えたら、上限を上げる前にまず中身を疑う。**
 * 写真の中身を PNG で持っていないか、長辺が必要より大きくないか。
 */
const IMAGE_BUDGET_KB = { each: 300, total: 850 };

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg', '.avif']);

/**
 * 画像の幅と高さを、ファイルの頭だけ読んで取る（PNG / JPEG）。
 * 申告した大きさと実物が合っているかを見るためだけのもの。
 */
function imageSize(buf) {
  // PNG: 8バイトの署名 → IHDR。幅と高さは 16 バイト目から
  if (buf.length > 24 && buf.readUInt32BE(0) === 0x89504e47) {
    return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
  }
  // JPEG: SOF マーカー（0xFFC0〜0xFFCF のうち C4/C8/CC を除く）に入っている
  if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) {
        i++;
        continue;
      }
      const marker = buf[i + 1];
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) };
      }
      i += 2 + buf.readUInt16BE(i + 2);
    }
  }
  return null;
}

/*
  禁止語を「登録している」ファイル。ここだけは当たって当たり前なので外す。

  ・tools/check-dist.mjs   一覧そのもの
  ・docs/stripe-compliance.md 何が禁止で、なぜかを書いた文書

  外すのはこの2つだけにする。増やしたくなったら、たいていは
  「そのファイルから禁止語を消す」ほうが正しい。
*/
const WORD_ALLOWLIST = ['tools/check-dist.mjs', 'docs/stripe-compliance.md'];

/**
 * リポジトリ側にも、禁止語と決済リンクが無いこと。
 *
 * ── なぜ配るものだけでは足りなかったか ──
 *
 * はじめ dist しか見ていなかった。それで README が素通りした。
 * README には支払いリンクの作りかたが手順ごと残っていて、
 * `https://buy.stripe.com/...` という行まであった。
 * 引き継ぎ資料（docs/handover.html）には**本物の支払いリンクが4本**入っていた。
 *
 * どちらも配布物には入らないので、dist を読む点検では永久に見つからない。
 * ただし公開リポジトリなので、人からは読める。
 * 「決済を持たない」と言っているアカウントのリポジトリに決済リンクの手順がある、
 * という状態だった。
 */
export function checkRepoWords() {
  // 配るものは checkDist が別に読む。ここはリポジトリ側だけを見る。
  // （'dist-tips' という綴りが残っていた。実際のフォルダは dist-tip なので
  //  素通りしていた。中に決済リンクが入るのは、まさにこの版）
  const skip = new Set(['node_modules', '.git', 'dist', 'dist-demo', 'dist-tip']);
  const exts = ['.ts', '.tsx', '.js', '.mjs', '.css', '.html', '.md', '.json', '.yml', '.yaml'];
  const files = [];
  const walkRepo = (dir) => {
    for (const name of readdirSync(dir)) {
      if (skip.has(name)) continue;
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walkRepo(p);
      else if (exts.includes(extname(p))) files.push(p);
    }
  };
  walkRepo(ROOT);

  const hits = [];
  for (const f of files) {
    const rel = relative(ROOT, f);
    if (WORD_ALLOWLIST.includes(rel)) continue;
    const text = readFileSync(f, 'utf8');
    for (const w of [...BANNED_WORDS, ...BANNED_LINKS]) {
      if (text.includes(w)) hits.push(`${rel}（${w}）`);
    }
  }
  return {
    name: 'リポジトリにも、禁止語と決済リンクが無い',
    ok: hits.length === 0,
    detail: hits.length ? [...new Set(hits)].join(' / ') : `${files.length} ファイル確認`,
  };
}

/**
 * リンクの絵の版下が、画面の言葉とずれていないこと。
 *
 * ── なぜ要るのか ──
 *
 * 前の絵は、実物と違うものを見せていた。フレームの一覧、色のえらび方、
 * 「100種類以上」、4工程。どれもこの道具には無い。
 * それでも半年ちかく貼られ続けた。**絵の中身は、機械にも人にも読めない**からで、
 * 作った本人の画面にはそもそも出てこない。
 *
 * 中の絵は読めないが、**版下は文字で書いてある**。せめて工程の名前だけは、
 * App.tsx の STEPS と同じであることを見ておく。
 * 画面の言葉を変えたときに、ここが取り残されたら気づける。
 */
export function checkOgSource() {
  const app = join(ROOT, 'src', 'App.tsx');
  const source = join(ROOT, 'tools', 'og', 'og.html');
  if (!existsSync(app) || !existsSync(source)) {
    return { name: 'リンクの絵の版下がある', ok: false, detail: '版下か App.tsx が無い' };
  }
  const labels = [...readFileSync(app, 'utf8').matchAll(/label:\s*'([^']+)'/g)].map((m) => m[1]);
  const html = readFileSync(source, 'utf8');
  const missing = labels.filter((l) => !html.includes(l));
  return {
    name: 'リンクの絵が、画面と同じ工程を見せている',
    ok: labels.length > 0 && missing.length === 0,
    detail: missing.length ? `版下に無い：${missing.join(' / ')}` : `${labels.length} 工程ぶん確認`,
  };
}

/**
 * 画面に出る文面と、Stripe に出す文面が同じであること。
 *
 * ── なぜ要るのか ──
 *
 * 審査には「実際に掲載する文面」を添えて出す。そのあと画面の言葉だけを
 * 直すと、**出したものと配っているものが食い違う**。しかもその食い違いは、
 * 直した本人にはいちばん見えない（手もとでは新しいほうしか見ない）。
 *
 * 前回、画面の言葉と条件分岐の向こうの言葉が食い違ったまま公開して
 * 止められている。同じ形の事故なので、機械に見張らせる。
 *
 * 見るのは `docs/` の中で `<!-- tip-copy -->` の目印が付いた枠と、
 * `src/components/Tip.tsx` の画面に出る文字。
 * どちらかを直したら、もう片方も直るまで通らない。
 *
 * ── なぜ「目印のある枠を全部見る」だけでは足りないのか ──
 *
 * はじめそう書いた。そして**目印を消すと、黙って通った**。
 * 見張られなくなったのに検証は緑のまま、といういちばん悪い形で、
 * 「消せば静かになる」道を自分で用意していた。
 *
 * なので、**どのファイルが掲載文面を持つか**を下に宣言しておく。
 * 宣言したファイルに枠が無ければ落ちる。ファイルごと消しても落ちる。
 * 置き場所が増えたら、この一覧に足すのが「見張ってください」の意思表示になる。
 */

/**
 * 掲載文面を持つと宣言した文書（`docs/` からの相対）。
 * ここに載っているファイルは、`<!-- tip-copy -->` の枠を必ず持っていること。
 */
const TIP_COPY_DOCS = ['tip-stripe-setup.md', 'tip-stripe-inquiry.md'];
export function checkTipCopy() {
  const name = 'お礼の文面が、Stripe に出すものと同じ';
  const tsx = join(ROOT, 'src', 'components', 'Tip.tsx');
  const docsDir = join(ROOT, 'docs');
  if (!existsSync(tsx) || !existsSync(docsDir)) {
    return { name, ok: false, detail: '文書か実装が無い' };
  }

  /*
    文書：目印のあとに来る枠の中身。
    引用（>）の中に置かれることがあるので、先に行頭の > を落としてから読む。
  */
  const blocks = [];
  const noBlock = [];
  for (const f of TIP_COPY_DOCS) {
    const path = join(docsDir, f);
    if (!existsSync(path)) {
      noBlock.push(`${f}（ファイルが無い）`);
      continue;
    }
    // 引用（>）の中に置かれることがあるので、先に行頭の > を落としてから読む
    const text = readFileSync(path, 'utf8').replace(/^> ?/gm, '');
    const found = [...text.matchAll(/<!-- tip-copy -->\s*```\n([\s\S]*?)```/g)];
    if (!found.length) {
      noBlock.push(`${f}（目印の付いた枠が無い）`);
      continue;
    }
    for (const m of found) blocks.push([f, m[1]]);
  }
  if (noBlock.length) return { name, ok: false, detail: noBlock.join(' / ') };

  /*
    実装：画面に出る文字だけにする。

    はじめ「タグと波かっこを消す」で書いて、盛大に外した。
    JSX の本体は波かっこで包まれているので、釣り合った波かっこを
    繰り返し消すと**中身ごと消える**。しかも消えたぶんは
    「画面に無い」と報告されるので、検証としては正しく見えてしまう。

    素直に、**タグとタグのあいだの文字**（JSX のテキストノード）だけを拾う。
    波かっこと山かっこを含まない範囲に限れば、式や属性は入ってこない。

    空白は消す。残すと、折り返しの位置を変えただけで落ちてしまう。
  */
  const source = readFileSync(tsx, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');
  const visible = (source.match(/>[^<>{}]+</g) ?? [])
    // 拾った両端の山かっこは、文字ではないので落とす（残すと <b> のところで途切れる）
    .map((m) => m.slice(1, -1))
    .join('')
    .replace(/\s+/g, '');

  const missing = [];
  let lines = 0;
  for (const [file, block] of blocks) {
    const rows = block
      .split('\n')
      // 枠の中の飾り（強調の【】、ボタンを表す［］）は画面には出ない文字
      .map((l) => l.replace(/[【】［］]/g, '').replace(/\s+/g, ''))
      .filter(Boolean);
    lines += rows.length;
    for (const r of rows) if (!visible.includes(r)) missing.push(`${file}：${r}`);
  }

  return {
    name,
    ok: lines > 0 && missing.length === 0,
    detail: missing.length
      ? `画面に無い：${missing.join(' / ')}`
      : `${blocks.length} か所 / ${lines} 行ぶん確認`,
  };
}

/** リポジトリ側に秘密鍵が入っていないこと。配るものとは別に見る */
export function checkRepoSecrets() {
  const skip = new Set(['node_modules', '.git', 'dist', 'dist-demo', 'dist-tip', 'assets-src']);
  const files = [];
  const walkRepo = (dir) => {
    for (const name of readdirSync(dir)) {
      if (skip.has(name)) continue;
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walkRepo(p);
      else if (
        TEXTY.has(extname(p)) ||
        ['.ts', '.tsx', '.md', '.yml', '.yaml'].includes(extname(p))
      )
        files.push(p);
    }
  };
  walkRepo(ROOT);

  const hits = [];
  for (const f of files) {
    const text = readFileSync(f, 'utf8');
    for (const re of SECRET_PATTERNS) if (re.test(text)) hits.push(relative(ROOT, f));
  }
  return {
    name: 'リポジトリに秘密鍵が入っていない',
    ok: hits.length === 0,
    detail: hits.length ? [...new Set(hits)].join(' / ') : `${files.length} ファイル確認`,
  };
}

/* 単体で走らせたとき */
if (import.meta.url === `file://${process.argv[1]}`) {
  const dir = join(ROOT, process.argv[2] ?? 'dist');
  const results = [
    ...checkDist(dir, { tipUrl: process.env.VITE_TIP_URL ?? '' }),
    checkOgSource(),
    checkTipCopy(),
    checkRepoWords(),
    checkRepoSecrets(),
  ];
  let bad = 0;
  console.log(`\n■ 配るものの点検（${relative(ROOT, dir) || '.'}）`);
  for (const r of results) {
    if (!r.ok) bad++;
    console.log(
      `  ${r.ok ? '\x1b[32mOK\x1b[0m  ' : '\x1b[31mNG\x1b[0m  '}${r.name}${r.detail ? '  ' + r.detail : ''}`,
    );
  }
  console.log(bad ? `\n\x1b[31m${bad} 件 だめ\x1b[0m\n` : `\n\x1b[32m全部とおりました\x1b[0m\n`);
  process.exit(bad ? 1 : 0);
}

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
export function checkDist(distDir) {
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

  /* 2. 決済リンク */
  const linkHits = [];
  for (const [f, text] of bodies) {
    for (const l of BANNED_LINKS)
      if (text.includes(l)) linkHits.push(`${l}（${relative(distDir, f)}）`);
  }
  add(
    '決済リンクが入っていない',
    linkHits.length === 0,
    linkHits.length ? where(linkHits) : `${BANNED_LINKS.length} 種ぶん確認`,
  );

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

  return results;
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
  const skip = new Set(['node_modules', '.git', 'dist', 'dist-demo', 'dist-tips']);
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

/** リポジトリ側に秘密鍵が入っていないこと。配るものとは別に見る */
export function checkRepoSecrets() {
  const skip = new Set(['node_modules', '.git', 'dist', 'dist-demo', 'dist-tips', 'assets-src']);
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
  const results = [...checkDist(dir), checkRepoWords(), checkRepoSecrets()];
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

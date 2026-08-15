/**
 * 応援まわりのページに敷く飾り。
 *
 * ── 1枚のモックを貼らない ──
 * 完成イメージをそのまま背景に置くと、文字の位置が画像に縛られ、
 * 端末の幅が変わった瞬間に崩れる。だから素材を層に分けて置き、
 * 文字とボタンは HTML のまま上に載せる。
 *
 * ── なぜ img ではなく CSS の背景なのか ──
 * 飾りの素材が置かれていなくても、ページは完全に使えなければならない。
 * <img> だと、ファイルが無いときに壊れた画像のしるしが出て、場所も取る。
 * CSS の背景なら、無ければ何も起きないだけで済む。
 * 意味を持つ絵（ハリネズミ）だけは <img> にして、alt を付ける。
 *
 * ── 配るのは webp、元は別の場所 ──
 * 元画像（1.5〜2.6MB）は assets-src/support/ に置いたまま触らず、
 * tools/optimize-assets.mjs が長辺1200px・webp に落としたものを配る。
 * 合計 8.3MB → 0.6MB。スマホしか持っていない人が前提のツールなので、
 * ここは見た目より先に効く。
 *
 * 背景の層は URL を1つしか書かない。CSS の background-image をカンマで並べると
 * 「無ければ次」ではなく「全部取りに行って重ねる」ので、
 * 候補を並べたぶんだけ無駄な 404 が出る。
 * マスコットだけは <img> なので、順に試しても無駄打ちが出ない。
 *
 * ── URL をスタイルシートに書かない理由 ──
 * ビルドすると CSS は dist/assets/ の中に置かれるので、
 * そこに書いた './assets/...' は assets/assets/... を指してしまう。
 * HTML から見た相対パスで解決させたいので、要素の style で渡す。
 * こうしておくと、GitHub Pages のサブディレクトリでも独自ドメインの直下でも、
 * 同じビルド成果物がそのまま動く。
 *
 * ── 触れないこと ──
 * すべて pointer-events: none。飾りが指を吸い取ると、
 * その下のボタンが押せなくなる。読み上げにも出さない（aria-hidden）。
 */
import { useState } from 'react';

/*
  かつては 'support'（応援）と 'thanks'（決済のあとのお礼）の2つだった。
  決済を外してお礼ページごと無くなったので、残るのは1つだけ。

  型に1つしか無いものを型として置いておくのは冗長だが、
  PageDecor / Mascot の呼び口を変えずに済むほうを取った。
  戻すときも、ここに足すだけで済む。
*/
export type DecorVariant = 'support';

/** 素材の置き場所。ここだけ見れば、どのファイルが要るか分かる。 */
export const SUPPORT_ASSETS = {
  /** 背景の層。1つだけ書く（並べると全部取りに行ってしまうため） */
  supportBg: 'support-bg.webp',
  water: 'support-water-decoration.webp',
  fruit: 'support-fruit-decoration.webp',
  /** マスコットは <img>。順に試しても無駄打ちにならないので候補を持てる */
  hedgehogSupport: ['hedgehog-support.webp', 'hedgehog-support.png'],
} as const;

/*
  お礼ページで使っていた「水の輪」（support-celebration.webp）と
  お礼のハリネズミ（hedgehog-thanks.webp）は、もう読み込まない。
  ファイル自体は public/assets/support/ に残っているが、参照は無い。
*/

/** 公開したときの置き場所に合わせて URL を組み立てる。 */
export function assetUrl(file: string) {
  const base = import.meta.env.BASE_URL || './';
  return `${base}assets/support/${file}`;
}

const bg = (file: string) => ({ backgroundImage: `url("${assetUrl(file)}")` });

export function PageDecor({ variant }: { variant: DecorVariant }) {
  return (
    <div className="decor" data-variant={variant} aria-hidden="true">
      {/* z-index 1 : ページ全体の淡い地 */}
      <div className="decor__bg" style={bg(SUPPORT_ASSETS.supportBg)} />
      {/* z-index 2 : 水・泡・ガラス */}
      <div className="decor__water" style={bg(SUPPORT_ASSETS.water)} />
      {/* z-index 3 : 葡萄・葉・蔓 */}
      <div className="decor__fruit" style={bg(SUPPORT_ASSETS.fruit)} />
    </div>
  );
}

/**
 * ハリネズミ。ここだけは意味のある絵なので <img>。
 *
 * 候補を順に試し、どれも無いときは枠ごと畳む。
 * 空き地が残って間延びするより、無いなら無いほうがいい。
 */
export function Mascot({ alt }: { variant?: DecorVariant; alt: string }) {
  const files = SUPPORT_ASSETS.hedgehogSupport;
  const [tried, setTried] = useState(0);

  if (tried >= files.length) return null;

  return (
    <img
      className="mascot"
      src={assetUrl(files[tried])}
      alt={alt}
      /* 幅と高さを先に伝えておくと、読み込みの前後で文字が飛ばない */
      width={512}
      height={512}
      decoding="async"
      onError={(e) => {
        // つぎの候補へ。全部だめなら、この枠ごと畳む
        if (tried + 1 >= files.length) {
          e.currentTarget.closest('.mascot-slot')?.setAttribute('data-missing', 'true');
        }
        setTried((n) => n + 1);
      }}
    />
  );
}

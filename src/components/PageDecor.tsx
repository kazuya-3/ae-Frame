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
 * ── 拡張子を1つに決めない ──
 * 素材を用意するのは、書き出しツールの都合で png になったり webp になったりする。
 * 「webp でなければ出ません」は、絵を描く側にとって理不尽な決まりごとなので、
 * 候補をいくつか並べて、あるものを使う。
 * CSS の background-image はカンマで並べると重なって描かれるだけなので、
 * 先頭が無ければ次が見える＝そのまま代わりとして働く。
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

export type DecorVariant = 'support' | 'thanks';

/**
 * 素材の置き場所。ここだけ見れば、どのファイルが要るか分かる。
 * 先に書いたものが優先。無ければ次を使う。
 */
export const SUPPORT_ASSETS = {
  supportBg: ['support-bg.webp', 'support-bg.png'],
  thanksBg: ['thanks-bg.webp', 'thanks-bg.png'],
  hedgehogSupport: ['hedgehog-support.png', 'hedgehog-support.webp'],
  hedgehogThanks: ['hedgehog-thanks.png', 'hedgehog-thanks.webp'],
  water: ['support-water-decoration.png', 'support-water-decoration.webp'],
  fruit: ['support-fruit-decoration.png', 'support-fruit-decoration.webp'],
  celebration: ['support-celebration.png', 'support-celebration.webp'],
} as const;

/** 公開したときの置き場所に合わせて URL を組み立てる。 */
export function assetUrl(file: string) {
  const base = import.meta.env.BASE_URL || './';
  return `${base}assets/support/${file}`;
}

/** 候補をぜんぶ重ねる。先頭が無ければ、次のものがそのまま見える。 */
const bg = (files: readonly string[]) => ({
  backgroundImage: files.map((f) => `url("${assetUrl(f)}")`).join(', '),
});

export function PageDecor({ variant }: { variant: DecorVariant }) {
  const thanks = variant === 'thanks';

  return (
    <div className="decor" data-variant={variant} aria-hidden="true">
      {/* z-index 1 : ページ全体の淡い地 */}
      <div
        className="decor__bg"
        style={bg(thanks ? SUPPORT_ASSETS.thanksBg : SUPPORT_ASSETS.supportBg)}
      />
      {/* z-index 2 : 水・泡・ガラス */}
      <div className="decor__water" style={bg(SUPPORT_ASSETS.water)} />
      {/* z-index 3 : 葡萄・葉・蔓 */}
      <div className="decor__fruit" style={bg(SUPPORT_ASSETS.fruit)} />
      {/* z-index 6 : 完了ページだけの紙吹雪。本文の上に重ねる */}
      {thanks && <div className="decor__celebration" style={bg(SUPPORT_ASSETS.celebration)} />}
    </div>
  );
}

/**
 * ハリネズミ。ここだけは意味のある絵なので <img>。
 *
 * 候補を順に試し、どれも無いときは枠ごと畳む。
 * 空き地が残って間延びするより、無いなら無いほうがいい。
 */
export function Mascot({ variant, alt }: { variant: DecorVariant; alt: string }) {
  const files =
    variant === 'thanks' ? SUPPORT_ASSETS.hedgehogThanks : SUPPORT_ASSETS.hedgehogSupport;
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

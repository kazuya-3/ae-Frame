/**
 * ひょっこり出るハリネズミ。
 *
 * ── なぜ「飾り」ではなく「場面」に置くのか ──
 *
 * つくる側の画面には、これまで飾りを一切置いてこなかった。
 * とくにステップ2（背景をけす）は、とうめいになったかどうかを
 * 目で判定する画面で、横に色のついた絵があると判断が鈍る。
 * 市松の下じきをテーマに追随させなかったのと同じ理由。
 *
 * だからここに出すのは、**何かが起きた瞬間だけ**にする。
 *
 *   ・まだ何も選んでいない（空っぽの枠）        → 寝ている子
 *   ・AI の切り抜きを待っている               → コーヒーの子
 *   ・保存できた                             → 手を振る子
 *   ・つかいかたを開いた                      → 歩いている子
 *
 * どれも「その場に他に見るものが無い」瞬間で、
 * 判断の邪魔をしない。ずっと出ているものは1つも無い。
 *
 *
 * ── 出るまで取りに行かない ──
 *
 * 場面が来るまで、この要素そのものが存在しない（条件付きで描いている）。
 * <img> なので、描かれてはじめて通信が起きる。
 * つまり、ふつうに開いただけのページの重さは 1バイトも増えない。
 * 1枚 23〜36KB なので、出たときの負担も小さい。
 *
 *
 * ── 無くても壊れない ──
 *
 * 素材が置かれていなくても、ページは完全に使えなければならない。
 * 読み込みに失敗したら、この枠ごと消える（壊れた画像のしるしを出さない）。
 * 意味を持たない絵なので alt は空にして、読み上げからも外す。
 */
import { useState } from 'react';

/** どの場面の絵か。ファイル名と1対1で対応する。 */
export type SpriteName = 'empty' | 'waiting' | 'saved' | 'help' | 'plain';

/** 公開したときの置き場所に合わせて URL を組み立てる。 */
function spriteUrl(name: SpriteName) {
  const base = import.meta.env.BASE_URL || './';
  return `${base}assets/support/hedgehog-${name}.webp`;
}

export function Sprite({
  name,
  size = 84,
  className,
}: {
  name: SpriteName;
  /** 出る大きさ（px）。小さく置くほうが、ひょっこり感が出る */
  size?: number;
  className?: string;
}) {
  const [gone, setGone] = useState(false);
  if (gone) return null;

  return (
    <img
      className={className ? `sprite ${className}` : 'sprite'}
      src={spriteUrl(name)}
      alt=""
      aria-hidden="true"
      width={size}
      height={size}
      style={{ width: size, height: size }}
      /* 画面に入るまで取りに行かない。出しっぱなしの場面でも無駄が出ない */
      loading="lazy"
      decoding="async"
      onError={() => setGone(true)}
    />
  );
}

/**
 * 応援まわりのページで共通に使う、いちばん外側の枠。
 *
 * つくる画面（App.tsx）のヘッダーとステップは、そのままの形を使い回す。
 * ここで新しい見た目の言語を作らない。
 * 同じサイトの中を移動しているだけ、と分かるようにするため。
 */
import type { ReactNode } from 'react';
import { navigate } from '../lib/route';
import { play } from '../lib/sound';
import { hasTipLinks } from '../tip-config';
import { Button } from './ui';
import { IconArrowLeft, IconFrame } from './Icons';

/** 応援の流れも、つくる画面と同じ3ステップの見た目にそろえる */
const SUPPORT_STEPS = [
  { id: 1, label: '支援をえらぶ' },
  { id: 2, label: '決済する' },
  { id: 3, label: '完了' },
];

export function SupportChrome({
  current,
  children,
}: {
  /** いま光らせるステップ */
  current: 1 | 2 | 3;
  children: ReactNode;
}) {
  return (
    <div className="app">
      <header className="appbar">
        <h1 className="appbar__title">
          <IconFrame size={24} />
          <span>アイコンフレーム メーカー</span>
        </h1>
        <Button
          variant="sm"
          sound="back"
          onClick={() => navigate('maker')}
          aria-label="つくる画面にもどる"
        >
          <IconArrowLeft size={16} />
          つくる
        </Button>
      </header>

      {/*
        ステップは進行の表示であって、押して飛べる場所ではない。
        決済は Stripe の画面で起きるので、こちらから 2 や 3 へは動かせない。
        押せないものをボタンに見せないよう、ol で組んでいる。

        ── 受け付けを止めているあいだは、丸ごと出さない ──

        止めたあとも、この帯だけは出しっぱなしになっていた。
        本文が「受け付けを止めています」と言っているすぐ上で、

          支援をえらぶ → 決済する → 完了

        が動いている状態。文言を消してまわったのに、いちばん上に
        **決済の順路そのもの**が残っていたことになる。
        「支援」は「応援」より寄付に寄った語でもある。

        しかもこれは条件分岐の向こうではなく、実際に表示されていた。
        公開後のスクリーンショットで見つかった。

        止めているあいだ、この順路はどこへも通じていない。
        通じていないものを描かない、というだけの話でもある。
      */}
      {hasTipLinks() && (
        <ol className="steps steps--static" aria-label="応援の手順">
          {SUPPORT_STEPS.map((s) => (
            <li
              key={s.id}
              className="steps__item"
              data-state={current === s.id ? 'current' : current > s.id ? 'done' : 'todo'}
              aria-current={current === s.id ? 'step' : undefined}
            >
              <span className="steps__dot">{s.id}</span>
              <span className="steps__label">{s.label}</span>
            </li>
          ))}
        </ol>
      )}

      {children}

      <div className="footer">
        {/*
          決済のあとの画面で「応援しなくても変わりません」と言うのは、
          もう払ってくれた人に向けると、しらけた言いかたになる。
          そこは「これからも無料」だけにする。
        */}
        <p>
          このツールはこれからも無料です。
          {current !== 3 && '応援しなくても、使える機能は何も変わりません。'}
        </p>
        <button
          type="button"
          className="tip__quiet"
          onClick={() => {
            play('back');
            navigate('maker');
          }}
        >
          アイコンフレームをつくる
        </button>
      </div>
    </div>
  );
}

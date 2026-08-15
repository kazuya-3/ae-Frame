/**
 * 知らせるページ（#/share）。
 *
 * ── 何のためにあるか ──
 *
 * ここは応援ページ（#/support）だった場所。金額を選んで Stripe の決済へ
 * 送り出す画面で、そのために作られていた。
 *
 * 2026-08 の Stripe の審査を受けて、決済を丸ごと外した。
 * 外したあと、この画面に残ったのは「ありがとう」と「知らせてもらえると助かる」
 * だけだった。**それだけなら、お金の話をする場所である必要が無い。**
 *
 * だから名前ごと変えた。お金に触れる要素は1つも置かない。
 * 金額も、決済への導線も、決済の順路も、募集の文言も無い。
 * 置いてあるのは、無料であることの確認と、人に知らせる手段だけ。
 *
 * ── 空いた場所を埋めない ──
 *
 * 決済まわりを外すと、この画面はかなり短くなる。そこを別のお願いで
 * 埋めたくなるが、埋めない。読む人にとっては、短いほうが良いページなので。
 *
 * ── 経緯 ──
 *
 * docs/stripe-compliance.md に、何を消したか・戻すとき何が要るかを書いてある。
 */
import { useEffect } from 'react';
import { navigate } from '../lib/route';
import { play } from '../lib/sound';
import { Note, Button } from './ui';
import { Mascot, PageDecor } from './PageDecor';
import { IconArrowLeft, IconFrame, IconShare } from './Icons';
import { ShareRow } from './ShareRow';

export function SharePage() {
  useEffect(() => {
    document.title = 'ありがとうございます｜アイコンフレーム メーカー';
    return () => {
      document.title = 'アイコンフレーム メーカー｜背景透過してアイコンに重ねる';
    };
  }, []);

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
        ここには「支援をえらぶ → 決済する → 完了」という順路の帯があった。
        通じる先が無くなったので、帯ごと消してある。
        通じていないものを描かない、というだけの話。
      */}

      <PageDecor variant="support" />

      <div className="card support">
        <div className="support__hero">
          <div className="mascot-slot">
            <Mascot variant="support" alt="ピンクのハートをかかえたハリネズミ" />
          </div>
          <div className="support__lead">
            <h2 className="support__title">いつも使ってくれてありがとう</h2>
            <p className="support__sub">このツールは、これからも無料で使えます。</p>
          </div>
        </div>

        <Note tone="ok">
          <span>
            <b>全部の機能が無料です。</b>
            <br />
            支払いはどこにもありません。
          </span>
        </Note>

        <section className="support__share" aria-labelledby="share-heading">
          <h3 className="support__next-title" id="share-heading">
            <IconShare size={17} />
            このページをシェアする
          </h3>
          <p className="support__next-body">知ってもらえるだけで、十分たすかります。</p>
          <ShareRow />
        </section>
      </div>

      <div className="footer">
        <p>このツールはこれからも無料です。</p>
        <button
          type="button"
          className="link-quiet"
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

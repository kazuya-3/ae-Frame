/**
 * 決済のあとに戻ってくるページ（#/support/thanks）。
 *
 * ここを「お買い上げありがとうございました」で終わらせない。
 * この人は、つい今しがたフレームを作った人でもある。
 * だからいちばん大きいボタンは、お礼ではなく「もう1個つくる」にする。
 *
 *   つくる → 保存 → 応援 → 決済 → お礼 → またつくる
 *
 * この輪がつながっているあいだは、道具として生きている。
 */
import { useEffect } from 'react';
import { navigate } from '../lib/route';
import { play, unlockAudio } from '../lib/sound';
import { Button, Note } from './ui';
import { SupportChrome } from './SupportChrome';
import { Mascot, PageDecor } from './PageDecor';
import { IconArrowRight, IconHeart } from './Icons';
import { ShareRow } from './ShareRow';
import { hasTipLinks } from '../tip-config';

export function ThanksPage() {
  useEffect(() => {
    document.title = '応援ありがとう！｜アイコンフレーム メーカー';
    return () => {
      document.title = 'アイコンフレーム メーカー｜背景透過してアイコンに重ねる';
    };
  }, []);

  return (
    <SupportChrome current={3}>
      <PageDecor variant="thanks" />

      <div className="card support support--thanks">
        <div className="support__hero support__hero--center">
          <div className="mascot-slot">
            <Mascot variant="thanks" alt="青いハートをかかえて喜んでいるハリネズミ" />
          </div>

          <div className="support__lead">
            <h2 className="support__title support__title--big">応援ありがとう！</h2>
            <p className="support__sub">おかげさまで、制作活動を続けていけます！</p>
          </div>
        </div>

        <div className="thanks__body">
          <p>
            このたびは ae-Frame の制作活動を応援していただき、本当にありがとうございます。
          </p>
          <p>
            いただいた応援は、新しいアイコンフレームの制作や、このツールの改善に
            大切に活用させていただきます。
          </p>
          <p>
            <b>本当にありがとうございます！</b>
          </p>
        </div>

        {/*
          いちばん大きいボタンは、お礼の続きではなく次の作業。
          ここで作る画面に戻れないと、ただの決済完了通知になってしまう。
        */}
        <Button
          variant="primary"
          onPointerDown={unlockAudio}
          onClick={() => {
            play('primary');
            navigate('maker');
          }}
        >
          もう1個つくる
          <IconArrowRight size={20} />
        </Button>

        <Note>
          決済の明細は Stripe からメールで届きます。このページには保存されていません。
        </Note>

        <section className="support__share" aria-labelledby="thanks-share-heading">
          <h3 className="support__next-title" id="thanks-share-heading">
            よかったら、知らせてもらえると嬉しいです
          </h3>
          <ShareRow />
        </section>

        {hasTipLinks() && (
          <button
            type="button"
            className="tip__quiet"
            onClick={() => {
              play('tap');
              navigate('support');
            }}
          >
            <IconHeart size={15} />
            また応援する
          </button>
        )}
      </div>
    </SupportChrome>
  );
}

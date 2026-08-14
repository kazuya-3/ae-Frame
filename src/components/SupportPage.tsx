/**
 * 応援ページ（#/support）。
 *
 * ここで守っていること:
 *
 * 1. 押さないことを、気まずくしない。
 *    「これからも無料」「押さなくても何も変わりません」を、
 *    お願いより先に書く。金額の話はそのあと。
 *
 * 2. カードを選んだだけでは、どこへも飛ばない。
 *    選ぶ操作と、お金の話へ進む操作を分ける。
 *    指が当たっただけで決済ページに飛ぶのは、いちばんやってはいけないこと。
 *
 * 3. カード番号はこのサイトに入力させない。
 *    入力欄は1つも作らない。決済は Stripe の画面でだけ起きる。
 */
import { useEffect, useMemo, useState } from 'react';
import { defaultPlanId, supportPlans, type TipOption } from '../tip-config';
import { play, unlockAudio } from '../lib/sound';
import { Note } from './ui';
import { SupportChrome } from './SupportChrome';
import { Mascot, PageDecor } from './PageDecor';
import { IconCheck, IconExternal, IconHeart, IconLock, IconShare } from './Icons';
import { ShareRow } from './ShareRow';

/** CTA の文字。選んだものがそのまま出るので、押す前に金額が分かる。 */
function ctaLabel(plan: TipOption | undefined) {
  if (!plan) return '応援する';
  return plan.id === 'custom' ? '好きな金額で応援する' : `${plan.label}で応援する`;
}

export function SupportPage() {
  const plans = useMemo(() => supportPlans(), []);
  const [selected, setSelected] = useState<string | null>(() => defaultPlanId());

  // 設定が空のときは、この画面に来ても金額は出さない（案内だけ）
  const plan = plans.find((p) => p.id === selected);

  useEffect(() => {
    /*
      タブに出る名前も、いまページが言っていることに合わせる。

      ここは「制作活動を応援する」だった。本文は「これからも無料」「受け付けを
      止めています」と言っているのに、タブだけが募っていることになる。
      しかも本文と違って、これは条件分岐の向こうではなく**実際に表示される**。
      消した文言より人目に触れる場所だった。
    */
    document.title = 'ありがとうございます｜アイコンフレーム メーカー';
    return () => {
      document.title = 'アイコンフレーム メーカー｜背景透過してアイコンに重ねる';
    };
  }, []);

  return (
    <SupportChrome current={1}>
      <PageDecor variant="support" />

      <div className="card support">
        {/* ---------------- ヒーロー ---------------- */}
        <div className="support__hero">
          <div className="mascot-slot">
            <Mascot variant="support" alt="ピンクのハートをかかえたハリネズミ" />
          </div>

          {/*
            受け付けを止めているあいだは、募集の文言を一切出さない。

            リンクを消しただけでは足りない。このページは URL を直に開けるので、
            「新しいフレームの制作に活用します」という文章だけが残る。
            それは「これから作るものへの資金集め」の証拠として、そのまま生きている。
            止めるなら、押すところだけでなく**言っていることも**止める。

            ── 出さないだけでは足りなかった ──

            はじめ、募集の文言は条件分岐の向こう側に残してあった。画面には
            出ないので、それで足りていると思っていた。足りていなかった。

            条件分岐は**描画を止めるだけ**で、文字列は配られる JS の中に
            そのまま入っている。審査を受けている当のアカウントで、
            引っかかった当の文言が、公開物から読み出せる状態だった。

            そして、この文言はどのみち二度と使えない。再開するときは
            「すでに提供したものへの任意の謝礼」として書き直すことになる
            （そうしないと同じ理由でまた止まる）。残す理由が無い。

            だから消す。戻すときは、ここに新しい文章を書く。
          */}
          <div className="support__lead">
            <h2 className="support__title">いつも使ってくれてありがとう</h2>
            <p className="support__sub">このツールは、これからも無料で使えます。</p>
          </div>
        </div>

        {/*
          お願いの前に、断っても何も起きないことを言い切る。
          ここを後ろに置くと、ただのお願いになる。
        */}
        <Note tone="ok">
          <span>
            <b>このツールはこれからも無料です。</b>
            <br />
            応援しなくても、使える機能は何も変わりません。
          </span>
        </Note>

        {plans.length === 0 ? (
          <Note>いまは応援の受け付けを止めています。ツールはこのまま無料で使えます。</Note>
        ) : (
          <>
            {/* ---------------- 金額をえらぶ ---------------- */}
            <div className="field">
              <div className="field__row">
                <span className="field__label">応援のきもち</span>
              </div>

              {/*
                見た目はカードだが、中身はラジオボタンひと組。
                矢印キーで選べて、選ばれているものが読み上げにも出る。
              */}
              <div className="plans" role="radiogroup" aria-label="応援のきんがく">
                {plans.map((p) => {
                  const on = p.id === selected;
                  return (
                    <button
                      key={p.id}
                      type="button"
                      role="radio"
                      aria-checked={on}
                      className="plan"
                      data-on={on || undefined}
                      onPointerDown={unlockAudio}
                      onClick={() => {
                        play('tap');
                        setSelected(p.id);
                      }}
                    >
                      {p.recommended && <span className="plan__badge">おすすめ</span>}
                      {/* 色だけで選択を示さない。印を出して、形でも分かるようにする */}
                      <span className="plan__mark" aria-hidden="true">
                        {on ? <IconCheck size={15} /> : null}
                      </span>
                      <span className="plan__amount">{p.label}</span>
                      <span className="plan__title">{p.title}</span>
                      <span className="plan__note">{p.note}</span>
                    </button>
                  );
                })}
              </div>
              <p className="field__note">
                カードを選んだだけでは、まだ何も起きません。下のボタンを押すと決済の画面へうつります。
              </p>
            </div>

            {/* ---------------- 進む ---------------- */}
            <a
              className="btn btn--primary support__cta"
              href={plan?.url}
              target="_blank"
              rel="noopener noreferrer"
              aria-disabled={plan ? undefined : true}
              onPointerDown={unlockAudio}
              onClick={(e) => {
                if (!plan) {
                  e.preventDefault();
                  play('error');
                  return;
                }
                play('primary');
              }}
            >
              <IconHeart size={20} />
              {ctaLabel(plan)}
              <IconExternal size={17} />
            </a>

            {/* ---------------- 安心してもらうための但し書き ---------------- */}
            <div className="safety">
              <p className="safety__head">
                <IconLock size={16} />
                安全な Stripe の決済ページへうつります
              </p>
              <ul className="safety__list">
                <li>カード情報がこのサイトを通ることはありません</li>
                <li>決済は Stripe が処理します</li>
                <li>毎月の支払い（サブスク）ではありません</li>
                <li>1回だけの、任意の応援です</li>
                <li>商品や個別のお返しなどの特典はありません</li>
              </ul>
            </div>
          </>
        )}

        {/*
          ここには「応援の使いみち」を置いていた。

            「応援が、次のフレームになります。」
            「次に何をつくるかは、まだ決めていません。」

          照会で最初に引っかかったのが、まさにこの2文だった。
          **これから作るもののために先にお金を集める**、と読める。
          条件分岐の向こうに残していたが、配られる JS には入ったままなので消した。

          戻すときは、この文章は使わないこと。書くなら、すでに提供した
          ものに対する任意の謝礼であること —— 見返りが無く、払っても払わなくても
          できることは変わらない、という側から書く。
        */}

        {/* ---------------- 広める ---------------- */}
        <section className="support__share" aria-labelledby="support-share-heading">
          <h3 className="support__next-title" id="support-share-heading">
            <IconShare size={17} />
            このページをシェアする
          </h3>
          <p className="support__next-body">
            お金でなくても、知ってもらえるだけで十分たすかります。
          </p>
          <ShareRow />
        </section>
      </div>
    </SupportChrome>
  );
}

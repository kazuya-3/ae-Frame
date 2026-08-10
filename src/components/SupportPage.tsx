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
    document.title = '制作活動を応援する｜アイコンフレーム メーカー';
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

          <div className="support__lead">
            <h2 className="support__title">
              制作活動を応援してくれると
              <br />
              とっても嬉しいです！
            </h2>
            <p className="support__sub">
              いただいた応援は、新しいアイコンフレームの制作や、
              このツールの改善に大切に活用させていただきます。
            </p>
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
          <Note>
            いまは応援の受け付けを止めています。ツールはこのまま無料で使えます。
          </Note>
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

        {/* ---------------- 応援の使いみち ---------------- */}
        <section className="support__next" aria-labelledby="support-next-heading">
          <h3 className="support__next-title" id="support-next-heading">
            応援が、次のフレームになります。
          </h3>
          <p className="support__next-body">
            透明な水、ガラスになる果実、液体金属。次に何をつくるかは、まだ決めていません。
            いただいた応援は、新しい表現を試すための制作に大切に使わせていただきます。
          </p>
        </section>

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

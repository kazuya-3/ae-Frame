/**
 * 応援（チップ）の入り口。
 *
 * 置き場所と言いかたで気をつけたこと:
 *
 * 1. 出すのは「保存できたあと」だけにする。
 *    まだ何も受け取っていない人にお願いするのは、ただのお願いになる。
 *    欲しいものが手に入った直後なら、こちらから言わなくても
 *    「これ無料でいいの？」と思ってもらえる瞬間がある。そこにだけ置く。
 *
 * 2. 押さないことを気まずくしない。
 *    「無料のままです」と先に言い切る。閉じるボタンを必ず添える。
 *    閉じたら、そのセッションではもう出さない。
 *
 * 3. お金の話は正直に短く。
 *    どこへ飛ぶのか、カード情報がどこを通るのかを、押す前に書いておく。
 */
import { useState } from 'react';
import { play, unlockAudio } from '../lib/sound';
import { activeTipOptions, hasTipLinks, TIP_CUSTOM_URL, TIP_OPTIONS } from '../tip-config';
import { IconHeart, IconX, IconExternal } from './Icons';

/** お試し版では、リンクが無くても見た目だけ確認できるようにする。 */
const DEMO = Boolean(import.meta.env.VITE_DEMO);

export function tipAvailable() {
  return hasTipLinks() || DEMO;
}

function TipButtons() {
  // お試し版では、URL が空でも見た目の確認ができるように全部並べる。
  // 中身は本番と同じ TIP_OPTIONS を使う（書き分けると片方だけ直し忘れる）。
  const options = DEMO ? TIP_OPTIONS : activeTipOptions();
  const custom = DEMO ? '' : TIP_CUSTOM_URL.trim();

  return (
    <>
      <div className="tip__row">
        {options.map((o) => (
          <a
            key={o.label}
            className="tip__amount"
            href={DEMO ? undefined : o.url}
            target="_blank"
            rel="noopener noreferrer"
            aria-disabled={DEMO || undefined}
            onPointerDown={unlockAudio}
            onClick={(e) => {
              if (DEMO) {
                e.preventDefault();
                play('error');
                return;
              }
              play('primary');
            }}
          >
            <span className="tip__value">{o.label}</span>
            <span className="tip__note">{o.note}</span>
          </a>
        ))}
      </div>

      {(custom || DEMO) && (
        <a
          className="tip__custom"
          href={DEMO ? undefined : custom}
          target="_blank"
          rel="noopener noreferrer"
          aria-disabled={DEMO || undefined}
          onPointerDown={unlockAudio}
          onClick={(e) => {
            if (DEMO) {
              e.preventDefault();
              play('error');
              return;
            }
            play('primary');
          }}
        >
          すきな金額をえらぶ
          <IconExternal size={16} />
        </a>
      )}

      <p className="tip__fine">
        {DEMO
          ? 'お試し版なので、ここのボタンは押しても何も起きません。'
          : 'Stripe の決済ページにうつります。カードの情報がこのサイトを通ることはありません。'}
      </p>
    </>
  );
}

/**
 * 保存できた直後に出す版。
 * 一度閉じたら、そのセッションではもう出さない。
 */
export function TipAfterSave({ onDismiss }: { onDismiss: () => void }) {
  if (!tipAvailable()) return null;

  return (
    <section className="tip tip--celebrate pop" aria-labelledby="tip-heading">
      <button
        type="button"
        className="tip__close"
        aria-label="応援の案内をとじる"
        onPointerDown={unlockAudio}
        onClick={() => {
          play('back');
          onDismiss();
        }}
      >
        <IconX size={18} />
      </button>

      <IconHeart size={30} className="tip__mark" />

      <h3 className="tip__title" id="tip-heading">
        このツールは、ずっと無料です
      </h3>
      <p className="tip__lede">
        広告も、会員登録もありません。もし気に入ってもらえたら、
        気持ちだけ受け取れる場所を用意しています。押さなくても、何も変わりません。
      </p>

      <TipButtons />
    </section>
  );
}

/**
 * 画面のすみに常に置いておく版。
 * 保存の案内を閉じた人が、あとから探せる場所。
 */
export function TipQuietLink() {
  const [open, setOpen] = useState(false);
  if (!tipAvailable()) return null;

  if (!open) {
    return (
      <button
        type="button"
        className="tip__quiet"
        onPointerDown={unlockAudio}
        onClick={() => {
          play('tap');
          setOpen(true);
        }}
      >
        <IconHeart size={15} />
        このツールを応援する
      </button>
    );
  }

  return (
    <section className="tip" aria-labelledby="tip-quiet-heading">
      <button
        type="button"
        className="tip__close"
        aria-label="とじる"
        onPointerDown={unlockAudio}
        onClick={() => {
          play('back');
          setOpen(false);
        }}
      >
        <IconX size={18} />
      </button>
      <h3 className="tip__title" id="tip-quiet-heading">
        応援する
      </h3>
      <p className="tip__lede">いただいたぶんは、このツールを動かしつづけるために使います。</p>
      <TipButtons />
    </section>
  );
}

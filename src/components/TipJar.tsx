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
 *    「これからも無料です」と先に言い切る。閉じるボタンを必ず添える。
 *    閉じたら、そのセッションではもう出さない。
 *
 * 3. ここで金額の話を始めない。
 *    保存できた直後の画面は、本来「できた！」を味わう場所。
 *    そこに金額のカードを4枚並べると、会計の画面になってしまう。
 *    金額を選ぶのは、自分でそこへ進んだ人だけでいい。
 */
import { navigate } from '../lib/route';
import { play, unlockAudio } from '../lib/sound';
import { hasTipLinks } from '../tip-config';
import { IconArrowRight, IconHeart, IconX } from './Icons';

/** お試し版では、リンクが無くても見た目だけ確認できるようにする。 */
const DEMO = Boolean(import.meta.env.VITE_DEMO);

export function tipAvailable() {
  return hasTipLinks() || DEMO;
}

/** 応援ページへ進むボタン。ここでは金額を出さない。 */
function SupportLink({ label }: { label: string }) {
  return (
    <button
      type="button"
      className="btn btn--primary tip__go"
      onPointerDown={unlockAudio}
      onClick={() => {
        play('primary');
        navigate('support');
      }}
    >
      <IconHeart size={19} />
      {label}
      <IconArrowRight size={18} />
    </button>
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
        このツールはこれからも無料です
      </h3>
      <p className="tip__lede">
        広告も、会員登録もありません。もし気に入ってもらえたら、
        制作活動を応援できる場所を用意しています。
        <b>押さなくても何も変わりません。</b>
      </p>

      <SupportLink label="制作活動を応援する" />

      <p className="tip__fine">
        金額はつぎの画面でえらべます。ここから先へ進まなくても、機能に違いはありません。
      </p>
    </section>
  );
}

/**
 * 画面のすみに常に置いておく版。
 * 保存の案内を閉じた人が、あとから探せる場所。
 */
export function TipQuietLink() {
  if (!tipAvailable()) return null;

  return (
    <button
      type="button"
      className="tip__quiet"
      onPointerDown={unlockAudio}
      onClick={() => {
        play('tap');
        navigate('support');
      }}
    >
      <IconHeart size={15} />
      制作活動を応援する
    </button>
  );
}

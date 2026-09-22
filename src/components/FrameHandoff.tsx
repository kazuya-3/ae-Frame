/**
 * フレームを人にわたすところ。
 *
 * ── なぜ部品にしたか ──
 *
 * はじめ、渡す道具を**3つめの画面（位置をあわせる）にだけ**置いていた。
 * そこはアイコンを仕上げる画面で、渡すのはそのついで、と思っていたから。
 *
 * けれど「配りたいだけの人」はアイコンを作らない。枠のフレームを1枚こしらえて、
 * みんなに配る。その人にとって、写真をえらぶのは**要らない作業**でしかない。
 * それなのに、写真を選ばないと背景けしの画面にすら行けず、
 * 位置あわせまで進まないとリンクが作れなかった。
 *
 * 背景をけした時点でフレームは出来ている。**出来た場所で渡せるべき。**
 * だから2つめの画面にも同じものを置けるように、ここへ切り出した。
 *
 * ── 画面ごとに違うところ ──
 *
 * 見え方の固定（すきまの色・まるく切りぬく）は、3つめの画面でしか選べない。
 * 2つめから配る人は選んでいないので、**この道具の既定**をそのまま焼きこむ。
 * 既定はいちばん多くの人に合う値なので、選ばなかった人が損をしない。
 */

import { useState } from 'react';
import { play } from '../lib/sound';
import { Button, Note, Toggle } from './ui';
import { IconDownload, IconShare } from './Icons';
import type { Hole } from '../lib/hole';
import { embedRecipe, type Placement, type Recipe, type RecipeLock } from '../lib/recipe';
import { CONTACT_URL, SHARE_ON, frameLink, putFrame } from '../lib/frameApi';

export type Handoff = { blob: Blob; hole: Hole | null };

export function FrameHandoff({
  build,
  lockDefaults,
  framePlacement,
  saveLabel,
  canShare = false,
  disabled = false,
  fileName,
}: {
  /** いまのフレームを、透過PNGとして作る。作れなければ null */
  build: () => Promise<Handoff | null>;
  /** 焼きこむ見え方。この画面で選べないものは、道具の既定を渡す */
  lockDefaults: { gap: RecipeLock['gap']; round: RecipeLock['round'] };
  /**
   * フレームの置き場所。渡さなければ contain のまま。
   * 背景けしの画面にはフレームを動かす手段が無いので、そこからは渡らない。
   */
  framePlacement?: Placement;
  /** 保存ボタンの文言。画面ごとに言いかたが違うので、呼ぶ側が決める */
  saveLabel: string;
  canShare?: boolean;
  disabled?: boolean;
  fileName: () => string;
}) {
  const [lockOnShare, setLockOnShare] = useState(false);
  const [frameName, setFrameName] = useState('');
  const [link, setLink] = useState('');
  const [linking, setLinking] = useState(false);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);

  /*
    渡すフレームを作る。

    「そろえる」が入っているときだけ、見え方を PNG の中に書き添える。
    書き添えるのは**フレームの見え方**だけで、写真の位置と大きさは相手に残す。
    そろえたいのはフレームであって、中の人ではない。
  */
  const make = async (): Promise<Blob | null> => {
    const got = await build();
    if (!got) return null;
    if (!lockOnShare) return got.blob;
    const lock: RecipeLock = { move: 'free', rotate: false, ...lockDefaults };
    // 名前は長さで切る。長いものを渡されても、もらった人の画面が崩れないように。
    const name = frameName.trim().slice(0, 40);
    const recipe: Recipe = {
      v: 1,
      ...(name ? { name } : {}),
      ...(got.hole ? { hole: got.hole } : {}),
      ...(framePlacement ? { frame: framePlacement } : {}),
      lock,
    };
    const out = embedRecipe(new Uint8Array(await got.blob.arrayBuffer()), recipe);
    return new Blob([out.buffer as ArrayBuffer], { type: 'image/png' });
  };

  const save = async () => {
    setBusy(true);
    try {
      const blob = await make();
      if (!blob) return;
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = fileName();
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
      play('done');
    } catch {
      play('error');
    } finally {
      setBusy(false);
    }
  };

  const send = async () => {
    setBusy(true);
    try {
      const blob = await make();
      if (!blob) return;
      const file = new File([blob], fileName(), { type: 'image/png' });
      if (navigator.canShare?.({ files: [file] })) {
        await navigator.share({ files: [file] });
        play('done');
        return;
      }
      await save();
    } catch (e) {
      // 閉じただけなら何も言わない
      if ((e as { name?: string })?.name !== 'AbortError') play('error');
    } finally {
      setBusy(false);
    }
  };

  /**
   * 配るリンクを作る。
   *
   * **ここが、この道具で唯一「絵がインターネットに出る」ところ。**
   * 押されたときだけ出る。黙って送るものは1つも無い。
   * 出るのはフレームだけで、利用者の写真は1バイトも出ない。
   */
  const makeLink = async () => {
    setLinking(true);
    setCopied(false);
    try {
      const blob = await make();
      if (!blob) throw new Error('フレームがありません');
      setLink(frameLink(await putFrame(blob)));
      play('done');
    } catch (e) {
      console.warn(e);
      setLink('');
      play('error');
    } finally {
      setLinking(false);
    }
  };

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      play('done');
    } catch {
      play('error');
    }
  };

  const off = disabled || busy;

  return (
    <div className="group">
      <p className="group__title">
        <IconShare size={15} />
        フレームを人にわたす
      </p>
      <p className="group__note">
        背景をけしたフレームそのものを渡せます。受け取った人は、自分の写真で同じものを作れます。
      </p>

      {/*
        そろえるスイッチ。

        渡すだけなら、いままでどおり渡せる。受け取った人は自由に置ける。
        けれど「みんなでつけよう」というときは、それだと**人によって
        大きさも位置も変わる**。そこをそろえるためのもの。

        固定するのはフレームの見え方だけで、**写真の位置と大きさは相手に残す**。
        顔の入れかたまで奪うと、顔が切れた人が直せなくなる。
      */}
      <Toggle on={lockOnShare} onChange={setLockOnShare} label="みんなの見た目をそろえる" />
      <p className="field__note">
        {lockOnShare ? (
          <>
            <b>いまの見え方を、フレームに焼きこんで渡します。</b>
            受け取った人の画面では、すきまの色・まるく切りぬく・かたむき・
            フレームの置き場所が<b>このまま</b>になります。
            写真の位置と大きさだけ、その人が決められます。
          </>
        ) : (
          <>受け取った人が、位置も大きさも自由に決められます。</>
        )}
      </p>

      {lockOnShare && (
        <div className="field">
          <div className="field__row">
            <span className="field__label">フレームの名前（なくてもOK）</span>
          </div>
          <input
            className="field__text"
            type="text"
            maxLength={40}
            value={frameName}
            onChange={(e) => setFrameName(e.target.value)}
            placeholder="れい：○○の枠"
            aria-label="フレームの名前"
          />
          <p className="field__note">
            受け取った人の画面に出ます。Discordで降ってきたファイルが
            <b>どの枠のものか</b>、開いた時点で分かります。
          </p>
        </div>
      )}

      {/*
        リンクで配る。

        ファイルで配るより、もらう人の手数がずっと少ない。
          ファイル : 長押しで保存 → アプリを開く → 写真 → 「フレームをえらぶ」
                     → さっき保存したものを探す → 調整 → 保存
          リンク   : リンクを押す → 写真をえらぶ → 保存

        配る相手の年齢も慣れもばらばらなら、この差は大きい。

        ただし**フレームがインターネットに出る**。だから押すまで何もしないし、
        何が出て何が出ないかを、押す前に書いておく。
      */}
      {lockOnShare && SHARE_ON && (
        <div className="field">
          <div className="field__row">
            <span className="field__label">リンクで配る</span>
          </div>
          {link ? (
            <div className="stack">
              <input
                className="field__text"
                type="text"
                readOnly
                value={link}
                aria-label="配るリンク"
                onFocus={(e) => e.currentTarget.select()}
              />
              <Button variant="ghost" onClick={copyLink} sound={null}>
                {copied ? 'コピーしました' : 'リンクをコピーする'}
              </Button>
              <p className="field__note">
                このリンクを押した人は、<b>フレームが入った状態</b>で開きます。
                あとは写真をえらぶだけです。90日で消えます。
              </p>
            </div>
          ) : (
            <div className="stack">
              <Button variant="ghost" onClick={makeLink} disabled={linking || off}>
                {linking ? '作っています…' : 'リンクを作る'}
              </Button>
              <p className="field__note">
                <b>このフレームだけがインターネットに送られます。</b>
                あなたの写真は送られません。90日で自動的に消えます。
              </p>
              {/*
                上げてよいものの決まり。

                どこかに畳んだ規約ではなく、**押す直前**に置く。
                読まれる場所に置いていないものは、書いていないのと同じ。
                長く書かない。2行で言えることを2行で言う。
              */}
              <p className="field__note">
                自分で作ったフレームか、配ってよいと分かっているものだけにしてください。
                <b>他の人の絵やキャラクターを、許可なく配らないでください。</b>
                <br />
                連絡をもらえば消します（
                <a href={CONTACT_URL} target="_blank" rel="noopener noreferrer">
                  相談・連絡はこちら
                </a>
                ）。
              </p>
            </div>
          )}
        </div>
      )}

      {canShare ? (
        <div className="btn-row">
          <Button variant="ghost" onClick={send} sound="tap" disabled={off}>
            <IconShare size={17} />
            とうめいなフレームを送る
          </Button>
          <Button variant="ghost" onClick={save} sound="tap" disabled={off}>
            <IconDownload size={17} />
            保存する
          </Button>
        </div>
      ) : (
        <Button variant="ghost" onClick={save} sound="tap" disabled={off}>
          <IconDownload size={17} />
          {saveLabel}
        </Button>
      )}

      {/*
        色は落とす。目を引くものは画面に1つだけ、というのがこの道具の決まり
        （styles.css の冒頭）。注意書きを強調色にすると、押すところが2つあるように見える。
      */}
      <Note>
        <span>
          <b>とうめいは、送りかたで消えます。</b>
          <br />
          LINE や SNS に<b>「写真」として送ると</b>、とうめいのところが白や黒で埋まります。
          そのまま渡したいときは、<b>「ファイル」として送る</b>
          か、いちど保存してから渡してください。
        </span>
      </Note>
    </div>
  );
}

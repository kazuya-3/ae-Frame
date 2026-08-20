/**
 * 保存。
 *
 * ── 形式ではなく「どこで使うか」で選ばせる ──
 *
 * WebM・MP4・PNG連番・アルファチャンネル。どれも、使う人が知りたい言葉ではない。
 * 知りたいのは「OBS に置けるのはどれ？」「CapCut に入れたい」だけ。
 * だからカードの見出しは行き先の名前にして、形式はその下に小さく置いた。
 *
 * ── 大きさの目安を先に出す ──
 *
 * PNG連番は、10秒でも 100MB を超えることがある。押してから知るのでは遅い。
 * 開いたときに1コマだけ実際に書き出して測り、その場で見当を出している。
 * 「たぶん大きい」ではなく、実測に基づく数字を出す。
 */
import { useEffect, useMemo, useState } from 'react';
import { downloadBlob, timestampName } from '../../lib/image';
import { play } from '../../lib/sound';
import {
  canRecordAlpha,
  estimateSequenceSize,
  exportPngSequence,
  exportStill,
  exportTransparent,
  exportWithBackdrop,
  opaqueContainer,
  type ExportedFile,
} from '../../lib/video/export';
import { GREEN, type Look, type MatteTrack } from '../../lib/video/matte';
import type { OpenedVideo } from '../../lib/video/pipeline';
import { Button, Note, Sheet } from '../ui';
import {
  IconArchive,
  IconBroadcast,
  IconCheck,
  IconDownload,
  IconFilm,
  IconLayers,
  IconPhoto,
  IconShare,
  IconX,
} from '../Icons';
import type { Media } from './types';

type Job = 'alpha' | 'green' | 'seq' | 'flat' | 'png';

export function SaveSheet({
  media,
  track,
  look,
  onClose,
}: {
  media: Media;
  track: MatteTrack;
  look: Look;
  onClose: () => void;
}) {
  const isVideo = media.kind === 'video';
  const video = isVideo ? (media.video as OpenedVideo) : null;

  /*
    4K のまま実時間で録るのは、たいていの端末で追いつかない
    （1コマごとに 800万画素を読んで書き戻すので、24コマ/秒に間に合わない）。
    大きい素材のときだけ、はじめから半分を選んでおく。選び直せる。
  */
  const [half, setHalf] = useState(media.kind === 'video' && media.width > 1920);
  const [withAudio, setWithAudio] = useState(true);
  const [busy, setBusy] = useState<{ value: number; label: string; paused?: boolean } | null>(null);
  const [result, setResult] = useState<{ file: ExportedFile; name: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [seqBytes, setSeqBytes] = useState<number | null>(null);
  const [canShare, setCanShare] = useState(false);
  const [embedded, setEmbedded] = useState(false);
  const [isIOS, setIsIOS] = useState(false);
  const [shareFailed, setShareFailed] = useState(false);
  const signal = useMemo(() => ({ aborted: false }), []);

  const width = Math.round((half ? media.width / 2 : media.width) / 2) * 2;
  const height = Math.round((half ? media.height / 2 : media.height) / 2) * 2;
  const seconds = Math.max(0.1, track.endSec - track.startSec);

  useEffect(() => () => void (signal.aborted = true), [signal]);

  /* 渡せるかどうかは、実際にファイルを1つ作って聞く（対応表では分からない） */
  useEffect(() => {
    if (typeof navigator === 'undefined' || typeof navigator.share !== 'function') return;
    try {
      const probe = new File([new Uint8Array(1)], 'probe.webm', { type: 'video/webm' });
      setCanShare(Boolean(navigator.canShare?.({ files: [probe] })));
    } catch {
      setCanShare(false);
    }
    try {
      setEmbedded(window.self !== window.top);
    } catch {
      setEmbedded(true);
    }
    /*
      iPhone / iPad かどうか。ここで保存の道が正反対になる。

        iPhone : 共有シートに「ビデオを保存」があり、写真アプリに入れる道はそこだけ。
                 ダウンロードすると「ファイル」アプリ行きになる。
        それ以外: ダウンロードがそのまま保存になる。

      つくる画面（ComposeStudio）と同じ判断をしている。
      iPadOS 13 以降は Macintosh を名乗るので、指で触れるかどうかで見分ける。
    */
    const ua = navigator.userAgent || '';
    const iPadOS = /Macintosh/.test(ua) && navigator.maxTouchPoints > 1;
    setIsIOS(/iPhone|iPad|iPod/.test(ua) || iPadOS);
  }, []);

  /* PNG連番の大きさを、1コマ書き出して測る */
  useEffect(() => {
    if (!video || track.frames.length < 2) return;
    let alive = true;
    void estimateSequenceSize({ video, track, look, width, height })
      .then((n) => alive && setSeqBytes(n))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [video, track, look, width, height]);

  const alphaOk = canRecordAlpha();
  const container = opaqueContainer();

  /** 動画1本ぶんの、だいたいの大きさ（録るときのビットレートから逆算） */
  const videoBytes = (() => {
    const bits = Math.min(
      24_000_000,
      Math.max(2_500_000, Math.round(width * height * track.fps * 0.12)),
    );
    return (bits / 8) * seconds;
  })();

  /*
    共有シートを開く。

    ここは押した指が離れてすぐでないと通らない（利用者の操作から時間が経つと、
    ブラウザが黙って断る）。だから「押したら開く」以外のことを間に入れない。
    ファイルは書き出しの時点でもう出来ているので、待たせずに渡せる。
  */
  const shareFile = (file: ExportedFile, name: string) => {
    try {
      const payload = new File([file.blob], name, { type: file.mime });
      if (!navigator.canShare?.({ files: [payload] })) {
        setShareFailed(true);
        return;
      }
      navigator.share({ files: [payload] }).catch((e: DOMException) => {
        // 利用者が閉じただけのときは、何も言わない
        if (e?.name !== 'AbortError') setShareFailed(true);
      });
    } catch {
      setShareFailed(true);
    }
  };

  const run = async (job: Job) => {
    if (busy) return;
    setError(null);
    setResult(null);
    setBusy({ value: 0, label: 'じゅんびしています' });
    const onProgress = (p: { value: number; label: string; paused?: boolean }) =>
      setBusy({ value: p.value, label: p.label, paused: p.paused });

    try {
      let file: ExportedFile;
      let name: string;

      if (job === 'png' || media.kind === 'image') {
        const image = media.kind === 'image' ? media.bitmap : media.video.el;
        const useLook = job === 'green' ? green(look) : job === 'png' ? bare(look) : look;
        file = await exportStill({ image, track, look: useLook, width, height });
        name = timestampName(job === 'green' ? 'green' : 'cutout', 'png');
      } else if (job === 'seq') {
        const base = timestampName('png-seq', 'x').replace(/\.x$/, '');
        file = await exportPngSequence({
          video: video!,
          track,
          look: bare(look),
          width,
          height,
          signal,
          onProgress,
          name: base,
        });
        name = `${base}.zip`;
      } else if (job === 'alpha') {
        file = await exportTransparent({
          video: video!,
          track,
          look: bare(look),
          width,
          height,
          signal,
          onProgress,
          withAudio,
        });
        name = timestampName('overlay', file.ext);
      } else {
        const useLook = job === 'green' ? green(look) : look;
        file = await exportWithBackdrop({
          video: video!,
          track,
          look: useLook,
          width,
          height,
          signal,
          onProgress,
          withAudio,
        });
        name = timestampName(job === 'green' ? 'greenback' : 'movie', file.ext);
      }

      setBusy(null);
      setResult({ file, name });
      setShareFailed(false);
      play('done');
      /*
        自分から落とすのは、それが「保存」になる端末だけ。

        ・枠の中（ほかのサイトに埋めこまれている）… ダウンロードは黙って捨てられる
        ・iPhone / iPad … 落としても「ファイル」アプリ止まりで、写真には入らない。
          しかも勝手に始まると、何が起きたのか分からないまま画面が切り替わる。
          こちらでは押してもらう（共有シートを開くのは、指が離れてすぐでないと通らない）。
      */
      if (!embedded && !isIOS) downloadBlob(file.blob, name);
    } catch (e) {
      console.warn(e);
      setBusy(null);
      setError(
        (e as Error)?.message ??
          '書き出せませんでした。時間を短くするか、大きさを半分にして試してください。',
      );
      play('error');
    }
  };

  return (
    <Sheet onClose={busy ? () => {} : onClose}>
      {busy ? (
        <div className="st-save__busy" data-paused={busy.paused ? 'true' : undefined}>
          <div className="st-ring" style={{ ['--v' as string]: busy.value }}>
            <span>{Math.round(busy.value * 100)}%</span>
          </div>
          <p className="st-save__busyLabel">{busy.label}</p>
          {/*
            止まっているときに「録っています」と出しっぱなしにしない。
            進捗が動かない理由が分からないと、人は壊れたと判断して閉じる。
          */}
          <p className="st-note-soft">
            {busy.paused
              ? 'ほかの画面に移ったので、いったん止めました。この画面に戻ると、続きから録ります。'
              : media.kind === 'video'
                ? '動画をそのまま流しながら録っています。画面はこのままにしてください。'
                : '書き出しています。'}
          </p>
          <Button
            variant="ghost"
            onClick={() => {
              signal.aborted = true;
              setBusy(null);
            }}
          >
            やめる
          </Button>
        </div>
      ) : result ? (
        <div className="st-save__done">
          <p className="st-save__doneTitle">
            <IconCheck size={22} /> できました
          </p>
          <p className="st-file">
            <span className="st-file__name">{result.name}</span>
            <span className="st-file__meta">{mb(result.file.blob.size)}</span>
          </p>

          {result.file.warning && <Note tone="warn">{result.file.warning}</Note>}

          {embedded ? (
            <Note tone="warn">
              いま、ほかのサイトの枠の中で開かれています。ここでは保存が止められることがあります。
              うまくいかないときは、このページを新しいタブで開いてから保存してください。
            </Note>
          ) : isIOS ? (
            /*
              iPhone では「保存できました」と言い切らない。
              言い切れるのは、共有シートで写真かファイルを選んでもらったあとだけ。
            */
            <Note>
              {/* 共有シートに並ぶ項目の名前は、渡すものによって変わる。そのまま書く */}
              {result.file.ext === 'zip'
                ? '下のボタンから「"ファイル"に保存」を選ぶと、ファイルアプリに入ります。'
                : result.file.ext === 'png'
                  ? '下のボタンから「画像を保存」を選ぶと、写真アプリに入ります。'
                  : '下のボタンから「ビデオを保存」を選ぶと、写真アプリに入ります。'}
            </Note>
          ) : (
            <Note tone="ok">ダウンロードのフォルダに入りました。</Note>
          )}

          {shareFailed && (
            <Note tone="warn">
              共有シートが開けませんでした。下の「ダウンロード」から保存してください（iPhone
              では「ファイル」アプリに入ります）。
            </Note>
          )}

          <div className="st-save__actions">
            {/*
              いちばん大きいボタンの中身を、端末で入れ替える。

              iPhone は共有シートだけが写真アプリへの道で、ダウンロードは
              「ファイル」行き。ほかの端末では逆に、共有シートに保存の項目が無い。
              同じ言葉で違う場所に届くので、ボタンの順番のほうを変える。
            */}
            {isIOS && canShare ? (
              <>
                <Button variant="primary" onClick={() => shareFile(result.file, result.name)}>
                  <IconShare size={20} />
                  {result.file.ext === 'zip' ? 'ファイルに保存する' : '写真に保存する'}
                </Button>
                <Button onClick={() => downloadBlob(result.file.blob, result.name)}>
                  <IconDownload size={20} /> ダウンロード（ファイルアプリ）
                </Button>
              </>
            ) : (
              <>
                <Button
                  variant="primary"
                  onClick={() => downloadBlob(result.file.blob, result.name)}
                >
                  <IconDownload size={20} /> もう一度ダウンロード
                </Button>
                {canShare && (
                  <Button onClick={() => shareFile(result.file, result.name)}>
                    <IconShare size={20} /> ほかのアプリに送る
                  </Button>
                )}
              </>
            )}
            <Button variant="ghost" onClick={() => setResult(null)}>
              べつの形でも保存する
            </Button>
          </div>
        </div>
      ) : (
        <>
          <div className="st-sheet__head">
            <div>
              <h2 className="st-sheet__title">どこで使いますか？</h2>
              <p className="st-sheet__sub">使う場所に合わせて、いちばん良い形で書き出します。</p>
            </div>
            <Button variant="icon" aria-label="とじる" onClick={onClose}>
              <IconX size={20} />
            </Button>
          </div>

          {error && <Note tone="warn">{error}</Note>}

          <div className="st-cards">
            {isVideo && alphaOk && (
              <Card
                icon={<IconBroadcast size={24} />}
                title="配信ソフトに、そのまま置く"
                lead="OBS・TikTok LIVE Studio・Streamlabs"
                meta={`透過WebM ・ ${mb(videoBytes)}前後${withAudio && video?.hasAudio ? ' ・ 音つき' : ''}`}
                note={
                  track.glow
                    ? '背景がない状態のまま置けます。光ものは、黒い地のままOBSに置いて「ブレンドモード → スクリーン」にする手もあります（そちらは画質がいっさい落ちません）。'
                    : '背景がない状態のまま置けます。いちばん手数が少ない道です。'
                }
                onClick={() => run('alpha')}
                accent
              />
            )}
            {/*
              透過の動画を作れない端末では、その行き先が黙って消える。

              消えたことに気づくのは「配信ソフトに置きたい人」だけで、その人は
              いちばんそれを必要としている人でもある。

              はじめは「作れません」という札を1枚置いていた。並べてみると、
              iPhone で保存を開いたとき、**最初に目に入るのが「できません」**になった。
              できることを先に置いて、事情はその中で説明したほうがいい。

              なので端末を見て、行き先そのものを差し替える。
              押す先はひとつ（緑の背景つき）で、なぜ緑なのかがその場に書いてある。
            */}
            {isVideo &&
              container &&
              (alphaOk ? (
                <Card
                  icon={<IconFilm size={24} />}
                  title="CapCut などの編集アプリで使う"
                  lead="スマホの編集アプリは、透過の動画を読めないことが多い"
                  meta={`緑の背景つき ・ ${container.toUpperCase()} ・ ${mb(videoBytes)}前後`}
                  note="アプリ側の「クロマキー」で緑を抜くと、切り抜きに戻ります。"
                  onClick={() => run('green')}
                />
              ) : (
                <Card
                  icon={<IconBroadcast size={24} />}
                  title="配信ソフト・編集アプリで使う"
                  lead="OBS・TikTok LIVE Studio・CapCut"
                  meta={`緑の背景つき ・ ${container.toUpperCase()} ・ ${mb(videoBytes)}前後`}
                  note={`${
                    isIOS
                      ? 'iPhone・iPad が録れるのは MP4 だけで、MP4 は透明を持てません。'
                      : 'このブラウザには、透明を保てる形式で録る仕組みがありません。'
                  }そのぶん緑で塗って渡すので、置いた先の「クロマキー」で緑を抜いてください。透明のまま渡したいときは、下の PNG連番が確実です。`}
                  onClick={() => run('green')}
                  accent
                />
              ))}
            {isVideo && (
              <Card
                icon={<IconArchive size={24} />}
                title="いちばんきれいに残す"
                lead="パソコンの編集ソフト（Premiere・AfterEffects・DaVinci）"
                meta={`透過PNG ${track.frames.length}枚 ・ ${seqBytes ? mb(seqBytes) : '大きさを調べています…'}`}
                note="画質は落ちません。そのぶん重いので、通信量にご注意ください。"
                onClick={() => run('seq')}
              />
            )}
            {isVideo && container && (
              <Card
                icon={<IconLayers size={24} />}
                title="そのまま投稿する"
                lead={
                  look.backdrop.kind === 'none'
                    ? 'いまは「とうめい」です。先に背景をえらんでください'
                    : 'いま画面に出ている背景のまま書き出します'
                }
                meta={`${container.toUpperCase()} ・ ${mb(videoBytes)}前後`}
                disabled={look.backdrop.kind === 'none'}
                onClick={() => run('flat')}
              />
            )}
            {!isVideo && (
              <>
                <Card
                  icon={<IconPhoto size={24} />}
                  title="背景のない画像として保存する"
                  lead="どこにでも重ねられます"
                  meta="透過PNG"
                  onClick={() => run('png')}
                  accent
                />
                <Card
                  icon={<IconLayers size={24} />}
                  title="いまの背景のまま保存する"
                  lead="画面に出ているとおりに書き出します"
                  meta="PNG"
                  onClick={() => run('flat')}
                />
              </>
            )}
          </div>

          <div className="st-save__opts">
            <div className="st-opt">
              <span className="st-opt__label">大きさ</span>
              <div className="st-chips st-chips--sm">
                <button
                  type="button"
                  className="st-chip"
                  aria-pressed={!half}
                  onClick={() => {
                    play('toggleOn');
                    setHalf(false);
                  }}
                >
                  そのまま {media.width}×{media.height}
                </button>
                <button
                  type="button"
                  className="st-chip"
                  aria-pressed={half}
                  onClick={() => {
                    play('toggleOn');
                    setHalf(true);
                  }}
                >
                  半分 {Math.round(media.width / 2)}×{Math.round(media.height / 2)}
                </button>
              </div>
            </div>
            {isVideo && video?.hasAudio && (
              <div className="st-opt">
                <span className="st-opt__label">音</span>
                <div className="st-chips st-chips--sm">
                  <button
                    type="button"
                    className="st-chip"
                    aria-pressed={withAudio}
                    onClick={() => {
                      play('toggleOn');
                      setWithAudio(true);
                    }}
                  >
                    そのまま入れる
                  </button>
                  <button
                    type="button"
                    className="st-chip"
                    aria-pressed={!withAudio}
                    onClick={() => {
                      play('toggleOff');
                      setWithAudio(false);
                    }}
                  >
                    音なしにする
                  </button>
                </div>
              </div>
            )}
          </div>

          {isVideo && (
            <p className="st-note-soft">
              動画の書き出しは、素材の長さと同じだけ時間がかかります（
              {seconds.toFixed(1)}秒 の素材なら {seconds.toFixed(1)}秒 ほど）。 PNG
              連番だけは、待たずに一気に書き出します。
            </p>
          )}
        </>
      )}
    </Sheet>
  );
}

function Card({
  icon,
  title,
  lead,
  meta,
  note,
  onClick,
  accent,
  disabled,
}: {
  icon: React.ReactNode;
  title: string;
  lead: string;
  meta: string;
  note?: string;
  onClick: () => void;
  accent?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      className="st-card"
      data-accent={accent ? 'true' : undefined}
      disabled={disabled}
      onClick={() => {
        play('primary');
        onClick();
      }}
    >
      <span className="st-card__icon">{icon}</span>
      <span className="st-card__body">
        <span className="st-card__title">{title}</span>
        <span className="st-card__lead">{lead}</span>
        <span className="st-card__meta">{meta}</span>
        {note && <span className="st-card__note">{note}</span>}
      </span>
    </button>
  );
}

/** 背景を敷かない見た目（透過のまま書き出すとき） */
function bare(look: Look): Look {
  return { ...look, backdrop: { ...look.backdrop, kind: 'none' } };
}
/** 緑を敷いた見た目（クロマキー用）。影は緑に落ちてしまうので外す */
function green(look: Look): Look {
  return { ...look, shadow: 0, backdrop: { kind: 'green', color: GREEN, image: null } };
}

function mb(bytes: number) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))}KB`;
  return `${(bytes / 1024 / 1024).toFixed(bytes > 100 * 1024 * 1024 ? 0 : 1)}MB`;
}

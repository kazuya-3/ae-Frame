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
      play('done');
      // 枠の中ではダウンロードが黙って捨てられる。そこでは自分から落とさない
      if (!embedded) downloadBlob(file.blob, name);
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
          {embedded ? (
            <Note tone="warn">
              いま、ほかのサイトの枠の中で開かれています。ここでは保存が止められることがあります。
              うまくいかないときは、このページを新しいタブで開いてから保存してください。
            </Note>
          ) : (
            <Note tone="ok">ダウンロードのフォルダに入りました。</Note>
          )}
          <div className="st-save__actions">
            <Button variant="primary" onClick={() => downloadBlob(result.file.blob, result.name)}>
              <IconDownload size={20} /> もう一度ダウンロード
            </Button>
            {canShare && (
              <Button
                onClick={() => {
                  const file = new File([result.file.blob], result.name, {
                    type: result.file.mime,
                  });
                  navigator.share({ files: [file] }).catch(() => {});
                }}
              >
                <IconShare size={20} /> ほかのアプリに送る
              </Button>
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
                note="背景がない状態のまま置けます。いちばん手数が少ない道です。"
                onClick={() => run('alpha')}
                accent
              />
            )}
            {isVideo && container && (
              <Card
                icon={<IconFilm size={24} />}
                title="CapCut などの編集アプリで使う"
                lead="スマホの編集アプリは、透過の動画を読めないことが多い"
                meta={`緑の背景つき ・ ${container.toUpperCase()} ・ ${mb(videoBytes)}前後`}
                note="アプリ側の「クロマキー」で緑を抜くと、切り抜きに戻ります。"
                onClick={() => run('green')}
              />
            )}
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

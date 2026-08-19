/**
 * うごく素材の背景けし（スタジオ）。
 *
 * ── この画面の設計 ──
 *
 * 使う人がやることは、いつでも3つしかない。
 *
 *     ① 置く   →   ② けす   →   ③ 使う先をえらぶ
 *
 * だから画面も、上から下へその順に積んである。
 * どの瞬間でも、いちばん大きくて色が付いているボタンは1つだけで、
 * それが「いま押すところ」。迷いは、選択肢の数ではなく
 * 「どれが今なのか分からないこと」から生まれるので、そこを消してある。
 *
 * ── 視線の置きかた ──
 *
 *   1. 舞台（プレビュー）… 画面の上半分をぜんぶ使う。確かめたいのはここだけ
 *   2. 背景チップ         … 舞台のすぐ下。押すと舞台が変わるので、視線が戻る
 *   3. フィルム           … 時間の話はここに集める
 *   4. 主ボタン           … 読み終わりの位置（下）に、1つだけ
 *   5. こまかい調整       … 畳んである。開くのは、うまくいかなかった人だけ
 *
 * ── 暗い画面にした理由 ──
 *
 * 透明を確かめる作業は、背景の明るさに引っぱられる。まわりが白いと
 * 白フチが見えず、まわりが暗いと黒フチが見えない。両方を確かめられるよう、
 * 舞台の外は徹底して暗く・無彩色にして、色の判断を舞台の中だけに閉じ込めた。
 * 有彩色は、いま押すところ（アクセント）と、緑背景の見本にしか出さない。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { fileToBitmap, fitWithin } from '../../lib/image';
import { play } from '../../lib/sound';
import { navigate } from '../../lib/route';
import {
  DEFAULT_REFINE,
  GREEN,
  type Backdrop,
  type BackdropKind,
  type Look,
  type MatteTrack,
  type Refine,
} from '../../lib/video/matte';
import {
  buildImageMatte,
  buildMatteTrack,
  decideEngine,
  frameToImageData,
  openVideo,
  seekTo,
  type Engine,
  type EngineUsed,
  type ProcessProgress,
} from '../../lib/video/pipeline';
import type { AiQuality } from '../../lib/ai';
import { Button, Disclosure, DropZone, Note, Segmented, Slider } from '../ui';
import {
  IconArrowLeft,
  IconFilm,
  IconLock,
  IconPhoto,
  IconScissors,
  IconSliders,
  IconSparkle,
  IconX,
} from '../Icons';
import { Stage } from './Stage';
import { FilmStrip, type Thumbs } from './FilmStrip';
import { SaveSheet } from './SaveSheet';
import type { Media, Phase, Range } from './types';
import '../../styles-studio.css';

/** フィルムに並べるコマの数。多すぎると1つ1つが小さく、少ないと進み具合が飛ぶ */
const FILM_SLOTS = 14;

/** 最初に選んでおく長さ。長い動画をそのまま流し込ませない（待ち時間が読めなくなる） */
const DEFAULT_SPAN_SEC = 15;

export default function StudioPage() {
  const [media, setMedia] = useState<Media | null>(null);
  const [phase, setPhase] = useState<Phase>('empty');
  const [error, setError] = useState<string | null>(null);

  const [range, setRange] = useState<Range>({ start: 0, end: 0 });
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [seekSignal, setSeekSignal] = useState<{ time: number; id: number } | null>(null);

  const [track, setTrack] = useState<MatteTrack | null>(null);
  const [progress, setProgress] = useState<ProcessProgress | null>(null);
  const [thumbs, setThumbs] = useState<Thumbs>(() => Array(FILM_SLOTS).fill(null));
  const [plan, setPlan] = useState<{ engine: EngineUsed; solid: boolean } | null>(null);

  const [refine, setRefine] = useState<Refine>(DEFAULT_REFINE);
  const [backdrop, setBackdrop] = useState<Backdrop>({ kind: 'none', color: GREEN, image: null });
  const [shadow, setShadow] = useState(0);
  const [bgColor, setBgColor] = useState<[number, number, number]>([0, 0, 0]);

  const [engine, setEngine] = useState<Engine>('auto');
  const [quality, setQuality] = useState<AiQuality>('balanced');
  const [smooth, setSmooth] = useState<'full' | 'half'>('full');
  const [stabilizeAmount, setStabilizeAmount] = useState(55);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);

  const abortRef = useRef<{ aborted: boolean }>({ aborted: false });
  const mediaRef = useRef<Media | null>(null);

  const look: Look = useMemo(
    () => ({ refine, backdrop, shadow, bgColor }),
    [refine, backdrop, shadow, bgColor],
  );

  useEffect(() => {
    mediaRef.current = media;
  }, [media]);

  /* 画面を離れるときは、動画とマットを手放す（戻ってこないものを抱えない） */
  useEffect(() => {
    return () => {
      abortRef.current.aborted = true;
      const m = mediaRef.current;
      if (m?.kind === 'video') m.video.close();
      if (m?.kind === 'image') m.bitmap.close?.();
    };
  }, []);

  /* ---------------- 素材を受け取る ---------------- */

  const reset = () => {
    abortRef.current.aborted = true;
    const m = mediaRef.current;
    if (m?.kind === 'video') m.video.close();
    if (m?.kind === 'image') m.bitmap.close?.();
    setMedia(null);
    setTrack(null);
    setPhase('empty');
    setProgress(null);
    setPlan(null);
    setThumbs(Array(FILM_SLOTS).fill(null));
    setBackdrop({ kind: 'none', color: GREEN, image: null });
    setRefine(DEFAULT_REFINE);
    setShadow(0);
    setPlaying(false);
    setDirty(false);
  };

  const loadFile = useCallback(async (file: File) => {
    setError(null);
    abortRef.current = { aborted: false };
    const prev = mediaRef.current;
    if (prev?.kind === 'video') prev.video.close();
    if (prev?.kind === 'image') prev.bitmap.close?.();

    setTrack(null);
    setThumbs(Array(FILM_SLOTS).fill(null));
    setProgress(null);
    setPlan(null);
    setDirty(false);
    setBackdrop({ kind: 'none', color: GREEN, image: null });

    const isVideo = file.type.startsWith('video/') || /\.(mp4|webm|mov|m4v)$/i.test(file.name);

    try {
      if (isVideo) {
        const video = await openVideo(file);
        const next: Media = {
          kind: 'video',
          video,
          name: file.name,
          width: video.width,
          height: video.height,
          durationSec: video.durationSec,
        };
        setMedia(next);
        mediaRef.current = next;
        const end = Math.min(video.durationSec, DEFAULT_SPAN_SEC);
        setRange({ start: 0, end });
        setTime(0);
        setPhase('ready');
        // 置いた瞬間から動き出す。「これがいまの素材」を、止め絵より早く伝えられる
        setPlaying(true);
        play('drop');

        // 表紙のコマを見て、どう消すことになるかを先に伝える
        await seekTo(video.el, Math.min(0.5, video.durationSec / 2));
        const probe = frameToImageData(video.el, video.width, video.height);
        const decided = decideEngine(probe, 'auto');
        setPlan({ engine: decided.engine, solid: decided.solid });
        void fillPosterThumbs(next, { start: 0, end }, setThumbs);
      } else {
        const bitmap = await fileToBitmap(file);
        const next: Media = {
          kind: 'image',
          bitmap,
          name: file.name,
          width: bitmap.width,
          height: bitmap.height,
        };
        setMedia(next);
        mediaRef.current = next;
        setRange({ start: 0, end: 0 });
        setPhase('ready');
        play('drop');
        const probe = frameToImageData(bitmap, bitmap.width, bitmap.height);
        const decided = decideEngine(probe, 'auto');
        setPlan({ engine: decided.engine, solid: decided.solid });
      }
    } catch (e) {
      console.warn(e);
      setError(
        (e as Error)?.message ??
          'この素材は読み込めませんでした。MP4・WebM・PNG・JPEG でお試しください。',
      );
      play('error');
    }
  }, []);

  /* ---------------- 背景を消す ---------------- */

  const processFps = (m: Media) => {
    if (m.kind !== 'video') return 1;
    const base = Math.min(30, m.video.fps || 24);
    return smooth === 'half' ? Math.max(8, Math.round(base / 2)) : base;
  };

  const start = async () => {
    if (!media) return;
    setError(null);
    setPlaying(false);
    setPhase('working');
    setDirty(false);
    /*
      ここでフィルムを空にしていた時期がある。
      空の枠が並ぶより、素材のコマが「切り抜いたあとの姿」に
      1枚ずつ置きかわっていくほうが、進み具合も仕上がりも同時に伝わる。
      写真が現像されていくのと同じ見えかたになる。
    */
    abortRef.current = { aborted: false };

    const total =
      media.kind === 'video'
        ? Math.max(1, Math.round((range.end - range.start) * processFps(media)) + 1)
        : 1;
    const thumbEvery = Math.max(1, Math.floor(total / FILM_SLOTS));

    const onProgress = (p: ProcessProgress) => {
      setProgress(p);
      if (p.thumb) {
        const slot = Math.min(FILM_SLOTS - 1, Math.round(p.thumb.index / thumbEvery));
        setThumbs((prev) => {
          const next = [...prev];
          next[slot]?.close?.();
          next[slot] = p.thumb!.bitmap;
          return next;
        });
      }
    };

    try {
      const result =
        media.kind === 'video'
          ? await buildMatteTrack(media.video, {
              startSec: range.start,
              endSec: range.end,
              fps: processFps(media),
              engine,
              quality,
              stabilizeAmount,
              signal: abortRef.current,
              onProgress,
              thumbCount: FILM_SLOTS,
            })
          : await buildImageMatte(media.bitmap, {
              engine,
              quality,
              signal: abortRef.current,
              onProgress,
            });

      setTrack(result.track);
      setBgColor(result.bgColor);
      setPlan({ engine: result.engine, solid: result.engine === 'color' });
      setPhase('done');
      setProgress(null);
      play('done');
      if (media.kind === 'video') {
        setSeekSignal({ time: result.track.startSec, id: Date.now() });
        setPlaying(true);
      }
    } catch (e) {
      console.warn(e);
      setPhase('ready');
      setProgress(null);
      if (!abortRef.current.aborted) {
        setError((e as Error)?.message ?? '背景を消せませんでした。もう一度おためしください。');
        play('error');
      }
    }
  };

  const stop = () => {
    abortRef.current.aborted = true;
    setPhase('ready');
    setProgress(null);
    play('back');
  };

  /* 消し直しが要る設定を触ったときだけ、消し直しの入口を出す */
  const markDirty = () => {
    if (phase === 'done') setDirty(true);
  };

  const frameCount =
    media?.kind === 'video' ? Math.round((range.end - range.start) * processFps(media)) + 1 : 1;

  /* ---------------- 画面 ---------------- */

  return (
    <div className="studio">
      <header className="st-top">
        <span className="st-brand">
          <IconScissors size={20} />
          <b>STUDIO</b>
          <span className="st-brand__sub">うごく素材の背景けし</span>
        </span>
        <button type="button" className="st-top__link" onClick={() => navigate('maker')}>
          <IconArrowLeft size={16} />
          アイコンフレームをつくる
        </button>
      </header>

      {!media ? (
        <section className="st-hero">
          <h1 className="st-hero__title">
            動画の背景を、
            <br />
            <em>まるごと消す。</em>
          </h1>
          <p className="st-hero__lead">
            配信のオーバーレイにも、編集アプリにも、そのまま置ける形で書き出します。
            <b>アップロードはしません。</b>ぜんぶこの端末の中で処理します。
          </p>

          <div className="st-drop">
            <DropZone
              title="動画や画像を、ここに置く"
              sub="タップして選ぶ／ドラッグ／貼り付け（Ctrl+V）　MP4・WebM・PNG・JPEG"
              icon={<IconFilm size={38} />}
              accept="video/*,image/*"
              onFile={loadFile}
            />
          </div>

          <ol className="st-steps">
            <li>
              <span className="st-steps__num">1</span>
              <b>置く</b>
              <span>動画でも、写真でも。</span>
            </li>
            <li>
              <span className="st-steps__num">2</span>
              <b>けす</b>
              <span>AIが1コマずつ切り抜きます。</span>
            </li>
            <li>
              <span className="st-steps__num">3</span>
              <b>使う</b>
              <span>置きたい場所を選ぶだけ。</span>
            </li>
          </ol>

          {error && <Note tone="warn">{error}</Note>}

          <p className="st-foot">
            <IconLock size={14} /> 素材はどこにも送信されません。通信するのは、AIの本体を
            はじめて取りにいくときだけです。
          </p>
        </section>
      ) : (
        <section className="st-work">
          <div className="st-work__main">
            <Stage
              media={media}
              track={phase === 'done' ? track : null}
              look={look}
              range={
                media.kind === 'video'
                  ? phase === 'done' && track
                    ? { start: track.startSec, end: track.endSec }
                    : range
                  : { start: 0, end: 0 }
              }
              playing={playing}
              onPlayingChange={setPlaying}
              onTime={setTime}
              seekSignal={seekSignal}
              comparable={phase === 'done'}
            >
              {phase === 'working' && (
                <div className="st-working">
                  <span className="st-working__scan" />
                  <div className="st-working__box">
                    <p className="st-working__label">
                      <IconSparkle size={18} />
                      {progress?.label ?? 'じゅんびしています'}
                    </p>
                    <div className="st-bar">
                      <span style={{ width: `${Math.max(3, (progress?.value ?? 0) * 100)}%` }} />
                    </div>
                    <p className="st-working__eta">
                      {progress?.etaSec != null && progress.etaSec > 0.5
                        ? `のこり およそ ${formatEta(progress.etaSec)}`
                        : 'はじめの1コマは、少し時間がかかります'}
                    </p>
                  </div>
                </div>
              )}
            </Stage>

            {/*
              背景チップ：舞台のすぐ下。押した結果が上に出るので、視線が上へ戻る。

              消す前は出さない。まだ背景が付いたままの絵に対して
              「うしろに敷くもの」を選ばせても、何も起きないうえ、
              押せない見た目のものが画面のいちばん目立つ場所に並ぶことになる。
            */}
            {phase === 'done' && (
              <div className="st-chips" role="group" aria-label="うしろに敷くもの">
                {(
                  [
                    ['none', 'とうめい'],
                    ['green', 'グリーン'],
                    ['white', '白'],
                    ['black', '黒'],
                    ['blur', 'ぼかし'],
                  ] as [BackdropKind, string][]
                ).map(([kind, label]) => (
                  <button
                    key={kind}
                    type="button"
                    className="st-chip"
                    data-kind={kind}
                    aria-pressed={backdrop.kind === kind}
                    onClick={() => {
                      play('toggleOn');
                      setBackdrop({ kind, color: GREEN, image: null });
                    }}
                  >
                    <span className="st-chip__swatch" data-kind={kind} />
                    {label}
                  </button>
                ))}
                <label className="st-chip st-chip--file">
                  <span className="st-chip__swatch" data-kind="image" />
                  画像
                  <input
                    type="file"
                    accept="image/*"
                    onChange={async (e) => {
                      const f = e.target.files?.[0];
                      e.target.value = '';
                      if (!f) return;
                      try {
                        const bmp = await fileToBitmap(f);
                        setBackdrop({ kind: 'image', color: GREEN, image: bmp });
                        play('drop');
                      } catch {
                        setError('この画像は背景に使えませんでした。');
                      }
                    }}
                  />
                </label>
              </div>
            )}

            {media.kind === 'video' && (
              <FilmStrip
                durationSec={media.durationSec}
                range={range}
                onRange={(r) => {
                  setRange(r);
                  markDirty();
                }}
                trimmable={phase === 'ready'}
                thumbs={thumbs}
                time={time}
                onSeek={(t) => {
                  setPlaying(false);
                  setTime(t);
                  setSeekSignal({ time: t, id: Date.now() });
                }}
              />
            )}
          </div>

          <div className="st-work__rail">
            <div className="st-clip">
              <span className="st-clip__icon">
                {media.kind === 'video' ? <IconFilm size={20} /> : <IconPhoto size={20} />}
              </span>
              <span className="st-clip__body">
                <b className="st-clip__name">{media.name}</b>
                <span className="st-clip__meta">
                  {media.width}×{media.height}
                  {media.kind === 'video' &&
                    ` ・ ${frameCount}コマ ・ ${(range.end - range.start).toFixed(1)}秒`}
                </span>
              </span>
              <button
                type="button"
                className="st-clip__x"
                aria-label="べつの素材にする"
                onClick={reset}
              >
                <IconX size={18} />
              </button>
            </div>

            {error && <Note tone="warn">{error}</Note>}

            {phase === 'ready' && (
              <>
                {plan && (
                  <p className="st-plan">
                    <IconSparkle size={16} />
                    {plan.engine === 'ai'
                      ? 'AIで、背景だけを見分けて消します。'
                      : plan.engine === 'keep'
                        ? 'この素材はもう背景がありません。そのまま使えます。'
                        : '背景が単色なので、色をたよりに一瞬で消します。'}
                  </p>
                )}
                <Button variant="primary" className="st-go" onClick={start}>
                  背景をけす
                </Button>
                {media.kind === 'video' && media.durationSec > DEFAULT_SPAN_SEC && (
                  <p className="st-note-soft">
                    長いので、はじめの{DEFAULT_SPAN_SEC}秒だけ選んでいます。
                    フィルムの両はしを動かすと変えられます。
                  </p>
                )}
              </>
            )}

            {phase === 'working' && (
              <Button variant="ghost" className="st-go" onClick={stop}>
                とちゅうでやめる
              </Button>
            )}

            {phase === 'done' && (
              <>
                {dirty && (
                  <Button variant="ghost" onClick={start}>
                    設定を変えました。もう一度けす
                  </Button>
                )}
                <Button
                  variant="primary"
                  className="st-go"
                  onClick={() => {
                    setPlaying(false);
                    setSaving(true);
                  }}
                >
                  ほぞんする
                </Button>
                <p className="st-note-soft">
                  {media.kind === 'video'
                    ? '配信ソフト・編集アプリ・投稿用。使う場所を選ぶだけです。'
                    : '透過PNGとして保存できます。'}
                </p>
              </>
            )}

            <Disclosure title="うまく消えないときは" icon={<IconSliders size={19} />}>
              <div className="stack">
                <div>
                  <p className="st-field-label">消しかた</p>
                  <Segmented
                    ariaLabel="消しかた"
                    value={engine}
                    onChange={(v) => {
                      setEngine(v);
                      markDirty();
                    }}
                    options={[
                      { value: 'auto', label: 'おまかせ' },
                      { value: 'ai', label: 'AI' },
                      { value: 'color', label: '色で' },
                    ]}
                  />
                  <p className="st-field-note">
                    「色で」は、背景が1色のときだけ使えます。速さは段ちがいです。
                  </p>
                </div>

                {/*
                  フチの調整は、消したあとにしか効かない。
                  まだ何も消えていないうちに出しても、動かしても何も起きない
                  つまみが並ぶだけになるので、そのときは出さない。
                */}
                {track && (
                  <>
                    <Slider
                      label="フチをけずる"
                      value={refine.choke}
                      min={-6}
                      max={6}
                      step={0.5}
                      defaultValue={DEFAULT_REFINE.choke}
                      onChange={(v) => setRefine((r) => ({ ...r, choke: v }))}
                      note="背景がうっすら残るときは右へ。消えすぎたときは左へ。"
                    />
                    <Slider
                      label="フチをやわらかく"
                      value={refine.feather}
                      min={0}
                      max={6}
                      step={0.2}
                      defaultValue={DEFAULT_REFINE.feather}
                      onChange={(v) => setRefine((r) => ({ ...r, feather: v }))}
                      note="輪郭のギザギザを目立たなくします。"
                    />
                    <Slider
                      label="フチの色をとる"
                      value={refine.decontaminate}
                      min={0}
                      max={100}
                      defaultValue={DEFAULT_REFINE.decontaminate}
                      onChange={(v) => setRefine((r) => ({ ...r, decontaminate: v }))}
                      format={(v) => `${v}%`}
                      note="暗い背景で撮ったものの、黒っぽいフチを消します。"
                    />
                    <Slider
                      label="のこす量"
                      value={refine.threshold}
                      min={10}
                      max={90}
                      defaultValue={DEFAULT_REFINE.threshold}
                      onChange={(v) => setRefine((r) => ({ ...r, threshold: v }))}
                      note="髪や毛が消えるときは右へ。うすいもやが残るときは左へ。"
                    />
                    <Slider
                      label="影をつける"
                      value={shadow}
                      min={0}
                      max={100}
                      defaultValue={0}
                      onChange={setShadow}
                      format={(v) => `${v}%`}
                      note="重ねたときに、浮いて見えないようにします。"
                    />
                  </>
                )}

                {media.kind === 'video' && (
                  <>
                    <div>
                      <p className="st-field-label">なめらかさ</p>
                      <Segmented
                        ariaLabel="なめらかさ"
                        value={smooth}
                        onChange={(v) => {
                          setSmooth(v);
                          markDirty();
                        }}
                        options={[
                          { value: 'full', label: 'そのまま' },
                          { value: 'half', label: '半分（速い）' },
                        ]}
                      />
                      <p className="st-field-note">
                        半分にすると、待ち時間も半分になります。止まっている素材なら見分けはつきません。
                      </p>
                    </div>
                    <Slider
                      label="ゆれをおさえる"
                      value={stabilizeAmount}
                      min={0}
                      max={100}
                      defaultValue={55}
                      onChange={(v) => {
                        setStabilizeAmount(v);
                        markDirty();
                      }}
                      format={(v) => `${v}%`}
                      note="輪郭がコマごとにチリチリ震えるときに上げます。"
                    />
                  </>
                )}

                <div>
                  <p className="st-field-label">きれいさ</p>
                  <Segmented
                    ariaLabel="きれいさ"
                    value={quality}
                    onChange={(v) => {
                      setQuality(v);
                      markDirty();
                    }}
                    options={[
                      { value: 'balanced', label: 'ふつう（速い）' },
                      { value: 'high', label: '最高（重い）' },
                    ]}
                  />
                </div>

                {dirty && (
                  <Note>
                    変えた設定は、もう一度けすと反映されます。
                    <div style={{ marginTop: 8 }}>
                      <Button variant="sm" onClick={start}>
                        もう一度けす
                      </Button>
                    </div>
                  </Note>
                )}
              </div>
            </Disclosure>

            <p className="st-foot">
              <IconLock size={14} /> 素材はこの端末から出ません。
            </p>
          </div>
        </section>
      )}

      {saving && media && track && (
        <SaveSheet
          media={media}
          track={track}
          look={look}
          onClose={() => {
            setSaving(false);
            // 見ていた続きから、また動き出す
            if (media.kind === 'video') setPlaying(true);
          }}
        />
      )}
    </div>
  );
}

/** 消す前のフィルムに、素材そのもののコマを並べておく（空の枠だけ見せない） */
async function fillPosterThumbs(
  media: Media,
  range: Range,
  setThumbs: (fn: (prev: Thumbs) => Thumbs) => void,
) {
  if (media.kind !== 'video') return;
  const { video } = media;
  const fit = fitWithin({ width: video.width, height: video.height }, 160);
  const canvas = document.createElement('canvas');
  canvas.width = fit.width;
  canvas.height = fit.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  for (let i = 0; i < FILM_SLOTS; i++) {
    const t = range.start + ((range.end - range.start) * i) / (FILM_SLOTS - 1);
    await seekTo(video.el, Math.min(t, video.durationSec - 0.05));
    ctx.drawImage(video.el, 0, 0, fit.width, fit.height);
    try {
      const bitmap = await createImageBitmap(canvas);
      setThumbs((prev) => {
        const next = [...prev];
        releaseThumb(next[i]);
        next[i] = bitmap;
        return next;
      });
    } catch {
      /* 1枚くらい欠けても、フィルムは読める */
    }
  }
  await seekTo(video.el, range.start);
}

/** 置きかえる前のコマを手放す（映像メモリを持ったままにしない） */
function releaseThumb(bitmap: ImageBitmap | null) {
  bitmap?.close?.();
}

function formatEta(sec: number) {
  if (sec < 60) return `${Math.ceil(sec)}秒`;
  const m = Math.floor(sec / 60);
  return `${m}分${Math.ceil(sec - m * 60)}秒`;
}

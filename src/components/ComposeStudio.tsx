/**
 * ステップ3：アイコン写真にフレームを重ねて、位置を合わせて書き出す画面。
 *
 * 触りかたは1つだけ覚えればいい：指1本で動かす、指2本で拡大・回転。
 * ボタンでも同じことができるので、ジェスチャーを知らない人でも詰まらない。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { canvasToBlob, createCanvas, downloadBlob, get2d, timestampName } from '../lib/image';
import { play } from '../lib/sound';
import { Button, Note, Segmented, Slider, Toggle } from './ui';
import {
  IconArrowLeft,
  IconDownload,
  IconFlip,
  IconMinus,
  IconMove,
  IconPlus,
  IconRefresh,
  IconRotate,
} from './Icons';
import { TipAfterSave } from './TipJar';

/** 書き出しサイズ。SNSのアイコンとしては十分で、スマホでも重くならない。 */
const EXPORT_SIZE = 1080;

type Transform = {
  x: number;
  y: number;
  scale: number;
  rotation: number;
  /** 左右反転。自撮りの向きを直したいときに要る */
  flipped: boolean;
};

/** すきま（写真が届かないところ）に敷く色 */
type Gap = 'none' | 'white' | 'black';

const GAP_FILL: Record<Gap, string | null> = {
  none: null,
  white: '#ffffff',
  black: '#111114',
};

type Target = 'photo' | 'frame';

const IDENTITY: Transform = { x: 0, y: 0, scale: 1, rotation: 0, flipped: false };

export function ComposeStudio({
  photo,
  frame,
  active,
  onBack,
  onRestart,
}: {
  photo: ImageBitmap;
  frame: ImageBitmap;
  /** この画面が表示されているか。隠れている間は幅が0なので描き直さない。 */
  active: boolean;
  onBack: () => void;
  onRestart: () => void;
}) {
  const [photoT, setPhotoT] = useState<Transform>(IDENTITY);
  const [frameT, setFrameT] = useState<Transform>(IDENTITY);
  const [target, setTarget] = useState<Target>('photo');
  const [round, setRound] = useState(true);
  const [gap, setGap] = useState<Gap>('none');
  // 一度でも触ったら、操作の案内は引っ込める
  const [touched, setTouched] = useState(false);
  const [tipDismissed, setTipDismissed] = useState(false);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [canShare, setCanShare] = useState(false);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<{
    dist: number;
    angle: number;
    cx: number;
    cy: number;
  } | null>(null);
  const rafRef = useRef(0);

  const t = target === 'photo' ? photoT : frameT;
  const setT = target === 'photo' ? setPhotoT : setFrameT;

  useEffect(() => {
    setCanShare(typeof navigator !== 'undefined' && typeof navigator.share === 'function');
  }, []);

  /* --------------- 画像の基準倍率 --------------- */

  // 写真は画面いっぱい（cover）、フレームは全体が入る（contain）が初期状態。
  const photoBase = useMemo(
    () => Math.max(EXPORT_SIZE / photo.width, EXPORT_SIZE / photo.height),
    [photo],
  );
  const frameBase = useMemo(
    () => Math.min(EXPORT_SIZE / frame.width, EXPORT_SIZE / frame.height),
    [frame],
  );

  /* --------------- 描画 --------------- */

  const paint = useCallback(
    (ctx: CanvasRenderingContext2D, size: number, withOverlay: boolean) => {
      const k = size / EXPORT_SIZE;
      ctx.clearRect(0, 0, size, size);
      ctx.imageSmoothingQuality = 'high';

      /*
        すきまの色。写真を小さくすると、まわりが透明のままになる。
        透明の PNG は SNS に上げると黒や白で埋められることがあるので、
        自分で決められるようにしておく。
      */
      const fill = GAP_FILL[gap];
      if (fill) {
        ctx.save();
        ctx.fillStyle = fill;
        if (round) {
          ctx.beginPath();
          ctx.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2);
          ctx.fill();
        } else {
          ctx.fillRect(0, 0, size, size);
        }
        ctx.restore();
      }

      const drawLayer = (img: ImageBitmap, base: number, tr: Transform) => {
        const w = img.width * base * tr.scale * k;
        const h = img.height * base * tr.scale * k;
        ctx.save();
        ctx.translate(size / 2 + tr.x * k, size / 2 + tr.y * k);
        ctx.rotate((tr.rotation * Math.PI) / 180);
        if (tr.flipped) ctx.scale(-1, 1);
        ctx.drawImage(img, -w / 2, -h / 2, w, h);
        ctx.restore();
      };

      drawLayer(photo, photoBase, photoT);
      drawLayer(frame, frameBase, frameT);

      if (withOverlay && round) {
        // 丸く切り抜いたときに消える範囲を、うすく暗くして見せる。
        // 四角と円を1つのパスにして even-odd で塗ると、円の内側だけが抜ける。
        ctx.save();
        ctx.fillStyle = 'rgba(0,0,0,0.45)';
        ctx.beginPath();
        ctx.rect(0, 0, size, size);
        ctx.moveTo(size, size / 2);
        ctx.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2);
        ctx.fill('evenodd');

        // 切り取り線。どこで切られるかを線でも示す。
        ctx.beginPath();
        ctx.arc(size / 2, size / 2, size / 2 - 1, 0, Math.PI * 2);
        ctx.setLineDash([size / 60, size / 60]);
        ctx.lineWidth = Math.max(1.5, size / 320);
        ctx.strokeStyle = 'rgba(255,255,255,0.9)';
        ctx.stroke();
        ctx.restore();
      }
    },
    [photo, frame, photoBase, frameBase, photoT, frameT, round, gap],
  );

  /*
    描く中身は毎回変わるが、「次のフレームで描く」という予約そのものは
    使いまわす。ここを分けないと、こういう事故が起きる:

      1フレームの間に指が2回動くと、2回めの更新で予約が取り消され、
      しかも「予約中」の印が残る。以後この画面は永久に描き直されない。

    実際その状態になっていて、素早くドラッグしたあとはスライダーも
    反転ボタンも矢印キーも、見た目が何も変わらなくなっていた。

    予約は1つだけ持ち、中身は毎回いちばん新しい paint を読みにいく。
    こうすると、まとめられたフレームでも必ず最新の状態が描かれる。
  */
  const paintRef = useRef(paint);
  paintRef.current = paint;

  const scheduleRender = useCallback(() => {
    if (rafRef.current) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = 0;
      const canvas = canvasRef.current;
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      // 隠れている（幅0）ときに描くと、1px のキャンバスが残ってしまう
      if (rect.width < 1) return;
      const dpr = Math.min(2.5, window.devicePixelRatio || 1);
      const size = Math.max(1, Math.round(rect.width * dpr));
      if (canvas.width !== size) {
        canvas.width = size;
        canvas.height = size;
      }
      paintRef.current(get2d(canvas), size, true);
    });
  }, []);

  // 中身が変わったら描き直す。
  // active が立った直後はまだ display:none のままなので、
  // レイアウトが確定してからもう一度描く。
  useEffect(() => {
    if (!active) return;
    scheduleRender();
    const id = requestAnimationFrame(() => scheduleRender());
    return () => cancelAnimationFrame(id);
  }, [paint, active, scheduleRender]);

  useEffect(() => {
    const onResize = () => scheduleRender();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [scheduleRender]);

  // 予約の片づけは、この部品が消えるときだけ。
  useEffect(
    () => () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      rafRef.current = 0;
    },
    [],
  );

  /* --------------- 指の操作 --------------- */

  // 表示の1pxが書き出しの何pxにあたるか
  const displayToExport = () => {
    const rect = canvasRef.current?.getBoundingClientRect();
    return rect && rect.width > 0 ? EXPORT_SIZE / rect.width : 1;
  };

  const onPointerDown = (e: React.PointerEvent) => {
    setTouched(true);
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.current.size === 2) gesture.current = readGesture();
  };

  const readGesture = () => {
    const [a, b] = [...pointers.current.values()];
    return {
      dist: Math.hypot(b.x - a.x, b.y - a.y),
      angle: (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI,
      cx: (a.x + b.x) / 2,
      cy: (a.y + b.y) / 2,
    };
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const prev = pointers.current.get(e.pointerId);
    if (!prev) return;
    const next = { x: e.clientX, y: e.clientY };
    pointers.current.set(e.pointerId, next);
    const ratio = displayToExport();

    if (pointers.current.size >= 2) {
      const g = readGesture();
      const start = gesture.current;
      if (start) {
        const scaleBy = start.dist > 4 ? g.dist / start.dist : 1;
        let dAngle = g.angle - start.angle;
        if (dAngle > 180) dAngle -= 360;
        if (dAngle < -180) dAngle += 360;
        setT((t0) => ({
          ...t0,
          x: t0.x + (g.cx - start.cx) * ratio,
          y: t0.y + (g.cy - start.cy) * ratio,
          scale: clamp(t0.scale * scaleBy, 0.15, 8),
          rotation: t0.rotation + dAngle,
        }));
      }
      gesture.current = g;
      return;
    }

    setT((t0) => ({
      ...t0,
      x: t0.x + (next.x - prev.x) * ratio,
      y: t0.y + (next.y - prev.y) * ratio,
    }));
  };

  const onPointerUp = (e: React.PointerEvent) => {
    pointers.current.delete(e.pointerId);
    if (pointers.current.size < 2) gesture.current = null;
  };

  const onWheel = (e: React.WheelEvent) => {
    setT((t0) => ({
      ...t0,
      scale: clamp(t0.scale * (e.deltaY < 0 ? 1.08 : 1 / 1.08), 0.15, 8),
    }));
  };

  /*
    矢印キーでの微調整。指では 1px 単位で置けないし、
    パソコンから使う人にはマウスより速い。
  */
  const onKeyDown = (e: React.KeyboardEvent) => {
    const step = e.shiftKey ? 20 : 4;
    const move = (dx: number, dy: number) => {
      e.preventDefault();
      setTouched(true);
      setT((t0) => ({ ...t0, x: t0.x + dx * step, y: t0.y + dy * step }));
    };
    if (e.key === 'ArrowLeft') move(-1, 0);
    else if (e.key === 'ArrowRight') move(1, 0);
    else if (e.key === 'ArrowUp') move(0, -1);
    else if (e.key === 'ArrowDown') move(0, 1);
    else if (e.key === '+' || e.key === '=') {
      e.preventDefault();
      nudgeScale(1.08);
    } else if (e.key === '-') {
      e.preventDefault();
      nudgeScale(1 / 1.08);
    }
  };

  const nudgeScale = (factor: number) => {
    play('tap');
    setT((t0) => ({ ...t0, scale: clamp(t0.scale * factor, 0.15, 8) }));
  };

  const resetTarget = () => {
    play('back');
    setT(IDENTITY);
  };

  /* --------------- 書き出し --------------- */

  const buildBlob = useCallback(async () => {
    const canvas = createCanvas(EXPORT_SIZE, EXPORT_SIZE);
    const ctx = get2d(canvas);
    paint(ctx, EXPORT_SIZE, false);
    if (round) {
      ctx.globalCompositeOperation = 'destination-in';
      ctx.beginPath();
      ctx.arc(EXPORT_SIZE / 2, EXPORT_SIZE / 2, EXPORT_SIZE / 2, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalCompositeOperation = 'source-over';
    }
    return canvasToBlob(canvas, 'image/png');
  }, [paint, round]);

  const save = async () => {
    setBusy(true);
    try {
      const blob = await buildBlob();
      downloadBlob(blob, timestampName('icon', 'png'));
      play('done');
      setSaved(true);
    } catch {
      play('error');
    } finally {
      setBusy(false);
    }
  };

  const share = async () => {
    setBusy(true);
    try {
      const blob = await buildBlob();
      const file = new File([blob], timestampName('icon', 'png'), {
        type: 'image/png',
      });
      // 画像を共有できない環境では、そのまま保存に切り替える
      if (navigator.canShare?.({ files: [file] })) {
        await navigator.share({ files: [file] });
        play('done');
        setSaved(true);
      } else {
        downloadBlob(blob, file.name);
        play('done');
        setSaved(true);
      }
    } catch {
      /* 共有シートを閉じただけなので、何も言わない */
    } finally {
      setBusy(false);
    }
  };

  const saveFrameOnly = async () => {
    const canvas = createCanvas(frame.width, frame.height);
    get2d(canvas).drawImage(frame, 0, 0);
    downloadBlob(await canvasToBlob(canvas, 'image/png'), timestampName('frame_toka', 'png'));
    play('done');
  };

  return (
    <div className="card">
      <div className="card__head">
        <span className="card__num">3</span>
        <h2 className="card__title">位置をあわせる</h2>
      </div>
      <p className="card__hint">
        写真は<b>指でつまんで動かせます</b>
        。大きさとかたむきは、下のボタンやスライダーでも変えられます。
        {round ? '暗いところは、まるく切りぬかれる部分です。' : ''}
      </p>

      <div
        className="stage"
        tabIndex={0}
        role="application"
        aria-label={`${target === 'photo' ? '写真' : 'フレーム'}の位置あわせ。矢印キーで動かせます`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onPointerLeave={onPointerUp}
        onWheel={onWheel}
        onKeyDown={onKeyDown}
      >
        <canvas ref={canvasRef} />

        {/* 触るまでは、何ができるかを大きく出しておく。触ったら邪魔なので消す。 */}
        {!touched ? (
          <span className="stage__coach">
            <IconMove size={20} />
            指でうごかす／2本でひろげて大きさ
          </span>
        ) : (
          <span className="stage__hint">
            {target === 'photo' ? '写真をうごかしています' : 'フレームをうごかしています'}
          </span>
        )}
      </div>

      <div className="spacer" />

      <div className="stack">
        <Segmented<Target>
          ariaLabel="うごかすもの"
          value={target}
          onChange={setTarget}
          options={[
            { value: 'photo', label: '写真をうごかす' },
            { value: 'frame', label: 'フレームをうごかす' },
          ]}
        />

        <div className="btn-row">
          <Button
            variant="icon"
            onClick={() => nudgeScale(1 / 1.12)}
            aria-label="小さくする"
            sound={null}
          >
            <IconMinus />
          </Button>
          <Button
            variant="icon"
            onClick={() => nudgeScale(1.12)}
            aria-label="大きくする"
            sound={null}
          >
            <IconPlus />
          </Button>
          <Button
            variant="icon"
            onClick={() => {
              play('tap');
              setT((t0) => ({ ...t0, rotation: t0.rotation + 15 }));
            }}
            aria-label="15度まわす"
            sound={null}
          >
            <IconRotate />
          </Button>
          <Button
            variant="icon"
            onClick={() => {
              play('toggleOn');
              setT((t0) => ({ ...t0, flipped: !t0.flipped }));
            }}
            aria-label="左右を反転する"
            title="左右反転"
            sound={null}
          >
            <IconFlip />
          </Button>
          <Button variant="ghost" onClick={resetTarget} sound={null} style={{ flex: '1 1 110px' }}>
            <IconRefresh size={18} />
            位置をもどす
          </Button>
        </div>

        <Slider
          label={target === 'photo' ? '写真の大きさ' : 'フレームの大きさ'}
          value={Math.round(t.scale * 100)}
          min={15}
          max={400}
          onChange={(v) => setT((t0) => ({ ...t0, scale: v / 100 }))}
          format={(v) => `${v}%`}
        />
        <Slider
          label="かたむき"
          value={Math.round(t.rotation)}
          min={-180}
          max={180}
          onChange={(v) => setT((t0) => ({ ...t0, rotation: v }))}
          format={(v) => `${v}°`}
        />

        <div className="field">
          <div className="field__row">
            <span className="field__label">すきまの色</span>
          </div>
          <Segmented<Gap>
            ariaLabel="すきまの色"
            value={gap}
            onChange={setGap}
            options={[
              { value: 'none', label: 'とうめい' },
              { value: 'white', label: '白' },
              { value: 'black', label: '黒' },
            ]}
          />
          <p className="field__note">
            写真を小さくしたとき、まわりに残るところの色です。とうめいのままだと、
            SNSによっては黒く表示されることがあります。
          </p>
        </div>

        <Toggle
          on={round}
          onChange={(v) => {
            play(v ? 'toggleOn' : 'toggleOff');
            setRound(v);
          }}
          label={round ? 'まるく切りぬく（SNSのアイコン用）' : 'しかくいまま保存する'}
        />

        {canShare ? (
          <>
            <Button variant="primary" onClick={share} disabled={busy}>
              <IconDownload size={20} />
              {busy ? '書き出しています…' : 'ほぞん・シェアする'}
            </Button>
            <Button variant="ghost" onClick={save} disabled={busy}>
              画像として保存だけする
            </Button>
          </>
        ) : (
          <Button variant="primary" onClick={save} disabled={busy}>
            <IconDownload size={20} />
            {busy ? '書き出しています…' : '画像をほぞんする'}
          </Button>
        )}

        {saved && (
          <div className="pop">
            <Note tone="ok">
              保存できました！SNSのプロフィール写真から、この画像をえらんでください。
              <br />
              うまく保存できないときは、画像を長おしして「写真に追加」を選んでください。
            </Note>
          </div>
        )}

        {/*
          応援の案内は、保存できた直後にだけ出す。
          欲しいものが手に入る前にお願いするのは、ただのお願いになってしまう。
          閉じたら、この画面を開いているあいだはもう出さない。
        */}
        {saved && !tipDismissed && <TipAfterSave onDismiss={() => setTipDismissed(true)} />}

        <Button variant="ghost" onClick={saveFrameOnly} sound="tap">
          とうめいにしたフレームだけを保存する
        </Button>

        <div className="btn-row">
          <Button variant="ghost" onClick={onBack} sound="back">
            <IconArrowLeft size={18} />
            背景けしにもどる
          </Button>
          <Button variant="ghost" onClick={onRestart} sound="back">
            さいしょから
          </Button>
        </div>
      </div>
    </div>
  );
}

function clamp(v: number, min: number, max: number) {
  return Math.min(max, Math.max(min, v));
}

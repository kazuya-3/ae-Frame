/**
 * ステップ2：背景をとうめいにする画面。
 *
 * 表に出しているのはプレビューと「つぎへ」だけ。
 * 直らなかった人だけが折りたたみを開けば、色キーの調整と手描き修正が全部ある。
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  analyze,
  applyProtectEnclosed,
  colorKeyAlpha,
  composite,
  createPaintMask,
  clearPaintMask,
  finishAlpha,
  measureQuality,
  passthroughAlpha,
  strokeBrush,
  DEFAULT_SETTINGS,
  type Analysis,
  type CutoutMode,
  type CutoutSettings,
  type PaintMask,
} from '../lib/cutout';
import type { AiQuality } from '../lib/ai';
import {
  canvasToBlob,
  downloadBlob,
  imageDataToCanvas,
  timestampName,
  trimTransparent,
} from '../lib/image';
import { play } from '../lib/sound';
import { Button, Disclosure, Note, Progress, Segmented, Slider, Toggle } from './ui';
import {
  IconBrush,
  IconCheck,
  IconDownload,
  IconEraser,
  IconRefresh,
  IconUndo,
  IconWand,
  IconArrowLeft,
} from './Icons';

type Status =
  | { kind: 'working'; label: string; progress: number }
  | { kind: 'ready' }
  | { kind: 'error'; message: string };

type Tool = 'pick' | 'erase' | 'keep' | null;

/**
 * プレビューの下じき。
 * 白いフレームは明るい市松の上では見えないので、暗い下じきに替えられるようにする。
 */
type Backdrop = 'checker' | 'dark' | 'white' | 'black';

const NEXT_BACKDROP: Record<Backdrop, Backdrop> = {
  checker: 'dark',
  dark: 'white',
  white: 'black',
  black: 'checker',
};

const BACKDROP_LABEL: Record<Backdrop, string> = {
  checker: '市松',
  dark: '市松（暗）',
  white: '白',
  black: '黒',
};

type UndoPatch = {
  x: number;
  y: number;
  w: number;
  h: number;
  erase: Uint8Array;
  keep: Uint8Array;
};

export function CutoutStudio({
  source,
  notice,
  onDone,
  onBack,
}: {
  source: ImageData;
  /** 読み込み時に自動でやったこと（切り取りなど）の知らせ */
  notice?: ReactNode;
  onDone: (result: ImageData) => void;
  onBack: () => void;
}) {
  const analysis: Analysis = useMemo(() => analyze(source), [source]);

  const [settings, setSettings] = useState<CutoutSettings>(() => initialSettings(analysis));
  const [status, setStatus] = useState<Status>({
    kind: 'working',
    label: '読み込んでいます',
    progress: 0.05,
  });
  const [tool, setTool] = useState<Tool>(null);
  const [brushSize, setBrushSize] = useState(28);
  const [quality, setQuality] = useState<AiQuality>('balanced');
  const [aiTried, setAiTried] = useState(false);
  const [undoCount, setUndoCount] = useState(0);
  const [backdrop, setBackdrop] = useState<Backdrop>('checker');

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const cursorRef = useRef<HTMLDivElement>(null);
  const baseAlphaRef = useRef<Uint8ClampedArray | null>(null);
  const finishedRef = useRef<Uint8ClampedArray | null>(null);
  const aiAlphaRef = useRef<Uint8ClampedArray | null>(null);
  const paintRef = useRef<PaintMask>(createPaintMask(source.width, source.height));
  const strokeBeforeRef = useRef<{
    erase: Uint8Array;
    keep: Uint8Array;
  } | null>(null);
  const strokeBoxRef = useRef<{
    x0: number;
    y0: number;
    x1: number;
    y1: number;
  } | null>(null);
  const frameBufRef = useRef<ImageData | null>(null);
  const undoRef = useRef<UndoPatch[]>([]);
  const lastPointRef = useRef<{ x: number; y: number } | null>(null);
  const rafRef = useRef(0);
  const runIdRef = useRef(0);

  /* --------------- 描画 --------------- */

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    const finished = finishedRef.current;
    if (!canvas || !finished) return;
    // バッファを使い回して、筆を動かしている間の確保・破棄をなくす
    const out = composite(source, finished, paintRef.current, settings, frameBufRef.current);
    frameBufRef.current = out;
    if (canvas.width !== out.width || canvas.height !== out.height) {
      canvas.width = out.width;
      canvas.height = out.height;
    }
    canvas.getContext('2d')?.putImageData(out, 0, 0);
  }, [source, settings]);

  const scheduleDraw = useCallback(() => {
    if (rafRef.current) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = 0;
      draw();
    });
  }, [draw]);

  /* --------------- ベースアルファの計算 --------------- */

  const computeBase = useCallback(
    async (
      requested: Exclude<CutoutMode, 'auto'>,
      s: CutoutSettings,
      forceAi = false,
      /** 結果を検算して、失敗していたら AI に切り替えてよいか（初回の自動実行のみ） */
      allowEscalate = false,
    ) => {
      const runId = ++runIdRef.current;
      let mode = requested;

      if (mode === 'color') {
        const alpha = colorKeyAlpha(source, s);

        /*
          出した結果を自分で検算する。
          白いガラスを白地に描いたようなデザインは、色だけでは背景と区別できず、
          絵がほとんど消えるか粉々の断片になる。そうなっていたら黙って AI に回す。
          ユーザーには「AIできれいにしています」としか見えない。
        */
        const q = allowEscalate ? measureQuality(alpha, source.width, source.height) : null;
        if (q?.suspicious) {
          mode = 'ai';
          setAiTried(true);
          setSettings((prev) => ({ ...prev, mode: 'ai' }));
          // AI を待つ間、暫定の結果を出しておく。画面が真っ白にならない。
          baseAlphaRef.current = alpha;
          finishedRef.current = finishAlpha(alpha, source.width, source.height, s);
          scheduleDraw();
        } else {
          baseAlphaRef.current = alpha;
        }
      }

      if (mode === 'none') {
        baseAlphaRef.current = passthroughAlpha(source);
      } else if (mode === 'ai') {
        if (aiAlphaRef.current && !forceAi) {
          baseAlphaRef.current = aiAlphaRef.current;
        } else {
          setStatus({
            kind: 'working',
            label: 'AIを準備しています',
            progress: 0.02,
          });
          try {
            const { runMatting } = await import('../lib/ai');
            const alpha = await runMatting(source, quality, (p) => {
              if (runIdRef.current !== runId) return;
              setStatus({
                kind: 'working',
                label: p.label,
                // ダウンロードで 0〜70%、推論で 70〜100% に割り当てる
                progress: p.phase === 'download' ? p.progress * 0.7 : 0.7 + p.progress * 0.3,
              });
            });
            if (runIdRef.current !== runId) return;
            aiAlphaRef.current = alpha;
            // AI も、囲まれた明るい部分（提灯の紙など）を背景と誤ることがある。
            // 色キーと同じ守りを通しておく。
            baseAlphaRef.current = s.protectEnclosed
              ? applyProtectEnclosed(alpha, source.width, source.height, s.softness >= 0.08)
              : alpha;
          } catch (e) {
            if (runIdRef.current !== runId) return;
            // AI が使えなくても手ぶらでは返さない。色キーに落として作業を続けられるようにする。
            baseAlphaRef.current = colorKeyAlpha(source, {
              ...s,
              mode: 'color',
            });
            finishedRef.current = finishAlpha(baseAlphaRef.current, source.width, source.height, s);
            scheduleDraw();
            setSettings((prev) => ({ ...prev, mode: 'color' }));
            setStatus({
              kind: 'error',
              message: import.meta.env.VITE_DEMO
                ? 'このお試し版ではAI切り抜きは使えません。かんたん処理に切り替えました（公開版ではAIも使えます）。'
                : 'AIの読み込みができませんでした（通信が不安定かもしれません）。かんたん処理に切り替えました。',
            });
            play('error');
            console.warn(e);
            return;
          }
        }
      }

      if (runIdRef.current !== runId) return;
      finishedRef.current = finishAlpha(baseAlphaRef.current!, source.width, source.height, s);
      scheduleDraw();
      setStatus({ kind: 'ready' });
    },
    [source, scheduleDraw, quality],
  );

  // 初回：判定してそのまま実行する（ユーザーに何も聞かない）。
  // 色キーで済むと踏んだ場合も、結果を検算して駄目なら AI に自動で切り替える。
  useEffect(() => {
    const mode = analysis.recommended;
    setAiTried(mode === 'ai');
    void computeBase(mode, initialSettings(analysis), false, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source]);

  // 色キーの数値を動かしたときの再計算（AI は再計算不要なのでキャッシュを使う）
  const recomputeTimer = useRef<number>(0);
  const recomputeColor = useCallback(
    (next: CutoutSettings) => {
      window.clearTimeout(recomputeTimer.current);
      recomputeTimer.current = window.setTimeout(() => {
        if (next.mode === 'color') {
          baseAlphaRef.current = colorKeyAlpha(source, next);
        } else if (next.mode === 'none') {
          baseAlphaRef.current = passthroughAlpha(source);
        } else if (aiAlphaRef.current) {
          baseAlphaRef.current = next.protectEnclosed
            ? applyProtectEnclosed(
                aiAlphaRef.current,
                source.width,
                source.height,
                next.softness >= 0.08,
              )
            : aiAlphaRef.current;
        }
        if (baseAlphaRef.current) {
          finishedRef.current = finishAlpha(
            baseAlphaRef.current,
            source.width,
            source.height,
            next,
          );
          scheduleDraw();
        }
      }, 45);
    },
    [source, scheduleDraw],
  );

  const patch = useCallback(
    (partial: Partial<CutoutSettings>) => {
      setSettings((prev) => {
        const next = { ...prev, ...partial };
        recomputeColor(next);
        return next;
      });
    },
    [recomputeColor],
  );

  const changeMode = useCallback(
    (mode: CutoutMode) => {
      const resolved: Exclude<CutoutMode, 'auto'> = mode === 'auto' ? analysis.recommended : mode;
      // 手法を変えたら、背景色の引き算もその手法に合った初期値に戻す
      const next = { ...settings, mode: resolved, decontaminate: decontaminateFor(resolved) };
      setSettings(next);
      if (resolved === 'ai') setAiTried(true);
      setStatus({ kind: 'working', label: '切り替えています', progress: 0.1 });
      void computeBase(resolved, next);
    },
    [analysis.recommended, settings, computeBase],
  );

  useEffect(() => () => cancelAnimationFrame(rafRef.current), []);

  /* --------------- 手描き修正 --------------- */

  const toImageCoords = (e: React.PointerEvent) => {
    const canvas = canvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    return {
      x: ((e.clientX - rect.left) / rect.width) * canvas.width,
      y: ((e.clientY - rect.top) / rect.height) * canvas.height,
    };
  };

  const beginStroke = () => {
    const p = paintRef.current;
    strokeBeforeRef.current = {
      erase: new Uint8Array(p.erase),
      keep: new Uint8Array(p.keep),
    };
    strokeBoxRef.current = null;
  };

  const expandBox = (x: number, y: number, r: number) => {
    const b = strokeBoxRef.current ?? {
      x0: Infinity,
      y0: Infinity,
      x1: -Infinity,
      y1: -Infinity,
    };
    b.x0 = Math.min(b.x0, x - r);
    b.y0 = Math.min(b.y0, y - r);
    b.x1 = Math.max(b.x1, x + r);
    b.y1 = Math.max(b.y1, y + r);
    strokeBoxRef.current = b;
  };

  const endStroke = () => {
    const before = strokeBeforeRef.current;
    const box = strokeBoxRef.current;
    strokeBeforeRef.current = null;
    strokeBoxRef.current = null;
    if (!before || !box) return;

    // 触ったところだけを取り出して積む（全面コピーを溜めるとメモリが持たない）
    const { width, height } = paintRef.current;
    const x = Math.max(0, Math.floor(box.x0));
    const y = Math.max(0, Math.floor(box.y0));
    const w = Math.min(width, Math.ceil(box.x1) + 1) - x;
    const h = Math.min(height, Math.ceil(box.y1) + 1) - y;
    if (w <= 0 || h <= 0) return;

    const erase = new Uint8Array(w * h);
    const keep = new Uint8Array(w * h);
    for (let row = 0; row < h; row++) {
      const src = (y + row) * width + x;
      erase.set(before.erase.subarray(src, src + w), row * w);
      keep.set(before.keep.subarray(src, src + w), row * w);
    }
    undoRef.current.push({ x, y, w, h, erase, keep });
    if (undoRef.current.length > 20) undoRef.current.shift();
    setUndoCount(undoRef.current.length);
  };

  const undo = () => {
    const p = undoRef.current.pop();
    setUndoCount(undoRef.current.length);
    if (!p) return;
    const mask = paintRef.current;
    for (let row = 0; row < p.h; row++) {
      const dst = (p.y + row) * mask.width + p.x;
      mask.erase.set(p.erase.subarray(row * p.w, row * p.w + p.w), dst);
      mask.keep.set(p.keep.subarray(row * p.w, row * p.w + p.w), dst);
    }
    scheduleDraw();
  };

  const brushRadius = () => (brushSize / 100) * Math.max(source.width, source.height) * 0.16 + 4;

  const onPointerDown = (e: React.PointerEvent) => {
    if (!tool || status.kind !== 'ready') return;
    const pt = toImageCoords(e);

    if (tool === 'pick') {
      const i = (Math.floor(pt.y) * source.width + Math.floor(pt.x)) * 4;
      const key: [number, number, number] = [
        source.data[i],
        source.data[i + 1],
        source.data[i + 2],
      ];
      play('toggleOn');
      setSettings((prev) => {
        const next = { ...prev, mode: 'color' as const, keyColor: key };
        recomputeColor(next);
        return next;
      });
      return;
    }

    (e.target as Element).setPointerCapture(e.pointerId);
    play('brush');
    beginStroke();
    const r = brushRadius();
    strokeBrush(paintRef.current, tool, pt, pt, r);
    expandBox(pt.x, pt.y, r);
    lastPointRef.current = pt;
    scheduleDraw();
  };

  const onPointerMove = (e: React.PointerEvent) => {
    // 筆先の輪郭を指の下に出す。どのくらい消えるかが押す前にわかる。
    if (tool === 'erase' || tool === 'keep') {
      const el = cursorRef.current;
      const canvas = canvasRef.current;
      if (el && canvas) {
        const rect = canvas.getBoundingClientRect();
        const scale = rect.width / canvas.width;
        const d = brushRadius() * 2 * scale;
        el.style.width = `${d}px`;
        el.style.height = `${d}px`;
        el.style.transform = `translate(${e.clientX - rect.left - d / 2}px, ${e.clientY - rect.top - d / 2}px)`;
        el.style.opacity = '1';
      }
    }
    if (!lastPointRef.current || !tool || tool === 'pick') return;
    const pt = toImageCoords(e);
    const r = brushRadius();
    strokeBrush(paintRef.current, tool, lastPointRef.current, pt, r);
    expandBox(pt.x, pt.y, r);
    lastPointRef.current = pt;
    scheduleDraw();
  };

  const onPointerUp = () => {
    if (lastPointRef.current) {
      endStroke();
      lastPointRef.current = null;
    }
    if (cursorRef.current) cursorRef.current.style.opacity = '0';
  };

  const resetPaint = () => {
    clearPaintMask(paintRef.current);
    undoRef.current = [];
    setUndoCount(0);
    scheduleDraw();
  };

  const resetAll = () => {
    resetPaint();
    const next = initialSettings(analysis);
    setSettings(next);
    setTool(null);
    setStatus({ kind: 'working', label: 'もとに戻しています', progress: 0.1 });
    void computeBase(analysis.recommended, next);
  };

  /* --------------- 次へ --------------- */

  /** いまの設定・手なおしを反映した、透過ずみの画像を作る。 */
  const buildResult = () => {
    const finished = finishedRef.current;
    if (!finished) return null;
    return trimTransparent(composite(source, finished, paintRef.current, settings));
  };

  const handleDone = () => {
    const out = buildResult();
    if (!out) return;
    play('done');
    onDone(out);
  };

  /*
    「フレームだけほしい」人のための出口。

    自分のアイコンに重ねたいわけではなく、透過PNGだけ取れれば十分、という人は
    そこそこいる。ここに置いておかないと、その人たちは重ねる相手の写真を
    選ばされてから、最後の画面までたどり着かないと保存できない。
  */
  const saveFrameOnly = async () => {
    const out = buildResult();
    if (!out) return;
    try {
      const blob = await canvasToBlob(imageDataToCanvas(out), 'image/png');
      downloadBlob(blob, timestampName('frame_toka', 'png'));
      play('done');
    } catch {
      play('error');
    }
  };

  const working = status.kind === 'working';
  const keyHex = rgbToHex(settings.keyColor);

  return (
    <div className="card">
      <div className="card__head">
        <span className="card__num">2</span>
        <h2 className="card__title">フレームの背景をけす</h2>
      </div>
      <p className="card__hint">
        {working
          ? 'いま自動で背景をけしています。そのままお待ちください。'
          : '白いところが「市松もよう」になっていれば、とうめいになっています。'}
      </p>

      {notice && <div style={{ marginBottom: 12 }}>{notice}</div>}

      <div className="preview" data-backdrop={backdrop}>
        <canvas
          ref={canvasRef}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerLeave={onPointerUp}
          onPointerCancel={onPointerUp}
          style={{
            touchAction: tool && tool !== 'pick' ? 'none' : 'auto',
            cursor: tool === 'pick' ? 'crosshair' : tool ? 'none' : 'default',
          }}
        />
        <div
          ref={cursorRef}
          aria-hidden
          style={{
            position: 'absolute',
            left: 0,
            top: 0,
            borderRadius: '50%',
            border: '1.6px solid var(--accent)',
            background: 'rgba(255,45,85,0.12)',
            pointerEvents: 'none',
            opacity: 0,
            transition: 'opacity .15s',
          }}
        />
        {tool === 'pick' && <span className="preview__badge">けしたい色をタップ</span>}
        {tool === 'erase' && <span className="preview__badge">なぞって消す</span>}
        {tool === 'keep' && <span className="preview__badge">なぞって元にもどす</span>}

        <button
          type="button"
          className="preview__backdrop"
          onClick={() => {
            play('toggleOn');
            setBackdrop(NEXT_BACKDROP[backdrop]);
          }}
          title="下じきの色を変えて、消え具合を確かめます"
        >
          下じき：{BACKDROP_LABEL[backdrop]}
        </button>
      </div>

      <div className="spacer" />

      {/*
        処理中でも下の操作パネルは出したままにする。
        ここを出し入れすると、開いていた「くわしい設定」が閉じてしまい、
        調整の途中で場所を見失う。
      */}
      <div className="stack">
        {working && (
          <>
            <Progress value={status.progress} label={status.label} />
            {settings.mode === 'ai' && (
              <>
                <Note>
                  はじめの1回だけ、AIの読み込みに少し時間がかかります（数十MB）。
                  2回目からはすぐ終わります。
                </Note>
                <Button variant="ghost" onClick={() => changeMode('color')}>
                  待たずに、かんたん処理にする
                </Button>
              </>
            )}
          </>
        )}

        {status.kind === 'error' && <Note tone="warn">{status.message}</Note>}

        <Button variant="primary" onClick={handleDone} disabled={working}>
          <IconCheck size={20} />
          {working ? 'しばらくお待ちください…' : 'これでOK！アイコンに重ねる'}
        </Button>

        <Button variant="ghost" onClick={saveFrameOnly} disabled={working} sound="tap">
          <IconDownload size={18} />
          とうめいなフレームだけ保存する
        </Button>

        <Disclosure title="うまく消えないときは" icon={<IconWand size={19} />}>
          <p className="card__hint" style={{ marginTop: 10 }}>
            上から順に試すと直りやすいです。数字は動かしながらプレビューを見てください。
          </p>

          <div className="field">
            <div className="field__row">
              <span className="field__label">けしかたを変える</span>
            </div>
            <Segmented<CutoutMode>
              ariaLabel="けしかた"
              value={settings.mode}
              onChange={changeMode}
              options={[
                { value: 'color', label: '1色をけす' },
                { value: 'ai', label: 'AIでけす' },
                { value: 'none', label: 'けさない' },
              ]}
            />
            <p className="field__note">
              {settings.mode === 'color'
                ? '白などの一色の背景に強く、線がくっきり残ります。'
                : settings.mode === 'ai'
                  ? '背景がごちゃごちゃした写真や、髪の毛などに強いです。'
                  : 'もともと透過ずみの画像は、これで元のまま使えます。'}
            </p>
          </div>

          {settings.mode === 'color' && (
            <>
              <div className="field">
                <div className="field__row">
                  <span className="field__label">けす色</span>
                  <span className="field__value">{keyHex}</span>
                </div>
                <div className="btn-row">
                  <span
                    aria-hidden
                    style={{
                      width: 46,
                      height: 46,
                      flex: 'none',
                      borderRadius: 12,
                      border: '1.6px solid var(--line)',
                      background: keyHex,
                      boxShadow: 'var(--shadow-sm)',
                    }}
                  />
                  <Button
                    variant="sm"
                    aria-pressed={tool === 'pick'}
                    onClick={() => setTool(tool === 'pick' ? null : 'pick')}
                    style={
                      tool === 'pick'
                        ? { background: 'var(--ink)', color: 'var(--paper)' }
                        : undefined
                    }
                  >
                    画像から色をえらぶ
                  </Button>
                </div>
              </div>

              <Slider
                label="どこまで消すか"
                value={Math.round(settings.tolerance * 100)}
                min={1}
                max={60}
                onChange={(v) => patch({ tolerance: v / 100 })}
                format={(v) => `${v}`}
                note="消え残りがあるときは大きく、消えすぎるときは小さくします。"
              />
              <Slider
                label="光のにじみを残す"
                value={Math.round(settings.softness * 100)}
                min={1}
                max={70}
                onChange={(v) => patch({ softness: v / 100 })}
                format={(v) => `${v}`}
                note="ネオンの光や水彩のぼかしを、うすいまま残す幅です。大きいほどふんわり残ります。"
              />
              <Toggle
                on={!settings.protectEnclosed}
                onChange={(v) => patch({ protectEnclosed: !v })}
                label="デザインの中の白もけす"
              />
              <p className="field__note">
                ふだんはオフのまま。オフだと、提灯の紙や面のような
                <b>囲まれた白は残り</b>、外側の背景とまん中の穴だけが消えます。
                白いフチや紙の質感まで全部消したいときだけオンにしてください。
              </p>
            </>
          )}

          <Slider
            label="フチをけずる"
            value={settings.shrink}
            min={0}
            max={6}
            onChange={(v) => patch({ shrink: v })}
            format={(v) => `${v}px`}
            note="まわりに白いフチが残ったときに上げます。"
          />
          <Slider
            label="フチのギザギザをとる"
            value={Math.round(settings.feather * 10)}
            min={0}
            max={30}
            onChange={(v) => patch({ feather: v / 10 })}
            format={(v) => `${(v / 10).toFixed(1)}`}
          />
          <Slider
            label="フチに残った色をぬく"
            value={Math.round(settings.decontaminate * 100)}
            min={0}
            max={100}
            onChange={(v) => patch({ decontaminate: v / 100 })}
            format={(v) => `${v}`}
            note={
              settings.mode === 'none'
                ? 'すでに透過ずみの画像なので 0 のままでOKです。白フチが焼き付いている画像のときだけ上げてください。'
                : '白い背景から切り抜いたときの、うっすら白いフチを消します。'
            }
          />

          <div className="field">
            <div className="field__row">
              <span className="field__label">指でなぞってなおす</span>
            </div>
            <div className="btn-row">
              <Button
                variant="sm"
                aria-pressed={tool === 'erase'}
                onClick={() => setTool(tool === 'erase' ? null : 'erase')}
                style={
                  tool === 'erase' ? { background: 'var(--ink)', color: 'var(--paper)' } : undefined
                }
              >
                <IconEraser size={18} />
                消しのこりを消す
              </Button>
              <Button
                variant="sm"
                aria-pressed={tool === 'keep'}
                onClick={() => setTool(tool === 'keep' ? null : 'keep')}
                style={
                  tool === 'keep' ? { background: 'var(--ink)', color: 'var(--paper)' } : undefined
                }
              >
                <IconBrush size={18} />
                消えすぎをもどす
              </Button>
              <Button variant="sm" onClick={undo} disabled={undoCount === 0} sound="back">
                <IconUndo size={18} />
                1つ前
              </Button>
            </div>
            <p className="field__note">
              {tool === 'keep'
                ? // なぞった場所は「元の画像そのまま」に戻る。背景の上をなぞれば背景も戻ってしまうので、そこを明示しておく。
                  '消えすぎたフレームの上だけをなぞってください。背景の上をなぞると、背景も戻ってしまいます。'
                : tool === 'erase'
                  ? 'いらないところをなぞると消えます。やりすぎたら「1つ前」で戻せます。'
                  : 'ボタンを押してから、プレビューの上を指でなぞります。'}
            </p>
            {(tool === 'erase' || tool === 'keep') && (
              <Slider
                label="筆の太さ"
                value={brushSize}
                min={4}
                max={100}
                onChange={setBrushSize}
                format={(v) => `${v}`}
              />
            )}
          </div>

          {aiTried && (
            <Toggle
              on={quality === 'high'}
              onChange={(v) => {
                const q: AiQuality = v ? 'high' : 'balanced';
                setQuality(q);
                aiAlphaRef.current = null;
                if (settings.mode === 'ai') {
                  setStatus({
                    kind: 'working',
                    label: 'AIを準備しています',
                    progress: 0.02,
                  });
                  void computeBase('ai', settings, true);
                }
              }}
              label="AIを高画質にする（重くなります）"
            />
          )}

          <div className="spacer" />
          <Button variant="ghost" onClick={resetAll} sound="back">
            <IconRefresh size={18} />
            さいしょからやりなおす
          </Button>
        </Disclosure>

        <Button variant="ghost" onClick={onBack} sound="back">
          <IconArrowLeft size={18} />
          べつのフレームをえらぶ
        </Button>
      </div>
    </div>
  );
}

function initialSettings(a: Analysis): CutoutSettings {
  return {
    ...DEFAULT_SETTINGS,
    mode: a.recommended,
    keyColor: a.borderColor,
    tolerance: a.suggestedTolerance,
    // グローがあるデザインだけ境目を広く取る（詳しくは analyze を参照）
    softness: a.suggestedSoftness,
    /*
      フチ削りは既定で 0。
      ネオンのグローや水彩のにじみは「うすい外周」そのものなので、
      1px でも削ると光の出はじめを食ってしまう。
      白フチが気になる人だけ、スライダーで足せばいい。
    */
    shrink: 0,
    // AI の出す境界はもともとなめらかなので、ぼかしは控えめに
    feather: a.recommended === 'color' ? 0.8 : 0.4,
    decontaminate: decontaminateFor(a.recommended),
  };
}

/**
 * すでに透過ずみの画像には、背景色の引き算をかけない。
 *
 * アルファはもう正しく付いているので、そこからさらに背景色を引くと
 * 半透明のグローの色が沈む（水色が緑に寄って暗くなる）。
 * ただし、他のツールで作られた「白フチが焼き付いた透過PNG」もあるので、
 * スライダーで足せる余地は残しておく。
 */
function decontaminateFor(mode: CutoutMode) {
  return mode === 'none' ? 0 : DEFAULT_SETTINGS.decontaminate;
}

function rgbToHex([r, g, b]: [number, number, number]) {
  return `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

/**
 * 舞台（プレビュー）。
 *
 * ── なぜここが画面でいちばん大きいのか ──
 *
 * このツールで人が確かめたいことは、ひとつしかない。
 * 「ちゃんと消えたか」。数値でも設定でもなく、絵でしか答えられない。
 * だから舞台を最大にして、他のものは全部その下に置いた。
 * 最初に目が行く場所と、確かめたい場所を、同じにしてある。
 *
 * ── 市松模様を canvas に描いていない理由 ──
 *
 * 透明を表す市松は CSS の背景に置いてある。canvas の中に描いてしまうと、
 * 「見えている絵」と「保存される絵」が別物になり、保存してはじめて
 * 市松が入っていないことに気づく（あるいは入ってしまう）。
 * canvas には、保存されるものと1ピクセルも違わないものだけを描く。
 *
 * ── 見くらべ（ワイプ）を真ん中に置いた理由 ──
 *
 * before / after を並べて置くと、どちらも小さくなる。重ねて境目を動かせば、
 * 同じ大きさのまま見くらべられる。つまみは指で掴める大きさにして、
 * 初回だけ「ドラッグ」と出す。触れば分かるものに、説明は要らない。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  MatteCanvas,
  matteAt,
  refineKey,
  renderComposite,
  type Look,
  type MatteTrack,
} from '../../lib/video/matte';
import { play } from '../../lib/sound';
import { IconCompare, IconPause, IconPlay } from '../Icons';
import type { Media, Range } from './types';

/*
  舞台の canvas の横幅の上限。

  画面に映すだけなら 1440 でもよいが、フチの色抜きは1コマごとに
  画素を読み書きするので、面積がそのまま毎コマの費用になる。
  960 なら見た目は変わらず、読み書きは半分以下で済む。
*/
const MAX_CANVAS_EDGE = 960;

export function Stage({
  media,
  track,
  look,
  range,
  playing,
  onPlayingChange,
  onTime,
  seekSignal,
  comparable,
  children,
}: {
  media: Media;
  track: MatteTrack | null;
  look: Look;
  range: Range;
  playing: boolean;
  onPlayingChange: (next: boolean) => void;
  onTime?: (t: number) => void;
  /** 数字が変わったら、その時刻へ飛ぶ */
  seekSignal?: { time: number; id: number } | null;
  /** 見くらべのつまみを出すか（消す前は、くらべる相手がいない） */
  comparable: boolean;
  /** 舞台の上にかぶせるもの（処理中の表示など） */
  children?: React.ReactNode;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const matteCanvasRef = useRef(new MatteCanvas());
  const drawRef = useRef<() => void>(() => {});
  const rangeRef = useRef(range);
  rangeRef.current = range;
  const [wipe, setWipe] = useState(0);
  const [dragging, setDragging] = useState(false);

  const aspect = media.width / Math.max(1, media.height);

  /* ---------------- 1枚描く ---------------- */

  drawRef.current = () => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;

    const cssWidth = wrap.clientWidth || 1;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const width = Math.min(MAX_CANVAS_EDGE, Math.max(320, Math.round(cssWidth * dpr)));
    const height = Math.max(1, Math.round(width / aspect));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    // フチの色抜きで毎コマ画素を読むので、そう宣言しておく（読み出しが速くなる）
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return;

    const image: CanvasImageSource = media.kind === 'video' ? media.video.el : media.bitmap;
    const time = media.kind === 'video' ? media.video.el.currentTime : 0;
    const found = track ? matteAt(track, time) : null;
    const matteCanvas = found
      ? matteCanvasRef.current.update(
          found.matte,
          look.refine,
          `${found.index}|${refineKey(look.refine)}`,
        )
      : null;

    renderComposite(ctx, { image, matteCanvas, look, width, height });

    /* 見くらべ：左側だけ、消す前の絵を上から描く */
    if (wipe > 0.001 && track) {
      const x = Math.round(width * wipe);
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, x, height);
      ctx.clip();
      ctx.drawImage(image, 0, 0, width, height);
      ctx.restore();
    }
  };

  const draw = useCallback(() => drawRef.current(), []);

  /* 素材・つまみ・つまみの位置が変わったら描き直す */
  useEffect(() => {
    draw();
  }, [draw, media, track, look, wipe]);

  /* 幅が変わったら描き直す（回転・折りたたみ・ウィンドウ変更） */
  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => draw());
    ro.observe(wrap);
    return () => ro.disconnect();
  }, [draw]);

  /* ---------------- 再生 ---------------- */

  useEffect(() => {
    if (media.kind !== 'video') return;
    const el = media.video.el;
    if (!playing) {
      el.pause();
      return;
    }
    let stopped = false;
    let raf = 0;
    const anyEl = el as HTMLVideoElement & {
      requestVideoFrameCallback?: (cb: () => void) => number;
    };

    const step = () => {
      if (stopped) return;
      // 選んだ範囲だけを繰り返す。範囲の外は「無いもの」として扱う。
      // 範囲は ref で読む（つまみを動かした直後から、新しい範囲で回るように）
      const r = rangeRef.current;
      if (el.currentTime >= r.end - 0.02 || el.currentTime < r.start - 0.05) {
        el.currentTime = r.start;
      }
      drawRef.current();
      onTime?.(el.currentTime);
      if (anyEl.requestVideoFrameCallback) anyEl.requestVideoFrameCallback(step);
      else raf = requestAnimationFrame(step);
    };

    el.muted = true;
    el.playsInline = true;
    const r0 = rangeRef.current;
    if (el.currentTime < r0.start - 0.05 || el.currentTime > r0.end) el.currentTime = r0.start;
    void el.play().then(
      () => step(),
      () => onPlayingChange(false),
    );
    return () => {
      stopped = true;
      cancelAnimationFrame(raf);
      el.pause();
    };
  }, [playing, media, onPlayingChange, onTime]);

  /* 外から時刻を指定された（フィルムを触った） */
  useEffect(() => {
    if (!seekSignal || media.kind !== 'video') return;
    const el = media.video.el;
    const onSeeked = () => draw();
    el.addEventListener('seeked', onSeeked, { once: true });
    el.currentTime = seekSignal.time;
    return () => el.removeEventListener('seeked', onSeeked);
  }, [seekSignal, media, draw]);

  /*
    消し終わった瞬間に、一度だけ右から左へ拭ってみせる。

    ── なぜ半分ひらいたままにしないのか ──

    はじめは「消す前」を半分残した状態で止めていた。くらべられることは
    伝わるが、**止まった絵は「まだ背景が残っている」ようにも見える。**
    保存に進む直前の画面としては、その誤解のほうが高くつく。

    拭う動きにすると、
      ・何が起きたのか（背景が消えた）が、言葉なしで伝わる
      ・終わったときの絵は、これから保存されるものと同じになる
    の両方が立つ。つまみは残してあるので、くらべたい人はいつでも戻せる。

    動きが苦手な人には拭わない（結果だけを出す）。
  */
  useEffect(() => {
    if (!track || !comparable) return;
    const quiet =
      typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (quiet) {
      setWipe(0);
      return;
    }

    setWipe(1);
    let raf = 0;
    const startAt = performance.now() + 380; // 出来上がりを、一拍おいてから拭う
    const span = 900;
    const step = (now: number) => {
      const t = Math.min(1, Math.max(0, (now - startAt) / span));
      // 端で急に止まらない曲線。拭き取る手の速さに近い
      setWipe(1 - (1 - Math.pow(1 - t, 3)));
      if (t < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [track, comparable]);

  /* ---------------- 見くらべのつまみ ---------------- */

  const moveWipe = (clientX: number) => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const r = wrap.getBoundingClientRect();
    const next = Math.min(1, Math.max(0, (clientX - r.left) / Math.max(1, r.width)));
    setWipe(next);
  };

  return (
    <div
      className="st-stage"
      ref={wrapRef}
      style={{ aspectRatio: `${media.width} / ${media.height}` }}
    >
      <canvas ref={canvasRef} className="st-stage__canvas" />

      {/*
        くらべるための入口。

        拭い終わったあとも、つまみを左端に置いたままにしていた時期がある。
        端にへばりついた丸は「何かが壊れている」ようにしか見えず、
        押せるものだとも伝わらなかった。名前のあるボタンに変えてある。
      */}
      {comparable && track && wipe <= 0.004 && (
        <button
          type="button"
          className="st-compare"
          onClick={() => {
            play('tap');
            setWipe(0.5);
          }}
        >
          <IconCompare size={16} />
          くらべる
        </button>
      )}

      {comparable && track && wipe > 0.004 && (
        <>
          <div
            className="st-wipe"
            style={{ left: `${wipe * 100}%` }}
            data-dragging={dragging}
            role="slider"
            aria-label="消す前と、消したあとを見くらべる"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(wipe * 100)}
            tabIndex={0}
            onPointerDown={(e) => {
              (e.target as HTMLElement).setPointerCapture(e.pointerId);
              setDragging(true);
              play('brush');
            }}
            onPointerMove={(e) => {
              if (!dragging) return;
              moveWipe(e.clientX);
            }}
            onPointerUp={() => setDragging(false)}
            onPointerCancel={() => setDragging(false)}
            onKeyDown={(e) => {
              const d = e.key === 'ArrowLeft' ? -0.05 : e.key === 'ArrowRight' ? 0.05 : 0;
              if (!d) return;
              e.preventDefault();
              setWipe((w) => Math.min(1, Math.max(0, w + d)));
            }}
          >
            <span className="st-wipe__line" />
            <span className="st-wipe__grip">
              <IconCompare size={20} />
            </span>
          </div>
          <span className="st-tag st-tag--before">消す前</span>
          {wipe < 0.98 && <span className="st-tag st-tag--after">消したあと</span>}
        </>
      )}

      {media.kind === 'video' && (
        <button
          type="button"
          className="st-play"
          aria-label={playing ? 'とめる' : '再生する'}
          onClick={() => {
            play('tap');
            onPlayingChange(!playing);
          }}
        >
          {playing ? <IconPause size={20} /> : <IconPlay size={20} />}
        </button>
      )}

      {children}
    </div>
  );
}

/**
 * フィルム。3つの役目を1本にまとめている。
 *
 *   1. どこを使うか決める（両端をつまんで縮める）
 *   2. 進み具合を見せる（消したコマから、順に絵が入っていく）
 *   3. 見たいところへ飛ぶ（触ったところが舞台に出る）
 *
 * ── 進捗バーではなく、フィルムにした理由 ──
 *
 * バーは「あとどれくらいか」しか言えない。フィルムは、それに加えて
 * 「どんな仕上がりか」を、待っているあいだにそのまま見せられる。
 * うまくいっていない（体が欠けている等）ことに 30 秒待ってから
 * 気づくのと、5コマ目で気づくのとでは、やり直しの重さが違う。
 *
 * 絵は切り抜いたあとの姿で、下は市松模様。
 * 「透明とはこういうこと」を、言葉なしに何度も見せることになる。
 */
import { useEffect, useRef } from 'react';
import { play } from '../../lib/sound';
import type { Range } from './types';

export type Thumbs = (ImageBitmap | null)[];

function ThumbCanvas({ bitmap }: { bitmap: ImageBitmap }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    canvas.getContext('2d')?.drawImage(bitmap, 0, 0);
  }, [bitmap]);
  return <canvas ref={ref} className="st-film__img" />;
}

export function FilmStrip({
  durationSec,
  range,
  onRange,
  trimmable,
  thumbs,
  time,
  onSeek,
  minSpanSec = 0.5,
}: {
  durationSec: number;
  range: Range;
  onRange: (next: Range) => void;
  trimmable: boolean;
  thumbs: Thumbs;
  time: number;
  onSeek: (t: number) => void;
  minSpanSec?: number;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<'start' | 'end' | 'seek' | null>(null);

  const pct = (t: number) =>
    `${Math.min(100, Math.max(0, (t / Math.max(0.001, durationSec)) * 100))}%`;

  const timeAt = (clientX: number) => {
    const el = wrapRef.current;
    if (!el) return 0;
    const r = el.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (clientX - r.left) / Math.max(1, r.width)));
    return ratio * durationSec;
  };

  const onMove = (clientX: number) => {
    const t = timeAt(clientX);
    if (dragRef.current === 'start') {
      onRange({ start: Math.min(t, range.end - minSpanSec), end: range.end });
    } else if (dragRef.current === 'end') {
      onRange({ start: range.start, end: Math.max(t, range.start + minSpanSec) });
    } else if (dragRef.current === 'seek') {
      onSeek(Math.min(range.end, Math.max(range.start, t)));
    }
  };

  return (
    <div className="st-film">
      <div
        className="st-film__track"
        ref={wrapRef}
        onPointerDown={(e) => {
          const kind = (e.target as HTMLElement).dataset.handle as 'start' | 'end' | undefined;
          dragRef.current = kind ?? 'seek';
          (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
          if (kind) play('brush');
          onMove(e.clientX);
        }}
        onPointerMove={(e) => {
          if (dragRef.current) onMove(e.clientX);
        }}
        onPointerUp={() => {
          dragRef.current = null;
        }}
        onPointerCancel={() => {
          dragRef.current = null;
        }}
      >
        <div className="st-film__cells">
          {thumbs.map((b, i) => (
            <div className="st-film__cell" key={i}>
              {b ? <ThumbCanvas bitmap={b} /> : <span className="st-film__wait" />}
            </div>
          ))}
        </div>

        {/* 使わないところは暗くする。「ここは出来上がりに入らない」を、色の濃さで言う */}
        {trimmable && (
          <>
            <div className="st-film__mask" style={{ left: 0, width: pct(range.start) }} />
            <div
              className="st-film__mask"
              style={{ left: pct(range.end), right: 0, width: 'auto' }}
            />
            {/*
              つまみは、指でもキーボードでも動かせる。

              指でしか動かせないと、パソコンから使う人・細かく合わせたい人が
              「だいたいの位置」で妥協することになる。矢印で 0.1 秒、
              Shift を足して 1 秒。数字を読まなくても、下の目盛りが動く。
            */}
            <div
              className="st-film__handle"
              data-handle="start"
              style={{ left: pct(range.start) }}
              role="slider"
              tabIndex={0}
              aria-label="ここから使う"
              aria-valuemin={0}
              aria-valuemax={Math.round(durationSec * 10) / 10}
              aria-valuenow={Math.round(range.start * 10) / 10}
              aria-valuetext={`${range.start.toFixed(1)}秒から`}
              onKeyDown={(e) =>
                nudge(e, (d) =>
                  onRange({
                    start: clamp(range.start + d, 0, range.end - minSpanSec),
                    end: range.end,
                  }),
                )
              }
            >
              <span data-handle="start" />
            </div>
            <div
              className="st-film__handle"
              data-handle="end"
              style={{ left: pct(range.end) }}
              role="slider"
              tabIndex={0}
              aria-label="ここまで使う"
              aria-valuemin={0}
              aria-valuemax={Math.round(durationSec * 10) / 10}
              aria-valuenow={Math.round(range.end * 10) / 10}
              aria-valuetext={`${range.end.toFixed(1)}秒まで`}
              onKeyDown={(e) =>
                nudge(e, (d) =>
                  onRange({
                    start: range.start,
                    end: clamp(range.end + d, range.start + minSpanSec, durationSec),
                  }),
                )
              }
            >
              <span data-handle="end" />
            </div>
          </>
        )}

        <div className="st-film__head" style={{ left: pct(time) }} />
      </div>

      <div className="st-film__scale">
        <span>{fmt(range.start)}</span>
        <span className="st-film__span">{fmt(range.end - range.start)} えらんでいます</span>
        <span>{fmt(range.end)}</span>
      </div>
    </div>
  );
}

/** 矢印キーを、時間の増減に変える。Shift でおおまかに */
function nudge(e: React.KeyboardEvent, apply: (delta: number) => void) {
  const dir = e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowRight' ? 1 : 0;
  if (!dir) return;
  e.preventDefault();
  play('tick');
  apply(dir * (e.shiftKey ? 1 : 0.1));
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

function fmt(sec: number) {
  const s = Math.max(0, sec);
  const m = Math.floor(s / 60);
  const rest = s - m * 60;
  return m > 0 ? `${m}:${rest.toFixed(1).padStart(4, '0')}` : `${rest.toFixed(1)}秒`;
}

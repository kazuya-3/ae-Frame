/**
 * ステップ3：アイコン写真にフレームを重ねて、位置を合わせて書き出す画面。
 *
 * 触りかたは1つだけ覚えればいい：指1本で動かす、指2本で拡大・回転。
 * ボタンでも同じことができるので、ジェスチャーを知らない人でも詰まらない。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { canvasToBlob, createCanvas, downloadBlob, get2d, timestampName } from '../lib/image';
import { play } from '../lib/sound';
import { PEER_LOOKS, drawPeerIcon } from '../lib/peerIcon';
import { Button, Note, Segmented, Sheet, Slider, Toggle } from './ui';
import { Sprite } from './Sprite';
import {
  IconArrowLeft,
  IconDownload,
  IconFlip,
  IconMinus,
  IconMove,
  IconPlus,
  IconRefresh,
  IconRotate,
  IconShare,
  IconTouch,
  IconWarn,
  IconX,
} from './Icons';
import { TipAfterSave } from './TipJar';

/** 書き出しサイズ。SNSのアイコンとしては十分で、スマホでも重くならない。 */
const EXPORT_SIZE = 1080;

/*
  アイコンが実際に出るところの大きさ。

  ── なぜこれが要るのか ──

  アイコンフレームは、ほぼ必ず「小さくて丸い」状態で見られる。
  なのにこの画面のプレビューは 350px ある。そこには決定的な抜けがあって、
  **細い線のフレームは、40px になると消える。**
  装飾の多いフレームは、ただの色の塊になる。
  350px を眺めているあいだ、それは一度も分からない。

  だから、出る大きさそのままで並べて見せる。縮小した絵ではなく、実寸。

  ── なぜ他社の画面を真似ないのか ──

  TikTok や LINE の画面を再現すると、相手のデザインが変わった時点で古くなるし、
  他社のUIを模倣することになる。だから丸と大きさと地の色だけの中立な見本にして、
  どこの話かはラベルで示す。こうしておけば、どのSNSにも当てはまる。

  数字は目安。実機と見比べて詰める前提の値。
*/
/** 隣に並べて見るときの大きさ。コメント欄と同じ */
const ROW_SIZE = 40;

const SCENES = [
  { id: 'profile', label: 'プロフィール', size: 96 },
  { id: 'post', label: '投稿', size: 48 },
  { id: 'comment', label: 'コメント欄', size: 40 },
] as const;

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

/**
 * 下じきにする写真そのものの形。
 *
 * フレームの穴より写真を小さくしたとき、四角い写真の角がフレームからはみ出て
 * 「切り忘れ」みたいに見える。まるく抜いておくと、それだけで仕上がりになる。
 */
type Shape = 'fill' | 'circle' | 'rounded' | 'square';

/** 形にそって写真を切り抜く。原点は写真の中心。 */
function clipToShape(ctx: CanvasRenderingContext2D, w: number, h: number, shape: Shape) {
  if (shape === 'fill') return;
  // まる・かどまる・しかくは、短いほうの辺にそろえる。
  // 長いほうに合わせると、写真の外側（何も無いところ）まで形に含まれてしまう。
  const s = Math.min(w, h);
  ctx.beginPath();
  if (shape === 'circle') {
    ctx.arc(0, 0, s / 2, 0, Math.PI * 2);
  } else if (shape === 'rounded' && typeof ctx.roundRect === 'function') {
    ctx.roundRect(-s / 2, -s / 2, s, s, s * 0.18);
  } else {
    ctx.rect(-s / 2, -s / 2, s, s);
  }
  ctx.clip();
}

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
  /*
    すきまの色は、はじめから「白」にしておく。

    とうめいのまま保存すると、SNS 側で黒く塗られることがある。
    そこは選べるようにしてあるが、**選ばなかった人が損をする既定値**にしては
    いけない。困るほうを既定にしない、というだけの話。

    写真が丸を埋めているあいだは、すきまが無いので何も変わらない。
    効いてくるのは、写真を小さくしたときだけ。
  */
  const [gap, setGap] = useState<Gap>('white');
  const [shape, setShape] = useState<Shape>('fill');
  // 一度でも触ったら、操作の案内は引っ込める
  const [touched, setTouched] = useState(false);
  const [tipDismissed, setTipDismissed] = useState(false);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [canShare, setCanShare] = useState(false);

  /*
    小さいときの見えかたを、明るい地と暗い地の両方で見られるようにする。

    暗い地が要るのは、コメント欄が暗いから。
    暗いフレームを暗い地に置くと消える。ステップ2に「下じき」を付けたのと同じ話で、
    透過した絵は、置かれる地の色によって見えかたが変わる。
  */
  const [sceneDark, setSceneDark] = useState(false);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  /** シーンごとの小さなキャンバス。本体と同じ rAF の中でまとめて描く */
  const sceneRefs = useRef<(HTMLCanvasElement | null)[]>([]);
  /** 「隣に並んだとき」の自分のアイコン（コメント欄の大きさ） */
  const rowRef = useRef<HTMLCanvasElement>(null);
  /** 隣に並ぶ見本のアイコン。中身は変わらないので、大きさが変わったときだけ描く */
  const peerRefs = useRef<(HTMLCanvasElement | null)[]>([]);
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

  /*
    「共有できるか」は navigator.share の有無だけでは分からない。
    パソコンの Chrome は share を持っているのに、画像ファイルは渡せない。
    実際に PNG のファイルを1つ作って、それを渡せるかどうかで判断する。
  */
  useEffect(() => {
    if (typeof navigator === 'undefined' || typeof navigator.share !== 'function') return;
    try {
      const probe = new File([new Uint8Array(1)], 'probe.png', { type: 'image/png' });
      setCanShare(Boolean(navigator.canShare?.({ files: [probe] })));
    } catch {
      setCanShare(false);
    }
  }, []);

  /*
    iPhone / iPad かどうか。ここで「保存の道」が正反対になる。

      iPhone : 共有シートに「画像を保存」があり、写真アプリに入れる道はそこだけ。
               ダウンロードすると「ファイル」アプリ行きになる。
      Android: 共有シートは Gmail や Instagram に「送る」ためのもので、
               保存の項目が無い。保存できるのはダウンロードのほう。

    実機（Android）で共有シートを開いてもらったら、
    Gmail / Instagram / 画像をコピー / QRコード しか並んでいなかった。
    つまり Android で共有を主役のボタンにするのは、はっきり間違い。
    だから端末を見て、大きいボタンの中身を入れ替える。
  */
  const [isIOS, setIsIOS] = useState(false);
  useEffect(() => {
    const ua = navigator.userAgent || '';
    // iPadOS 13 以降は Macintosh を名乗るので、指で触れるかどうかで見分ける
    const iPadOS = /Macintosh/.test(ua) && navigator.maxTouchPoints > 1;
    setIsIOS(/iPhone|iPad|iPod/.test(ua) || iPadOS);
  }, []);

  /*
    このページが、ほかのサイトの中に埋めこまれて開かれているか。

    プレビュー用の枠（お試しリンクなど）の中では、ダウンロードも共有も
    止められていることがある。しかも <a download> は例外を投げず、
    ただ何も起きない。検知できるのは「枠の中にいる」という事実だけなので、
    それを見て、はじめから別の道を出す。
  */
  const [embedded, setEmbedded] = useState(false);
  useEffect(() => {
    try {
      setEmbedded(window.self !== window.top);
    } catch {
      // 上の窓を覗けない＝別サイトの枠の中、ということ
      setEmbedded(true);
    }
  }, []);

  /*
    案内は、触れば消える。ただしボタンやスライダーだけで操作する人は
    プレビューに一度も触らないので、いつまでも絵の上に残ってしまう。
    読むには十分な時間だけ出して、あとは自分から引っ込める。
  */
  useEffect(() => {
    if (!active || touched) return;
    const id = setTimeout(() => setTouched(true), 6000);
    return () => clearTimeout(id);
  }, [active, touched]);

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

      const drawLayer = (img: ImageBitmap, base: number, tr: Transform, cut: Shape = 'fill') => {
        const w = img.width * base * tr.scale * k;
        const h = img.height * base * tr.scale * k;
        ctx.save();
        ctx.translate(size / 2 + tr.x * k, size / 2 + tr.y * k);
        ctx.rotate((tr.rotation * Math.PI) / 180);
        if (tr.flipped) ctx.scale(-1, 1);
        // 切り抜きは回転のあとに掛ける。写真をかたむけたら、まるも一緒にかたむく。
        clipToShape(ctx, w, h, cut);
        ctx.drawImage(img, -w / 2, -h / 2, w, h);
        ctx.restore();
      };

      drawLayer(photo, photoBase, photoT, shape);
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
    [photo, frame, photoBase, frameBase, photoT, frameT, round, gap, shape],
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

      /*
        シーンの見本も、同じ1フレームの中で描く。
        別に予約すると、本体と1フレームずれて「さっきの絵」が残る。

        いちばん大きくて 96px なので、3枚足しても描く手間はほとんど増えない。
        目印（overlay）は出さない。小さすぎて、切り取り線が絵を潰してしまう。
      */
      for (const [i, scene] of SCENES.entries()) {
        const c = sceneRefs.current[i];
        if (!c) continue;
        const px = Math.max(1, Math.round(scene.size * dpr));
        if (c.width !== px) {
          c.width = px;
          c.height = px;
        }
        paintRef.current(get2d(c), px, false);
      }

      /*
        「隣に並んだとき」の自分。コメント欄と同じ 40px。

        実際のコメント欄で、アイコンが単独で見られることはない。
        上下に他の人のアイコンが並んでいて、その中で埋もれるかどうかは、
        1つだけ見ていても分からない。
      */
      const row = rowRef.current;
      if (row) {
        const px = Math.max(1, Math.round(ROW_SIZE * dpr));
        if (row.width !== px) {
          row.width = px;
          row.height = px;
        }
        paintRef.current(get2d(row), px, false);
      }

      /*
        隣に並ぶ見本。

        中身が変わらない絵なので、画素の数が変わったときだけ描き直す
        （はじめて出たとき、端末の解像度が変わったとき）。
        毎フレーム描き直しても軽いが、動かないものを動く場所に置かない。
      */
      for (let i = 0; i < PEER_LOOKS.length; i++) {
        const el = peerRefs.current[i];
        if (!el) continue;
        const px = Math.max(1, Math.round(ROW_SIZE * dpr));
        if (el.width === px) continue;
        el.width = px;
        el.height = px;
        drawPeerIcon(get2d(el), px, PEER_LOOKS[i]);
      }
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

  /*
    ここは「保存したのに写真に入ってこない」を直すための作りになっている。

    iPhone でつまずく理由が2つあった。

    1. navigator.share は、指が離れてから少しの間しか呼べない（ユーザー操作の有効期限）。
       ボタンを押してから PNG を作ると 0.2〜1秒かかるので、その間に期限が切れて
       共有シートが開かない。しかも投げられる例外は「利用者が閉じた」ときと
       見分けがつきにくく、黙って何も起きないように見える。
       → 書き出しずみの画像を先に用意しておき、押した瞬間には待ち時間ゼロで呼ぶ。

    2. <a download> は iOS では「写真」ではなく「ファイル」アプリに入る。
       写真アプリに入れるには、共有シートか、画像の長おし→「写真に追加」しかない。
       → どちらも出す。うまくいかなかったときの逃げ道を必ず1つ残す。
  */

  /** 押した瞬間に使えるよう、先に作ってある書き出し結果 */
  const readyRef = useRef<{ blob: Blob; url: string } | null>(null);
  const [ready, setReady] = useState<{ blob: Blob; url: string } | null>(null);
  const [sheet, setSheet] = useState(false);

  const putReady = useCallback((next: { blob: Blob; url: string } | null) => {
    const prev = readyRef.current;
    readyRef.current = next;
    setReady(next);
    if (prev) URL.revokeObjectURL(prev.url);
  }, []);

  // 画面の中身が変わったら、少し落ち着いてから書き出しておく。
  // 指を動かしている最中に毎回 PNG を作ると重いので、止まってからにする。
  useEffect(() => {
    if (!active) return;
    let alive = true;
    const id = setTimeout(async () => {
      try {
        const blob = await buildBlob();
        if (!alive) return;
        putReady({ blob, url: URL.createObjectURL(blob) });
      } catch {
        /* 用意できなくても、押したときに作り直すので黙っておく */
      }
    }, 500);
    return () => {
      alive = false;
      clearTimeout(id);
    };
  }, [buildBlob, active, putReady]);

  useEffect(() => () => putReady(null), [putReady]);

  const makeFile = (blob: Blob) =>
    new File([blob], timestampName('icon', 'png'), { type: 'image/png' });

  /** 共有シートを開く。待ち時間ゼロで呼べるときだけ成功する。 */
  const shareNow = (blob: Blob) => {
    const file = makeFile(blob);
    if (!navigator.canShare?.({ files: [file] })) return false;
    navigator
      .share({ files: [file] })
      .then(() => {
        play('done');
        /*
          共有できた＝保存できた、とは限らない。
          iPhone の共有シートには「画像を保存」があるので保存の道になるが、
          Android の共有シートは Gmail や Instagram に送るだけで、保存の項目が無い。
          Android で「保存しました」と出すのは嘘になるので、そこは黙っておく。
        */
        if (isIOS) setSaved(true);
      })
      .catch((e: unknown) => {
        // 利用者が閉じただけなら、何も言わない。
        // それ以外（期限切れなど）は行き止まりなので、逃げ道を出す。
        if ((e as { name?: string })?.name !== 'AbortError') setSheet(true);
      });
    return true;
  };

  /** いちばん大きいボタン。ここが「携帯に入れる」入り口。 */
  const saveToPhone = async () => {
    const warm = readyRef.current;
    if (warm && canShare && shareNow(warm.blob)) return;

    // 用意が間に合っていない、または共有できない端末。作ってから逃げ道を出す。
    setBusy(true);
    try {
      const blob = warm?.blob ?? (await buildBlob());
      if (!warm) putReady({ blob, url: URL.createObjectURL(blob) });
      play('done');
      setSheet(true);
    } catch {
      play('error');
    } finally {
      setBusy(false);
    }
  };

  /** 逃げ道の画面を開く。共有は試さず、長おしで保存できる形をそのまま見せる。 */
  const openSheet = async () => {
    play('tap');
    if (readyRef.current) {
      setSheet(true);
      return;
    }
    setBusy(true);
    try {
      const blob = await buildBlob();
      putReady({ blob, url: URL.createObjectURL(blob) });
      setSheet(true);
    } catch {
      play('error');
    } finally {
      setBusy(false);
    }
  };

  /** ファイルとして落とす。パソコンと Android はこれで保存できる。 */
  const downloadNow = async () => {
    setBusy(true);
    try {
      const blob = readyRef.current?.blob ?? (await buildBlob());

      /*
        埋めこみの枠の中では、ダウンロードそのものが止められる。
        <a download> は例外を投げずに、ただ何も起きない。
        「保存できました」と出したうえで1枚も落ちてこないのが、いちばん悪い。
        ここでは嘘をつかず、その場で保存できる形（長おしできる画像）を出す。
      */
      if (embedded) {
        if (!readyRef.current) putReady({ blob, url: URL.createObjectURL(blob) });
        play('done');
        setSheet(true);
        return;
      }

      downloadBlob(blob, timestampName('icon', 'png'));
      play('done');
      setSaved(true);
    } catch {
      play('error');
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

      {/*
        小さいときの見えかた。

        置き場所は、大きいプレビューのすぐ下。ここが見比べる場所だから。
        保存ボタンのそばに置くと、調整が全部終わったあとになってしまい、
        「直そう」と思っても戻る道が長い。
      */}
      <div className="scenes" data-dark={sceneDark}>
        <div className="scenes__head">
          <span className="scenes__title">小さいときの見えかた</span>
          <button
            type="button"
            className="scenes__swap"
            onClick={() => {
              play('tap');
              setSceneDark((d) => !d);
            }}
          >
            地の色：{sceneDark ? 'くらい' : 'あかるい'}
          </button>
        </div>
        <div className="scenes__row">
          {SCENES.map((scene, i) => (
            <div className="scenes__item" key={scene.id}>
              <canvas
                className="scenes__canvas"
                ref={(el) => {
                  sceneRefs.current[i] = el;
                }}
                style={{ width: scene.size, height: scene.size }}
                aria-hidden="true"
              />
              <span className="scenes__label">{scene.label}</span>
            </div>
          ))}
        </div>

        {/*
          隣に並んだとき。
          実際のコメント欄では、アイコンは1つだけでは見られていない。
          上下に他の人のアイコンが並ぶ。その中で自分のフレームが埋もれないか、
          あるいは浮きすぎないかは、単独で眺めても分からない。

          隣は、ふつうの（フレームの無い）アイコンに見立てた見本。
          はじめ無地の丸を置いていたが、それでは比べものにならなかった。
          実際のコメント欄で隣に並ぶのは無地ではなく、何かが描いてあって
          色がついている。相手が無地だと、自分のアイコンは必ず勝ってしまう。

          他社の画面は再現しない。丸と大きさと、隣に何かが居ることだけ。
        */}
        <div className="scenes__strip" aria-hidden="true">
          <canvas
            className="scenes__peer"
            ref={(el) => {
              peerRefs.current[0] = el;
            }}
            style={{ width: ROW_SIZE, height: ROW_SIZE }}
          />
          <canvas
            className="scenes__me"
            ref={rowRef}
            style={{ width: ROW_SIZE, height: ROW_SIZE }}
          />
          <canvas
            className="scenes__peer"
            ref={(el) => {
              peerRefs.current[1] = el;
            }}
            style={{ width: ROW_SIZE, height: ROW_SIZE }}
          />
          {/* いちばん端は薄くして、まだ続きがあることだけ示す */}
          <canvas
            className="scenes__peer scenes__peer--last"
            ref={(el) => {
              peerRefs.current[2] = el;
            }}
            style={{ width: ROW_SIZE, height: ROW_SIZE }}
          />
        </div>
        <p className="scenes__strip-label">コメント欄で、他の人と並んだとき</p>
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
          defaultValue={100}
          min={15}
          max={400}
          onChange={(v) => setT((t0) => ({ ...t0, scale: v / 100 }))}
          format={(v) => `${v}%`}
        />
        <Slider
          label="かたむき"
          value={Math.round(t.rotation)}
          defaultValue={0}
          min={-180}
          max={180}
          onChange={(v) => setT((t0) => ({ ...t0, rotation: v }))}
          format={(v) => `${v}°`}
        />

        <div className="field">
          <div className="field__row">
            <span className="field__label">写真のかたち</span>
          </div>
          <Segmented<Shape>
            ariaLabel="写真のかたち"
            value={shape}
            onChange={(v) => {
              play('tap');
              setShape(v);
            }}
            options={[
              { value: 'fill', label: 'そのまま' },
              { value: 'circle', label: 'まる' },
              { value: 'rounded', label: 'かどまる' },
              { value: 'square', label: 'しかく' },
            ]}
          />
          <p className="field__note">
            下じきにする写真そのものを切りぬきます。写真を小さくしてフレームの内側に
            おさめるとき、四角い角がはみ出さなくなります。
          </p>
        </div>

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

        {/*
          いちばん大きいボタンは、その端末で「ほんとうに保存できる道」にする。
          iPhone は共有シート、それ以外はダウンロード。
          共有は、保存できない端末では「送る」ための道具として下に置く。
        */}
        {isIOS && canShare ? (
          <>
            <Button variant="primary" onClick={saveToPhone} disabled={busy}>
              <IconShare size={20} />
              {busy ? '書き出しています…' : '写真アプリにほぞんする'}
            </Button>
            <Button variant="ghost" onClick={downloadNow} disabled={busy}>
              <IconDownload size={18} />
              ファイルとしてダウンロード
            </Button>
          </>
        ) : (
          <>
            <Button variant="primary" onClick={downloadNow} disabled={busy}>
              <IconDownload size={20} />
              {busy ? '書き出しています…' : '画像をほぞんする'}
            </Button>
            {canShare && (
              <Button variant="ghost" onClick={saveToPhone} disabled={busy}>
                <IconShare size={18} />
                ほかのアプリに送る（保存ではありません）
              </Button>
            )}
          </>
        )}

        {/* うまくいかなかったときの逃げ道。押しても保存できない人を、ここで拾う。 */}
        <button type="button" className="link-quiet" onClick={openSheet} disabled={busy}>
          携帯に入ってこないときは
        </button>

        {/*
          「保存できました」と言い切らない。
          こちらから分かるのは「保存をはじめた」ところまでで、
          本当に端末に入ったかどうかは見えない。
          見あたらなかった人が次にどこを押せばいいかを、必ず添える。
        */}
        {saved && (
          <div className="pop">
            <Note tone="ok">
              {isIOS
                ? '保存しました。写真アプリから、この画像をえらんでください。'
                : '保存しました。写真アプリ（ギャラリー）の「ダウンロード」に入っています。'}
              <br />
              見あたらないときは、上の「携帯に入ってこないときは」から保存できます。
            </Note>
            {/*
              ここがこの道具のゴール。3ステップぶん付き合ってもらった相手に、
              最後にひとこと返す場所が無かった。
              案内の中ではなく外に置く。緑の枠の中に絵を入れると、
              「見あたらないときは」の一文が読みにくくなる。
            */}
            <p className="sprite-line sprite-line--center">
              <Sprite name="saved" size={80} />
              <span>できました！おつかれさまでした。</span>
            </p>
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

      {/*
        「保存したのに携帯に入ってこない」を最後に受けとめる画面。
        iPhone では、画像の長おし →「写真に追加」が唯一たしかな道なので、
        できあがった画像そのものを大きく置いて、そこを長おししてもらう。
      */}
      {sheet && ready && (
        <Sheet
          onClose={() => {
            play('back');
            setSheet(false);
          }}
        >
          <div className="card__head" style={{ marginBottom: 10 }}>
            <h2 className="card__title" style={{ flex: 1 }}>
              携帯にほぞんする
            </h2>
            <Button
              variant="icon"
              aria-label="とじる"
              onClick={() => {
                play('back');
                setSheet(false);
              }}
            >
              <IconX size={20} />
            </Button>
          </div>

          {/*
            埋めこみの枠の中にいると分かっているときは、まずそれを言う。
            「自分の操作が悪かったのかな」と思わせないため。
          */}
          {embedded && (
            <div className="saver__warn">
              <IconWarn size={18} />
              <span>
                いま、このページは<b>ほかのサイトの中で開かれています</b>。
                その場合、ダウンロードが止められて1枚も保存できません。
                下の画像を長おしして保存するか、
                <b>ツールのURLを直接ひらいて</b>ためしてください。
              </span>
            </div>
          )}

          <p className="saver__lede">
            <IconTouch size={20} />
            <span>
              <b>この画像を長おしすると保存できます。</b>
              {isIOS
                ? '出てきたメニューから「写真に追加」または「“写真”に保存」をえらんでください。'
                : '出てきたメニューから「画像をダウンロード」をえらんでください。'}
            </span>
          </p>

          {/* 長おしできる本物の <img>。canvas では長おしのメニューが出ない。 */}
          <img className="saver__image" src={ready.url} alt="できあがったアイコン画像" />

          {/* ここも、その端末で保存になるほうを上に置く */}
          <div className="saver__actions">
            {isIOS && canShare ? (
              <>
                <Button
                  variant="primary"
                  onClick={() => {
                    // 押した瞬間に画像が手元にあるので、共有シートは必ず開く
                    if (!shareNow(ready.blob)) play('error');
                  }}
                >
                  <IconShare size={20} />
                  共有からほぞんする
                </Button>
                <Button variant="ghost" onClick={downloadNow} disabled={busy}>
                  <IconDownload size={18} />
                  ファイルとしてダウンロード
                </Button>
              </>
            ) : (
              <>
                <Button variant="primary" onClick={downloadNow} disabled={busy}>
                  <IconDownload size={20} />
                  ファイルとしてダウンロード
                </Button>
                {canShare && (
                  <Button
                    variant="ghost"
                    onClick={() => {
                      if (!shareNow(ready.blob)) play('error');
                    }}
                  >
                    <IconShare size={18} />
                    ほかのアプリに送る（保存ではありません）
                  </Button>
                )}
              </>
            )}
          </div>

          <p className="saver__fine">
            {embedded
              ? '「ダウンロード」は、この枠の中では効かないことがあります。効かなかったときは、上の画像を長おししてください。'
              : isIOS
                ? 'iPhone は「ダウンロード」だと、写真アプリではなく「ファイル」アプリに入ります。写真アプリに入れたいときは、長おしか共有からどうぞ。'
                : 'Android の共有シートには保存の項目がありません。保存したいときは「ダウンロード」か、上の画像の長おしを使ってください。'}
          </p>
        </Sheet>
      )}
    </div>
  );
}

function clamp(v: number, min: number, max: number) {
  return Math.min(max, Math.max(min, v));
}

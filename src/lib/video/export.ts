/**
 * 書き出し。
 *
 * ── 透過のまま動画にできるのは、いまのところ WebM だけ ──
 *
 * MP4（H.264）は透明を持てない。持てるのは WebM（VP8/VP9）と、
 * Apple の HEVC with alpha だけで、ブラウザから作れるのは前者。
 * しかも WebCodecs の VideoEncoder は alpha:'keep' を受け付けない
 * （2026年8月時点、どの実装も未対応）。
 *
 * 唯一とおるのが MediaRecorder で、canvas の透明はそのまま VP8/VP9 に入る。
 * そのかわり「実時間で録る」ことになる。10秒の素材なら10秒かかる。
 * 速さより、透過が保たれることを取った。
 *
 * ── だから出口を4つ用意している ──
 *
 *   透過WebM   … OBS / TikTok LIVE Studio に直接置ける。透明のまま
 *   グリーン   … CapCut など「透過を読めない」アプリ用。緑を後で抜く
 *   PNG連番    … 画質はいちばん良い。編集アプリに読ませる
 *   背景つき   … そのまま投稿する
 *
 * どれが要るかは、その人が次にどのアプリを開くかで決まる。
 * だから画面では形式名ではなく「どこで使うか」で選ばせている。
 */
import { canvasToBlob, createCanvas, get2d } from '../image';
import {
  MatteCanvas,
  matteAt,
  refineKey,
  renderComposite,
  type Look,
  type MatteTrack,
} from './matte';
import { readFrames, seekTo, type OpenedVideo } from './source';
import { ZipBuilder } from './zip';

export type ExportProgress = {
  value: number;
  label: string;
  /** 画面を離れたので、いったん止めている最中か */
  paused?: boolean;
};

export type ExportBase = {
  video: OpenedVideo;
  track: MatteTrack;
  look: Look;
  width: number;
  height: number;
  signal: { aborted: boolean };
  onProgress?: (p: ExportProgress) => void;
};

export type ExportedFile = { blob: Blob; ext: string; mime: string };

/* ---------------- どの形式で録れるか ---------------- */

/** 透過を保てる録りかた。VP8 を先に置くのは、受け取る側（OBS・ffmpeg）で確実に開けるため */
const ALPHA_TYPES = ['video/webm;codecs=vp8', 'video/webm;codecs=vp9', 'video/webm'];

/** 透過が要らないときは、渡した先で扱いやすい MP4 を優先する */
const OPAQUE_TYPES = [
  'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
  'video/mp4;codecs=avc1.42E01E',
  'video/mp4',
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp9',
  'video/webm;codecs=vp8,opus',
  'video/webm',
];

/**
 * その形式で本当に録れるかを、実際に録音機を組み立てて確かめる。
 *
 * isTypeSupported だけでは足りない。手元の Chromium は
 * `video/mp4` に「対応している」と答えるのに、中身の符号器（H.264）を
 * 持っていない。信じて進むと、書き出しの直前で例外になる。
 *
 * 組み立てるだけなら費用はほとんど無い（2×2 の canvas を1枚使うだけ）。
 * 結果は覚えておき、聞かれるたびに作り直さない。
 */
const probed = new Map<string, boolean>();

function canUse(type: string): boolean {
  if (typeof MediaRecorder === 'undefined') return false;
  const known = probed.get(type);
  if (known !== undefined) return known;
  let ok = MediaRecorder.isTypeSupported(type);
  if (ok) {
    try {
      const canvas = createCanvas(2, 2);
      const stream = canvas.captureStream(1);
      const rec = new MediaRecorder(stream, { mimeType: type });
      rec.stop();
      for (const t of stream.getTracks()) t.stop();
    } catch {
      ok = false;
    }
  }
  probed.set(type, ok);
  return ok;
}

function pickType(list: string[]): string | null {
  for (const t of list) if (canUse(t)) return t;
  return null;
}

export function canRecordAlpha() {
  return pickType(ALPHA_TYPES) != null;
}
export function canRecordVideo() {
  return pickType(OPAQUE_TYPES) != null;
}
/** 透明でない動画の入れ物（mp4 か webm か）。画面に出す言葉を変えるのに使う */
export function opaqueContainer(): 'mp4' | 'webm' | null {
  const t = pickType(OPAQUE_TYPES);
  return t ? (t.startsWith('video/mp4') ? 'mp4' : 'webm') : null;
}

/* ---------------- 実時間で録る ---------------- */

/** MediaElementSource は要素につき1つしか作れないので、作ったものを覚えておく */
const audioTaps = new WeakMap<
  HTMLVideoElement,
  { ctx: AudioContext; dest: MediaStreamAudioDestinationNode }
>();

/**
 * 音を、スピーカーには出さずに録音側だけへ流す。
 *
 * 書き出しのあいだ動画は実際に再生される。そのまま鳴らすと
 * 「保存を押したら急に音が出た」ことになるので、音の行き先を
 * 録音先だけにつなぐ（スピーカーへはつながない）。
 */
/** 止めているあいだに眠った音の回路を、起こし直す */
function wakeAudio(el: HTMLVideoElement) {
  const found = audioTaps.get(el);
  if (found && found.ctx.state === 'suspended') void found.ctx.resume();
}

function tapAudio(el: HTMLVideoElement): MediaStreamAudioDestinationNode | null {
  try {
    const found = audioTaps.get(el);
    if (found) {
      void found.ctx.resume();
      return found.dest;
    }
    const Ctor = window.AudioContext ?? (window as any).webkitAudioContext;
    if (!Ctor) return null;
    const ctx: AudioContext = new Ctor();
    const source = ctx.createMediaElementSource(el);
    const dest = ctx.createMediaStreamDestination();
    source.connect(dest);
    audioTaps.set(el, { ctx, dest });
    void ctx.resume();
    return dest;
  } catch {
    // 音は「あればうれしい」もの。取れなくても映像は出す
    return null;
  }
}

type RecordOptions = ExportBase & { alpha: boolean; withAudio: boolean };

async function record(opts: RecordOptions): Promise<ExportedFile> {
  const mime = pickType(opts.alpha ? ALPHA_TYPES : OPAQUE_TYPES);
  if (!mime) throw new Error('このブラウザでは動画を書き出せません');

  const { video, track, look, width, height } = opts;
  const canvas = createCanvas(width, height);
  // フチの色抜きは1コマごとに画素を読む。そう宣言しておくと読み出しが速い
  const ctx = get2d(canvas, { willReadFrequently: true });
  const mc = new MatteCanvas();
  const rkey = refineKey(look.refine);

  /*
    こちらから「いま1コマ出来た」と渡せる（requestFrame）なら、そうする。
    描いたコマと録られるコマが1対1になり、取りこぼしも重複も起きない。
    渡せないブラウザでは、canvas を一定間隔で覗いてもらう形に切り替える
    （0 のままだと、覗きにも来ないし渡すこともできず、1コマも録れない）。
  */
  let stream = canvas.captureStream(0);
  let [videoTrack] = stream.getVideoTracks() as (CanvasCaptureMediaStreamTrack &
    MediaStreamTrack)[];
  const canPush = typeof videoTrack?.requestFrame === 'function';
  if (!canPush) {
    for (const t of stream.getTracks()) t.stop();
    stream = canvas.captureStream(Math.min(60, Math.max(1, Math.round(track.fps))));
    [videoTrack] = stream.getVideoTracks() as (CanvasCaptureMediaStreamTrack & MediaStreamTrack)[];
  }

  /* 音を混ぜる */
  const el = video.el;
  const wasMuted = el.muted;
  let audioDest: MediaStreamAudioDestinationNode | null = null;
  if (opts.withAudio && video.hasAudio) {
    audioDest = tapAudio(el);
    if (audioDest) {
      el.muted = false;
      for (const t of audioDest.stream.getAudioTracks()) stream.addTrack(t);
    }
  }

  const bitsPerPixel = 0.12; // 見た目が崩れない下限あたり
  const recorder = new MediaRecorder(stream, {
    mimeType: mime,
    videoBitsPerSecond: Math.min(
      24_000_000,
      Math.max(2_500_000, Math.round(width * height * track.fps * bitsPerPixel)),
    ),
  });
  // 音のトラックを足したことで受けつけられなくなる組み合わせもあるので、
  // 実際に出来た録音機が名乗る形式を、そのまま拡張子の判断に使う
  const actual = recorder.mimeType || mime;
  const chunks: Blob[] = [];
  recorder.ondataavailable = (e) => {
    if (e.data.size) chunks.push(e.data);
  };
  const stopped = new Promise<void>((resolve) => (recorder.onstop = () => resolve()));

  const start = track.startSec;
  const end = track.endSec;
  const span = Math.max(0.001, end - start);

  await seekTo(el, start);
  recorder.start(250);

  /*
    再生しながら、出てきたコマをそのつど組み立てて canvas に置く。
    requestVideoFrameCallback は「新しいコマが画面に出た」ときだけ呼ばれるので、
    タイマーで回すのと違って、同じコマを二重に録ることも、飛ばすこともない。
  */
  /*
    ── 途中で画面を離れられたときのこと ──

    書き出しは実時間で進む。10秒の素材なら10秒、そのあいだ画面はこのまま。
    けれど人は待つ。待つあいだに、別のタブを見にいく。通知に応える。
    画面が消える。**それはふつうの行動であって、失敗ではない。**

    ところがブラウザは、見えていない画面のコマ送りを止める。
    requestVideoFrameCallback も requestAnimationFrame も呼ばれなくなる。
    いっぽう <video> は再生を続け、録音機も時間を刻み続ける。
    その結果できあがるのは、**途中から止め絵になった動画**だった。
    しかも本人は最後まで録れたと思っている。気づくのは配信の最中になる。

    だから、見えなくなったら本当に止める。

      ・<video> を止める（時間が進まない）
      ・録音機も止める（pause は時間の刻みごと止まる。継ぎ目は残らない）
      ・戻ってきたら、両方を起こして、コマ送りを繋ぎ直す

    待ち時間はそのぶん延びるが、延びたことは画面に出る。
    黙って壊れたものを渡すより、ずっといい。
  */
  await new Promise<void>((resolve, reject) => {
    const anyEl = el as HTMLVideoElement & {
      requestVideoFrameCallback?: (cb: (now: number, meta: unknown) => void) => number;
    };
    let raf = 0;
    let held = false;
    /** コマ送りの予約の世代。止めて再開するたびに進める */
    let gen = 0;
    /** 止めているあいだだけ動く見張り */
    let watch = 0;

    const drawOne = () => {
      const t = el.currentTime;
      const found = matteAt(track, t);
      const matteCanvas = found
        ? mc.update(found.matte, look.refine, `${found.index}|${rkey}`)
        : null;
      renderComposite(ctx, { image: el, matteCanvas, look, width, height });
      if (canPush) videoTrack.requestFrame();
      opts.onProgress?.({
        value: Math.min(1, (t - start) / span),
        label: '書き出しています',
      });
    };

    const tick = () => {
      if (opts.signal.aborted) return finish();
      // 止めているあいだは描かない。再開はこちらからではなく、戻ってきた側から
      if (held) return;
      drawOne();
      if (el.currentTime >= end - 0.001 || el.ended) return finish();
      schedule();
    };

    /*
      次のコマを待つ。

      requestVideoFrameCallback は「新しいコマが出た」ときだけ呼ばれるので、
      これで回すのがいちばん正確（同じコマを二重に録らない）。
      ただし、何かの理由でコマが出てこなくなると**そのまま返ってこない**。
      保険として、しばらく音沙汰が無ければこちらから進める。
      正常なときは 40ミリ秒ほどで呼ばれるので、この保険は働かない。
    */
    /*
      止めて再開したとき、**古い予約が生き返る**ことがある。
      止める前に入れた requestVideoFrameCallback は取り消せないので、
      戻ってきた瞬間に「古い予約」と「新しい予約」の2本が走り、
      1コマを2回描いて2回渡すことになる。

      世代番号を持たせて、古い予約は自分で気づいて降りるようにしてある。
    */
    const schedule = () => {
      const mine = gen;
      if (!anyEl.requestVideoFrameCallback) {
        raf = requestAnimationFrame(() => {
          if (mine === gen) tick();
        });
        return;
      }
      let moved = false;
      const once = () => {
        if (moved || mine !== gen) return;
        moved = true;
        clearTimeout(guard);
        tick();
      };
      const guard = setTimeout(once, 300);
      anyEl.requestVideoFrameCallback(once);
    };

    const finish = () => {
      cancelAnimationFrame(raf);
      clearInterval(watch);
      document.removeEventListener('visibilitychange', onVisibility);
      el.pause();
      resolve();
    };

    /** 再生を始めて、コマ送りを繋ぐ。隠れているあいだは始めない */
    const begin = () => {
      if (held || opts.signal.aborted) return;
      el.play().then(
        () => schedule(),
        (e) => {
          // 音つきで再生できないときは、音を諦めて録りなおす
          el.muted = true;
          el.play().then(
            () => schedule(),
            () => reject(e),
          );
        },
      );
    };

    const hold = () => {
      held = true;
      el.pause();
      if (recorder.state === 'recording') recorder.pause();
      opts.onProgress?.({
        value: Math.min(1, (el.currentTime - start) / span),
        label: '止めています',
        paused: true,
      });
      /*
        止めているあいだは、コマ送りが1回も回らない。
        「やめる」を押されたことに気づく場所も、そこには無い。
        止めているあいだだけ、別に見張りを立てる（戻ってきたら畳む）。
      */
      clearInterval(watch);
      watch = setInterval(() => {
        if (opts.signal.aborted) finish();
      }, 500) as unknown as number;
    };

    const onVisibility = () => {
      if (document.hidden === held) return;
      if (document.hidden) hold();
      else {
        held = false;
        clearInterval(watch);
        gen++;
        if (recorder.state === 'paused') recorder.resume();
        wakeAudio(el);
        begin(); // コマ送りは止まったままなので、こちらから繋ぎ直す
      }
    };
    document.addEventListener('visibilitychange', onVisibility);

    /*
      すでに隠れている状態で始まることがある。

      押した直後に別のタブへ移る（＝押したことを覚えていて、待つあいだに移動する）と、
      下ごしらえのあいだに隠れてしまい、こちらは「変わった」を受け取れない。
      変化だけを見ていると、**はじめから隠れている場合に素通りする。**
      検証でも、まさにここが素通りした。始める前に、いまの状態を一度見る。
    */
    if (document.hidden) hold();
    begin();
  });

  // 最後のコマが取りこぼされないよう、少しだけ録り続けてから止める
  await new Promise((r) => setTimeout(r, 260));
  if (recorder.state !== 'inactive') recorder.stop();
  await stopped;
  el.muted = wasMuted;
  for (const t of stream.getTracks()) if (t.kind === 'video') t.stop();

  const blob = new Blob(chunks, { type: actual });
  if (!blob.size) throw new Error('動画を書き出せませんでした');
  return { blob, ext: actual.startsWith('video/mp4') ? 'mp4' : 'webm', mime: actual };
}

/** 透過のまま録る（配信ソフト向け） */
export function exportTransparent(opts: ExportBase & { withAudio: boolean }) {
  return record({ ...opts, alpha: true });
}

/** 背景を敷いて録る（グリーンバック・差し替え） */
export function exportWithBackdrop(opts: ExportBase & { withAudio: boolean }) {
  return record({ ...opts, alpha: false });
}

/* ---------------- PNG 連番 ---------------- */

/**
 * 1コマずつ PNG にして ZIP にまとめる。
 * 実時間の縛りが無いぶん、いちばん速く・いちばんきれいに出せる。
 */
export async function exportPngSequence(
  opts: ExportBase & { name: string },
): Promise<ExportedFile> {
  const { video, track, look, width, height } = opts;
  const canvas = createCanvas(width, height);
  const ctx = get2d(canvas, { willReadFrequently: true });
  const mc = new MatteCanvas();
  const rkey = refineKey(look.refine);
  const zip = new ZipBuilder();

  const total = track.frames.length;
  let i = 0;

  for await (const frame of readFrames(video, {
    startSec: track.startSec,
    endSec: track.endSec,
    fps: track.fps,
    signal: opts.signal,
  })) {
    if (opts.signal.aborted) break;
    const found = matteAt(track, frame.timeSec);
    const matteCanvas = found
      ? mc.update(found.matte, look.refine, `${found.index}|${rkey}`)
      : null;
    renderComposite(ctx, { image: frame.image, matteCanvas, look, width, height });
    await zip.add(`${opts.name}/${String(i + 1).padStart(4, '0')}.png`, await canvasToBlob(canvas));
    i++;
    opts.onProgress?.({ value: Math.min(1, i / total), label: `${i} / ${total} コマ` });
  }

  /*
    連番だけ渡されても、読み込むときの「1秒何コマか」が分からないと
    速さが変わってしまう。数字を書いた紙を一緒に入れておく。
  */
  await zip.add(
    `${opts.name}/このフォルダについて.txt`,
    new Blob(
      [
        `透過PNG連番\r\n\r\n`,
        `コマ数: ${i}\r\n`,
        `1秒あたり: ${track.fps} コマ\r\n`,
        `大きさ: ${width} × ${height}\r\n\r\n`,
        `編集アプリで読み込むときは、1秒あたりのコマ数を ${track.fps} に合わせてください。\r\n`,
        `合わせないと、動きの速さが変わります。\r\n`,
      ],
      { type: 'text/plain;charset=utf-8' },
    ),
  );

  return { blob: zip.finish(), ext: 'zip', mime: 'application/zip' };
}

/** PNG 連番の大きさを、1コマ測って見当をつける */
export async function estimateSequenceSize(opts: {
  video: OpenedVideo;
  track: MatteTrack;
  look: Look;
  width: number;
  height: number;
}): Promise<number> {
  const canvas = createCanvas(opts.width, opts.height);
  const ctx = get2d(canvas, { willReadFrequently: true });
  const mc = new MatteCanvas();
  const mid = Math.floor(opts.track.frames.length / 2);
  await seekTo(opts.video.el, opts.track.times[mid] ?? opts.track.startSec);
  const matte = opts.track.frames[mid];
  const matteCanvas = matte
    ? mc.update(matte, opts.look.refine, `est|${refineKey(opts.look.refine)}`)
    : null;
  renderComposite(ctx, {
    image: opts.video.el,
    matteCanvas,
    look: opts.look,
    width: opts.width,
    height: opts.height,
  });
  const blob = await canvasToBlob(canvas);
  return blob.size * opts.track.frames.length;
}

/* ---------------- 静止画 ---------------- */

export async function exportStill(opts: {
  image: CanvasImageSource;
  track: MatteTrack;
  look: Look;
  width: number;
  height: number;
}): Promise<ExportedFile> {
  const canvas = createCanvas(opts.width, opts.height);
  const ctx = get2d(canvas, { willReadFrequently: true });
  const mc = new MatteCanvas();
  const matte = opts.track.frames[0];
  const matteCanvas = matte
    ? mc.update(matte, opts.look.refine, `still|${refineKey(opts.look.refine)}`)
    : null;
  renderComposite(ctx, {
    image: opts.image,
    matteCanvas,
    look: opts.look,
    width: opts.width,
    height: opts.height,
  });
  return { blob: await canvasToBlob(canvas), ext: 'png', mime: 'image/png' };
}

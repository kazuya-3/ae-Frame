/**
 * 動画から、コマを順に取り出す。
 *
 * 取り出しかたは2通りあり、使えるほうを黙って選ぶ。
 *
 *   1. WebCodecs（速い・正確）
 *      MP4 を自分でほどいて（mp4.ts）、VideoDecoder に直接わたす。
 *      seek をしないので、コマの取りこぼしも重複も起きない。
 *
 *   2. <video> を進めながら描き写す（どこでも動く）
 *      WebM や、ほどけなかった MP4、WebCodecs の無いブラウザ用。
 *
 * どちらを使ったかは engine に入る。画面には出さない
 * （使う人にとっては、速いか遅いかの違いしかないため）。
 *
 * 取り出したコマは「その場で描き写す」約束にしている。
 * VideoDecoder のコマは持っているだけで端末の映像メモリを食い、
 * <video> のほうは次に進めた瞬間に中身が変わるので、
 * どちらにしても溜め込めない。呼ぶ側は受け取ったらすぐ描く。
 */
import { parseMp4, type Mp4Track } from './mp4';

export type OpenedVideo = {
  el: HTMLVideoElement;
  url: string;
  width: number;
  height: number;
  durationSec: number;
  /** 実測できたときは実測値。できないときは推定 */
  fps: number;
  /** 実測できたか（画面で「◯コマ」と言い切ってよいか） */
  fpsExact: boolean;
  hasAudio: boolean;
  engine: 'webcodecs' | 'video';
  track: Mp4Track | null;
  buffer: ArrayBuffer | null;
  close(): void;
};

export type SourceFrame = {
  timeSec: number;
  /** canvas に drawImage できるもの。次のコマへ進むと無効になる */
  image: CanvasImageSource;
  width: number;
  height: number;
};

/** WebCodecs が使えるか（安全なつなぎ方の中でだけ動く API なので、その場で見る） */
function hasWebCodecs() {
  return typeof VideoDecoder !== 'undefined' && typeof EncodedVideoChunk !== 'undefined';
}

export async function openVideo(file: File): Promise<OpenedVideo> {
  const url = URL.createObjectURL(file);
  const el = document.createElement('video');
  el.src = url;
  el.muted = true;
  el.playsInline = true;
  el.preload = 'auto';
  // 端末によっては、これが無いと canvas に描いた時点で汚染扱いになる
  el.crossOrigin = 'anonymous';

  /*
    画面には出さないが、DOM には入れる。

    コマを1枚ずつ確実に受け取るために requestVideoFrameCallback を使っている。
    これは「新しいコマが画面に出た」ときに呼ばれるもので、**どこにも
    置かれていない <video> では呼ばれないことがある。**
    そうなると、プレビューは1コマ目で止まり、書き出しは終わりを待ったまま
    永久に返らない。しかも例外は出ないので、原因が分からない止まりかたになる。

    display:none も同じ理由で使えない（描かれないものにコマは出ない）。
    2px の大きさで画面の外に置き、指も当たらないようにしてある。
  */
  el.setAttribute('aria-hidden', 'true');
  el.style.cssText =
    'position:fixed;left:-9999px;top:0;width:2px;height:2px;opacity:0.01;pointer-events:none;';
  document.body.appendChild(el);

  await new Promise<void>((resolve, reject) => {
    const ok = () => resolve();
    el.addEventListener('loadedmetadata', ok, { once: true });
    el.addEventListener('error', () => reject(new Error('この動画は開けませんでした')), {
      once: true,
    });
    setTimeout(() => reject(new Error('動画の読み込みに時間がかかりすぎました')), 30_000);
  });
  // 1コマ目を確実に描ける状態にしておく（表紙の絵に使う）
  await waitReadable(el);

  const durationSec = await ensureDuration(el);
  const width = el.videoWidth;
  const height = el.videoHeight;
  if (!width || !height) {
    URL.revokeObjectURL(url);
    throw new Error('この動画からは映像を取り出せませんでした');
  }

  /* ── ほどけるなら、ほどいておく ── */
  let track: Mp4Track | null = null;
  let buffer: ArrayBuffer | null = null;
  if (hasWebCodecs()) {
    try {
      const ab = await file.arrayBuffer();
      const t = parseMp4(ab);
      if (t && t.samples.length > 1) {
        // デコーダが本当にその形を受けられるかは、聞いてみないと分からない
        const support = await VideoDecoder.isConfigSupported({
          codec: t.codec,
          description: t.description,
          codedWidth: width,
          codedHeight: height,
        });
        if (support.supported) {
          track = t;
          buffer = ab;
        }
      }
    } catch {
      /* ほどけないものは、そのまま <video> にまかせる */
    }
  }

  /*
    1秒あたりのコマ数。

    MP4 をほどけたときは数えるだけで分かる。ほどけないとき（WebM など）は、
    ほんの一瞬だけ再生して実測する。実測できないときだけ 30 を置く。

    ここを外すと、そのぶん無駄が出る。24コマの素材を 30 で処理すると、
    同じ絵を1.25回ずつ見ることになり、待ち時間が 25% 増える。
    数字も「120コマ」と出てしまい、素材の実際（96コマ）と食い違う。
  */
  const measured = track ? null : await measureFps(el);
  const fps = track
    ? track.samples.length / Math.max(0.001, track.durationSec)
    : (measured ?? guessFps(durationSec));

  return {
    el,
    url,
    width,
    height,
    durationSec,
    fps: Math.min(60, Math.max(1, Math.round(fps * 100) / 100)),
    fpsExact: !!track || measured != null,
    hasAudio: hasAudioTrack(el),
    engine: track ? 'webcodecs' : 'video',
    track,
    buffer,
    close() {
      try {
        el.pause();
      } catch {
        /* 既に外れている */
      }
      el.removeAttribute('src');
      el.load();
      el.remove();
      URL.revokeObjectURL(url);
    },
  };
}

/**
 * 長さを確かめる。
 *
 * ── なぜ el.duration をそのまま信じられないのか ──
 *
 * 画面録画ソフトやブラウザが作った WebM は、**長さが書かれていない**ことがある。
 * 録りながら書き出す形式なので、書き終わるまで長さが決まらず、
 * そのまま閉じられると欄が空のまま残る。読み込むと duration は Infinity になる。
 *
 * このとき、こちらは「0秒の動画」を受け取ったように見え、
 * 1コマも処理せずに終わってしまう。OBS で録ったものを持ってきた人には
 * 「対応していない動画」に見える。実際には、ただ長さが書かれていないだけ。
 *
 * 直しかたは決まっていて、いったん「あり得ないほど先」へ飛ばすこと。
 * そこまで読みにいったブラウザが本当の終わりを知り、長さを教え直してくれる。
 */
async function ensureDuration(el: HTMLVideoElement): Promise<number> {
  const good = () => Number.isFinite(el.duration) && el.duration > 0;
  if (good()) return el.duration;

  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      el.removeEventListener('durationchange', onChange);
      resolve();
    };
    const onChange = () => {
      if (good()) finish();
    };
    el.addEventListener('durationchange', onChange);
    try {
      el.currentTime = 1e101;
    } catch {
      finish();
    }
    setTimeout(finish, 4_000);
  });
  await seekTo(el, 0);
  return good() ? el.duration : 0;
}

/**
 * 音のトラックがあるか。
 *
 * webkitAudioDecodedByteCount は「これまでに何バイト鳴らしたか」なので、
 * 読み込んだ直後はいつも 0 になる。それを「音が無い」と読むと、
 * 音のある動画から音を落として書き出してしまう。実際に一度そうなりかけた。
 *
 * いちばん当てになるのは、その要素から実際に取り出せるトラックを数えること。
 * 取り出せないブラウザでは「ある」と答えておく（消してしまうより安全）。
 */
function hasAudioTrack(el: HTMLVideoElement): boolean {
  const any = el as unknown as {
    mozHasAudio?: boolean;
    captureStream?: () => MediaStream;
    mozCaptureStream?: () => MediaStream;
    audioTracks?: { length: number };
  };
  if (typeof any.mozHasAudio === 'boolean') return any.mozHasAudio;
  if (any.audioTracks) return any.audioTracks.length > 0;
  const capture = any.captureStream ?? any.mozCaptureStream;
  if (typeof capture === 'function') {
    try {
      const stream = capture.call(el);
      const has = stream.getAudioTracks().length > 0;
      for (const t of stream.getTracks()) t.stop();
      return has;
    } catch {
      /* 取り出せない端末では、下の答えにする */
    }
  }
  return true;
}

/**
 * 一瞬だけ再生して、1秒あたりのコマ数を数える。
 *
 * requestVideoFrameCallback は「そのコマが素材の何秒の絵か（mediaTime）」と
 * 「これまでに何コマ出したか（presentedFrames）」を一緒に渡してくる。
 * 2点のあいだで割れば、そのまま実測値になる。
 *
 * 音は消したまま、画面の外に置いた要素で回すので、目にも耳にも触れない。
 * 取れないブラウザ（この API が無い、再生が始められない）では null を返す。
 */
async function measureFps(el: HTMLVideoElement): Promise<number | null> {
  type Meta = { mediaTime: number; presentedFrames: number };
  const anyEl = el as HTMLVideoElement & {
    requestVideoFrameCallback?: (cb: (now: number, meta: Meta) => void) => number;
  };
  if (!anyEl.requestVideoFrameCallback) return null;

  const wasMuted = el.muted;
  el.muted = true;
  try {
    await el.play();
  } catch {
    return null;
  }

  const raw = await new Promise<number | null>((resolve) => {
    let first: Meta | null = null;
    let settled = false;
    const finish = (v: number | null) => {
      if (settled) return;
      settled = true;
      el.pause();
      resolve(v);
    };
    const tick = (_now: number, meta: Meta) => {
      if (settled) return;
      if (!first) first = meta;
      else {
        const dt = meta.mediaTime - first.mediaTime;
        const df = meta.presentedFrames - first.presentedFrames;
        if (dt > 0.2 && df > 2) return finish(df / dt);
      }
      anyEl.requestVideoFrameCallback!(tick);
    };
    anyEl.requestVideoFrameCallback!(tick);
    // 出てこないときに待ち続けない（読み込み直後の1回きりの計測なので）
    setTimeout(() => finish(null), 1500);
  });

  el.muted = wasMuted;
  await seekTo(el, 0);
  if (raw == null || !Number.isFinite(raw) || raw < 1 || raw > 200) return null;

  /*
    実測はわずかにぶれる（24.03 のように出る）。
    よく使われる刻みに近ければ、そちらに寄せる。表示にも書き出しにも
    そのまま出る数字なので、半端な小数のままにしない。
  */
  const common = [8, 10, 12, 15, 20, 23.976, 24, 25, 29.97, 30, 50, 59.94, 60];
  const near = common.find((c) => Math.abs(c - raw) / c < 0.06);
  return near ?? Math.round(raw);
}

function guessFps(_durationSec: number) {
  // ほどけなかったときは、配信・撮影でいちばん多い 30 を置く。
  // 実際の書き出しは <video> の再生に合わせるので、ここがずれても絵は崩れない。
  return 30;
}

function waitReadable(el: HTMLVideoElement) {
  if (el.readyState >= 2) return Promise.resolve();
  return new Promise<void>((resolve) => {
    el.addEventListener('loadeddata', () => resolve(), { once: true });
    setTimeout(resolve, 5_000);
  });
}

export type ReadOptions = {
  startSec: number;
  endSec: number;
  /** 1秒あたり何コマ取り出すか */
  fps: number;
  signal?: { aborted: boolean };
};

/** コマを時刻の順に取り出す。 */
export async function* readFrames(
  video: OpenedVideo,
  opts: ReadOptions,
): AsyncGenerator<SourceFrame> {
  if (video.track && video.buffer) {
    try {
      yield* readWithWebCodecs(video, opts);
      return;
    } catch (e) {
      // 途中で落ちたときは、頭から <video> でやり直す。
      // 中断（利用者が止めた）だけは、やり直さずにそのまま終わる。
      if (opts.signal?.aborted) return;
      console.warn('WebCodecs での取り出しに失敗しました。<video> に切り替えます', e);
    }
  }
  yield* readWithElement(video, opts);
}

/* ---------------- 1. WebCodecs ---------------- */

async function* readWithWebCodecs(
  video: OpenedVideo,
  opts: ReadOptions,
): AsyncGenerator<SourceFrame> {
  const track = video.track!;
  const buffer = video.buffer!;
  const bytes = new Uint8Array(buffer);

  const startUs = opts.startSec * 1e6;
  const endUs = opts.endSec * 1e6;
  const stepUs = 1e6 / Math.max(1, opts.fps);

  /* 表示順ではなく復号順に送るので、開始位置は「直前のキーフレーム」まで戻す */
  const ordered = track.samples;
  let from = 0;
  for (let i = 0; i < ordered.length; i++) {
    if (ordered[i].timestampUs <= startUs && ordered[i].key) from = i;
  }

  const queue: VideoFrame[] = [];
  let done = false;
  let failure: Error | null = null;
  let wake: (() => void) | null = null;
  const ping = () => {
    wake?.();
    wake = null;
  };

  const decoder = new VideoDecoder({
    output: (frame) => {
      queue.push(frame);
      ping();
    },
    error: (e) => {
      failure = e instanceof Error ? e : new Error(String(e));
      ping();
    },
  });
  decoder.configure({
    codec: track.codec,
    description: track.description,
    codedWidth: video.width,
    codedHeight: video.height,
    // 貯めこまず、送った順に早く出してもらう
    optimizeForLatency: true,
  });

  /* 送り込む側。受け取り側が詰まったら待つ（映像メモリを溢れさせない） */
  const pump = (async () => {
    for (let i = from; i < ordered.length; i++) {
      if (opts.signal?.aborted) break;
      const s = ordered[i];
      if (s.timestampUs > endUs + stepUs) break;
      while (queue.length > 4 || decoder.decodeQueueSize > 8) {
        if (opts.signal?.aborted || failure) break;
        await new Promise<void>((r) => {
          wake = r;
          setTimeout(r, 50);
        });
      }
      if (failure) break;
      decoder.decode(
        new EncodedVideoChunk({
          type: s.key ? 'key' : 'delta',
          timestamp: s.timestampUs,
          duration: s.durationUs,
          data: bytes.subarray(s.offset, s.offset + s.size),
        }),
      );
    }
    try {
      if (!opts.signal?.aborted) await decoder.flush();
    } catch {
      /* 中断したときの flush は失敗してよい */
    }
    done = true;
    ping();
  })();

  let nextWantUs = startUs;
  try {
    for (;;) {
      if (failure) throw failure;
      const frame = queue.shift();
      if (!frame) {
        if (done) break;
        await new Promise<void>((r) => {
          wake = r;
          setTimeout(r, 30);
        });
        continue;
      }
      const ts = frame.timestamp ?? 0;
      // 欲しい時刻に届いていないコマ、範囲外のコマは捨てる
      if (ts + 1 < nextWantUs || ts > endUs + stepUs * 0.5 || opts.signal?.aborted) {
        frame.close();
        if (ts > endUs) break;
        continue;
      }
      nextWantUs = ts + stepUs * 0.9;
      try {
        yield {
          timeSec: ts / 1e6,
          image: frame,
          width: frame.displayWidth,
          height: frame.displayHeight,
        };
      } finally {
        frame.close();
      }
    }
  } finally {
    for (const f of queue) f.close();
    queue.length = 0;
    try {
      if (decoder.state !== 'closed') decoder.close();
    } catch {
      /* もう閉じている */
    }
    await pump.catch(() => {});
  }
}

/* ---------------- 2. <video> を進める ---------------- */

async function* readWithElement(
  video: OpenedVideo,
  opts: ReadOptions,
): AsyncGenerator<SourceFrame> {
  const el = video.el;
  el.pause();
  const step = 1 / Math.max(1, opts.fps);
  const end = Math.min(opts.endSec, video.durationSec - step * 0.25);

  for (let t = opts.startSec; t <= end + 1e-6; t += step) {
    if (opts.signal?.aborted) return;
    await seekTo(el, t);
    yield { timeSec: el.currentTime, image: el, width: video.width, height: video.height };
  }
}

/** そこまで進めて、絵が入れ替わるのを待つ */
export function seekTo(el: HTMLVideoElement, timeSec: number): Promise<void> {
  return new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      el.removeEventListener('seeked', finish);
      resolve();
    };
    el.addEventListener('seeked', finish, { once: true });
    try {
      el.currentTime = Math.max(0, timeSec);
    } catch {
      finish();
    }
    // 端末によっては seeked が来ないことがある。待ち続けるより、進めたほうがよい
    setTimeout(finish, 2_000);
  });
}

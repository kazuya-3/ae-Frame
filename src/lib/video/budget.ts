/**
 * 「いちどにどれだけ引き受けるか」を決める計算。
 *
 * ── なぜ上限が要るのか ──
 *
 * この画面は、コマごとのマット（濃さ1枚）をぜんぶメモリに持つ。
 * 10秒なら 35MB で収まるが、上限を置かないとこうなる。
 *
 *   3分の動画をそのまま渡される → 5400コマ → 1.2GB → 端末が落ちる
 *
 * 落ちかたが悪い。数分待たせたあとに、何も残さずタブごと消える。
 * 「重い処理でしたね」ではなく「このツールは壊れている」と受け取られる。
 *
 * だから、受けられる長さを先に計算して、**渡される前に**縮めておく。
 * 断るのではなく、こちらで安全な範囲に収めて、その理由を一言そえる。
 *
 * ── DOM を触らない理由 ──
 *
 * ここは算数しかしていない。分けておくと Node からそのまま呼べるので、
 * ブラウザを起こさずに検証できる（tests/mp4.mjs と同じ考えかた）。
 */

/** マットを持つ解像度の上限。長辺をここまで縮めて持つ */
export const MATTE_MAX_EDGE = 640;

/**
 * マットに使ってよいメモリの総量。
 *
 * 160MB は「安い Android でも、他のタブと一緒に生きていられる」あたり。
 * 1280×720 の素材なら 640×360 のマットで 1コマ 230KB、およそ 690 コマ。
 * 30コマ/秒なら 23秒、半分の 15コマ/秒なら 46秒ぶんになる。
 */
export const MATTE_BUDGET_BYTES = 160 * 1024 * 1024;

/** 長辺を上限に収めた大きさ（lib/image の fitWithin と同じ考えかた） */
export function matteSize(width: number, height: number, maxEdge = MATTE_MAX_EDGE) {
  const longest = Math.max(width, height);
  if (longest <= maxEdge || longest === 0) return { width, height };
  const scale = maxEdge / longest;
  return { width: Math.round(width * scale), height: Math.round(height * scale) };
}

/** 1コマぶんのマットが占めるバイト数 */
export function matteBytesPerFrame(width: number, height: number) {
  const fit = matteSize(width, height);
  return Math.max(1, fit.width * fit.height);
}

/** その大きさの素材を、いくつのコマまで持てるか */
export function maxFrames(width: number, height: number) {
  return Math.max(1, Math.floor(MATTE_BUDGET_BYTES / matteBytesPerFrame(width, height)));
}

/**
 * いちどに消せる長さ（秒）。
 *
 * 0.1 秒の刻みで切り捨てる。「23.13秒まで」と出しても意味が無く、
 * 切り上げると上限を1コマ超える組み合わせが出るため。
 */
export function maxSpanSec(width: number, height: number, fps: number) {
  const frames = maxFrames(width, height);
  const seconds = frames / Math.max(1, fps);
  return Math.max(1, Math.floor(seconds * 10) / 10);
}

/**
 * 選ばれた範囲を、受けられる長さに収める。
 *
 * 動かしたほうの端を残す。終わりを引っぱって伸ばしすぎたなら終わりを戻し、
 * 始まりを引っぱったなら始まりを戻す。**いま指で触っているほうが動く**と、
 * 手ごたえと画面が食い違わない。
 */
export function clampRange(
  range: { start: number; end: number },
  limitSec: number,
  moved: 'start' | 'end' = 'end',
) {
  const start = Math.max(0, range.start);
  const end = Math.max(start, range.end);
  if (end - start <= limitSec) return { start, end };
  return moved === 'start' ? { start: end - limitSec, end } : { start, end: start + limitSec };
}

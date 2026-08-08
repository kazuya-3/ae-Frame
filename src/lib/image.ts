/** 画像の読み込み・変換まわりの小さなヘルパー群。 */

export type Size = { width: number; height: number };

/** 端末の負荷を抑えつつ、書き出し品質を保てる作業解像度の上限。 */
export const WORK_MAX_EDGE = 1600;

export async function fileToBitmap(file: File | Blob): Promise<ImageBitmap> {
  if ('createImageBitmap' in window) {
    try {
      // iOS の HEIC など、デコードできない形式はここで例外になる
      return await createImageBitmap(file);
    } catch {
      /* <img> 経由にフォールバック */
    }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.decoding = 'async';
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error('画像を読み込めませんでした'));
      img.src = url;
    });
    return await createImageBitmap(img);
  } finally {
    URL.revokeObjectURL(url);
  }
}

export function fitWithin(size: Size, maxEdge: number): Size {
  const scale = Math.min(1, maxEdge / Math.max(size.width, size.height));
  return {
    width: Math.max(1, Math.round(size.width * scale)),
    height: Math.max(1, Math.round(size.height * scale)),
  };
}

export function createCanvas(width: number, height: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = width;
  c.height = height;
  return c;
}

export function get2d(canvas: HTMLCanvasElement, opts?: CanvasRenderingContext2DSettings) {
  const ctx = canvas.getContext('2d', opts);
  if (!ctx) throw new Error('canvas を初期化できませんでした');
  return ctx;
}

/** ImageBitmap を作業解像度の ImageData にする。 */
export function bitmapToImageData(bmp: ImageBitmap, maxEdge = WORK_MAX_EDGE): ImageData {
  const { width, height } = fitWithin({ width: bmp.width, height: bmp.height }, maxEdge);
  const canvas = createCanvas(width, height);
  const ctx = get2d(canvas, { willReadFrequently: true });
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bmp, 0, 0, width, height);
  return ctx.getImageData(0, 0, width, height);
}

export function imageDataToCanvas(data: ImageData): HTMLCanvasElement {
  const canvas = createCanvas(data.width, data.height);
  get2d(canvas).putImageData(data, 0, 0);
  return canvas;
}

export function cloneImageData(data: ImageData): ImageData {
  return new ImageData(new Uint8ClampedArray(data.data), data.width, data.height);
}

export function canvasToBlob(
  canvas: HTMLCanvasElement,
  type = 'image/png',
  quality?: number,
): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('画像を書き出せませんでした'))),
      type,
      quality,
    );
  });
}

/**
 * 透明部分を実際に使っている範囲まで詰める。
 * フレーム画像は余白が大きいことが多く、そのままだと重ねたときに小さく見える。
 */
export function trimTransparent(data: ImageData, alphaThreshold = 8): ImageData {
  const { width, height, data: px } = data;
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (px[(y * width + x) * 4 + 3] > alphaThreshold) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return data; // 全部透明なら何もしない

  const w = maxX - minX + 1;
  const h = maxY - minY + 1;
  if (w === width && h === height) return data;

  const out = new ImageData(w, h);
  for (let y = 0; y < h; y++) {
    const src = ((y + minY) * width + minX) * 4;
    out.data.set(px.subarray(src, src + w * 4), y * w * 4);
  }
  return out;
}

export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Safari が読み終える前に破棄すると失敗するので少し待つ
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export function timestampName(prefix: string, ext: string) {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${prefix}_${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(
    d.getMinutes(),
  )}${p(d.getSeconds())}.${ext}`;
}

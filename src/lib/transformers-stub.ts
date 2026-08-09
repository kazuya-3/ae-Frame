/**
 * お試し版（DEMO=1）でだけ使う、AI ランタイムの差し替え。
 *
 * HTML1枚に埋め込む版は、外部への通信ができない場所に置かれる前提なので、
 * どのみちモデルを取りに行けない。20MB 以上を埋め込むより、
 * ここで素直に失敗させて色キーに落としたほうが速いし正直。
 *
 * 呼び出し側（lib/ai.ts）は失敗を握って色キーへ戻すので、
 * ここでは投げるだけでよい。
 */

const notAvailable = () => {
  throw new Error('DEMO_NO_AI');
};

export const env: {
  allowLocalModels: boolean;
  backends: { onnx?: { wasm?: { numThreads: number } } };
} = {
  allowLocalModels: false,
  backends: {},
};

export const AutoModel = { from_pretrained: async () => notAvailable() };
export const AutoProcessor = { from_pretrained: async () => notAvailable() };

export class RawImage {
  constructor() {
    notAvailable();
  }
}

export type Tensor = { dims: number[]; data: ArrayLike<number> };

import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { viteSingleFile } from 'vite-plugin-singlefile';

/*
  DEMO=1 でビルドすると、HTML1枚に全部を埋め込んだ「お試し版」を作る。
  ファイルを1つ配るだけで動くので、その場で触ってもらえる。

  ただし外部への通信ができない場所に置かれる前提なので、AI 切り抜きは動かない。
  そのときは色キーに落ちる（もともと通信が切れた端末で通る道と同じ）。
*/
const demo = process.env.DEMO === '1';

/*
  お礼（チップ）の入口は、ビルドのときに丸ごと入るか入らないかが決まる。

  ── なぜ条件分岐ではだめか ──

  前に一度しくじっている。募集の文言を `if` の向こうに置いて「画面に出ない」
  で止めた。描画はされないが、**文字列は配られる JS にそのまま残っていた**。
  審査を受けている当のアカウントで、引っかかった当の文言が公開物から
  読み出せる状態だった（docs/stripe-compliance.md）。

  条件分岐は、束ねる側の気分しだいで残る。残ったかどうかは目で見ても分からない。
  だから**モジュールの解決そのものを差し替える**。VITE_TIP_URL が空なら、
  TipPage.tsx はモジュールの地図に一度も現れない。入りようがない。

  この仕掛けが効いていることは tools/check-dist.mjs が実物を読んで確かめる。
*/
const tipOn = !!process.env.VITE_TIP_URL;

const tipEntry = {
  name: 'ae-frame:tip-entry',
  resolveId(id: string) {
    if (id === 'virtual:tip') return '\0virtual:tip';
    return null;
  },
  load(id: string) {
    if (id !== '\0virtual:tip') return null;
    return tipOn
      ? `export { TipPage, TipLink } from '/src/components/Tip.tsx';`
      : `export const TipPage = () => null;\nexport const TipLink = () => null;`;
  },
};

// 既定を相対パスにしておくと、GitHub Pages のサブディレクトリ
// （https://ユーザー名.github.io/ae-Frame/）でも、独自ドメインの直下でも、
// 同じビルド成果物がそのまま動く。必要なら BASE_PATH で上書きできる。
const base = process.env.BASE_PATH ?? './';

export default defineConfig({
  base: demo ? './' : base,
  plugins: [react(), tipEntry, ...(demo ? [viteSingleFile()] : [])],
  define: demo ? { 'import.meta.env.VITE_DEMO': '"1"' } : {},
  resolve: demo
    ? {
        // お試し版では AI ランタイムを丸ごと差し替える。
        // 通信できない場所では動かせないうえ、20MB 以上を埋め込むことになるため。
        alias: { '@huggingface/transformers': '/src/lib/transformers-stub.ts' },
      }
    : {},
  /*
    ここには manualChunks があった。
    「@huggingface/transformers と onnxruntime を 'ai' という塊にまとめて、
    必要になるまで読み込ませない」という意図で書いたもの。

    実際には逆のことが起きていた。

    まとめ先の 'ai' に、Vite が動的 import のために使う小さな補助関数
    （200バイトほど）まで一緒に入ってしまい、その補助関数は入口の側から
    ふつうに import される。結果、入口が 875KB の塊を静的に参照する形になり、
    index.html に modulepreload まで付いて、**どのページを開いても**
    AI の実行環境が丸ごと落ちてきていた。

    切り抜きの画面に一度も行かない応援ページやお礼ページでも、
    855KB を先に払っていたことになる。飾りの画像を全部足しても 690KB なので、
    ここが最大の1件だった。

      つくる    1.11MB → 0.28MB
      応援      1.67MB → 0.83MB
      お礼      1.54MB → 0.71MB

    外したことで、動的 import はそのまま素直に別の塊になる
    （lib/ai.ts と transformers.web が別々に出る）。
    まとめる指示を書かないほうが、意図したとおりに分かれる。

    ※ AI の切り抜きを実際に走らせたときだけ落ちてくることは、
      tests/run.mjs の「AIへの切り替え」で見ている。
  */
  build: {
    target: 'es2022',
  },
  optimizeDeps: {
    exclude: ['@huggingface/transformers'],
  },
});

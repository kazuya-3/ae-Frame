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

// 既定を相対パスにしておくと、GitHub Pages のサブディレクトリ
// （https://ユーザー名.github.io/ae-Frame/）でも、独自ドメインの直下でも、
// 同じビルド成果物がそのまま動く。必要なら BASE_PATH で上書きできる。
const base = process.env.BASE_PATH ?? './';

export default defineConfig({
  base: demo ? './' : base,
  plugins: [react(), ...(demo ? [viteSingleFile()] : [])],
  define: demo ? { 'import.meta.env.VITE_DEMO': '"1"' } : {},
  resolve: demo
    ? {
        // お試し版では AI ランタイムを丸ごと差し替える。
        // 通信できない場所では動かせないうえ、20MB 以上を埋め込むことになるため。
        alias: { '@huggingface/transformers': '/src/lib/transformers-stub.ts' },
      }
    : {},
  build: {
    target: 'es2022',
    rollupOptions: demo
      ? {}
      : {
          output: {
            manualChunks(id) {
              // AIモデル用ランタイムは重いので、必要になるまで読み込ませない
              if (id.includes('@huggingface/transformers')) return 'ai';
              if (id.includes('onnxruntime')) return 'ai';
            },
          },
        },
  },
  optimizeDeps: {
    exclude: ['@huggingface/transformers'],
  },
});

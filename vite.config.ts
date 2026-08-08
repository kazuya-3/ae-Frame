import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// 既定を相対パスにしておくと、GitHub Pages のサブディレクトリ
// （https://ユーザー名.github.io/ae-Frame/）でも、独自ドメインの直下でも、
// 同じビルド成果物がそのまま動く。必要なら BASE_PATH で上書きできる。
const base = process.env.BASE_PATH ?? './';

export default defineConfig({
  base,
  plugins: [react()],
  build: {
    target: 'es2022',
    rollupOptions: {
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

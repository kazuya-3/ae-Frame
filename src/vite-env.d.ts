/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** お試し版のビルドか */
  readonly VITE_DEMO?: string;
  /** お礼の送り先。空なら、お礼の入口はビルドごと入らない（vite.config.ts） */
  readonly VITE_TIP_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

/*
  お礼まわり。VITE_TIP_URL が空のビルドでは、中身が何もない部品に差し替わる。
  実体は src/components/Tip.tsx（vite.config.ts の ae-frame:tip-entry）。
  ページも入口も、まとめてこの1本で出し入れする。
*/
declare module 'virtual:tip' {
  export const TipPage: () => JSX.Element | null;
  export const TipLink: () => JSX.Element | null;
}

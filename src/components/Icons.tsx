/**
 * 線画アイコン。すべて塗りなし・線だけで統一している。
 * サイズと線幅は本文の文字とそろえてあるので、文章の中に混ぜても浮かない。
 */
import type { SVGProps } from 'react';

type Props = SVGProps<SVGSVGElement> & { size?: number };

function Svg({ size = 22, children, ...rest }: Props) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      {children}
    </svg>
  );
}

export const IconPhoto = (p: Props) => (
  <Svg {...p}>
    <rect x="3" y="4.5" width="18" height="15" rx="3" />
    <circle cx="8.5" cy="10" r="1.6" />
    <path d="M3.5 17l4.6-4.3a2 2 0 0 1 2.7 0l3.2 3M13 15.4l2.2-2a2 2 0 0 1 2.7.1l2.4 2.3" />
  </Svg>
);

export const IconFrame = (p: Props) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="9" />
    <circle cx="12" cy="12" r="5.6" strokeDasharray="1.6 2.6" />
    <path d="M12 3v2.4M12 18.6V21M3 12h2.4M18.6 12H21" />
  </Svg>
);

export const IconWand = (p: Props) => (
  <Svg {...p}>
    <path d="M4.5 19.5L14 10M16.8 7.2l2-2" />
    <path d="M12.2 11.8l-1.6-1.6" />
    <path d="M17.5 3.2l.7 1.9 1.9.7-1.9.7-.7 1.9-.7-1.9-1.9-.7 1.9-.7z" />
    <path d="M6.6 5l.5 1.3 1.3.5-1.3.5-.5 1.3-.5-1.3L4.8 6.8l1.3-.5z" />
    <path d="M19.6 13.4l.4 1 1 .4-1 .4-.4 1-.4-1-1-.4 1-.4z" />
  </Svg>
);

export const IconSoundOn = (p: Props) => (
  <Svg {...p}>
    <path d="M4 9.5h3l4.5-3.6v12.2L7 14.5H4z" />
    <path d="M15.5 9.2a4 4 0 0 1 0 5.6M18.2 6.6a7.7 7.7 0 0 1 0 10.8" />
  </Svg>
);

export const IconSoundOff = (p: Props) => (
  <Svg {...p}>
    <path d="M4 9.5h3l4.5-3.6v12.2L7 14.5H4z" />
    <path d="M16 10l4 4M20 10l-4 4" />
  </Svg>
);

export const IconChevron = (p: Props) => (
  <Svg {...p}>
    <path d="M6 9.5l6 6 6-6" />
  </Svg>
);

export const IconArrowRight = (p: Props) => (
  <Svg {...p}>
    <path d="M4.5 12h14M13 6.5l5.5 5.5L13 17.5" />
  </Svg>
);

export const IconArrowLeft = (p: Props) => (
  <Svg {...p}>
    <path d="M19.5 12h-14M11 6.5L5.5 12 11 17.5" />
  </Svg>
);

export const IconCheck = (p: Props) => (
  <Svg {...p}>
    <path d="M4.5 12.8l4.6 4.4L19.5 6.8" />
  </Svg>
);

export const IconEraser = (p: Props) => (
  <Svg {...p}>
    <path d="M8.6 19.5l-4-4a1.8 1.8 0 0 1 0-2.6l7.6-7.6a1.8 1.8 0 0 1 2.6 0l4 4a1.8 1.8 0 0 1 0 2.6l-7.6 7.6z" />
    <path d="M11 19.5h9M6.8 11.2l6 6" />
  </Svg>
);

export const IconBrush = (p: Props) => (
  <Svg {...p}>
    <path d="M14.5 4.8l4.7 4.7-8 8-4.7-4.7z" />
    <path d="M6.5 12.8L4 20l7.2-2.5" />
    <path d="M16.6 2.7l1.6-1.1" />
  </Svg>
);

export const IconUndo = (p: Props) => (
  <Svg {...p}>
    <path d="M4 9h10a5.5 5.5 0 0 1 0 11h-4" />
    <path d="M7.5 5.2L3.7 9l3.8 3.8" />
  </Svg>
);

export const IconDownload = (p: Props) => (
  <Svg {...p}>
    <path d="M12 3.8v10.6M7.8 10.6L12 14.8l4.2-4.2" />
    <path d="M4.5 16.5v1.8a2.2 2.2 0 0 0 2.2 2.2h10.6a2.2 2.2 0 0 0 2.2-2.2v-1.8" />
  </Svg>
);

export const IconPlus = (p: Props) => (
  <Svg {...p}>
    <path d="M12 5.5v13M5.5 12h13" />
  </Svg>
);

export const IconMinus = (p: Props) => (
  <Svg {...p}>
    <path d="M5.5 12h13" />
  </Svg>
);

export const IconRotate = (p: Props) => (
  <Svg {...p}>
    <path d="M20 12a8 8 0 1 1-2.6-5.9" />
    <path d="M20.4 3.6v4.2h-4.2" />
  </Svg>
);

export const IconCircle = (p: Props) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="8.4" />
  </Svg>
);

export const IconSquare = (p: Props) => (
  <Svg {...p}>
    <rect x="3.6" y="3.6" width="16.8" height="16.8" rx="3" />
  </Svg>
);

export const IconInfo = (p: Props) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="8.6" />
    <path d="M12 11v5.2M12 7.8v.6" />
  </Svg>
);

export const IconWarn = (p: Props) => (
  <Svg {...p}>
    <path d="M12 4.2l8.4 14.6H3.6z" />
    <path d="M12 9.6v3.8M12 16.2v.5" />
  </Svg>
);

export const IconMove = (p: Props) => (
  <Svg {...p}>
    <path d="M12 3.5v17M3.5 12h17" />
    <path d="M9.4 6.1L12 3.5l2.6 2.6M9.4 17.9L12 20.5l2.6-2.6M6.1 9.4L3.5 12l2.6 2.6M17.9 9.4l2.6 2.6-2.6 2.6" />
  </Svg>
);

export const IconX = (p: Props) => (
  <Svg {...p}>
    <path d="M6.2 6.2l11.6 11.6M17.8 6.2L6.2 17.8" />
  </Svg>
);

export const IconHelp = (p: Props) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="8.6" />
    <path d="M9.6 9.6a2.5 2.5 0 1 1 3.3 2.4c-.6.2-.9.8-.9 1.5v.4" />
    <path d="M12 16.6v.5" />
  </Svg>
);

export const IconLock = (p: Props) => (
  <Svg {...p}>
    <rect x="4.6" y="10.4" width="14.8" height="9.6" rx="2.6" />
    <path d="M8.2 10.4V7.8a3.8 3.8 0 0 1 7.6 0v2.6" />
  </Svg>
);

export const IconRefresh = (p: Props) => (
  <Svg {...p}>
    <path d="M3.8 12a8.2 8.2 0 0 1 14-5.8l2.4 2.3" />
    <path d="M20.2 12a8.2 8.2 0 0 1-14 5.8L3.8 15.5" />
    <path d="M20.4 4v4.5h-4.5M3.6 20v-4.5h4.5" />
  </Svg>
);

export const IconHeart = (p: Props) => (
  <Svg {...p}>
    <path d="M12 20.3l-7.1-7a4.5 4.5 0 0 1 0-6.4 4.5 4.5 0 0 1 6.4 0l.7.7.7-.7a4.5 4.5 0 0 1 6.4 0 4.5 4.5 0 0 1 0 6.4z" />
  </Svg>
);

export const IconExternal = (p: Props) => (
  <Svg {...p}>
    <path d="M13.5 4.5H19.5V10.5" />
    <path d="M19.5 4.5L10.8 13.2" />
    <path d="M17.5 14v4.3a1.7 1.7 0 0 1-1.7 1.7H5.7A1.7 1.7 0 0 1 4 18.3V8.2a1.7 1.7 0 0 1 1.7-1.7H10" />
  </Svg>
);

/** 左右反転 */
export const IconFlip = (p: Props) => (
  <Svg {...p}>
    <path d="M12 3.5v17" strokeDasharray="2.4 2.6" />
    <path d="M9 7.5L4 12l5 4.5z" />
    <path d="M15 7.5L20 12l-5 4.5z" />
  </Svg>
);

/** 共有（端末の共有シートを開く） */
export const IconShare = (p: Props) => (
  <Svg {...p}>
    <path d="M12 15V3.5" />
    <path d="M8.5 7L12 3.5 15.5 7" />
    <path d="M5.5 12.5v6a1.5 1.5 0 001.5 1.5h10a1.5 1.5 0 001.5-1.5v-6" />
  </Svg>
);

/** かどまる（角の丸い四角） */
export const IconRounded = (p: Props) => (
  <Svg {...p}>
    <rect x="4" y="4" width="16" height="16" rx="5.5" />
  </Svg>
);

/** 指で長おし */
export const IconTouch = (p: Props) => (
  <Svg {...p}>
    <path d="M11 11.5V5.2a1.7 1.7 0 013.4 0v8.3" />
    <path d="M14.4 11.2a1.6 1.6 0 013.2 0v.9" />
    <path d="M17.6 11.9a1.6 1.6 0 013.1.5v2.4c0 3.2-2.2 5.7-5.4 5.7h-1.4c-2 0-3.2-.8-4.3-2.4l-2.4-3.5a1.7 1.7 0 012.6-2.1l1.3 1.4" />
  </Svg>
);

/* ---------------- うごく素材のスタジオで使うもの ---------------- */

/** フィルム（動画そのもの） */
export const IconFilm = (p: Props) => (
  <Svg {...p}>
    <rect x="3" y="5" width="18" height="14" rx="2.5" />
    <path d="M7 5v14M17 5v14" />
    <path d="M3 9.5h4M3 14.5h4M17 9.5h4M17 14.5h4" />
  </Svg>
);

/** 再生 */
export const IconPlay = (p: Props) => (
  <Svg {...p}>
    <path d="M8 5.5l11 6.5-11 6.5z" />
  </Svg>
);

/** 一時停止 */
export const IconPause = (p: Props) => (
  <Svg {...p}>
    <path d="M9 5v14M15 5v14" />
  </Svg>
);

/** 見くらべ（左右にひらく） */
export const IconCompare = (p: Props) => (
  <Svg {...p}>
    <path d="M12 3v18" />
    <path d="M8 8L4 12l4 4" />
    <path d="M16 8l4 4-4 4" />
  </Svg>
);

/** 配信（電波を出す） */
export const IconBroadcast = (p: Props) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="2.2" />
    <path d="M8.4 8.4a5 5 0 000 7.2M15.6 8.4a5 5 0 010 7.2" />
    <path d="M5.6 5.6a9 9 0 000 12.8M18.4 5.6a9 9 0 010 12.8" />
  </Svg>
);

/** 重ねる（レイヤー） */
export const IconLayers = (p: Props) => (
  <Svg {...p}>
    <path d="M12 3.5l8.5 4.5L12 12.5 3.5 8z" />
    <path d="M3.5 12.5L12 17l8.5-4.5" />
    <path d="M3.5 16.5L12 21l8.5-4.5" />
  </Svg>
);

/** つまみ（こまかい調整） */
export const IconSliders = (p: Props) => (
  <Svg {...p}>
    <path d="M4 7h10M18 7h2M4 17h4M12 17h8" />
    <circle cx="16" cy="7" r="2" />
    <circle cx="10" cy="17" r="2" />
  </Svg>
);

/** ひとまとめの箱（ZIP） */
export const IconArchive = (p: Props) => (
  <Svg {...p}>
    <rect x="3.5" y="4" width="17" height="4.5" rx="1.4" />
    <path d="M5 8.5V19a1.5 1.5 0 001.5 1.5h11A1.5 1.5 0 0019 19V8.5" />
    <path d="M10.5 12.5h3" />
  </Svg>
);

/** きらめき（AI がやっていること） */
export const IconSparkle = (p: Props) => (
  <Svg {...p}>
    <path d="M12 3.5l1.8 4.7L18.5 10l-4.7 1.8L12 16.5l-1.8-4.7L5.5 10l4.7-1.8z" />
    <path d="M18.5 15.5l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7z" />
  </Svg>
);

/** はさみ（切り抜き） */
export const IconScissors = (p: Props) => (
  <Svg {...p}>
    <circle cx="6.5" cy="17.5" r="2.5" />
    <circle cx="6.5" cy="6.5" r="2.5" />
    <path d="M8.6 8.4L20 18M8.6 15.6L20 6" />
  </Svg>
);

/** スタジオ画面のあいだで受け渡すものの型。 */
import type { OpenedVideo } from '../../lib/video/pipeline';

export type Media =
  | {
      kind: 'video';
      video: OpenedVideo;
      name: string;
      width: number;
      height: number;
      durationSec: number;
    }
  | { kind: 'image'; bitmap: ImageBitmap; name: string; width: number; height: number };

/** 画面がいまどの段階にいるか。出すものと出さないものは、これだけで決まる */
export type Phase = 'empty' | 'ready' | 'working' | 'done';

export type Range = { start: number; end: number };

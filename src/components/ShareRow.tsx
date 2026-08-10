/**
 * ページを人に知らせるための一行。
 *
 * 置いていいものの基準:
 *   その場で必ず動くこと。SDK を足さないこと。
 *
 * Instagram はウェブページを外から投稿できないので、ボタンを置かない。
 * 押しても何も起きないボタンは、無いほうがましなので。
 */
import { useEffect, useState } from 'react';
import { play, unlockAudio } from '../lib/sound';
import { Button } from './ui';
import { IconCheck, IconExternal, IconShare } from './Icons';

const TEXT = 'TikTokのアイコンフレームを、スマホだけで使えるツール';

function pageUrl() {
  // ハッシュを外した、この道具そのもののURLを配る。
  // 応援ページのURLを配ると「お金の話」から始まってしまう。
  const { origin, pathname } = window.location;
  return `${origin}${pathname}`;
}

export function ShareRow() {
  const [canShare, setCanShare] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    setCanShare(typeof navigator !== 'undefined' && typeof navigator.share === 'function');
  }, []);

  useEffect(() => {
    if (!copied) return;
    const id = setTimeout(() => setCopied(false), 2400);
    return () => clearTimeout(id);
  }, [copied]);

  const copy = async () => {
    const url = pageUrl();
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(url);
      } else {
        // clipboard API が無い（古い端末・非 https）ときの逃げ道
        const ta = document.createElement('textarea');
        ta.value = url;
        ta.setAttribute('readonly', '');
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        ta.remove();
      }
      play('done');
      setCopied(true);
    } catch {
      play('error');
    }
  };

  return (
    <div className="share">
      {canShare && (
        <Button
          variant="ghost"
          onPointerDown={unlockAudio}
          onClick={() => {
            play('tap');
            navigator.share({ title: TEXT, text: TEXT, url: pageUrl() }).catch(() => {
              /* 閉じただけなので、何も言わない */
            });
          }}
        >
          <IconShare size={18} />
          シェアする
        </Button>
      )}

      <Button variant="ghost" onClick={copy}>
        {copied ? <IconCheck size={18} /> : null}
        {copied ? 'コピーしました' : 'リンクをコピー'}
      </Button>

      <div className="share__links">
        <a
          className="btn btn--ghost btn--sm"
          href={`https://twitter.com/intent/tweet?text=${encodeURIComponent(TEXT)}&url=${encodeURIComponent(pageUrl())}`}
          target="_blank"
          rel="noopener noreferrer"
          onPointerDown={unlockAudio}
          onClick={() => play('tap')}
        >
          X で伝える
          <IconExternal size={14} />
        </a>
        <a
          className="btn btn--ghost btn--sm"
          href={`https://social-plugins.line.me/lineit/share?url=${encodeURIComponent(pageUrl())}`}
          target="_blank"
          rel="noopener noreferrer"
          onPointerDown={unlockAudio}
          onClick={() => play('tap')}
        >
          LINE で送る
          <IconExternal size={14} />
        </a>
      </div>

      {/* 読み上げにも「コピーできた」を伝える */}
      <span className="sr-only" role="status" aria-live="polite">
        {copied ? 'リンクをコピーしました' : ''}
      </span>
    </div>
  );
}

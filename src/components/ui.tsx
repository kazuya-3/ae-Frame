/**
 * 共通部品。
 * どれも「押したら鳴る」を部品側で持っているので、画面側は音のことを考えなくていい。
 */
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type ReactNode,
} from 'react';
import { play, unlockAudio, type SoundName } from '../lib/sound';
import { IconChevron, IconInfo, IconWarn, IconCheck } from './Icons';

/* ---------------- ボタン ---------------- */

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'default' | 'primary' | 'ghost' | 'icon' | 'sm';
  sound?: SoundName | null;
};

export function Button({
  variant = 'default',
  sound = 'tap',
  className,
  onClick,
  ...rest
}: ButtonProps) {
  const cls = [
    'btn',
    variant === 'primary' && 'btn--primary',
    variant === 'ghost' && 'btn--ghost',
    variant === 'icon' && 'btn--icon',
    variant === 'sm' && 'btn--sm',
    className,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <button
      type="button"
      className={cls}
      onPointerDown={unlockAudio}
      onClick={(e) => {
        if (sound) play(sound);
        onClick?.(e);
      }}
      {...rest}
    />
  );
}

/* ---------------- トグル ---------------- */

export function Toggle({
  on,
  onChange,
  label,
  icon,
  title,
}: {
  on: boolean;
  onChange: (next: boolean) => void;
  label?: string;
  icon?: ReactNode;
  title?: string;
}) {
  return (
    <button
      type="button"
      className="toggle"
      aria-pressed={on}
      title={title}
      aria-label={title ?? label}
      onPointerDown={unlockAudio}
      onClick={() => onChange(!on)}
    >
      {icon}
      <span className="toggle__track">
        <span className="toggle__knob" />
      </span>
      {label && <span className="toggle__label">{label}</span>}
    </button>
  );
}

/* ---------------- スライダー ---------------- */

export function Slider({
  label,
  value,
  min,
  max,
  step = 1,
  onChange,
  format,
  note,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (v: number) => void;
  format?: (v: number) => string;
  note?: string;
}) {
  const id = useId();
  return (
    <div className="field">
      <div className="field__row">
        <label className="field__label" htmlFor={id}>
          {label}
        </label>
        <span className="field__value">{format ? format(value) : value}</span>
      </div>
      <input
        id={id}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onPointerDown={unlockAudio}
        onChange={(e) => {
          play('tick');
          onChange(Number(e.target.value));
        }}
      />
      {note && <p className="field__note">{note}</p>}
    </div>
  );
}

/* ---------------- セグメント選択 ---------------- */

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  ariaLabel,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
  ariaLabel?: string;
}) {
  return (
    <div className="segmented" role="group" aria-label={ariaLabel}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          className="segmented__btn"
          aria-pressed={value === o.value}
          onPointerDown={unlockAudio}
          onClick={() => {
            if (o.value !== value) play('toggleOn');
            onChange(o.value);
          }}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/* ---------------- 折りたたみ ---------------- */

export function Disclosure({
  title,
  icon,
  children,
  defaultOpen = false,
}: {
  title: string;
  icon?: ReactNode;
  children: ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="disclosure" data-open={open}>
      <button
        type="button"
        className="disclosure__btn"
        aria-expanded={open}
        onPointerDown={unlockAudio}
        onClick={() => {
          play(open ? 'toggleOff' : 'toggleOn');
          setOpen(!open);
        }}
      >
        {icon}
        {title}
        <IconChevron className="disclosure__chev" size={20} />
      </button>
      {open && <div className="disclosure__body">{children}</div>}
    </div>
  );
}

/* ---------------- 注意書き ---------------- */

export function Note({
  tone = 'info',
  children,
}: {
  tone?: 'info' | 'warn' | 'ok';
  children: ReactNode;
}) {
  const Icon = tone === 'warn' ? IconWarn : tone === 'ok' ? IconCheck : IconInfo;
  return (
    <div className={`note ${tone === 'warn' ? 'note--warn' : tone === 'ok' ? 'note--ok' : ''}`}>
      <Icon className="note__icon" size={18} />
      <div>{children}</div>
    </div>
  );
}

/* ---------------- 画像を置く場所 ---------------- */

export function DropZone({
  title,
  sub,
  icon,
  onFile,
  accept = 'image/*',
}: {
  title: string;
  sub: string;
  icon: ReactNode;
  onFile: (file: File) => void;
  accept?: string;
}) {
  const [over, setOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const handle = useCallback(
    (file: File | undefined | null) => {
      if (!file) return;
      play('drop');
      onFile(file);
    },
    [onFile],
  );

  // どこにでも貼り付けられるようにしておく（スクショを撮ってそのまま Ctrl+V）
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const item = [...(e.clipboardData?.items ?? [])].find((i) => i.type.startsWith('image/'));
      if (item) handle(item.getAsFile());
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, [handle]);

  return (
    <div
      className="drop"
      data-over={over}
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        handle(e.dataTransfer.files?.[0]);
      }}
      onClick={() => {
        unlockAudio();
        inputRef.current?.click();
      }}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          inputRef.current?.click();
        }
      }}
    >
      {icon}
      <span className="drop__title">{title}</span>
      <span className="drop__sub">{sub}</span>
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        onChange={(e) => {
          handle(e.target.files?.[0]);
          e.target.value = ''; // 同じファイルをもう一度選べるように
        }}
        onClick={(e) => e.stopPropagation()}
      />
    </div>
  );
}

/* ---------------- 進捗バー ---------------- */

export function Progress({ value, label }: { value: number; label: string }) {
  return (
    <div>
      <div className="progress-label">
        <span>{label}</span>
        <span>{Math.round(value * 100)}%</span>
      </div>
      <div
        className="progress"
        role="progressbar"
        aria-valuenow={Math.round(value * 100)}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={label}
      >
        <div className="progress__bar" style={{ width: `${Math.max(3, value * 100)}%` }} />
      </div>
    </div>
  );
}

/* ---------------- ボトムシート ---------------- */

export function Sheet({ onClose, children }: { onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [onClose]);

  return (
    <div className="sheet-backdrop" onClick={onClose} role="presentation">
      <div className="sheet" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <div className="sheet__grip" />
        {children}
      </div>
    </div>
  );
}

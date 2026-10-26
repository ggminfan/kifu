import { useState, type ReactNode } from 'react';
import { systemText } from '../../shared/i18n';
import { useLocale } from '../../shared/i18n/react';

export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}

const TONES = {
  zinc: 'bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300',
  indigo: 'bg-indigo-50 text-indigo-700 dark:bg-indigo-950 dark:text-indigo-300',
  green: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300',
  red: 'bg-red-50 text-red-700 dark:bg-red-950 dark:text-red-300',
  amber: 'bg-amber-50 text-amber-800 dark:bg-amber-950 dark:text-amber-300',
  violet: 'bg-violet-50 text-violet-700 dark:bg-violet-950 dark:text-violet-300',
  sky: 'bg-sky-50 text-sky-700 dark:bg-sky-950 dark:text-sky-300',
  pink: 'bg-pink-50 text-pink-700 dark:bg-pink-950 dark:text-pink-300',
} as const;

export type Tone = keyof typeof TONES;

export function Badge({ children, tone = 'zinc', title, className }: { children: ReactNode; tone?: Tone; title?: string; className?: string }) {
  return (
    <span title={title} className={cx('inline-flex items-center gap-1 whitespace-nowrap rounded px-1.5 py-px text-[11px] font-medium', TONES[tone], className)}>
      {children}
    </span>
  );
}

export function Button({
  children,
  onClick,
  variant = 'default',
  size = 'sm',
  disabled,
  title,
  className,
  type = 'button',
}: {
  children: ReactNode;
  onClick?: () => void;
  variant?: 'default' | 'primary' | 'ghost' | 'danger';
  size?: 'xs' | 'sm';
  disabled?: boolean;
  title?: string;
  className?: string;
  type?: 'button' | 'submit';
}) {
  const v = {
    default: 'border border-zinc-300 bg-white hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900 dark:hover:bg-zinc-800',
    primary: 'bg-indigo-600 text-white hover:bg-indigo-500 disabled:bg-indigo-400',
    ghost: 'hover:bg-zinc-100 dark:hover:bg-zinc-800',
    danger: 'bg-red-600 text-white hover:bg-red-500',
  }[variant];
  const s = size === 'xs' ? 'px-1.5 py-0.5 text-[11px]' : 'px-2.5 py-1 text-[12px]';
  return (
    <button type={type} title={title} disabled={disabled} onClick={onClick} className={cx('inline-flex items-center gap-1 rounded font-medium disabled:cursor-not-allowed disabled:opacity-60', v, s, className)}>
      {children}
    </button>
  );
}

export function Spinner({ label }: { label?: string }) {
  return (
    <div className="flex items-center gap-2 text-zinc-500">
      <span className="h-3 w-3 animate-spin rounded-full border-2 border-zinc-300 border-t-indigo-500" />
      {label && <span>{label}</span>}
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="flex h-full items-center justify-center p-6 text-center text-zinc-500">{children}</div>;
}

export function ErrorBox({ error }: { error: unknown }) {
  useLocale();
  return <div className="m-3 rounded border border-red-300 bg-red-50 p-2 text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300">{systemText((error as Error)?.message ?? String(error))}</div>;
}

export function Tabs<T extends string>({ tabs, value, onChange }: { tabs: Array<{ id: T; label: ReactNode }>; value: T; onChange: (t: T) => void }) {
  return (
    <div className="flex gap-0.5 border-b border-zinc-200 px-2 dark:border-zinc-800">
      {tabs.map((t) => (
        <button
          key={t.id}
          onClick={() => onChange(t.id)}
          className={cx(
            '-mb-px border-b-2 px-2.5 py-1.5 text-[12px] font-medium',
            value === t.id ? 'border-indigo-500 text-indigo-600 dark:text-indigo-400' : 'border-transparent text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200',
          )}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

export function Collapsible({ title, children, defaultOpen = false, className }: { title: ReactNode; children: ReactNode; defaultOpen?: boolean; className?: string }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className={className}>
      <button onClick={() => setOpen(!open)} className="flex w-full items-center gap-1 text-left text-[12px] text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200">
        <span className={cx('inline-block w-3 transition-transform', open && 'rotate-90')}>▸</span>
        {title}
      </button>
      {open && <div className="mt-1">{children}</div>}
    </div>
  );
}

export function KV({ k, children }: { k: ReactNode; children: ReactNode }) {
  return (
    <div className="flex gap-2 py-0.5">
      <div className="w-24 shrink-0 text-zinc-500">{k}</div>
      <div className="min-w-0 flex-1 break-all">{children}</div>
    </div>
  );
}

import { useLocale } from '../../shared/i18n/react';
import { tr } from '../../shared/i18n';
import { useEffect, type ReactNode } from 'react';
import { cx } from './ui';

/** A dialog rendered by the page (the desktop webviews have no native dialogs). Escape or a click outside closes it. */
export function Modal({ title, children, footer, onClose, wide }: { title: ReactNode; children: ReactNode; footer?: ReactNode; onClose: () => void; wide?: boolean }) {
  useLocale();
  useEffect(() => {
    const key = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/30 p-4" onMouseDown={onClose}>
      <div
        role="dialog"
        className={cx('flex max-h-full w-full flex-col rounded-xl border border-zinc-200 bg-white shadow-xl dark:border-zinc-700 dark:bg-zinc-900', wide ? 'max-w-3xl' : 'max-w-lg')}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b border-zinc-200 px-4 py-2.5 dark:border-zinc-800">
          <div className="min-w-0 flex-1 truncate text-[14px] font-semibold">{title}</div>
          <button className="text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200" onClick={onClose} title={tr("关闭")}>
            ×
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-auto px-4 py-3 text-[12.5px]">{children}</div>
        {footer && <div className="flex items-center justify-end gap-2 border-t border-zinc-200 px-4 py-2.5 dark:border-zinc-800">{footer}</div>}
      </div>
    </div>
  );
}

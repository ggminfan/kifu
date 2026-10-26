import { useLocale } from '../../shared/i18n/react';
import { tr } from '../../shared/i18n';
import { useEffect, useState } from 'react';
import { Button } from './ui';

/**
 * In-page dialogs. The desktop app's webviews do not implement window.confirm
 * (it returns false without asking), so confirmations and image previews are
 * rendered by the page itself.
 */

interface ConfirmRequest {
  title: string;
  body?: string;
  confirm: string;
  danger?: boolean;
  resolve: (ok: boolean) => void;
}

type Overlay = { kind: 'confirm'; req: ConfirmRequest } | { kind: 'image'; src: string };

let show: ((o: Overlay) => void) | undefined;

export function askConfirm(o: { title: string; body?: string; confirm?: string; danger?: boolean }): Promise<boolean> {
  return new Promise((resolve) => {
    if (!show) {
      resolve(window.confirm([o.title, o.body].filter(Boolean).join('\n')));
      return;
    }
    show({ kind: 'confirm', req: { title: o.title, body: o.body, confirm: o.confirm ?? tr("确认"), danger: o.danger, resolve } });
  });
}

export function previewImage(src: string): void {
  show?.({ kind: 'image', src });
}

/** Mount once near the root. */
export function DialogHost() {
  useLocale();
  const [overlay, setOverlay] = useState<Overlay>();
  useEffect(() => {
    show = setOverlay;
    return () => {
      show = undefined;
    };
  }, []);

  const close = (ok: boolean) => {
    if (overlay?.kind === 'confirm') overlay.req.resolve(ok);
    setOverlay(undefined);
  };

  useEffect(() => {
    if (!overlay) return;
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close(false);
      else if (e.key === 'Enter' && overlay.kind === 'confirm') close(true);
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  });

  if (!overlay) return null;
  if (overlay.kind === 'image') {
    return (
      <div className="fixed inset-0 z-50 flex cursor-zoom-out items-center justify-center bg-black/70 p-6" onMouseDown={() => close(false)}>
        <img src={overlay.src} className="max-h-full max-w-full rounded shadow-2xl" alt="" />
      </div>
    );
  }
  const r = overlay.req;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-6" onMouseDown={() => close(false)}>
      <div
        role="dialog"
        className="w-[440px] max-w-full rounded-xl border border-zinc-200 bg-white p-5 shadow-xl dark:border-zinc-700 dark:bg-zinc-900"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="text-[14px] font-semibold">{r.title}</div>
        {r.body && <div className="mt-2 whitespace-pre-wrap break-all text-[12.5px] text-zinc-600 dark:text-zinc-400">{r.body}</div>}
        <div className="mt-4 flex justify-end gap-2">
          <Button onClick={() => close(false)}>{tr("取消")}</Button>
          <Button variant={r.danger ? 'danger' : 'primary'} onClick={() => close(true)}>
            {r.confirm}
          </Button>
        </div>
      </div>
    </div>
  );
}

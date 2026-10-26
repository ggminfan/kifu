import { useCallback, useEffect, useRef, useState } from 'react';

function load(key: string, fallback: number): number {
  try {
    const v = Number(localStorage.getItem(`kifu.width.${key}`));
    return Number.isFinite(v) && v > 0 ? v : fallback;
  } catch {
    return fallback;
  }
}

/** Persisted panel width with a drag handle. `side` is where the handle sits relative to the panel. */
export function useResizable(key: string, initial: number, min: number, max: number, side: 'right' | 'left') {
  const [width, setWidth] = useState(() => load(key, initial));
  const drag = useRef<{ x: number; w: number } | null>(null);

  useEffect(() => {
    try {
      localStorage.setItem(`kifu.width.${key}`, String(Math.round(width)));
    } catch {
      // storage unavailable
    }
  }, [key, width]);

  const onMouseDown = useCallback(
    (e: React.MouseEvent) => {
      drag.current = { x: e.clientX, w: width };
      const move = (ev: MouseEvent) => {
        if (!drag.current) return;
        const dx = ev.clientX - drag.current.x;
        setWidth(Math.min(max, Math.max(min, drag.current.w + (side === 'right' ? dx : -dx))));
      };
      const up = () => {
        drag.current = null;
        window.removeEventListener('mousemove', move);
        window.removeEventListener('mouseup', up);
        document.body.style.cursor = '';
      };
      window.addEventListener('mousemove', move);
      window.addEventListener('mouseup', up);
      document.body.style.cursor = 'col-resize';
    },
    [width, min, max, side],
  );

  const handle = (
    <div
      onMouseDown={onMouseDown}
      className="w-1 shrink-0 cursor-col-resize bg-zinc-200 transition-colors hover:bg-indigo-400 dark:bg-zinc-800"
    />
  );
  return { width, handle };
}

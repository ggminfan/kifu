import { useLocale } from '../../shared/i18n/react';
import { tr } from '../../shared/i18n';
import { useEffect, useRef, useState } from 'react';
import type { Txt } from '../../shared/types';
import { fetchText } from '../lib/api';
import { cx } from './ui';

/** Full texts already loaded (a virtualized list unmounts rows that scroll away: they come back loaded). */
const fullCache = new Map<string, string>();
const cacheKey = (sessionId: string, txt: Txt | undefined) => (txt?.ref ? `${sessionId}|${txt.ref.line}|${txt.ref.ptr}|${txt.ref.json ?? ''}` : undefined);

/** JSON shown indented, when it is JSON (tool arguments come as one line). */
function pretty(text: string): string {
  const t = text.trimStart();
  if (!t.startsWith('{') && !t.startsWith('[')) return text;
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

/**
 * Shows a Txt preview; when the server only sent a prefix, offers to load the
 * full value. `json`: indent it when it is JSON (once complete). `copy`: a
 * button that copies the whole value (loading it first if needed). `tail`: a
 * button that loads it all and shows the end (where a command's errors are).
 */
export function LazyText({
  sessionId,
  txt,
  mono = true,
  maxHeight = 'max-h-72',
  className,
  json = false,
  copy = false,
  tail = false,
}: {
  sessionId: string;
  txt: Txt | undefined;
  mono?: boolean;
  maxHeight?: string;
  className?: string;
  json?: boolean;
  copy?: boolean;
  tail?: boolean;
}) {
  useLocale();
  const [full, setFull] = useState<string | undefined>(() => {
    const k = cacheKey(sessionId, txt);
    return k ? fullCache.get(k) : undefined;
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const [copied, setCopied] = useState(false);
  const [toEnd, setToEnd] = useState(false);
  const preRef = useRef<HTMLPreElement>(null);
  useEffect(() => {
    if (toEnd && full !== undefined && preRef.current) {
      preRef.current.scrollTop = preRef.current.scrollHeight;
      setToEnd(false);
    }
  }, [toEnd, full]);
  if (!txt) return null;
  const truncated = Boolean(txt.ref) && full === undefined;
  const raw = full ?? txt.preview;
  const text = json && !truncated ? pretty(raw) : raw;
  const fetchFull = async (): Promise<string | undefined> => {
    if (!txt.ref) return txt.preview;
    setLoading(true);
    setError(undefined);
    try {
      const res = await fetchText(sessionId, txt.ref);
      const value = res.truncated ? tr`${res.text}\n…（已截断，共 ${res.chars} 字）` : res.text;
      setFull(value);
      const k = cacheKey(sessionId, txt)!;
      fullCache.set(k, value);
      if (fullCache.size > 300) fullCache.delete(fullCache.keys().next().value!);
      return res.text;
    } catch (e) {
      setError((e as Error).message);
      return undefined;
    } finally {
      setLoading(false);
    }
  };
  const doCopy = async () => {
    const value = full ?? (truncated ? await fetchFull() : txt.preview);
    if (value === undefined) return;
    try {
      await navigator.clipboard.writeText(json ? pretty(value) : value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch (e) {
      setError(tr`复制失败：${(e as Error).message}`);
    }
  };
  return (
    <div className={cx('group/lazy relative', className)}>
      <pre ref={preRef} className={cx('overflow-auto whitespace-pre-wrap break-words rounded bg-zinc-50 p-2 text-[12px] leading-relaxed dark:bg-zinc-900', mono ? 'font-mono' : 'font-sans', maxHeight)}>
        {text || <span className="text-zinc-400">{tr("（空）")}</span>}
        {truncated && <span className="text-zinc-400">…</span>}
      </pre>
      {copy && text && (
        <button
          onClick={() => void doCopy()}
          className="absolute right-1.5 top-1.5 rounded border border-zinc-200 bg-white/90 px-1.5 text-[10.5px] text-zinc-500 opacity-0 transition-opacity hover:text-zinc-800 group-hover/lazy:opacity-100 dark:border-zinc-700 dark:bg-zinc-900/90 dark:hover:text-zinc-200"
          title={truncated ? tr`复制全文（${txt.chars.toLocaleString()} 字）` : tr("复制")}
        >
          {copied ? tr("已复制") : tr("复制")}
        </button>
      )}
      {truncated && (
        <div className="mt-0.5 flex gap-3">
          <button onClick={() => void fetchFull()} disabled={loading} className="text-[11px] text-indigo-600 hover:underline dark:text-indigo-400">
            {loading ? tr("加载中…") : tr`展开全部（${txt.chars.toLocaleString()} 字）`}
          </button>
          {tail && !loading && (
            <button
              onClick={async () => {
                setToEnd(true);
                await fetchFull();
              }}
              className="text-[11px] text-indigo-600 hover:underline dark:text-indigo-400"
              title={tr("加载全部并滚到末尾（命令的报错通常在最后）")}
            >{tr("看末尾")}</button>
          )}
        </div>
      )}
      {error && <div className="text-[11px] text-red-600">{error}</div>}
    </div>
  );
}

import { getLocale, tr } from '../../shared/i18n';
import { useLocale } from '../../shared/i18n/react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { ContextSeriesResponse } from '../../shared/api';
import { fmtTokens } from '../lib/format';
import { CAT_META } from '../lib/meta';

/** Bottom to top: what stays the same (tool definitions, system prompt, instructions) under what grows (the conversation). */
const STACK = [
  'tools_overhead',
  'system',
  'permissions',
  'developer',
  'agents_md',
  'environment',
  'skills_listing',
  'plugins',
  'memory',
  'skill_content',
  'system_reminder',
  'compaction_summary',
  'user',
  'inter_agent',
  'assistant',
  'reasoning',
  'tool_call',
  'tool_output',
  'other',
];

const HEIGHT = 44;

/**
 * Every step's input, stacked by category: how the context filled up and what
 * filled it, where a compaction cut it down. A line follows the input the agent
 * reported; where the reconstruction is bigger (the agent left part of its
 * history out of the request), the excess is veiled. The selected step is
 * marked; a click goes to a step. More steps than pixels: each pixel shows its
 * biggest.
 */
export function ContextTrend({ series, selected, filter, onJump }: { series: ContextSeriesResponse; selected?: number; filter?: string; onJump?: (call: number) => void }) {
  useLocale();
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [width, setWidth] = useState(0);
  const [hover, setHover] = useState<{ x: number; point: number }>();
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);
  const order = useMemo(() => {
    const known = STACK.map((c) => series.cats.indexOf(c as (typeof series.cats)[number])).filter((k) => k >= 0);
    return [...known, ...series.cats.map((_, k) => k).filter((k) => !known.includes(k))];
  }, [series, getLocale()]);
  const totals = useMemo(() => series.points.map((p) => p.v.reduce((s, x) => s + x, 0)), [series, getLocale()]);
  const maxTotal = Math.max(1, ...totals);
  const win = series.contextWindow;
  // against the window when the session came near it
  const yMax = win && maxTotal > win * 0.6 ? Math.max(win, maxTotal) : maxTotal;
  const cols = useMemo(() => {
    const n = series.points.length;
    if (!width || !n) return [];
    if (n <= width) return series.points.map((_, i) => i);
    const out: number[] = [];
    for (let x = 0; x < width; x++) {
      const a = Math.floor((x * n) / width);
      const b = Math.max(a + 1, Math.floor(((x + 1) * n) / width));
      let best = a;
      for (let i = a + 1; i < b; i++) if (totals[i] > totals[best]) best = i;
      out.push(best);
    }
    return out;
  }, [series, width, totals, getLocale()]);
  const selPoint = selected === undefined ? -1 : series.points.findIndex((p) => p.call === selected);
  const colOf = (point: number) => (series.points.length <= width ? point : Math.floor((point * width) / series.points.length));

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !width || !cols.length) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = width * dpr;
    canvas.height = HEIGHT * dpr;
    const ctx = canvas.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, HEIGHT);
    const dark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    const cw = width / cols.length;
    const colW = cw > 4 ? cw - 1 : cw;
    cols.forEach((pi, ci) => {
      const p = series.points[pi];
      let y = HEIGHT;
      for (const k of order) {
        const v = p.v[k];
        if (!v) continue;
        const h = (v / yMax) * HEIGHT;
        ctx.globalAlpha = filter && series.cats[k] !== filter ? 0.2 : 0.9;
        ctx.fillStyle = CAT_META[series.cats[k]]?.color ?? '#d4d4d8';
        ctx.fillRect(ci * cw, y - h, colW, h);
        y -= h;
      }
      // more reconstructed than the model was sent (the agent left history out): veiled above the real input
      if (p.input && totals[pi] > p.input * 1.2) {
        const yIn = HEIGHT - (p.input / yMax) * HEIGHT;
        ctx.globalAlpha = 0.6;
        ctx.fillStyle = dark ? '#18181b' : '#fafafa';
        ctx.fillRect(ci * cw, y, colW, yIn - y);
      }
    });
    ctx.globalAlpha = 1;
    // the input the model was sent (the agent's own count)
    ctx.strokeStyle = dark ? '#d4d4d8' : '#3f3f46';
    ctx.lineWidth = 1;
    ctx.beginPath();
    let drawing = false;
    cols.forEach((pi, ci) => {
      const input = series.points[pi].input;
      if (!input) {
        drawing = false;
        return;
      }
      const y = HEIGHT - (input / yMax) * HEIGHT + 0.5;
      if (!drawing) ctx.moveTo(ci * cw, y);
      else ctx.lineTo(ci * cw, y);
      ctx.lineTo(ci * cw + cw, y);
      drawing = true;
    });
    ctx.stroke();
    if (win && yMax >= win) {
      const y = HEIGHT - (win / yMax) * HEIGHT;
      ctx.strokeStyle = '#ef4444';
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(0, y + 0.5);
      ctx.lineTo(width, y + 0.5);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    if (selPoint >= 0) {
      const x = colOf(selPoint) * cw + cw / 2;
      ctx.fillStyle = dark ? '#fafafa' : '#18181b';
      ctx.fillRect(x - 0.75, 0, 1.5, HEIGHT);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [series, cols, width, order, yMax, win, filter, selPoint]);

  const pointAt = (x: number) => {
    if (!cols.length) return undefined;
    return cols[Math.max(0, Math.min(cols.length - 1, Math.floor((x / width) * cols.length)))];
  };
  const hovered = hover ? series.points[hover.point] : undefined;
  const parts = hovered
    ? hovered.v
        .map((v, k) => ({ cat: series.cats[k], v }))
        .filter((x) => x.v > 0)
        .sort((a, b) => b.v - a.v)
        .slice(0, 4)
    : [];
  const hoveredTotal = hover ? totals[hover.point] : 0;
  return (
    <div ref={wrapRef} className="relative">
      <canvas
        ref={canvasRef}
        style={{ width, height: HEIGHT, cursor: onJump ? 'pointer' : 'default' }}
        className="block rounded bg-zinc-50 dark:bg-zinc-900"
        onMouseMove={(e) => {
          const x = e.clientX - e.currentTarget.getBoundingClientRect().left;
          const point = pointAt(x);
          setHover(point === undefined ? undefined : { x, point });
        }}
        onMouseLeave={() => setHover(undefined)}
        onClick={(e) => {
          const point = pointAt(e.clientX - e.currentTarget.getBoundingClientRect().left);
          if (point !== undefined && onJump) onJump(series.points[point].call);
        }}
      />
      <div className="pointer-events-none absolute left-1 top-0.5 text-[9.5px] leading-none text-zinc-400">
        ≤{fmtTokens(yMax)}{tr("· 线为实际输入")}{win && yMax >= win ? tr(" · 红线为上下文窗口") : ''}
      </div>
      {hovered && hover && (
        <div className="pointer-events-none absolute top-full z-20 mt-1 w-56 rounded border border-zinc-200 bg-white px-2 py-1 text-[11px] shadow-md dark:border-zinc-700 dark:bg-zinc-900" style={{ left: Math.max(0, Math.min(hover.x - 112, width - 224)) }}>
          <div>
            <span className="font-medium">Step {hovered.call + 1}</span>{tr("的输入")}{fmtTokens(hovered.input ?? hoveredTotal)}
            {win ? <span className="text-zinc-500">{tr("（窗口的")}{Math.round(((hovered.input ?? hoveredTotal) / win) * 100)}%）</span> : null}
          </div>
          {hovered.input ? <div className="text-zinc-500">{tr("缓存命中")}{Math.round(((hovered.cached ?? 0) / hovered.input) * 100)}%</div> : null}
          {hovered.input && hoveredTotal > hovered.input * 1.3 ? (
            <div className="text-amber-600 dark:text-amber-400">{tr("按记录重建 ≈")}{fmtTokens(hoveredTotal)}{tr("，比实际输入多：agent 发送时省略或截断了部分历史")}</div>
          ) : null}
          {parts.map((x) => (
            <div key={x.cat} className="flex items-center gap-1.5">
              <span className="h-2 w-2 shrink-0 rounded-sm" style={{ background: CAT_META[x.cat]?.color }} />
              <span className="min-w-0 flex-1 truncate">{CAT_META[x.cat]?.label ?? x.cat}</span>
              <span className="font-mono text-zinc-500">
                ≈{fmtTokens(x.v)} · {Math.round((x.v / Math.max(1, hoveredTotal)) * 100)}%
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

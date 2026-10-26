import { systemText, getLocale, tr } from '../../shared/i18n';
import { useLocale } from '../../shared/i18n/react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { TraceView } from '../../shared/types';
import { fmtDuration, fmtTokens, fmtUsage } from '../lib/format';
import { TOOL_META } from '../lib/meta';
import { cx } from './ui';

/**
 * Canvas timeline of a session: turns, LLM calls and tool calls on a compressed
 * time axis (idle gaps longer than 30s are squeezed to a fixed width), and below
 * them the size of each step's input — how the context grows, and where a
 * compaction cut it back. Wheel to zoom, shift+wheel or drag to pan,
 * double-click to reset.
 */

interface Span {
  kind: 'turn' | 'call' | 'tool';
  start: number;
  end: number;
  callIndex: number;
  toolId?: string;
  label: string;
  color: string;
  error?: boolean;
}

interface Mark {
  t: number;
  kind: 'compaction' | 'abort' | 'error' | 'rollback';
  detail?: string;
}

const GAP_MS = 30_000;
const LANES = { turn: { y: 3, h: 5 }, call: { y: 12, h: 14 }, tool: { y: 30, h: 9 } };
/** Marks (compaction, abort …) under the tools; the input-size lane at the bottom. */
const MARK_Y = 41;
const CTX = { y: 52, h: 16 };
const HEIGHT = 70;

function ms(iso: string | undefined): number | undefined {
  if (!iso) return undefined;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : undefined;
}

function buildScale(spans: Span[]) {
  const sorted = [...spans].sort((a, b) => a.start - b.start);
  const segs: Array<{ s: number; e: number; v0: number }> = [];
  let v = 0;
  for (const sp of sorted) {
    const last = segs[segs.length - 1];
    if (last && sp.start - last.e <= GAP_MS) {
      last.e = Math.max(last.e, sp.end);
    } else {
      if (last) v += last.e - last.s + GAP_MS * 0.4;
      segs.push({ s: sp.start, e: Math.max(sp.end, sp.start + 1), v0: v });
    }
  }
  const last = segs[segs.length - 1];
  const total = last ? last.v0 + (last.e - last.s) : 1;
  const toV = (t: number): number => {
    let lo = 0;
    let hi = segs.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (segs[mid].s <= t) lo = mid;
      else hi = mid - 1;
    }
    const sg = segs[lo];
    if (!sg) return 0;
    return sg.v0 + Math.min(Math.max(t - sg.s, 0), sg.e - sg.s);
  };
  return { toV, total, gaps: segs.slice(1).map((sg) => sg.v0 - GAP_MS * 0.4) };
}

export function Timeline({
  trace,
  selectedCall,
  onSelect,
  problemCalls,
}: {
  trace: TraceView;
  selectedCall?: number;
  onSelect: (callIndex: number, toolId?: string) => void;
  /** Steps with problems (problem bar): a dot above the step, red for facts, violet for heuristics. */
  problemCalls?: Map<number, 'fact' | 'heuristic'>;
}) {
  useLocale();
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [width, setWidth] = useState(800);
  const [view, setView] = useState<[number, number]>([0, 1]);
  const [hover, setHover] = useState<{ x: number; span?: Span; mark?: Mark; ctx?: { call: number; input: number; cached: number } }>();
  const drag = useRef<{ x: number; view: [number, number] } | null>(null);

  const { spans, marks, scale } = useMemo(() => {
    const spans: Span[] = [];
    const marks: Mark[] = [];
    for (const t of trace.turns) {
      const s = ms(t.startedAt);
      const e = ms(t.endedAt) ?? (t.calls.length ? ms(trace.calls[t.calls[t.calls.length - 1]]?.ts) : undefined);
      if (s !== undefined && e !== undefined) spans.push({ kind: 'turn', start: s, end: e, callIndex: t.calls[0] ?? 0, label: tr`第 ${t.index + 1} 轮`, color: '#a1a1aa' });
      for (const m of t.marks) {
        const mt = ms(m.ts);
        if (mt !== undefined) marks.push({ t: mt, kind: m.kind, detail: m.detail });
      }
    }
    for (const c of trace.calls) {
      const e = ms(c.ts);
      if (e === undefined) continue;
      const s = Math.min(ms(c.startTs) ?? e, e);
      const color = c.kind === 'compaction' ? '#8b5cf6' : c.kind === 'orphan' ? '#a1a1aa' : '#3b82f6';
      spans.push({ kind: 'call', start: s, end: e, callIndex: c.index, label: `Step ${c.index + 1} · ${fmtUsage(c.usage)}`, color });
      for (const id of c.tools) {
        const tool = trace.tools[id];
        const ts = ms(tool?.ts);
        if (!tool || ts === undefined) continue;
        const te = ms(tool.outputTs) ?? ts + (tool.durationMs ?? 0);
        spans.push({
          kind: 'tool',
          start: ts,
          end: Math.max(te, ts),
          callIndex: c.index,
          toolId: id,
          label: `${tool.name} · ${fmtDuration(tool.durationMs)}`,
          color: TOOL_META[tool.kind]?.color ?? '#a1a1aa',
          error: tool.isError,
        });
      }
    }
    return { spans, marks, scale: buildScale(spans) };
  }, [trace, getLocale()]);
  // each step's input size, at the time its response came (the context lane)
  const inputs = useMemo(() => {
    const out: Array<{ t: number; input: number; cached: number; call: number }> = [];
    for (const c of trace.calls) {
      const t = ms(c.ts);
      if (t !== undefined && c.usage && c.kind !== 'orphan') out.push({ t, input: c.usage.input, cached: Math.min(c.usage.cached, c.usage.input), call: c.index });
    }
    return out.sort((a, b) => a.t - b.t);
  }, [trace, getLocale()]);
  const maxInput = Math.max(1, ...inputs.map((p) => p.input));
  const ctxWindow = trace.meta.contextWindow;

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  useEffect(() => setView([0, 1]), [trace]);

  const xOf = (t: number) => {
    const f = scale.toV(t) / scale.total;
    return ((f - view[0]) / (view[1] - view[0])) * width;
  };

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = width * dpr;
    canvas.height = HEIGHT * dpr;
    const ctx = canvas.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, HEIGHT);
    const dark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    // gap markers
    ctx.strokeStyle = dark ? '#3f3f46' : '#d4d4d8';
    ctx.setLineDash([2, 3]);
    for (const g of scale.gaps) {
      const x = ((g / scale.total - view[0]) / (view[1] - view[0])) * width;
      if (x < 0 || x > width) continue;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, HEIGHT);
      ctx.stroke();
    }
    ctx.setLineDash([]);
    for (const sp of spans) {
      const x0 = xOf(sp.start);
      const x1 = Math.max(xOf(sp.end), x0 + (sp.kind === 'turn' ? 2 : 1.5));
      if (x1 < 0 || x0 > width) continue;
      const lane = LANES[sp.kind];
      ctx.fillStyle = sp.error ? '#ef4444' : sp.color;
      ctx.globalAlpha = sp.kind === 'turn' ? 0.5 : 0.85;
      ctx.fillRect(x0, lane.y, x1 - x0, lane.h);
      if (sp.kind === 'call' && sp.callIndex === selectedCall) {
        ctx.globalAlpha = 1;
        ctx.strokeStyle = dark ? '#fafafa' : '#18181b';
        ctx.lineWidth = 1.5;
        ctx.strokeRect(x0 - 1, lane.y - 1, x1 - x0 + 2, lane.h + 2);
      }
      const problem = sp.kind === 'call' ? problemCalls?.get(sp.callIndex) : undefined;
      if (problem) {
        ctx.globalAlpha = 1;
        ctx.fillStyle = problem === 'fact' ? '#ef4444' : '#8b5cf6';
        ctx.beginPath();
        ctx.arc((x0 + x1) / 2, lane.y - 2.5, 2, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.globalAlpha = 1;
    for (const m of marks) {
      const x = xOf(m.t);
      if (x < -5 || x > width + 5) continue;
      ctx.fillStyle = m.kind === 'compaction' ? '#8b5cf6' : m.kind === 'abort' ? '#f59e0b' : m.kind === 'rollback' ? '#0ea5e9' : '#ef4444';
      ctx.beginPath();
      ctx.moveTo(x, MARK_Y);
      ctx.lineTo(x - 4, MARK_Y + 8);
      ctx.lineTo(x + 4, MARK_Y + 8);
      ctx.closePath();
      ctx.fill();
    }
    // the input size of each step: a step line, filled (steps outside the view are clipped by the canvas)
    if (inputs.length) {
      const yOf = (v: number) => CTX.y + CTX.h - (v / maxInput) * CTX.h;
      ctx.beginPath();
      ctx.moveTo(xOf(inputs[0].t), CTX.y + CTX.h);
      let lastY = yOf(inputs[0].input);
      for (const [i, p] of inputs.entries()) {
        const x = xOf(p.t);
        if (i) ctx.lineTo(x, lastY);
        lastY = yOf(p.input);
        ctx.lineTo(x, lastY);
      }
      ctx.lineTo(xOf(inputs[inputs.length - 1].t), CTX.y + CTX.h);
      ctx.closePath();
      ctx.fillStyle = dark ? 'rgba(129,140,248,0.22)' : 'rgba(99,102,241,0.14)';
      ctx.fill();
      // the part read from the prompt cache, darker: a dip under the line is a cache miss
      ctx.beginPath();
      ctx.moveTo(xOf(inputs[0].t), CTX.y + CTX.h);
      let lastC = yOf(inputs[0].cached);
      for (const [i, p] of inputs.entries()) {
        const x = xOf(p.t);
        if (i) ctx.lineTo(x, lastC);
        lastC = yOf(p.cached);
        ctx.lineTo(x, lastC);
      }
      ctx.lineTo(xOf(inputs[inputs.length - 1].t), CTX.y + CTX.h);
      ctx.closePath();
      ctx.fillStyle = dark ? 'rgba(129,140,248,0.32)' : 'rgba(99,102,241,0.22)';
      ctx.fill();
      ctx.beginPath();
      for (const [i, p] of inputs.entries()) {
        const x = xOf(p.t);
        const y = yOf(p.input);
        if (!i) ctx.moveTo(x, y);
        else {
          ctx.lineTo(x, yOf(inputs[i - 1].input));
          ctx.lineTo(x, y);
        }
      }
      ctx.strokeStyle = dark ? '#818cf8' : '#6366f1';
      ctx.lineWidth = 1;
      ctx.stroke();
      const sel = inputs.find((p) => p.call === selectedCall);
      if (sel) {
        ctx.fillStyle = dark ? '#fafafa' : '#18181b';
        ctx.beginPath();
        ctx.arc(xOf(sel.t), yOf(sel.input), 2.5, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spans, marks, scale, width, view, selectedCall, problemCalls, inputs, maxInput]);

  const hit = (x: number, y: number): { span?: Span; mark?: Mark; ctx?: { call: number; input: number; cached: number } } => {
    if (y >= CTX.y - 1) {
      // the input-size lane: the step whose response is nearest
      let best: (typeof inputs)[number] | undefined;
      let bestD = 8;
      for (const p of inputs) {
        const d = Math.abs(xOf(p.t) - x);
        if (d < bestD) {
          bestD = d;
          best = p;
        }
      }
      return best ? { ctx: { call: best.call, input: best.input, cached: best.cached } } : {};
    }
    if (y >= MARK_Y - 2) {
      const mark = marks.find((m) => Math.abs(xOf(m.t) - x) < 6);
      if (mark) return { mark };
    }
    const lane = y < LANES.call.y - 1 ? 'turn' : y < LANES.tool.y - 1 ? 'call' : 'tool';
    let best: Span | undefined;
    let bestD = 6;
    for (const sp of spans) {
      if (sp.kind !== lane) continue;
      const x0 = xOf(sp.start);
      const x1 = Math.max(xOf(sp.end), x0 + 1.5);
      const d = x < x0 ? x0 - x : x > x1 ? x - x1 : 0;
      if (d < bestD) {
        bestD = d;
        best = sp;
      }
    }
    return { span: best };
  };

  const pos = (e: React.MouseEvent) => {
    const r = canvasRef.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  return (
    <div ref={wrapRef} className="group/tl relative select-none border-b border-zinc-200 bg-white px-0 dark:border-zinc-800 dark:bg-zinc-950">
      <canvas
        ref={canvasRef}
        style={{ width, height: HEIGHT, cursor: drag.current ? 'grabbing' : 'crosshair' }}
        onMouseMove={(e) => {
          const { x, y } = pos(e);
          if (drag.current) {
            const span = drag.current.view[1] - drag.current.view[0];
            let d = ((drag.current.x - x) / width) * span;
            d = Math.max(-drag.current.view[0], Math.min(1 - drag.current.view[1], d));
            setView([drag.current.view[0] + d, drag.current.view[1] + d]);
            return;
          }
          setHover({ x, ...hit(x, y) });
        }}
        onMouseLeave={() => {
          setHover(undefined);
          drag.current = null;
        }}
        onMouseDown={(e) => {
          drag.current = { x: pos(e).x, view };
        }}
        onMouseUp={(e) => {
          const moved = drag.current && Math.abs(drag.current.x - pos(e).x) > 3;
          drag.current = null;
          if (moved) return;
          const { x, y } = pos(e);
          const h = hit(x, y);
          if (h.span) onSelect(h.span.callIndex, h.span.toolId);
          else if (h.ctx) onSelect(h.ctx.call);
        }}
        onDoubleClick={() => setView([0, 1])}
        onWheel={(e) => {
          const { x } = pos(e);
          const span = view[1] - view[0];
          if (e.shiftKey) {
            let d = (e.deltaY / width) * span;
            d = Math.max(-view[0], Math.min(1 - view[1], d));
            setView([view[0] + d, view[1] + d]);
            return;
          }
          const f = view[0] + (x / width) * span;
          const factor = e.deltaY > 0 ? 1.25 : 0.8;
          const ns = Math.min(1, Math.max(0.0005, span * factor));
          let a = f - (x / width) * ns;
          a = Math.max(0, Math.min(1 - ns, a));
          setView([a, a + ns]);
        }}
      />
      {hover && (hover.span || hover.mark || hover.ctx) && (
        <div className="pointer-events-none absolute top-full z-20 mt-1 rounded border border-zinc-200 bg-white px-2 py-1 text-[11px] shadow-md dark:border-zinc-700 dark:bg-zinc-900" style={{ left: Math.min(hover.x, width - 260) }}>
          {hover.span && (
            <>
              <div className="font-medium">{hover.span.label}</div>
              <div className="text-zinc-500">{fmtDuration(hover.span.end - hover.span.start)}</div>
            </>
          )}
          {hover.mark && (
            <div>
              {{ compaction: tr("上下文压缩"), abort: tr("中断"), error: tr("错误"), rollback: tr("回滚") }[hover.mark.kind]}
              {hover.mark.detail ? `：${systemText(hover.mark.detail)}` : ''}
            </div>
          )}
          {hover.ctx && (
            <div>
              <span className="font-medium">Step {hover.ctx.call + 1}</span>{tr("的输入")}{fmtTokens(hover.ctx.input)}
              {ctxWindow ? <span className="text-zinc-500">{tr("（上下文窗口的")}{Math.round((hover.ctx.input / ctxWindow) * 100)}%）</span> : null}
              <div className="text-zinc-500">{tr("缓存命中")}{fmtTokens(hover.ctx.cached)}（{Math.round((hover.ctx.cached / Math.max(1, hover.ctx.input)) * 100)}%）
              </div>
            </div>
          )}
        </div>
      )}
      <div className="pointer-events-none absolute left-1 text-[9.5px] leading-none text-zinc-400" style={{ top: CTX.y }} title={tr("每一步的输入大小")}>{tr("输入 ≤")}{fmtTokens(maxInput)}
        {ctxWindow ? ` / ${fmtTokens(ctxWindow)}` : ''}
      </div>
      <div
        className={cx(
          'pointer-events-none absolute right-1 rounded bg-white/90 px-1 text-[10px] text-zinc-500 dark:bg-zinc-950/90',
          view[1] - view[0] < 0.999 ? '' : 'opacity-0 transition-opacity group-hover/tl:opacity-100',
        )}
        style={{ top: CTX.y }}
      >
        {view[1] - view[0] < 0.999 ? tr`缩放 ${(1 / (view[1] - view[0])).toFixed(1)}× · 双击复位` : tr("滚轮缩放 · 拖动平移 · j/k 上下一步")}
      </div>
    </div>
  );
}

import type { CallContextResponse, CompositionRow, ContextItem, ContextSeriesResponse } from '../../shared/api';
import type { LlmCall, SegmentCat, SessionTrace } from '../../shared/types';
import { weightedChars } from '../text';

/**
 * Context reconstruction and composition for one LLM call.
 *
 * Token estimates: weighted chars (CJK = 1, other = 1/4) × a per-session ratio
 * fitted by least squares on consecutive calls: Δinput_tokens ≈ ratio × Δweighted.
 * Whatever the base instructions and items don't explain is shown as tool
 * definitions / overhead.
 */

const prefixCache = new WeakMap<SessionTrace, number[][]>();
const ratioCache = new WeakMap<SessionTrace, number>();

/** Cumulative weighted chars per epoch: prefix[e][n] = Σ wchars of the first n items. */
function prefixSums(trace: SessionTrace): number[][] {
  let p = prefixCache.get(trace);
  if (!p) {
    p = trace.epochs.map((ep) => {
      const out = new Array<number>(ep.length + 1);
      out[0] = 0;
      for (let i = 0; i < ep.length; i++) out[i + 1] = out[i] + (trace.items[ep[i]]?.wchars ?? 0);
      return out;
    });
    prefixCache.set(trace, p);
  }
  return p;
}

export function viewWeight(trace: SessionTrace, call: LlmCall): number {
  return prefixSums(trace)[call.view.epoch]?.[call.view.len] ?? 0;
}

export function systemWeight(trace: SessionTrace): { chars: number; wchars: number } {
  const b = trace.meta.baseInstructions;
  if (!b || !b.chars) return { chars: 0, wchars: 0 };
  const sample = b.preview.length ? weightedChars(b.preview) / b.preview.length : 0.25;
  return { chars: b.chars, wchars: sample * b.chars };
}

export function sessionRatio(trace: SessionTrace): number {
  const cached = ratioCache.get(trace);
  if (cached !== undefined) return cached;
  let num = 0;
  let den = 0;
  let prev: LlmCall | undefined;
  for (const c of trace.calls) {
    if (!c.usage || c.kind !== 'response') continue;
    if (prev && prev.view.epoch === c.view.epoch && prev.usage) {
      const dT = c.usage.input - prev.usage.input;
      const dW = viewWeight(trace, c) - viewWeight(trace, prev);
      if (dW > 50 && dT > 0) {
        num += dT * dW;
        den += dW * dW;
      }
    }
    prev = c;
  }
  let ratio = den > 0 ? num / den : 1;
  if (!Number.isFinite(ratio) || ratio < 0.3 || ratio > 3) ratio = 1;
  ratioCache.set(trace, ratio);
  return ratio;
}

export function callInputIndices(trace: SessionTrace, call: LlmCall): number[] {
  return trace.epochs[call.view.epoch]?.slice(0, call.view.len) ?? [];
}

const producedCache = new WeakMap<SessionTrace, Map<number, number>>();

/** item index → the call whose response produced it. */
function producedBy(trace: SessionTrace): Map<number, number> {
  let m = producedCache.get(trace);
  if (!m) {
    m = new Map();
    for (const c of trace.calls) for (const i of c.outputItems) m.set(i, c.index);
    producedCache.set(trace, m);
  }
  return m;
}

/** The turn a record line belongs to (undefined before the first turn). */
export function turnOfLine(trace: SessionTrace, line: number): number | undefined {
  const turns = trace.turns;
  let lo = 0;
  let hi = turns.length - 1;
  let found: number | undefined;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const s = turns[mid].startLine;
    if (s === undefined || s <= line) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found === undefined ? undefined : turns[found].index;
}

function previousCall(trace: SessionTrace, call: LlmCall): LlmCall | undefined {
  for (let i = call.index - 1; i >= 0; i--) {
    const c = trace.calls[i];
    if (c.kind !== 'orphan') return c;
  }
  return undefined;
}

export function callContext(trace: SessionTrace, callIndex: number): CallContextResponse {
  const call = trace.calls[callIndex];
  if (!call) throw new Error(`no call ${callIndex}`);
  const ratio = sessionRatio(trace);
  const indices = callInputIndices(trace, call);
  const injected = new Set(call.injected);
  const prev = previousCall(trace, call);
  const prevSet = new Set(prev ? callInputIndices(trace, prev) : []);

  const produced = producedBy(trace);
  const toItem = (idx: number, isNew?: boolean): ContextItem => {
    const it = trace.items[idx];
    return {
      idx,
      kind: it.kind,
      role: it.role,
      name: it.name,
      callId: it.callId,
      cat: it.cat,
      chars: it.chars,
      estTokens: Math.round(it.wchars * ratio),
      preview: it.preview,
      ref: it.ref,
      injected: injected.has(idx) || undefined,
      isNew,
      turn: turnOfLine(trace, it.line),
      from: produced.get(idx),
      tool: it.callId && trace.tools[it.callId] ? it.callId : undefined,
    };
  };
  const items: ContextItem[] = indices.map((idx) => toItem(idx, prev ? !prevSet.has(idx) || undefined : undefined));
  // what the previous step had and this one has not: compacted away, rolled back
  const here = new Set(indices);
  const removed = prev ? [...prevSet].filter((i) => !here.has(i)).map((i) => toItem(i)) : [];

  const rows = new Map<CompositionRow['cat'], CompositionRow>();
  const add = (cat: CompositionRow['cat'], chars: number, est: number) => {
    const r = rows.get(cat) ?? { cat, chars: 0, estTokens: 0, items: 0 };
    r.chars += chars;
    r.estTokens += est;
    r.items += 1;
    rows.set(cat, r);
  };
  const sys = systemWeight(trace);
  if (sys.chars) add('system', sys.chars, Math.round(sys.wchars * ratio));
  for (const it of items) add(it.cat as SegmentCat, it.chars, it.estTokens);
  const explained = [...rows.values()].reduce((s, r) => s + r.estTokens, 0);
  const input = call.usage?.input;
  if (input && input > explained) rows.set('tools_overhead', { cat: 'tools_overhead', chars: 0, estTokens: input - explained, items: 0 });

  return {
    callIndex,
    fidelity: call.fidelity,
    inputTokens: input,
    cachedTokens: call.usage?.cached,
    ratio,
    composition: [...rows.values()].sort((a, b) => b.estTokens - a.estTokens),
    system: trace.meta.baseInstructions
      ? {
          preview: trace.meta.baseInstructions.preview,
          chars: sys.chars,
          estTokens: Math.round(sys.wchars * ratio),
          ref: trace.meta.baseInstructions.ref,
        }
      : undefined,
    items,
    newCount: items.filter((i) => i.isNew).length,
    prevCall: prev?.index,
    newTokens: prev ? items.filter((i) => i.isNew).reduce((s, i) => s + i.estTokens, 0) : undefined,
    removed: removed.length ? removed : undefined,
    removedTokens: removed.length ? removed.reduce((s, i) => s + i.estTokens, 0) : undefined,
    contextWindow: trace.meta.contextWindow,
  };
}

const seriesCache = new WeakMap<SessionTrace, ContextSeriesResponse>();

/**
 * Every step's composition, for the whole session at once: per epoch, the
 * category sums grow with the view's length (one pass over each epoch).
 */
export function contextSeries(trace: SessionTrace): ContextSeriesResponse {
  const hit = seriesCache.get(trace);
  if (hit) return hit;
  const ratio = sessionRatio(trace);
  const sys = systemWeight(trace);
  const cats: Array<CompositionRow['cat']> = [];
  const catIndex = new Map<string, number>();
  const indexOf = (cat: CompositionRow['cat']) => {
    let k = catIndex.get(cat);
    if (k === undefined) {
      k = cats.length;
      cats.push(cat);
      catIndex.set(cat, k);
    }
    return k;
  };
  if (sys.chars) indexOf('system');
  const steps = trace.calls.filter((c) => c.kind !== 'orphan');
  const byEpoch = new Map<number, LlmCall[]>();
  for (const c of steps) byEpoch.set(c.view.epoch, [...(byEpoch.get(c.view.epoch) ?? []), c]);
  const weights = new Map<number, number[]>();
  for (const [epoch, calls] of byEpoch) {
    const ep = trace.epochs[epoch] ?? [];
    const acc: number[] = [];
    let n = 0;
    for (const c of calls.sort((a, b) => a.view.len - b.view.len)) {
      for (const len = Math.min(c.view.len, ep.length); n < len; n++) {
        const it = trace.items[ep[n]];
        if (!it) continue;
        const k = indexOf(it.cat);
        acc[k] = (acc[k] ?? 0) + it.wchars;
      }
      weights.set(c.index, [...acc]);
    }
  }
  const raw = steps.map((c) => {
    const w = weights.get(c.index) ?? [];
    const v = cats.map((cat, k) => Math.round((cat === 'system' ? sys.wchars : (w[k] ?? 0)) * ratio));
    const explained = v.reduce((s, x) => s + x, 0);
    return { c, v, over: c.usage && c.usage.input > explained ? c.usage.input - explained : 0 };
  });
  const overhead = raw.some((r) => r.over > 0);
  const res: ContextSeriesResponse = {
    cats: overhead ? [...cats, 'tools_overhead'] : cats,
    points: raw.map(({ c, v, over }) => ({ call: c.index, input: c.usage?.input, cached: c.usage?.cached, v: overhead ? [...v, over] : v })),
    contextWindow: trace.meta.contextWindow,
  };
  seriesCache.set(trace, res);
  return res;
}

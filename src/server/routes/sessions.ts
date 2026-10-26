import { Hono } from 'hono';
import { callContext, callInputIndices, contextSeries } from '../../core/analysis/context';
import type { ContextSearchResponse, SessionListResponse, TraceResponse } from '../../shared/api';
import { toolSummary } from '../../shared/tools';
import type { SessionTrace, TextRef, ToolBrief, ToolCall, TraceView } from '../../shared/types';
import { readBlob, readRaw, readText, type ParsedEntry } from '../services/parseCache';
import { NotFound, parsedSession } from '../services/sessions';
import { indexStatus, sessionsWithSignal, summaryOf, type SignalKind } from '../services/indexer';
import { currentAgent, sources } from '../sources/registry';
import { getSession, listSessions, rootOf, sessionTree, sourceInfos } from '../services/stateDb';

export const sessionRoutes = new Hono();

function num(v: string | undefined): number | undefined {
  if (v === undefined || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

export function toolBrief(t: ToolCall): ToolBrief {
  const { args, argsJson, output, inner, ...rest } = t;
  return {
    ...rest,
    summary: toolSummary(t),
    argsChars: args.chars,
    outputChars: output?.chars,
    inner: inner.map(({ kind, type, line, ts, link, title, status, exitCode, durationMs, isError }) => ({ kind, type, line, ts, link, title, status, exitCode, durationMs, isError })),
  };
}

export function toView(trace: SessionTrace): TraceView {
  const { items, epochs, tools, listings, invocations, orphanEvents, ...rest } = trace;
  const briefs: Record<string, ToolBrief> = {};
  for (const [id, t] of Object.entries(tools)) briefs[id] = toolBrief(t);
  return { ...rest, tools: briefs, itemCount: items.length, epochCount: epochs.length };
}

sessionRoutes.get('/', (c) => {
  const q = c.req.query();
  const all = listSessions({
    q: q.q,
    cwd: q.cwd,
    model: q.model,
    from: num(q.from),
    to: num(q.to),
    source: q.src || undefined,
    includeSubagents: q.sub === '1' || Boolean(q.skill) || Boolean(q.signal),
    limit: Number.MAX_SAFE_INTEGER,
  }).sessions.map((s) => ({ ...s, summary: summaryOf(s.id) }));
  // signal=<listed|loaded|missed|truncated>:<skill>
  const [kind, ...rest] = (q.signal ?? '').split(':');
  const withSignal = q.signal && ['listed', 'loaded', 'missed', 'truncated'].includes(kind) && rest.length ? sessionsWithSignal(kind as SignalKind, rest.join(':')) : undefined;
  const filtered = all.filter((s) => {
    if (q.errors === '1' && !(s.summary && s.summary.toolErrors > 0)) return false;
    if (q.skill && !s.summary?.skills.includes(q.skill)) return false;
    if (withSignal && !withSignal.has(s.id)) return false;
    return true;
  });
  // sessions whose record file is gone are listed apart (missing=exclude / only), so they cannot crowd out the readable ones
  const missing = filtered.filter((s) => !s.rolloutExists).length;
  const shown = q.missing === 'exclude' ? filtered.filter((s) => s.rolloutExists) : q.missing === 'only' ? filtered.filter((s) => !s.rolloutExists) : filtered;
  const offset = num(q.offset) ?? 0;
  const res: SessionListResponse = { sessions: shown.slice(offset, offset + (num(q.limit) ?? 500)), total: shown.length, missing, sources: sourceInfos() };
  return c.json(res);
});

sessionRoutes.get('/_index/status', (c) => c.json(indexStatus()));

sessionRoutes.get('/:id', (c) => {
  const s = getSession(c.req.param('id'));
  if (!s) throw new NotFound('会话不存在');
  return c.json(s);
});

sessionRoutes.get('/:id/tree', (c) => {
  const tree = sessionTree(rootOf(c.req.param('id')));
  if (!tree) throw new NotFound('会话不存在');
  return c.json(tree);
});

sessionRoutes.get('/:id/trace', async (c) => {
  const id = c.req.param('id');
  const entry = await parsedSession(id);
  const s = getSession(id);
  const multi = sources().length > 1;
  const body: TraceResponse = {
    ...toView(entry.trace),
    title: s?.title,
    agent: currentAgent(),
    ...(multi && s?.sourceId ? { sourceId: s.sourceId, sourceLabel: s.sourceLabel } : {}),
  };
  return c.json(body);
});

/** A tool call in full: arguments, output, inner events with their output (the step list only has briefs). */
sessionRoutes.get('/:id/tools/:toolId', async (c) => {
  const entry = await parsedSession(c.req.param('id'));
  const tool = entry.trace.tools[c.req.param('toolId')];
  if (!tool) throw new NotFound('工具调用不存在');
  return c.json(tool);
});

sessionRoutes.get('/:id/calls/:index/context', async (c) => {
  const entry = await parsedSession(c.req.param('id'));
  return c.json(callContext(entry.trace, Number(c.req.param('index'))));
});

sessionRoutes.get('/:id/context-series', async (c) => {
  const entry = await parsedSession(c.req.param('id'));
  return c.json(contextSeries(entry.trace));
});

// ------------------------------------------------------------------ search a step's input

/** Full texts of context items, kept for repeated searches (most recently used, up to a budget). */
const textCache = new Map<string, string>();
let textCacheChars = 0;
const TEXT_CACHE_CHARS = 48 * 1024 * 1024;
/** One search reads at most this much text it does not have yet. */
const SEARCH_READ_CHARS = 64 * 1024 * 1024;

async function fullText(entry: ParsedEntry, ref: TextRef): Promise<string> {
  const key = `${entry.path}#${entry.key}#${ref.line}#${ref.ptr}#${ref.json ?? ''}`;
  const hit = textCache.get(key);
  if (hit !== undefined) {
    textCache.delete(key);
    textCache.set(key, hit);
    return hit;
  }
  const { text } = await readText(entry, ref);
  textCache.set(key, text);
  textCacheChars += text.length;
  while (textCacheChars > TEXT_CACHE_CHARS && textCache.size > 1) {
    const [k, v] = textCache.entries().next().value!;
    textCache.delete(k);
    textCacheChars -= v.length;
  }
  return text;
}

/** Where a word appears in a step's input — the full texts, not only the previews (-1: the system prompt). */
sessionRoutes.get('/:id/calls/:index/context/search', async (c) => {
  const entry = await parsedSession(c.req.param('id'));
  const q = (c.req.query('q') ?? '').trim().toLowerCase();
  const res: ContextSearchResponse = { hits: [], skipped: 0 };
  if (!q) return c.json(res);
  const call = entry.trace.calls[Number(c.req.param('index'))];
  if (!call) throw new NotFound('没有这一步');
  let budget = SEARCH_READ_CHARS;
  const scan = (idx: number, text: string) => {
    const lower = text.toLowerCase();
    let at = lower.indexOf(q);
    if (at === -1) return;
    const first = at;
    let count = 0;
    while (at !== -1 && count < 999) {
      count++;
      at = lower.indexOf(q, at + q.length);
    }
    const from = Math.max(0, first - 60);
    const snippet = `${from ? '…' : ''}${text.slice(from, first + q.length + 100).replace(/\s+/g, ' ')}${first + q.length + 100 < text.length ? '…' : ''}`;
    res.hits.push({ idx, count, snippet });
  };
  const read = async (preview: string, chars: number, ref: TextRef | undefined, idx: number) => {
    if (chars <= preview.length || !ref) return scan(idx, preview);
    if (budget <= 0) {
      if (preview.toLowerCase().includes(q)) scan(idx, preview);
      else res.skipped++;
      return;
    }
    const text = await fullText(entry, ref);
    budget -= text.length;
    scan(idx, text);
  };
  const base = entry.trace.meta.baseInstructions;
  if (base) await read(base.preview, base.chars, base.ref, -1);
  for (const idx of callInputIndices(entry.trace, call)) {
    const it = entry.trace.items[idx];
    await read(it.preview, it.chars, it.ref, idx);
  }
  return c.json(res);
});

sessionRoutes.get('/:id/text', async (c) => {
  const entry = await parsedSession(c.req.param('id'));
  const line = num(c.req.query('line'));
  const ptr = c.req.query('ptr');
  if (line === undefined || ptr === undefined) return c.json({ error: 'line and ptr required' }, 400);
  return c.json(await readText(entry, { line, ptr, json: c.req.query('json') || undefined }));
});

sessionRoutes.get('/:id/raw', async (c) => {
  const entry = await parsedSession(c.req.param('id'));
  const line = num(c.req.query('line'));
  if (line === undefined) return c.json({ error: 'line required' }, 400);
  return c.json(await readRaw(entry, line));
});

sessionRoutes.get('/:id/blob/:line/:k', async (c) => {
  const entry = await parsedSession(c.req.param('id'));
  const blob = await readBlob(entry, Number(c.req.param('line')), Number(c.req.param('k')));
  if (!blob) throw new NotFound('blob 不存在');
  return new Response(new Uint8Array(blob.data), { headers: { 'content-type': blob.mime, 'cache-control': 'max-age=3600' } });
});

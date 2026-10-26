import { getLocale, tr } from '../../shared/i18n';
import { useLocale } from '../../shared/i18n/react';
import { useQuery } from '@tanstack/react-query';
import { defaultRangeExtractor, useVirtualizer, type Range } from '@tanstack/react-virtual';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ContextItem, ContextSearchResponse, EvidenceHit } from '../../shared/api';
import type { TraceView } from '../../shared/types';
import { api, useCallContext, useContextSeries, useEvidence, useTrace } from '../lib/api';
import { fmtTokens } from '../lib/format';
import { CAT_META } from '../lib/meta';
import { ContextTrend } from './ContextTrend';
import { Highlight, SOURCE_LABEL } from './Evidence';
import { LazyText } from './LazyText';
import { Badge, Empty, ErrorBox, Spinner, cx } from './ui';

type Jump = (callIndex: number, toolId?: string) => void;

function useDebounced<T>(v: T, ms: number): T {
  const [d, setD] = useState(v);
  useEffect(() => {
    const t = setTimeout(() => setD(v), ms);
    return () => clearTimeout(t);
  }, [v, ms]);
  return d;
}

function HitSnippet({ hit, best }: { hit: EvidenceHit; best: number }) {
  useLocale();
  return (
    <div className="mt-1 flex items-start gap-1.5">
      <div className="mt-1 h-1.5 w-10 shrink-0 overflow-hidden rounded bg-zinc-200 dark:bg-zinc-700" title={tr`相关度 ${hit.score}`}>
        <div className="h-full bg-amber-500" style={{ width: `${Math.max(8, Math.round((hit.score / best) * 100))}%` }} />
      </div>
      <pre className="max-h-32 min-w-0 flex-1 overflow-auto whitespace-pre-wrap break-words rounded bg-amber-50/60 p-1 font-mono text-[11px] dark:bg-amber-950/20">
        <span className="text-zinc-400">{tr("行")}{hit.lineStart}-{hit.lineEnd}：
        </span>
        <Highlight text={hit.snippet} words={hit.matched} />
      </pre>
    </div>
  );
}

/** Where an item came from: the step whose response wrote it, or the tool call whose output it is. */
function Origin({ item, trace, onJump }: { item: ContextItem; trace?: TraceView; onJump?: Jump }) {
  useLocale();
  const tool = item.tool ? trace?.tools[item.tool] : undefined;
  const step = item.from ?? tool?.callIndex;
  if (step === undefined || !onJump) return null;
  const output = item.from === undefined && tool;
  return (
    <button
      className="shrink-0 rounded px-1 font-mono text-[10.5px] text-indigo-600 hover:bg-indigo-50 dark:text-indigo-400 dark:hover:bg-indigo-950/50"
      title={output ? tr`Step ${step + 1} 调用 ${tool.name} 的输出：跳到那一步` : tr`Step ${step + 1} 的输出：跳到那一步`}
      onClick={(e) => {
        e.stopPropagation();
        onJump(step, tool?.id);
      }}
    >
      {output ? '←' : ''}Step {step + 1}
    </button>
  );
}

function ItemRow({
  sessionId,
  item,
  trace,
  maxTokens,
  onJump,
  hit,
  best,
  match,
  query,
  removed,
  open,
  onToggle,
}: {
  sessionId: string;
  item: ContextItem;
  trace?: TraceView;
  maxTokens: number;
  onJump?: Jump;
  hit?: EvidenceHit;
  best?: number;
  /** A full-text search match in this item. */
  match?: { count: number; snippet: string };
  query?: string;
  removed?: boolean;
  /** Expanded (kept by the list: rows scrolled away are unmounted). */
  open: boolean;
  onToggle: () => void;
}) {
  useLocale();
  const meta = CAT_META[item.cat] ?? CAT_META.other;
  const isCall = item.cat === 'tool_call' || item.kind === 'function_call' || item.kind === 'custom_tool_call';
  return (
    <div
      className={cx(
        'border-b border-zinc-100 px-2 py-1 dark:border-zinc-800/80',
        item.isNew && !removed && 'bg-emerald-50/50 dark:bg-emerald-950/20',
        removed && 'bg-red-50/40 dark:bg-red-950/15',
        best !== undefined && !hit && 'opacity-50',
      )}
    >
      <div className="flex cursor-pointer items-center gap-1.5" onClick={onToggle}>
        <span className="w-2.5 shrink-0 text-[9px] text-zinc-400">{open ? '▾' : '▸'}</span>
        <span className="h-2.5 w-2.5 shrink-0 rounded-sm" style={{ background: meta.color }} title={meta.label} />
        <span className="shrink-0 text-[11px] text-zinc-500">{meta.label}</span>
        {item.name && <span className="shrink-0 font-mono text-[11px]">{item.name}</span>}
        {item.isNew && !removed && <Badge tone="green">{tr("新增")}</Badge>}
        {item.injected && <Badge tone="zinc">{tr("随响应注入")}</Badge>}
        <Origin item={item} trace={trace} onJump={onJump} />
        <span className={cx('min-w-0 flex-1 truncate text-[12px] text-zinc-600 dark:text-zinc-300', removed && 'line-through decoration-red-400/60')}>{item.preview.replace(/\s+/g, ' ').slice(0, 200)}</span>
        {match && match.count > 1 && <span className="shrink-0 text-[10.5px] text-amber-600">×{match.count}</span>}
        <span className="flex w-16 shrink-0 items-center justify-end gap-1" title={tr`≈${item.estTokens.toLocaleString()} tokens · ${item.chars.toLocaleString()} 字`}>
          <span className="h-1 w-6 overflow-hidden rounded bg-zinc-100 dark:bg-zinc-800">
            <span className="block h-full rounded" style={{ width: `${Math.max(4, Math.round((item.estTokens / maxTokens) * 100))}%`, background: meta.color }} />
          </span>
          <span className="font-mono text-[10.5px] text-zinc-400">{fmtTokens(item.estTokens)}</span>
        </span>
      </div>
      {match && !open && (
        <div className="ml-4 mt-0.5 truncate font-mono text-[11px] text-zinc-500" title={match.snippet}>
          <Highlight text={match.snippet} words={query ? [query] : []} />
        </div>
      )}
      {hit && best !== undefined && !open && <HitSnippet hit={hit} best={best} />}
      {open && (
        <LazyText
          className="ml-4 mt-1"
          sessionId={sessionId}
          txt={{ preview: item.preview, chars: item.chars, ref: item.chars > item.preview.length ? item.ref : undefined }}
          maxHeight="max-h-96"
          json={isCall}
          copy
        />
      )}
    </div>
  );
}

const TREND_KEY = 'kifu.ctx.trend';

type Row =
  | { type: 'disk'; hit: EvidenceHit; key: string }
  | { type: 'system'; key: string }
  | { type: 'group'; g: Group; key: string }
  | { type: 'item'; it: ContextItem; removed?: boolean; key: string };

interface Group {
  key: string;
  turn?: number;
  items: ContextItem[];
  tokens: number;
  newCount: number;
}

/**
 * What the model saw at a step: its input, as the agent's history had it then.
 * By default grouped by the turn each part entered the context (the opening
 * context — system, permissions, skill list, AGENTS.md — first); each part
 * links back to the step that produced it. Search reads full texts; with a
 * tool call selected, the relevance view ranks the context by how much of the
 * call's arguments each part contains (BM25) — where the call most likely came
 * from. Compared with the step before: what is new, and what a compaction or
 * rollback removed.
 */
export function ContextPanel({
  sessionId,
  callIndex,
  toolId,
  toolName,
  onJump,
}: {
  sessionId: string;
  callIndex: number | undefined;
  toolId?: string;
  toolName?: string;
  onJump?: Jump;
}) {
  useLocale();
  const { data, isLoading, error } = useCallContext(sessionId, callIndex);
  const trace = useTrace(sessionId).data;
  const series = useContextSeries(sessionId, trace?.calls.length);
  const [trend, setTrend] = useState(() => {
    try {
      return localStorage.getItem(TREND_KEY) !== '0';
    } catch {
      return true;
    }
  });
  const [filter, setFilter] = useState<string>();
  const [onlyNew, setOnlyNew] = useState(false);
  const [bySize, setBySize] = useState(false);
  const [showRemoved, setShowRemoved] = useState(false);
  const [byRelevance, setByRelevance] = useState(true);
  const [q, setQ] = useState('');
  const dq = useDebounced(q.trim(), 300);
  const relevance = Boolean(toolId) && byRelevance;
  const evidence = useEvidence(sessionId, relevance ? toolId : undefined);
  const search = useQuery({
    queryKey: ['contextSearch', sessionId, callIndex, dq],
    queryFn: () => api<ContextSearchResponse>(`/sessions/${sessionId}/calls/${callIndex}/context/search?q=${encodeURIComponent(dq)}`),
    enabled: dq.length >= 2 && callIndex !== undefined,
    staleTime: Infinity,
  });
  const searching = dq.length >= 2;
  const hits = useMemo(() => {
    const m = new Map<number, EvidenceHit>();
    for (const h of evidence.data?.hits ?? []) if (h.itemIdx !== undefined && !m.has(h.itemIdx)) m.set(h.itemIdx, h);
    return m;
  }, [evidence.data, getLocale()]);
  const matches = useMemo(() => new Map((search.data?.hits ?? []).map((h) => [h.idx, h])), [search.data, getLocale()]);
  const best = Math.max(1, ...(evidence.data?.hits ?? []).map((h) => h.score));
  // the turn of the selected step (expanded by default), and groups the user opened or closed
  const turnOfCall = useMemo(() => {
    if (!trace || callIndex === undefined) return undefined;
    return trace.turns.find((t) => t.calls.includes(callIndex))?.index;
  }, [trace, callIndex, getLocale()]);
  const [toggled, setToggled] = useState<Set<string>>(new Set());
  const [allOpen, setAllOpen] = useState<boolean>();
  // expanded rows, kept here: the list is virtualized (rows scrolled away are unmounted)
  const [openRows, setOpenRows] = useState<Set<string>>(new Set());
  useEffect(() => {
    setToggled(new Set());
    setAllOpen(undefined);
    setShowRemoved(false);
    setOpenRows(new Set());
  }, [callIndex]);

  const flat = relevance || searching || Boolean(filter) || onlyNew || bySize || showRemoved;
  const list = useMemo(() => {
    let items = showRemoved ? (data?.removed ?? []) : (data?.items ?? []);
    if (filter) items = items.filter((i) => i.cat === filter);
    if (onlyNew && !showRemoved) items = items.filter((i) => i.isNew);
    if (searching) items = items.filter((i) => matches.has(i.idx));
    if (relevance && hits.size) items = [...items].sort((a, b) => (hits.get(b.idx)?.score ?? -1) - (hits.get(a.idx)?.score ?? -1));
    else if (bySize) items = [...items].sort((a, b) => b.estTokens - a.estTokens);
    return items;
  }, [data, filter, onlyNew, searching, matches, relevance, hits, bySize, showRemoved, getLocale()]);
  const groups = useMemo<Group[]>(() => {
    const out: Group[] = [];
    for (const it of data?.items ?? []) {
      const key = it.turn === undefined ? 'start' : `t${it.turn}`;
      let g = out[out.length - 1];
      if (!g || g.key !== key) {
        g = { key, turn: it.turn, items: [], tokens: 0, newCount: 0 };
        out.push(g);
      }
      g.items.push(it);
      g.tokens += it.estTokens;
      if (it.isNew) g.newCount++;
    }
    return out;
  }, [data, getLocale()]);
  const maxTokens = Math.max(1, ...(data?.items ?? []).map((i) => i.estTokens));
  const many = (data?.items.length ?? 0) > 40;
  // collapsed by default: earlier turns of a long context (the opening context, the current turn and turns with new parts stay open)
  const isOpen = useCallback(
    (g: Group) => {
      const def = allOpen ?? (!many || g.key === 'start' || g.turn === turnOfCall || g.newCount > 0);
      return toggled.has(g.key) ? !def : def;
    },
    [allOpen, many, turnOfCall, toggled],
  );
  const showSystem = Boolean(data?.system) && !filter && !onlyNew && !relevance && !showRemoved && (!searching || matches.has(-1));
  const rows = useMemo<Row[]>(() => {
    const out: Row[] = [];
    if (relevance) (evidence.data?.hits ?? []).forEach((h, i) => h.itemIdx === undefined && out.push({ type: 'disk', hit: h, key: `d${i}` }));
    if (showSystem) out.push({ type: 'system', key: 'system' });
    if (flat) for (const it of list) out.push({ type: 'item', it, removed: showRemoved, key: `${showRemoved ? 'r' : 'i'}${it.idx}` });
    else
      for (const g of groups) {
        out.push({ type: 'group', g, key: `g:${g.key}` });
        if (isOpen(g)) for (const it of g.items) out.push({ type: 'item', it, key: `i${it.idx}` });
      }
    return out;
  }, [relevance, evidence.data, showSystem, flat, list, showRemoved, groups, isOpen, getLocale()]);
  // the header of the turn being read stays on top while its parts scroll by
  const parentRef = useRef<HTMLDivElement>(null);
  const stickyIdx = useMemo(() => rows.flatMap((r, i) => (r.type === 'group' ? [i] : [])), [rows, getLocale()]);
  const activeSticky = useRef(-1);
  const rangeExtractor = useCallback(
    (range: Range) => {
      activeSticky.current = [...stickyIdx].reverse().find((i) => range.startIndex >= i) ?? -1;
      const next = new Set(defaultRangeExtractor(range));
      if (activeSticky.current >= 0) next.add(activeSticky.current);
      return [...next].sort((a, b) => a - b);
    },
    [stickyIdx],
  );
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: (i) => {
      const r = rows[i];
      if (r.type === 'group') return 27;
      if (r.type === 'system') return 27;
      if (r.type === 'disk') return 72;
      return 29 + (openRows.has(r.key) ? 220 : 0) + (searching && matches.has(r.it.idx) ? 17 : 0) + (relevance && hits.has(r.it.idx) ? 46 : 0);
    },
    overscan: 12,
    rangeExtractor,
    getItemKey: (i) => rows[i].key,
  });
  const toggleRow = useCallback(
    (key: string) =>
      setOpenRows((s) => {
        const n = new Set(s);
        if (n.has(key)) n.delete(key);
        else n.add(key);
        return n;
      }),
    [],
  );

  if (callIndex === undefined) return <Empty>{tr("在左侧选择一个 Step，查看模型在这次调用时看到的输入")}</Empty>;
  if (isLoading) return <div className="p-3"><Spinner label={tr("重建输入上下文…")} /></div>;
  if (error) return <ErrorBox error={error} />;
  if (!data) return null;
  const totalEst = data.composition.reduce((s, r) => s + r.estTokens, 0) || 1;
  const used = data.inputTokens ?? totalEst;
  // what the reconstruction explains, against what the agent reported sending
  const explained = data.composition.reduce((s, r) => s + (r.cat === 'tools_overhead' ? 0 : r.estTokens), 0);
  const overReconstructed = data.inputTokens !== undefined && explained > data.inputTokens * 1.5 && explained - data.inputTokens > 5000;
  const toggle = (key: string) =>
    setToggled((s) => {
      const n = new Set(s);
      if (n.has(key)) n.delete(key);
      else n.add(key);
      return n;
    });
  const groupTitle = (g: Group) => {
    if (g.turn === undefined) return tr("会话开始");
    const t = trace?.turns[g.turn];
    return tr`第 ${g.turn + 1} 轮${g.turn === turnOfCall ? tr("（这一步所在）") : ''}${t?.input?.preview ? ` · ${t.input.preview.replace(/\s+/g, ' ')}` : ''}`;
  };
  const rowProps = { sessionId, trace, maxTokens, onJump };

  return (
    <div className="flex h-full flex-col">
      <div className="space-y-1.5 border-b border-zinc-200 p-2 dark:border-zinc-800">
        <div className="flex items-center gap-2 text-[12px]">
          <span className="font-medium">Step {callIndex + 1}{tr("的输入")}</span>
          <Badge tone={data.fidelity === 'exact' ? 'green' : 'zinc'} title={data.fidelity === 'exact' ? tr("模型收到的原始请求") : tr("由会话记录重建，不含工具定义")}>
            {data.fidelity === 'exact' ? tr("精确") : tr("重建")}
          </Badge>
          <span className="flex-1" />
          <span className="font-mono text-[11px] text-zinc-500" title={tr("这一步模型实际收到的输入 token（agent 记录的用量）")}>
            {fmtTokens(data.inputTokens)} in
            {data.cachedTokens ? tr` · ${fmtTokens(data.cachedTokens)} 缓存（${Math.round((data.cachedTokens / Math.max(1, data.inputTokens ?? 1)) * 100)}%）` : ''}
          </span>
        </div>
        {data.contextWindow ? (
          <div className="flex items-center gap-2 text-[11px] text-zinc-500" title={tr`上下文窗口 ${data.contextWindow.toLocaleString()} tokens`}>
            <span className="shrink-0">{tr("上下文窗口")}</span>
            <div className="h-1.5 flex-1 overflow-hidden rounded bg-zinc-100 dark:bg-zinc-800">
              <div className={cx('h-full rounded', used / data.contextWindow > 0.8 ? 'bg-red-500' : used / data.contextWindow > 0.6 ? 'bg-amber-500' : 'bg-indigo-500')} style={{ width: `${Math.min(100, (used / data.contextWindow) * 100)}%` }} />
            </div>
            <span className="shrink-0 font-mono">
              {Math.round((used / data.contextWindow) * 100)}% / {fmtTokens(data.contextWindow)}
            </span>
          </div>
        ) : null}
        {data.prevCall !== undefined && (
          <div className="flex flex-wrap items-center gap-x-2 text-[11px] text-zinc-500">
            <span>{tr("比 Step")}{data.prevCall + 1}：</span>
            <button className={cx('rounded px-1', onlyNew ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/50 dark:text-emerald-200' : 'text-emerald-700 hover:bg-emerald-50 dark:text-emerald-400 dark:hover:bg-emerald-950/40')} onClick={() => setOnlyNew(!onlyNew)} title={tr("只看新增的部分")}>
              +{data.newCount}{tr("条 ≈")}{fmtTokens(data.newTokens ?? 0)}
            </button>
            {data.removed?.length ? (
              <button className={cx('rounded px-1', showRemoved ? 'bg-red-100 text-red-800 dark:bg-red-900/50 dark:text-red-200' : 'text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950/40')} onClick={() => setShowRemoved(!showRemoved)} title={tr("上一步有、这一步没有的部分（被压缩成摘要，或回滚掉了）")}>
                −{data.removed.length}{tr("条 ≈")}{fmtTokens(data.removedTokens ?? 0)}{tr("（被压缩 / 回滚）")}</button>
            ) : null}
          </div>
        )}
        {overReconstructed && (
          <div className="rounded bg-amber-50 px-1.5 py-1 text-[11px] text-amber-900 dark:bg-amber-950/30 dark:text-amber-200" title={tr("token 是按字数估算的，误差通常在两成以内；差得这么多，是请求里少了历史")}>{tr("这一步实际输入")}{fmtTokens(data.inputTokens)}{tr("，按记录重建出的上下文约")}{fmtTokens(explained)}{tr("：agent 发送时省略或截断了部分历史（例如换模型 / provider 之后），下面的条目不一定都发给了模型。")}</div>
        )}
        {series.data && series.data.points.length > 1 && (
          <div>
            <button
              className="flex items-center gap-1 text-[11px] text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200"
              onClick={() => {
                setTrend(!trend);
                try {
                  localStorage.setItem(TREND_KEY, trend ? '0' : '1');
                } catch {
                  // not remembered
                }
              }}
              title={tr("整个会话每一步的输入，按类别堆叠（压缩后会掉下来）；点一列跳到那一步")}
            >
              <span className="w-2.5 text-[9px] text-zinc-400">{trend ? '▾' : '▸'}</span>{tr("各步的输入构成（")}{series.data.points.length}{tr("步）")}</button>
            {trend && (
              <div className="mt-0.5">
                <ContextTrend series={series.data} selected={callIndex} filter={filter} onJump={onJump ? (c) => onJump(c) : undefined} />
              </div>
            )}
          </div>
        )}
        <div className="flex h-3 w-full overflow-hidden rounded">
          {data.composition.map((r) => (
            <div
              key={r.cat}
              title={`${CAT_META[r.cat]?.label ?? r.cat} ≈ ${fmtTokens(r.estTokens)} tokens (${Math.round((r.estTokens / totalEst) * 100)}%)`}
              onClick={() => r.cat !== 'tools_overhead' && r.cat !== 'system' && setFilter(filter === r.cat ? undefined : r.cat)}
              className="h-full cursor-pointer"
              style={{ width: `${(r.estTokens / totalEst) * 100}%`, background: CAT_META[r.cat]?.color ?? '#d4d4d8', opacity: filter && filter !== r.cat ? 0.3 : 1 }}
            />
          ))}
        </div>
        <div className="flex flex-wrap gap-x-2.5 gap-y-0.5">
          {data.composition.map((r) => (
            <button
              key={r.cat}
              onClick={() => r.cat !== 'tools_overhead' && r.cat !== 'system' && setFilter(filter === r.cat ? undefined : r.cat)}
              className={cx('flex items-center gap-1 text-[11px]', filter === r.cat ? 'font-semibold' : 'text-zinc-500')}
              title={r.cat === 'tools_overhead' ? tr("实际输入里，重建出的内容解释不了的部分：工具定义、格式开销等") : tr`${r.items} 条，点击只看这一类`}
            >
              <span className="h-2 w-2 rounded-sm" style={{ background: CAT_META[r.cat]?.color }} />
              {CAT_META[r.cat]?.label ?? r.cat} {fmtTokens(r.estTokens)}
            </button>
          ))}
        </div>
        {toolId && (
          <div className="flex items-center gap-2 rounded bg-amber-50 px-1.5 py-1 text-[11px] text-amber-900 dark:bg-amber-950/30 dark:text-amber-200">
            <label className="flex items-center gap-1">
              <input type="checkbox" checked={byRelevance} onChange={(e) => setByRelevance(e.target.checked)} />{tr("按与")}<span className="font-mono">{toolName ?? tr("这次工具调用")}</span>{tr("的相关度排列")}</label>
            {relevance && evidence.isLoading && <Spinner />}
            {relevance && evidence.data && (
              <span className="min-w-0 flex-1 truncate text-amber-700 dark:text-amber-300" title={evidence.data.query.join('、')}>
                {evidence.data.hits.length ? tr`${evidence.data.hits.length} 处相关，查询词：${evidence.data.query.slice(0, 8).join('、')}` : tr("没有明显的词法来源")}
              </span>
            )}
          </div>
        )}
        <div className="flex items-center gap-2 text-[11px] text-zinc-500">
          <div className="relative min-w-0 flex-1">
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => e.key === 'Escape' && setQ('')}
              placeholder={tr("搜索这一步的输入（含全文）…")}
              className="w-full rounded border border-zinc-300 bg-white px-1.5 py-0.5 text-[11.5px] outline-none focus:border-indigo-500 dark:border-zinc-700 dark:bg-zinc-900"
            />
            {searching && (
              <span className="pointer-events-none absolute right-1.5 top-0.5 text-[10.5px] text-zinc-400">
                {search.isFetching ? '…' : tr`${search.data?.hits.length ?? 0} 处${search.data?.skipped ? tr`（${search.data.skipped} 条太大未读）` : ''}`}
              </span>
            )}
          </div>
          <label className="flex shrink-0 items-center gap-1" title={tr("按估算 token 从大到小排列")}>
            <input type="checkbox" checked={bySize} onChange={(e) => setBySize(e.target.checked)} />{tr("按大小")}</label>
          {!flat && many && (
            <button className="shrink-0 text-indigo-600 hover:underline dark:text-indigo-400" onClick={() => {
              setAllOpen(!(allOpen ?? false));
              setToggled(new Set());
            }}>
              {allOpen ? tr("收起各轮") : tr("展开全部")}
            </button>
          )}
          <span className="shrink-0 text-zinc-400" title={tr("tokens ≈ 系数 × 加权字数（中文 1、其他 1/4），按会话拟合；每条的 token 是估算")}>
            ×{data.ratio.toFixed(2)}
          </span>
          {(filter || onlyNew || showRemoved) && (
            <button
              className="shrink-0 text-indigo-600 hover:underline dark:text-indigo-400"
              onClick={() => {
                setFilter(undefined);
                setOnlyNew(false);
                setShowRemoved(false);
              }}
            >{tr("清除筛选")}</button>
          )}
        </div>
      </div>
      <div ref={parentRef} className="min-h-0 flex-1 overflow-auto">
        <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
          {virtualizer.getVirtualItems().map((v) => {
            const row = rows[v.index];
            const sticky = activeSticky.current === v.index;
            return (
              <div
                key={v.key}
                data-index={v.index}
                ref={virtualizer.measureElement}
                style={sticky ? { position: 'sticky', top: 0, zIndex: 10 } : { position: 'absolute', top: 0, left: 0, width: '100%', transform: `translateY(${v.start}px)` }}
              >
                {row.type === 'disk' ? (
                  <div className="border-b border-zinc-100 px-2 py-1 dark:border-zinc-800">
                    <div className="flex items-center gap-1.5 text-[11px]">
                      <Badge tone="amber">{SOURCE_LABEL[row.hit.source]}</Badge>
                      {row.hit.skill && <span className="font-mono">{row.hit.skill}</span>}
                      <span className="text-zinc-400">{tr("不在这一步的上下文里，加载时读过")}</span>
                    </div>
                    <HitSnippet hit={row.hit} best={best} />
                  </div>
                ) : row.type === 'system' ? (
                  <div className="border-b border-zinc-100 px-2 py-1 dark:border-zinc-800">
                    <details>
                      <summary className="cursor-pointer text-[11px] text-zinc-500">
                        <span className="mr-1 inline-block h-2.5 w-2.5 rounded-sm align-middle" style={{ background: CAT_META.system.color }} />{tr("系统提示词（base_instructions，")}{data.system!.chars.toLocaleString()}{tr("字，≈")}{fmtTokens(data.system!.estTokens)}）
                        {searching && matches.get(-1) ? <span className="ml-1 text-amber-600">×{matches.get(-1)!.count}</span> : null}
                      </summary>
                      <LazyText className="mt-1" sessionId={sessionId} txt={{ preview: data.system!.preview, chars: data.system!.chars, ref: data.system!.ref }} maxHeight="max-h-96" copy />
                    </details>
                  </div>
                ) : row.type === 'group' ? (
                  <button
                    className="flex w-full items-center gap-1.5 border-b border-zinc-200 bg-zinc-50/95 px-2 py-1 text-left text-[11px] backdrop-blur dark:border-zinc-800 dark:bg-zinc-900/95"
                    onClick={() => toggle(row.g.key)}
                    title={isOpen(row.g) ? tr("收起") : tr("展开")}
                  >
                    <span className="w-2.5 text-[9px] text-zinc-400">{isOpen(row.g) ? '▾' : '▸'}</span>
                    <span className={cx('min-w-0 flex-1 truncate font-medium', row.g.turn === turnOfCall ? 'text-indigo-700 dark:text-indigo-300' : 'text-zinc-600 dark:text-zinc-300')}>{groupTitle(row.g)}</span>
                    {row.g.newCount > 0 && <Badge tone="green">+{row.g.newCount}</Badge>}
                    <span className="shrink-0 font-mono text-zinc-400">
                      {row.g.items.length}{tr("条 · ≈")}{fmtTokens(row.g.tokens)}
                    </span>
                  </button>
                ) : (
                  <ItemRow
                    {...rowProps}
                    item={row.it}
                    removed={row.removed}
                    hit={relevance ? hits.get(row.it.idx) : undefined}
                    best={relevance && hits.size ? best : undefined}
                    match={searching ? matches.get(row.it.idx) : undefined}
                    query={dq}
                    open={openRows.has(row.key)}
                    onToggle={() => toggleRow(row.key)}
                  />
                )}
              </div>
            );
          })}
        </div>
        {flat && !list.length && <Empty>{searching ? (search.isFetching ? tr("搜索中…") : tr("这一步的输入里没有找到")) : showRemoved ? tr("没有被移除的部分") : tr("没有匹配的条目")}</Empty>}
      </div>
    </div>
  );
}

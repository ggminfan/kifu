import { systemText, getLocale, localized, tr } from '../../shared/i18n';
import { useLocale } from '../../shared/i18n/react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useEffect, useMemo, useRef } from 'react';
import type { LlmCall, TraceView, Turn, TurnMark } from '../../shared/types';
import type { Problem, TurnCutView } from '../lib/casesApi';
import { fmtDuration, fmtTime, fmtTokens } from '../lib/format';
import { CallCard } from './CallCard';
import { Badge, Button, cx, type Tone } from './ui';

type Row =
  | { type: 'turn'; turn: Turn }
  | { type: 'call'; call: LlmCall }
  /** Where a compaction, rollback, abort or request error happened between the steps (the same kind in a row: once, ×count). */
  | { type: 'mark'; mark: TurnMark; count: number; key: string; before?: number; after?: number };

const MARK_META: Record<TurnMark['kind'], { label: string; tone: Tone; line: string; note?: string }> = localized({
  compaction: { label: '上下文压缩', tone: 'violet', line: 'border-violet-300 dark:border-violet-800', note: '之前的历史换成了摘要' },
  rollback: { label: '回滚', tone: 'sky', line: 'border-sky-300 dark:border-sky-800' },
  abort: { label: '中断', tone: 'amber', line: 'border-amber-300 dark:border-amber-800' },
  error: { label: '请求错误', tone: 'red', line: 'border-red-300 dark:border-red-800' },
});

function MarkRow({ row }: { row: Extract<Row, { type: 'mark' }> }) {
  useLocale();
  const meta = MARK_META[row.mark.kind];
  const detail = row.mark.detail ?? meta.note;
  return (
    <div className="mx-3 my-1 flex items-center gap-2 text-[11px]">
      <span className={cx('w-4 shrink-0 border-t border-dashed', meta.line)} />
      <Badge tone={meta.tone}>
        {meta.label}
        {row.count > 1 ? ` ×${row.count}` : ''}
      </Badge>
      {detail && (
        <span className="min-w-0 truncate text-zinc-500" title={detail}>
          {detail}
        </span>
      )}
      {row.mark.kind === 'compaction' && row.before !== undefined && row.after !== undefined && (
        <span className="shrink-0 font-mono text-zinc-400" title={tr("压缩前最后一步和压缩后第一步的输入")}>{tr("输入")}{fmtTokens(row.before)} → {fmtTokens(row.after)}
        </span>
      )}
      <span className={cx('min-w-4 flex-1 border-t border-dashed', meta.line)} />
      {row.mark.ts && <span className="shrink-0 font-mono text-[10.5px] text-zinc-400">{fmtTime(row.mark.ts)}</span>}
    </div>
  );
}

export interface DebugTurns {
  cuts: Map<number, TurnCutView>;
  /** Turn whose case is being created. */
  busy?: number;
  onDebug: (turnIndex: number) => void;
}

function TurnHeader({ turn, trace, problems, debug }: { turn: Turn; trace: TraceView; problems: number; debug?: DebugTurns }) {
  useLocale();
  const tokens = turn.calls.reduce((s, i) => s + (trace.calls[i]?.usage?.total ?? 0), 0);
  const cut = debug?.cuts.get(turn.index);
  return (
    <div className="group mx-3 mt-3 mb-1 flex items-start gap-2 rounded bg-zinc-100 px-2.5 py-1.5 dark:bg-zinc-900/70">
      <span className="shrink-0 text-[12px] font-semibold">{tr`第${turn.index + 1}轮`}</span>
      <Badge tone={turn.trigger === 'inter_agent' ? 'pink' : turn.trigger === 'system' ? 'zinc' : 'green'}>
        {turn.trigger === 'inter_agent' ? tr("agent 消息") : turn.trigger === 'user' ? tr("用户") : turn.trigger === 'system' ? tr("系统消息") : tr("未知触发")}
      </Badge>
      <div className="min-w-0 flex-1 truncate text-[12px] text-zinc-600 dark:text-zinc-300" title={turn.input?.preview}>
        {turn.input?.preview ?? <span className="text-zinc-400">{tr("（无输入文本）")}</span>}
      </div>
      {turn.status === 'aborted' && <Badge tone="amber">{tr("已中断")}</Badge>}
      {turn.status === 'failed' && <Badge tone="red">{tr("失败")}</Badge>}
      {turn.marks.some((m) => m.kind === 'compaction') && <Badge tone="violet">{tr("压缩 ×")}{turn.marks.filter((m) => m.kind === 'compaction').length}</Badge>}
      {turn.marks.some((m) => m.kind === 'rollback') && <Badge tone="sky">{tr("回滚")}</Badge>}
      {problems > 0 && <Badge tone="red" title={tr("这一轮的问题数（见上方问题栏）")}>⚠ {problems}</Badge>}
      <span className="shrink-0 whitespace-nowrap font-mono text-[11px] text-zinc-400">
        {turn.calls.length}{tr("步 ·")}{fmtTokens(tokens)} · {fmtDuration(turn.durationMs)}
        <span className="hidden @[40rem]:inline">
          {turn.ttftMs ? ` · TTFT ${fmtDuration(turn.ttftMs)}` : ''} · {fmtTime(turn.startedAt)}
        </span>
      </span>
      {debug && cut && (
        <span className={cut.replayable ? 'shrink-0' : 'shrink-0 opacity-0 group-hover:opacity-100'}>
          <Button
            size="xs"
            variant={problems > 0 ? 'default' : 'ghost'}
            disabled={!cut.replayable || debug.busy !== undefined}
            onClick={() => debug.onDebug(turn.index)}
            title={cut.replayable ? tr`从第 ${turn.index + 1} 轮之前开始回放，改 skill / 输入 / 模型后对比${cut.warnings.length ? tr`\n注意：${cut.warnings.map(systemText).join('；')}` : ''}` : tr`不能回放：${cut.reasons.map(systemText).join('；')}`}
          >
            {debug.busy === turn.index ? tr("创建中…") : tr("调试这一轮")}
          </Button>
        </span>
      )}
    </div>
  );
}

export function StepList({
  sessionId,
  trace,
  selectedCall,
  selectedTool,
  scrollToCall,
  onSelectCall,
  onSelectTool,
  onOpenThread,
  problems,
  debug,
}: {
  sessionId: string;
  trace: TraceView;
  selectedCall?: number;
  selectedTool?: string;
  /** Changes when the list should scroll (e.g. timeline click). */
  scrollToCall?: { index: number; nonce: number };
  onSelectCall: (i: number) => void;
  onSelectTool: (callIndex: number, toolId: string) => void;
  onOpenThread: (threadId: string) => void;
  problems?: Problem[];
  /** Replayable turns get a "调试这一轮" button. */
  debug?: DebugTurns;
}) {
  useLocale();
  const byCall = useMemo(() => {
    const m = new Map<number, Problem[]>();
    for (const p of problems ?? []) if (p.callIndex !== undefined) m.set(p.callIndex, [...(m.get(p.callIndex) ?? []), p]);
    return m;
  }, [problems, getLocale()]);
  const byTurn = useMemo(() => {
    const m = new Map<number, number>();
    for (const p of problems ?? []) m.set(p.turnIndex, (m.get(p.turnIndex) ?? 0) + 1);
    return m;
  }, [problems, getLocale()]);
  const parentRef = useRef<HTMLDivElement>(null);
  const rows = useMemo<Row[]>(() => {
    const out: Row[] = [];
    const addMark = (turn: Turn, mark: TurnMark) => {
      const last = out[out.length - 1];
      if (last?.type === 'mark' && last.mark.kind === mark.kind) last.count++;
      else out.push({ type: 'mark', mark, count: 1, key: `m-${turn.id}-${mark.line}-${mark.kind}` });
    };
    for (const turn of trace.turns) {
      out.push({ type: 'turn', turn });
      // each mark between the steps around it (by rollout line)
      const marks = [...turn.marks].sort((a, b) => a.line - b.line);
      let m = 0;
      for (const i of turn.calls) {
        const call = trace.calls[i];
        if (!call) continue;
        while (m < marks.length && marks[m].line < call.line) addMark(turn, marks[m++]);
        out.push({ type: 'call', call });
      }
      while (m < marks.length) addMark(turn, marks[m++]);
    }
    // a compaction's effect: the input of the step before it and of the step after
    let last: number | undefined;
    for (const r of out) {
      if (r.type === 'call' && r.call.usage && r.call.kind !== 'orphan') last = r.call.usage.input;
      else if (r.type === 'mark') r.before = last;
    }
    let next: number | undefined;
    for (let i = out.length - 1; i >= 0; i--) {
      const r = out[i];
      if (r.type === 'call' && r.call.usage && r.call.kind === 'response') next = r.call.usage.input;
      else if (r.type === 'mark') r.after = next;
    }
    return out;
  }, [trace, getLocale()]);
  // each step's input next to the one before: how much it grew
  const prevInput = useMemo(() => {
    const m = new Map<number, number>();
    let last: number | undefined;
    for (const c of trace.calls) {
      if (c.kind === 'orphan' || !c.usage) continue;
      if (last !== undefined) m.set(c.index, last);
      last = c.usage.input;
    }
    return m;
  }, [trace, getLocale()]);
  const rowOfCall = useMemo(() => {
    const m = new Map<number, number>();
    rows.forEach((r, i) => {
      if (r.type === 'call') m.set(r.call.index, i);
    });
    return m;
  }, [rows, getLocale()]);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: (i) => {
      const r = rows[i];
      if (r.type === 'turn') return 44;
      if (r.type === 'mark') return 26;
      return 56 + r.call.tools.length * 32 + (r.call.text ? 48 : 0) + (r.call.reasoning ? 20 : 0);
    },
    overscan: 6,
    getItemKey: (i) => {
      const r = rows[i];
      return r.type === 'turn' ? `t-${r.turn.id}` : r.type === 'mark' ? r.key : `c-${r.call.index}`;
    },
  });

  useEffect(() => {
    if (!scrollToCall) return;
    const r = rowOfCall.get(scrollToCall.index);
    if (r !== undefined) virtualizer.scrollToIndex(r, { align: 'center' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scrollToCall?.nonce]);

  return (
    <div ref={parentRef} className="@container min-h-0 flex-1 overflow-auto">
      <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
        {virtualizer.getVirtualItems().map((v) => {
          const row = rows[v.index];
          return (
            <div key={v.key} data-index={v.index} ref={virtualizer.measureElement} style={{ position: 'absolute', top: 0, left: 0, width: '100%', transform: `translateY(${v.start}px)` }}>
              {row.type === 'turn' ? (
                <TurnHeader turn={row.turn} trace={trace} problems={byTurn.get(row.turn.index) ?? 0} debug={debug} />
              ) : row.type === 'mark' ? (
                <MarkRow row={row} />
              ) : (
                <CallCard
                  sessionId={sessionId}
                  trace={trace}
                  call={row.call}
                  selected={selectedCall === row.call.index}
                  selectedTool={selectedCall === row.call.index ? selectedTool : undefined}
                  onSelectCall={onSelectCall}
                  onSelectTool={onSelectTool}
                  onOpenThread={onOpenThread}
                  problems={byCall.get(row.call.index)}
                  prevInput={prevInput.get(row.call.index)}
                />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

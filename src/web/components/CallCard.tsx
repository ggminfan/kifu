import { useLocale } from '../../shared/i18n/react';
import { tr } from '../../shared/i18n';
import { memo, useState } from 'react';
import { PROBLEM_LABEL } from '../../core/analysis/problems';
import type { LlmCall, ToolBrief, TraceView } from '../../shared/types';
import type { Problem } from '../lib/casesApi';
import { fetchText } from '../lib/api';
import { fmtDuration, fmtTokens, spanMs } from '../lib/format';
import { TOOL_META } from '../lib/meta';
import { Markdown } from './Markdown';
import { Badge, cx } from './ui';

/** Input / output tokens of a step, with how much the input grew since the step before (a big tool output, a compaction …). */
function UsageBadge({ call, prevInput }: { call: LlmCall; prevInput?: number }) {
  useLocale();
  const u = call.usage;
  if (!u) return <Badge tone="amber">{tr("无用量")}</Badge>;
  const cachedPct = u.input ? Math.round((u.cached / u.input) * 100) : 0;
  const delta = prevInput !== undefined ? u.input - prevInput : undefined;
  return (
    <span
      className="shrink-0 font-mono text-[11px] text-zinc-500"
      title={tr`输入 ${u.input.toLocaleString()} · 缓存 ${u.cached.toLocaleString()}（${cachedPct}%）· 输出 ${u.output.toLocaleString()} · 推理 ${u.reasoning.toLocaleString()}${delta !== undefined ? tr`\n比上一步的输入 ${delta >= 0 ? '+' : ''}${delta.toLocaleString()}` : ''}`}
    >
      {fmtTokens(u.input)} in
      {delta !== undefined && delta !== 0 && (
        <span className={cx('ml-0.5', delta < 0 ? 'text-violet-500' : delta >= 5000 ? 'text-amber-600 dark:text-amber-400' : 'text-zinc-400')}>
          {delta > 0 ? '+' : '−'}
          {fmtTokens(Math.abs(delta))}
        </span>
      )}
      <span className="hidden @[30rem]:inline"> · {fmtTokens(u.output)} out</span>
      {u.cached ? <span className="hidden @[38rem]:inline"> · {cachedPct}{tr("% 缓存")}</span> : null}
    </span>
  );
}

function StatusDot({ tool }: { tool: ToolBrief }) {
  useLocale();
  if (tool.isError) return <span className="text-red-500" title={tool.errorReason}>✗</span>;
  if (tool.status === 'running') return <span className="text-amber-500" title={tr("后台运行，稍后由 wait 收集")}>◔</span>;
  if (tool.status === 'pending') return <span className="text-zinc-400" title={tr("没有输出")}>…</span>;
  return <span className="text-emerald-500">✓</span>;
}

export function ToolRow({
  tool,
  selected,
  onSelect,
  onOpenThread,
}: {
  tool: ToolBrief;
  selected: boolean;
  onSelect: () => void;
  onOpenThread?: (threadId: string) => void;
}) {
  useLocale();
  const [open, setOpen] = useState(false);
  const meta = TOOL_META[tool.kind] ?? TOOL_META.function;
  const innerErrors = tool.inner.filter((e) => e.isError).length;
  // the exit code of what failed (a command run by the call)
  const failedExit = tool.isError ? tool.inner.find((e) => e.exitCode !== undefined && e.exitCode !== 0)?.exitCode : undefined;
  return (
    <div className={cx('rounded border', selected ? 'border-indigo-400 bg-indigo-50/60 dark:border-indigo-600 dark:bg-indigo-950/40' : 'border-zinc-200 dark:border-zinc-800')}>
      <div className="flex cursor-pointer items-center gap-1.5 px-2 py-1" onClick={onSelect}>
        <button
          className={cx('w-3 text-zinc-400', !tool.inner.length && 'invisible')}
          onClick={(e) => {
            e.stopPropagation();
            setOpen(!open);
          }}
        >
          {open ? '▾' : '▸'}
        </button>
        {/* the kind badge says nothing more when the tool is named after it ("shell") */}
        {meta.label !== tool.name && <Badge tone={meta.tone}>{meta.label}</Badge>}
        <span className="shrink-0 font-mono text-[12px] font-medium" style={meta.label === tool.name ? { color: meta.color } : undefined}>
          {tool.name}
        </span>
        <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-zinc-500" title={tool.summary}>
          {tool.summary}
        </span>
        {failedExit !== undefined && <span className="shrink-0 font-mono text-[11px] text-red-500">exit {failedExit}</span>}
        {tool.skill && <Badge tone="amber" title={tr("这次调用加载了 skill")}>⚑ {tool.skill}</Badge>}
        {tool.childThreadId && onOpenThread && (
          <button
            className="text-[11px] text-pink-600 hover:underline dark:text-pink-400"
            onClick={(e) => {
              e.stopPropagation();
              onOpenThread(tool.childThreadId!);
            }}
          >{tr("子 agent →")}</button>
        )}
        {tool.inner.length > 1 && (
          <span className={cx('hidden shrink-0 text-[11px] @[34rem]:inline', innerErrors ? 'text-red-500' : 'text-zinc-400')}>
            {tool.inner.length}{tr("事件")}{innerErrors ? tr` · ${innerErrors} 失败` : ''}
          </span>
        )}
        <span className="w-12 shrink-0 text-right font-mono text-[11px] text-zinc-400">{fmtDuration(tool.durationMs)}</span>
        <StatusDot tool={tool} />
      </div>
      {open && tool.inner.length > 0 && (
        <div className="border-t border-zinc-100 px-2 py-1 dark:border-zinc-800">
          {tool.inner.map((e, i) => (
            <div key={i} className="flex items-center gap-1.5 py-0.5 font-mono text-[11px]">
              <span className={e.isError ? 'text-red-500' : 'text-zinc-400'}>{e.isError ? '✗' : '·'}</span>
              <span className="text-zinc-400">{e.kind}</span>
              <span className="min-w-0 flex-1 truncate">{e.title}</span>
              {e.exitCode !== undefined && <span className={e.exitCode ? 'text-red-500' : 'text-zinc-400'}>exit {e.exitCode}</span>}
              <span className="text-zinc-400">{fmtDuration(e.durationMs)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** The model's reasoning: folded; the full text on demand (the trace has a preview). */
function Reasoning({ sessionId, call }: { sessionId: string; call: LlmCall }) {
  useLocale();
  const [open, setOpen] = useState(false);
  const [full, setFull] = useState<string>();
  const [loading, setLoading] = useState(false);
  const r = call.reasoning;
  if (!r) return null;
  const truncated = Boolean(r.ref) && full === undefined;
  return (
    <div>
      <button className="text-[11px] text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200" onClick={() => setOpen(!open)}>
        {open ? '▾' : '▸'}{tr("推理（")}{r.chars.toLocaleString()}{tr("字）")}</button>
      {open && (
        <div className="mt-1 whitespace-pre-wrap border-l-2 border-zinc-200 pl-2 text-[12px] italic text-zinc-500 dark:border-zinc-700">
          {full ?? r.preview}
          {truncated && (
            <>
              …{' '}
              <button
                className="not-italic text-indigo-600 hover:underline dark:text-indigo-400"
                disabled={loading}
                onClick={async () => {
                  setLoading(true);
                  try {
                    setFull((await fetchText(sessionId, r.ref!)).text);
                  } finally {
                    setLoading(false);
                  }
                }}
              >
                {loading ? tr("加载中…") : tr("查看全文")}
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function AssistantText({ sessionId, call }: { sessionId: string; call: LlmCall }) {
  useLocale();
  const [full, setFull] = useState<string>();
  if (!call.text) return null;
  const truncated = Boolean(call.text.ref) && full === undefined;
  return (
    <div className="text-[13px]">
      <Markdown text={full ?? call.text.preview} />
      {truncated && (
        <button className="text-[11px] text-indigo-600 hover:underline dark:text-indigo-400" onClick={async () => setFull((await fetchText(sessionId, call.text!.ref!)).text)}>{tr("查看全文（")}{call.text.chars.toLocaleString()}{tr("字）")}</button>
      )}
    </div>
  );
}

export const CallCard = memo(function CallCard({
  sessionId,
  trace,
  call,
  selected,
  selectedTool,
  onSelectCall,
  onSelectTool,
  onOpenThread,
  problems,
  prevInput,
}: {
  sessionId: string;
  trace: TraceView;
  call: LlmCall;
  selected: boolean;
  selectedTool?: string;
  onSelectCall: (i: number) => void;
  onSelectTool: (callIndex: number, toolId: string) => void;
  onOpenThread: (threadId: string) => void;
  /** Problems found at this step (problem bar). */
  problems?: Problem[];
  /** Input tokens of the step before (shows how much the input grew). */
  prevInput?: number;
}) {
  useLocale();
  const dur = spanMs(call.startTs, call.ts);
  return (
    <div className={cx('mx-3 my-1.5 rounded-md border bg-white dark:bg-zinc-900', selected ? 'border-indigo-500 shadow-sm' : 'border-zinc-200 dark:border-zinc-800')}>
      <div className="flex cursor-pointer items-center gap-2 whitespace-nowrap border-b border-zinc-100 px-2.5 py-1.5 dark:border-zinc-800" onClick={() => onSelectCall(call.index)}>
        <span className="shrink-0 font-mono text-[12px] font-semibold text-zinc-700 dark:text-zinc-300">Step {call.index + 1}</span>
        {call.kind === 'compaction' && <Badge tone="violet">{tr("压缩")}</Badge>}
        {call.kind === 'orphan' && <Badge tone="amber" title={tr("有用量但没有提交输出（可能被中断）")}>{tr("无输出")}</Badge>}
        {call.phase === 'commentary' && <Badge>{tr("过程说明")}</Badge>}
        {call.phase === 'final_answer' && <Badge tone="green">{tr("最终回答")}</Badge>}
        {call.injected.length > 0 && <Badge tone="zinc" title={tr("随这次响应一起注入的上下文（system-reminder 等）")}>+{tr`${call.injected.length} 项注入`}</Badge>}
        {problems && problems.length > 0 && (
          <Badge tone={problems.some((p) => p.certainty === 'fact') ? 'red' : 'violet'} title={problems.map((p) => `${tr(PROBLEM_LABEL[p.kind])}：${p.title}`).join('\n')}>
            ⚠ {problems.length}
          </Badge>
        )}
        <span className="flex-1" />
        {call.model && <span className="hidden min-w-0 truncate text-[11px] text-zinc-400 @[36rem]:inline">{call.model}</span>}
        <UsageBadge call={call} prevInput={prevInput} />
        <span className="w-12 shrink-0 text-right font-mono text-[11px] text-zinc-400" title={tr("上一条记录到这次输出提交的时间（≈ 请求耗时）")}>
          {fmtDuration(dur)}
        </span>
      </div>
      <div className="space-y-1.5 px-2.5 py-1.5">
        <Reasoning sessionId={sessionId} call={call} />
        <AssistantText sessionId={sessionId} call={call} />
        {call.tools.length > 0 && (
          <div className="space-y-1">
            {call.tools.map((id) => {
              const tool = trace.tools[id];
              if (!tool) return null;
              return <ToolRow key={id} tool={tool} selected={selectedTool === id} onSelect={() => onSelectTool(call.index, id)} onOpenThread={onOpenThread} />;
            })}
          </div>
        )}
        {!call.text && !call.tools.length && !call.reasoning && <div className="text-[12px] text-zinc-400">{call.kind === 'compaction' ? tr("生成压缩摘要（输出写入下一段历史）") : tr("（无可见输出）")}</div>}
      </div>
    </div>
  );
});

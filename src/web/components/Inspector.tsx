import { getLocale, tr } from '../../shared/i18n';
import { useLocale } from '../../shared/i18n/react';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import type { InnerEvent, ToolBrief, TraceView, Txt } from '../../shared/types';
import { blobUrl, useRaw, useTool } from '../lib/api';
import { fmtDuration, fmtTime, readableJson } from '../lib/format';
import { TOOL_META } from '../lib/meta';
import { ContextPanel } from './ContextPanel';
import { previewImage } from './dialogs';
import { LazyText } from './LazyText';
import { Badge, Empty, ErrorBox, KV, Spinner, Tabs, cx } from './ui';

export type InspectorTab = 'context' | 'tool' | 'raw' | (string & {});

function EventView({ sessionId, ev, sameOutput }: { sessionId: string; ev: InnerEvent; sameOutput?: boolean }) {
  useLocale();
  return (
    <div className="rounded border border-zinc-200 p-1.5 dark:border-zinc-800">
      <div className="flex items-center gap-1.5 text-[12px]">
        <Badge tone={ev.isError ? 'red' : 'zinc'}>{ev.kind}</Badge>
        <span className="min-w-0 flex-1 break-all font-mono text-[12px]">{ev.title}</span>
      </div>
      <div className="mt-0.5 flex flex-wrap gap-x-3 text-[11px] text-zinc-500">
        {ev.status && <span>{tr("状态")}{ev.status}</span>}
        {ev.exitCode !== undefined && <span className={ev.exitCode ? 'text-red-500' : ''}>exit {ev.exitCode}</span>}
        {ev.durationMs !== undefined && <span>{fmtDuration(ev.durationMs)}</span>}
        <span>{tr("关联：")}{{ self: tr("直接"), nested: tr("code-mode 嵌套"), position: tr("按位置推断") }[ev.link]}</span>
        {ev.ts && <span>{fmtTime(ev.ts)}</span>}
      </div>
      {ev.paths && ev.paths.length > 0 && <div className="mt-0.5 break-all font-mono text-[11px] text-zinc-500">{ev.paths.join('  ')}</div>}
      {ev.output && ev.output.chars > 0 && (sameOutput ? <div className="mt-0.5 text-[11px] text-zinc-400">{tr("输出同上")}</div> : <LazyText className="mt-1" sessionId={sessionId} txt={ev.output} maxHeight="max-h-60" tail copy />)}
      {ev.blobs && (
        <div className="mt-1 flex flex-wrap gap-1">
          {ev.blobs.map((b) => (
            <button key={b} type="button" className="cursor-zoom-in" title={tr("查看大图")} onClick={() => previewImage(blobUrl(sessionId, b))}>
              <img src={blobUrl(sessionId, b)} loading="lazy" className="h-24 rounded border border-zinc-200 dark:border-zinc-700" />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function ToolPanel({ sessionId, trace, tool, onOpenThread }: { sessionId: string; trace: TraceView; tool?: ToolBrief; onOpenThread: (id: string) => void }) {
  useLocale();
  // the trace has briefs: arguments, output and events' output come for the tool that is opened
  const full = useTool(sessionId, tool?.id);
  if (!tool) return <Empty>{tr("在 Step 里点击一个工具调用查看详情")}</Empty>;
  const waitsFor = tool.waitsFor ? trace.tools[tool.waitsFor] : undefined;
  const detail = full.data;
  return (
    <div className="space-y-2 overflow-auto p-2">
      <div className="flex items-center gap-1.5">
        <Badge tone={TOOL_META[tool.kind]?.tone}>{TOOL_META[tool.kind]?.label}</Badge>
        <span className="font-mono text-[13px] font-semibold">{tool.name}</span>
        {tool.isError && <Badge tone="red">{tr("失败")}</Badge>}
        {tool.status === 'running' && <Badge tone="amber">{tr("后台运行（cell")}{tool.cellId}）</Badge>}
      </div>
      {tool.summary && <div className="break-all rounded bg-zinc-50 px-2 py-1 font-mono text-[12px] dark:bg-zinc-900">{tool.summary}</div>}
      <div className="text-[12px]">
        <KV k="call_id">
          <span className="font-mono text-[11px]">{tool.id}</span>
        </KV>
        <KV k={tr("所在 Step")}>Step {tool.callIndex + 1}</KV>
        {tool.namespace && <KV k="namespace">{tool.namespace}</KV>}
        <KV k={tr("耗时")}>{fmtDuration(tool.durationMs)}</KV>
        {tool.errorReason && <KV k={tr("错误")}>{tool.errorReason}</KV>}
        {tool.skill && <KV k={tr("加载 skill")}><Badge tone="amber">{tool.skill}</Badge></KV>}
        {waitsFor && <KV k={tr("收集")}>exec cell {waitsFor.cellId}（{waitsFor.id.slice(-8)}）</KV>}
        {tool.childThreadId && (
          <KV k={tr("子 agent")}>
            <button className="font-mono text-[11px] text-pink-600 hover:underline dark:text-pink-400" onClick={() => onOpenThread(tool.childThreadId!)}>
              {tool.childThreadId} →
            </button>
          </KV>
        )}
      </div>
      {full.error ? <ErrorBox error={full.error} /> : null}
      {!detail && full.isLoading && <Spinner label={tr("读取参数和输出…")} />}
      {detail && (
        <>
          <Section title={tool.kind === 'code_exec' ? tr("代码（exec input）") : tr("参数")}>
            <LazyText sessionId={sessionId} txt={detail.args} maxHeight="max-h-80" json={tool.kind !== 'code_exec'} copy />
          </Section>
          <Section title={tr("输出")}>{detail.output ? <LazyText sessionId={sessionId} txt={detail.output} maxHeight="max-h-80" tail copy /> : <div className="text-zinc-400">{tr("（没有输出）")}</div>}</Section>
          {detail.inner.length > 0 && (
            <Section title={tr`执行事件（${detail.inner.length}）`}>
              <div className="space-y-1">
                {detail.inner.map((ev, i) => (
                  // a command's output usually is the call's output too: shown once
                  <EventView key={i} sessionId={sessionId} ev={ev} sameOutput={sameText(ev.output, detail.output)} />
                ))}
              </div>
            </Section>
          )}
        </>
      )}
    </div>
  );
}

/** The same text (as long, and one preview the start of the other: they are cut at different lengths). */
function sameText(a?: Txt, b?: Txt): boolean {
  if (!a || !b || a.chars !== b.chars) return false;
  return a.preview.length <= b.preview.length ? b.preview.startsWith(a.preview) : a.preview.startsWith(b.preview);
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  useLocale();
  return (
    <div>
      <div className="mb-0.5 text-[11px] font-medium uppercase tracking-wide text-zinc-500">{title}</div>
      {children}
    </div>
  );
}

const UNWRAP_KEY = 'kifu.raw.unwrap';

/**
 * One record of the rollout, around the selected step or tool: step to the
 * records before and after it, or to the tool's call, output and events.
 */
export function RawPanel({ sessionId, line, total, marks = [] }: { sessionId: string; line?: number; total?: number; marks?: Array<{ label: string; line: number }> }) {
  useLocale();
  const [at, setAt] = useState(line);
  useEffect(() => setAt(line), [line, sessionId]);
  const [unwrap, setUnwrap] = useState(() => {
    try {
      return localStorage.getItem(UNWRAP_KEY) !== '0';
    } catch {
      return true;
    }
  });
  const [copied, setCopied] = useState(false);
  const { data, isLoading, error } = useRaw(sessionId, at);
  // strings with line breaks shown as lines (tool outputs, AGENTS.md …), when the record came whole
  const shown = useMemo(() => {
    if (!data || !unwrap || data.truncated) return data?.text;
    try {
      return readableJson(JSON.parse(data.text));
    } catch {
      return data.text;
    }
  }, [data, unwrap, getLocale()]);
  if (line === undefined || at === undefined) return <Empty>{tr("选择 Step 或工具后可查看对应的原始记录")}</Empty>;
  const go = (n: number) => setAt(Math.max(0, total ? Math.min(total - 1, n) : n));
  const navBtn = 'rounded px-1 text-zinc-500 hover:bg-zinc-100 hover:text-zinc-800 disabled:opacity-30 dark:hover:bg-zinc-800 dark:hover:text-zinc-200';
  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 border-b border-zinc-200 px-2 py-1 text-[11px] text-zinc-500 dark:border-zinc-800">
        <span className="flex items-center">
          <button className={navBtn} disabled={at <= 0} onClick={() => go(at - 1)} title={tr("上一条记录")}>
            ‹
          </button>
          <span className="font-mono">{tr`第${at + 1}行`}{total ? ` / ${total}` : ''}
          </span>
          <button className={navBtn} disabled={total !== undefined && at >= total - 1} onClick={() => go(at + 1)} title={tr("下一条记录")}>
            ›
          </button>
        </span>
        {marks.map((m) => (
          <button key={`${m.label}${m.line}`} className={cx('rounded px-1', m.line === at ? 'bg-indigo-100 text-indigo-800 dark:bg-indigo-900/50 dark:text-indigo-200' : 'text-indigo-600 hover:bg-indigo-50 dark:text-indigo-400 dark:hover:bg-indigo-950/40')} onClick={() => setAt(m.line)} title={tr`第 ${m.line + 1} 行`}>
            {m.label}
          </button>
        ))}
        {at !== line && !marks.some((m) => m.line === at) && (
          <button className="text-indigo-600 hover:underline dark:text-indigo-400" onClick={() => setAt(line)}>{tr("回到所选")}</button>
        )}
        <span className="flex-1" />
        <label className="flex items-center gap-1" title={tr("字符串里的换行按行显示（只为阅读，不是合法 JSON；复制得到原样 JSON）")}>
          <input
            type="checkbox"
            checked={unwrap}
            onChange={(e) => {
              setUnwrap(e.target.checked);
              try {
                localStorage.setItem(UNWRAP_KEY, e.target.checked ? '1' : '0');
              } catch {
                // not remembered
              }
            }}
          />{tr("多行字符串按行显示")}</label>
        {data && (
          <button
            className="rounded px-1 hover:bg-zinc-100 hover:text-zinc-800 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
            onClick={() =>
              void navigator.clipboard.writeText(data.text).then(() => {
                setCopied(true);
                setTimeout(() => setCopied(false), 1200);
              })
            }
            title={tr("复制这条记录（JSON）")}
          >
            {copied ? tr("已复制") : tr("复制")}
          </button>
        )}
      </div>
      {data?.truncated && <div className="border-b border-zinc-200 px-2 py-0.5 text-[11px] text-amber-600 dark:border-zinc-800">{tr("记录太大，只显示前")}{data.text.length.toLocaleString()}{tr("字（共")}{data.chars.toLocaleString()}{tr("字）")}</div>}
      {isLoading ? (
        <div className="p-3">
          <Spinner label={tr("读取原始记录…")} />
        </div>
      ) : error ? (
        <ErrorBox error={error} />
      ) : (
        <pre className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-words p-2 font-mono text-[11px]">{shown}</pre>
      )}
      <div className="border-t border-zinc-200 px-2 py-0.5 text-[10.5px] text-zinc-400 dark:border-zinc-800">{tr("base64 图片已替换为 blob 引用")}</div>
    </div>
  );
}

export function Inspector({
  sessionId,
  trace,
  tab,
  onTab,
  callIndex,
  toolId,
  onOpenThread,
  onJump,
  extraTabs = [],
  renderExtra,
}: {
  sessionId: string;
  trace: TraceView;
  tab: InspectorTab;
  onTab: (t: InspectorTab) => void;
  callIndex?: number;
  toolId?: string;
  onOpenThread: (id: string) => void;
  /** Go to a step (and a tool call in it): the context links back to where each part came from. */
  onJump?: (callIndex: number, toolId?: string) => void;
  extraTabs?: Array<{ id: string; label: ReactNode }>;
  renderExtra?: (tab: string) => ReactNode;
}) {
  useLocale();
  const tool = toolId ? trace.tools[toolId] : undefined;
  const rawLine = tool ? (tool.inner[0]?.line ?? tool.outputLine ?? trace.calls[tool.callIndex]?.line) : callIndex !== undefined ? trace.calls[callIndex]?.line : undefined;
  const rawMarks = useMemo(() => {
    if (!tool) return callIndex !== undefined && trace.calls[callIndex] ? [{ label: tr("这一步的响应"), line: trace.calls[callIndex].line }] : [];
    const out: Array<{ label: string; line: number }> = [];
    const callLine = trace.calls[tool.callIndex]?.line;
    if (callLine !== undefined) out.push({ label: tr("调用"), line: callLine });
    const events = [...new Set(tool.inner.map((e) => e.line))];
    events.slice(0, 6).forEach((l, i) => out.push({ label: events.length > 1 ? tr`事件 ${i + 1}` : tr("事件"), line: l }));
    if (tool.outputLine !== undefined) out.push({ label: tr("输出"), line: tool.outputLine });
    return out.filter((m, i) => out.findIndex((x) => x.line === m.line) === i);
  }, [tool, callIndex, trace, getLocale()]);
  return (
    <div className="flex h-full flex-col bg-white dark:bg-zinc-950">
      <Tabs<InspectorTab>
        tabs={[{ id: 'context', label: tr("输入上下文") }, { id: 'tool', label: tr("工具详情") }, ...extraTabs, { id: 'raw', label: tr("原始记录") }]}
        value={tab}
        onChange={onTab}
      />
      <div className="min-h-0 flex-1 overflow-hidden">
        {tab === 'context' && <ContextPanel sessionId={sessionId} callIndex={callIndex} toolId={tool ? toolId : undefined} toolName={tool ? `Step ${tool.callIndex + 1} · ${tool.name}` : undefined} onJump={onJump} />}
        {tab === 'tool' && (
          <div className="h-full overflow-auto">
            <ToolPanel sessionId={sessionId} trace={trace} tool={tool} onOpenThread={onOpenThread} />
          </div>
        )}
        {tab === 'raw' && <RawPanel sessionId={sessionId} line={rawLine} total={trace.file.lines} marks={rawMarks} />}
        {tab !== 'context' && tab !== 'tool' && tab !== 'raw' && renderExtra?.(tab)}
      </div>
    </div>
  );
}

import { useLocale } from '../../shared/i18n/react';
import { tr } from '../../shared/i18n';
import { AGENT_ICON } from '../../shared/agent-icons';
import type { TraceResponse } from '../../shared/api';
import type { AgentKind } from '../../shared/agents';
import { fmtDuration, fmtTokens, shortId } from '../lib/format';
import { Badge } from './ui';

const CLI_NAME: Record<AgentKind, string> = { codex: 'codex', claude: 'Claude Code' };

export function TraceHeader({ trace, onOpenThread }: { trace: TraceResponse; onOpenThread: (id: string) => void }) {
  useLocale();
  const m = trace.meta;
  const t = trace.totals;
  const title = trace.title || trace.turns[0]?.input?.preview?.slice(0, 120) || m.spawn?.nickname || shortId(m.threadId);
  return (
    <div className="border-b border-zinc-200 bg-white px-3 py-2 dark:border-zinc-800 dark:bg-zinc-950">
      <div className="flex items-center gap-2">
        <h1 className="min-w-0 flex-1 truncate text-[14px] font-semibold" title={title}>
          {title}
        </h1>
        <span className="font-mono text-[11px] text-zinc-400" title={m.threadId}>
          {shortId(m.threadId)}
        </span>
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-1.5">
        {m.model && <Badge tone="indigo">{m.model}</Badge>}
        {m.cliVersion && (
          <Badge>
            <img src={AGENT_ICON[trace.agent ?? 'codex']} alt="" className="h-3 w-3" />
            {CLI_NAME[trace.agent ?? 'codex']} {m.cliVersion}
          </Badge>
        )}
        {trace.sourceLabel && (
          <Badge tone="sky" title={tr("会话所在的来源（CODEX_HOME / 项目）")}>
            {trace.sourceLabel}
          </Badge>
        )}
        {m.source && <Badge>{m.source}</Badge>}
        {m.spawn && (
          <Badge tone="pink" title={m.spawn.agentPath}>{tr("子 agent")}{m.spawn.nickname ?? ''} {m.spawn.role ? `· ${m.spawn.role}` : ''}
          </Badge>
        )}
        {m.spawn?.parentThreadId && (
          <button className="text-[11px] text-pink-600 hover:underline dark:text-pink-400" onClick={() => onOpenThread(m.spawn!.parentThreadId)}>{tr("← 父会话")}</button>
        )}
        {trace.forkPrefix &&
          (trace.forkPrefix.kind === 'replay' ? (
            <Badge tone="violet" title={tr("开头的记录是原会话到回放那一轮之前的副本，只用于重建上下文，不计入步骤")}>{tr("回放（前")}{trace.forkPrefix.endLine}{tr("行为原会话副本）")}</Badge>
          ) : (
            <Badge tone="amber" title={tr("开头的记录是父会话历史的副本，只用于重建上下文，不计入步骤")}>
              {trace.forkPrefix.kind === 'full' ? tr("完整 fork") : tr("部分 fork")}{tr("（前")}{trace.forkPrefix.endLine}{tr("行为父会话副本）")}</Badge>
          ))}
        <span className="flex-1" />
        <span className="font-mono text-[11px] text-zinc-500">
          {t.turns}{tr("轮 ·")}{t.calls}{tr("步 ·")}{tr`${t.tools} 个工具调用`}{t.toolErrors ? <span className="text-red-500"> · {tr`${t.toolErrors} 次失败`}</span> : null} · {fmtTokens(t.usage.input)} in / {fmtTokens(t.usage.output)} out
          {t.usage.cached ? ` (${Math.round((t.usage.cached / Math.max(1, t.usage.input)) * 100)}% cached)` : ''} · {fmtDuration(t.durationMs)}
          {t.subagents ? tr` · ${t.subagents} 子 agent` : ''}
        </span>
      </div>
      {trace.diagnostics.length > 0 && (
        <div className="mt-1 text-[11px] text-amber-600" title={trace.diagnostics.map((d) => `${d.kind}:${d.detail} ×${d.count}`).join('\n')}>{tr("解析提示：")}{trace.diagnostics.map((d) => `${d.detail} ×${d.count}`).join('，')}
        </div>
      )}
    </div>
  );
}

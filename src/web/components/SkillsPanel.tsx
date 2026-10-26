import { useLocale } from '../../shared/i18n/react';
import { localized, tr } from '../../shared/i18n';
import { useState } from 'react';
import { Link } from 'wouter';
import type { SkillFlag, SkillReportRow } from '../../shared/api';
import { useSkillReport } from '../lib/api';
import { Badge, Button, Empty, ErrorBox, Spinner, cx, type Tone } from './ui';

export const FLAG_META: Record<SkillFlag, { label: string; tone: Tone; hint: string }> = localized({
  loaded: { label: '已加载', tone: 'green', hint: '本会话中被加载过' },
  maybe_missed: { label: '可能漏触发', tone: 'amber', hint: '某一轮的用户请求与描述高度相关，但那一轮没有加载它（启发式）' },
  trigger_truncated: { label: '触发词被截断', tone: 'red', hint: '与用户请求匹配的词只出现在被截断的描述尾部，模型看不到' },
  partial_read: { label: '部分读取', tone: 'amber', hint: '模型只读了 SKILL.md 的一部分（sed -n / head）' },
  not_followed: { label: '加载未遵循', tone: 'amber', hint: '加载后的工具调用没有使用 SKILL.md 中的命令/路径/标识符（启发式）' },
  desc_changed: { label: '描述已变更', tone: 'sky', hint: '会话中看到的描述与磁盘上当前的描述不一致' },
  not_listed: { label: '未在列表中', tone: 'zinc', hint: '被加载了，但不在本会话的 skill 列表里' },
});

const MODE_LABEL = localized({ tool: "Skill 工具", mention: "$ 提及", implicit_read: "读取 SKILL.md", resource: 'skill://' } as const);

function Description({ row }: { row: SkillReportRow }) {
  useLocale();
  if (!row.visibleDescription && !row.fullDescription) return null;
  if (row.truncated && row.hiddenTail !== undefined) {
    return (
      <div className="text-[12px] leading-relaxed">
        <span>{row.visibleDescription}</span>
        <span className="bg-red-50 text-red-400 line-through decoration-red-300 dark:bg-red-950/40" title={tr("被截断，模型看不到")}>
          {row.hiddenTail}
        </span>
      </div>
    );
  }
  return <div className="text-[12px] leading-relaxed text-zinc-600 dark:text-zinc-300">{row.visibleDescription ?? row.fullDescription}</div>;
}

interface DebugProps {
  onDebugTurn?: (turnIndex: number) => void;
  canDebug?: (turnIndex: number) => boolean;
}

/** The turn where this skill mattered: where it probably should have triggered, or where it was loaded. */
function turnOf(row: SkillReportRow): number | undefined {
  if (row.relevance && (row.flags.includes('maybe_missed') || row.flags.includes('trigger_truncated'))) return row.relevance.turnIndex;
  return row.invocations[0]?.turnIndex ?? row.relevance?.turnIndex;
}

function Row({ row, sessionId, onJump, onDebugTurn, canDebug }: { row: SkillReportRow; sessionId: string; onJump: (callIndex: number, toolId?: string) => void } & DebugProps) {
  useLocale();
  const [open, setOpen] = useState(row.invocations.length > 0 || row.flags.includes('maybe_missed'));
  const turn = turnOf(row);
  const debuggable = turn !== undefined && onDebugTurn && canDebug?.(turn);
  return (
    <div className="border-b border-zinc-100 px-2 py-1.5 dark:border-zinc-800">
      <div className="flex cursor-pointer items-center gap-1.5" onClick={() => setOpen(!open)}>
        <span className="w-3 text-zinc-400">{open ? '▾' : '▸'}</span>
        <span className="font-mono text-[12px] font-medium">{row.name}</span>
        {row.flags.map((f) => (
          <Badge key={f} tone={FLAG_META[f].tone} title={FLAG_META[f].hint}>
            {FLAG_META[f].label}
            {f === 'loaded' ? ` ×${row.invocations.length}` : ''}
          </Badge>
        ))}
        <span className="flex-1" />
        {debuggable && (
          <span onClick={(e) => e.stopPropagation()}>
            <Button size="xs" onClick={() => onDebugTurn!(turn!)} title={tr`从第 ${turn! + 1} 轮之前回放，改这个 skill 后对比`}>{tr`调试第${turn! + 1}轮`}</Button>
          </span>
        )}
        <Link href={`/skills?skill=${encodeURIComponent(row.name)}&session=${sessionId}`} className="text-[11px] text-indigo-600 hover:underline dark:text-indigo-400" onClick={(e) => e.stopPropagation()}>
          Skills →
        </Link>
      </div>
      {open && (
        <div className="mt-1 space-y-1 pl-4">
          <Description row={row} />
          {row.relevance && (
            <div className="text-[11px] text-zinc-500">{tr("与第")}{row.relevance.turnIndex + 1}{tr("轮用户请求相关度")}{row.relevance.score}{tr("：匹配")}{row.relevance.matched.slice(0, 8).join('、')}
              {row.relevance.tailOnly.length > 0 && <span className="text-red-500">{tr("（其中")}{row.relevance.tailOnly.join('、')}{tr("只在截断部分）")}</span>}
            </div>
          )}
          {row.invocations.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {row.invocations.map((inv, i) => (
                <button key={i} onClick={() => onJump(inv.callIndex, inv.toolCallId)} className="rounded border border-zinc-200 px-1.5 py-0.5 text-[11px] hover:border-indigo-400 dark:border-zinc-700">
                  Step {inv.callIndex + 1} · {MODE_LABEL[inv.mode]}
                  {inv.seenLines ? tr` · 行 ${inv.seenLines[0]}-${inv.seenLines[1]}${row.fileLines ? `/${row.fileLines}` : ''}` : ''}
                </button>
              ))}
            </div>
          )}
          {row.follow && (
            <div className="text-[11px] text-zinc-500">{tr("加载后检查了")}{row.follow.checked}{tr("次工具调用，")}{row.follow.matched}{tr("次用到了 SKILL.md 里的内容")}{row.follow.samples.length > 0 && tr`（如：${row.follow.samples[0].tokens.slice(0, 4).join('、')}）`}
            </div>
          )}
          {row.path && <div className="break-all font-mono text-[10.5px] text-zinc-400">{row.path}</div>}
        </div>
      )}
    </div>
  );
}

export function SkillsPanel({ sessionId, onJump, onDebugTurn, canDebug }: { sessionId: string; onJump: (callIndex: number, toolId?: string) => void } & DebugProps) {
  useLocale();
  const { data, isLoading, error } = useSkillReport(sessionId);
  const debug = { onDebugTurn, canDebug };
  const [showAll, setShowAll] = useState(false);
  if (isLoading) return <div className="p-3"><Spinner label={tr("分析 skill 使用情况…")} /></div>;
  if (error) return <ErrorBox error={error} />;
  if (!data) return null;
  const interesting = data.rows.filter((r) => r.flags.length > 0);
  const rest = data.rows.filter((r) => r.flags.length === 0);
  return (
    <div className="h-full overflow-auto">
      {data.listing ? (
        <div className="border-b border-zinc-200 p-2 text-[12px] dark:border-zinc-800">
          <div>{tr("Skill 列表（")}{data.listing.format}{tr("格式）：")}{data.listing.entries}{tr("个 skill")}{data.listing.distinct > 1 && tr`，会话中出现过 ${data.listing.distinct} 个版本`}
          </div>
          <div className={cx('mt-0.5', data.listing.truncatedCount ? 'text-amber-600' : 'text-zinc-500')}>
            {data.listing.truncatedCount
              ? tr`${data.listing.truncatedCount} 个描述被截断（预算约 ${data.listing.cap ?? '?'} 字/个，超出部分模型看不到）`
              : tr("描述均未被截断")}
          </div>
        </div>
      ) : (
        <div className="border-b border-zinc-200 p-2 text-[12px] text-zinc-500 dark:border-zinc-800">{tr("本会话没有 skill 列表")}</div>
      )}
      {interesting.map((r) => (
        <Row key={r.name} row={r} sessionId={sessionId} onJump={onJump} {...debug} />
      ))}
      {!interesting.length && <Empty>{tr("本会话没有加载 skill，也没有发现可疑信号")}</Empty>}
      {rest.length > 0 && (
        <div className="p-2">
          <button className="text-[11px] text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200" onClick={() => setShowAll(!showAll)}>
            {showAll ? '▾' : '▸'}{tr("其余")}{rest.length}{tr("个已列出但无信号的 skill")}</button>
        </div>
      )}
      {showAll && rest.map((r) => <Row key={r.name} row={r} sessionId={sessionId} onJump={onJump} {...debug} />)}
    </div>
  );
}

import { systemText, localized, tr } from '../../../shared/i18n';
import { useLocale } from '../../../shared/i18n/react';
import { useState } from 'react';
import { Link } from 'wouter';
import type { FidelitySummary } from '../../../shared/replay';
import { CAT_META } from '../../lib/meta';
import { isActive, useReplayProgress, type ReplayRecord, type RunStatus } from '../../lib/casesApi';
import { fmtDuration, fmtTokens, relTime } from '../../lib/format';
import { Badge, Button, cx, type Tone } from '../ui';
import { CheckChip } from './Checks';

export const STATUS: Record<RunStatus, { label: string; tone: Tone }> = localized({
  queued: { label: '排队', tone: 'zinc' },
  running: { label: '运行中', tone: 'sky' },
  completed: { label: '完成', tone: 'green' },
  failed: { label: '失败', tone: 'red' },
  cancelled: { label: '已取消', tone: 'amber' },
  paused: { label: '已暂停', tone: 'amber' },
});

const EXTRA_LABEL: Record<string, string> = localized({
  permissions: '权限',
  environment: '环境',
  skills: 'skill 列表',
  agents_md: 'AGENTS.md',
  model: '模型切换',
  mode: '协作模式',
  other: '其它',
});

/** How faithful the replay's start was, and what the agent added on resume. */
export function FidelityBadge({ f }: { f: FidelitySummary }) {
  useLocale();
  const cov = f.historyCoverage;
  const added = Object.entries(f.added).filter(([, n]) => n > 0);
  const total = added.reduce((s, [, n]) => s + n, 0);
  const title = [
    tr`第一次请求覆盖了原第 K 轮 ${(cov * 100).toFixed(1)}% 的历史（由记录重建）`,
    tr`基础指令覆盖 ${(f.baseCoverage * 100).toFixed(1)}%`,
    total ? tr`Agent 恢复时新增：${added.map(([k, n]) => tr`${CAT_META[k as keyof typeof CAT_META]?.label ?? k} ${n} 字`).join('、')}` : tr("恢复时没有新增内容"),
    ...Object.entries(f.extras).map(([k, n]) => tr`多出 ${EXTRA_LABEL[k] ?? k} ${n} 字`),
    f.missingChars ? tr`原历史中有 ${f.missingChars} 字不在回放里` : '',
  ]
    .filter(Boolean)
    .join('\n');
  return (
    <Badge tone={cov >= 0.98 ? 'green' : cov >= 0.9 ? 'amber' : 'red'} title={title}>{tr("保真")}{(cov * 100).toFixed(cov >= 0.995 ? 0 : 1)}%{total ? tr` · +${fmtTokens(total)} 字` : ''}
    </Badge>
  );
}

export function ReplayRow({ r, onCancel, onDelete, extra }: { r: ReplayRecord; onCancel?: () => void; onDelete?: () => void; extra?: React.ReactNode }) {
  useLocale();
  const active = isActive(r.status);
  const live = useReplayProgress(r.id, active);
  const [open, setOpen] = useState(false);
  const s = r.result?.summary;
  const steps = active ? live.steps : r.result?.steps;
  return (
    <div className="border-b border-zinc-100 px-2 py-1.5 dark:border-zinc-800">
      <div className="flex flex-wrap items-center gap-1.5 text-[12px]">
        <button className="w-3 text-zinc-400" onClick={() => setOpen(!open)}>
          {open ? '▾' : '▸'}
        </button>
        <span className="font-medium">{r.label}</span>
        <Badge tone={STATUS[r.status].tone}>{STATUS[r.status].label}</Badge>
        {(active || r.result?.stoppedAtMax) && steps !== undefined && (
          <span className="font-mono text-[11px] text-zinc-500">
            {steps}/{r.options.maxSteps}{tr("步")}{r.result?.stoppedAtMax ? tr("（到上限停止）") : ''}
          </span>
        )}
        {r.checks?.map((c, i) => <CheckChip key={i} r={c} compact />)}
        {r.result?.fidelity && <FidelityBadge f={r.result.fidelity} />}
        {r.result && !r.result.guard.originalUnchanged && <Badge tone="red">{tr("原会话有变化")}</Badge>}
        <span className="flex-1" />
        {s && (
          <span className="font-mono text-[11px] text-zinc-500">
            {s.steps}{tr("步 ·")}{tr`${s.tools} 个工具调用`}{s.failedCommands ? tr` · ${s.failedCommands} 失败命令` : ''} · {fmtTokens(s.inputTokens)} in · {fmtDuration(r.result?.wallMs)}
          </span>
        )}
        {r.threadId && (
          <Link href={`/s/${r.threadId}`} className="text-[11px] text-indigo-600 hover:underline dark:text-indigo-400">{tr("打开 →")}</Link>
        )}
        {active
          ? onCancel && (
              <Button size="xs" variant="ghost" onClick={onCancel}>{tr("取消")}</Button>
            )
          : onDelete && (
              <Button size="xs" variant="ghost" onClick={onDelete} title={tr("删除这次回放和它的文件")}>{tr("删除")}</Button>
            )}
      </div>
      {extra}
      {r.error && <div className="mt-0.5 pl-4 text-[11px] text-red-600">{systemText(r.error)}</div>}
      {open && (
        <div className="mt-1 space-y-1 pl-4 text-[11px]">
          <div className="text-zinc-500">
            {relTime(r.createdAt)} · {r.options.model ?? tr("默认模型")}
            {r.options.effort ? `（${r.options.effort}）` : ''} · {{ readonly: tr("原目录只读"), clone: tr("克隆工作区"), empty: tr("空目录") }[r.options.workspace]}
            {r.options.allowMcp ? tr(" · 允许外部工具") : ''}
          </div>
          {r.checks?.map((c, i) => (
            <div key={i} className="flex items-center gap-1">
              <CheckChip r={c} />
              {c.detail && <span className="text-zinc-500">{systemText(c.detail)}</span>}
            </div>
          ))}
          {active && live.log.length > 0 && <pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded bg-zinc-950 p-1.5 font-mono text-[10.5px] text-zinc-200">{live.log.join('\n')}</pre>}
          {r.result?.notes.map((n, i) => (
            <div key={i} className="text-amber-600">
              {n}
            </div>
          ))}
          {r.result?.fidelity?.samples.length ? (
            <details>
              <summary className="cursor-pointer text-zinc-500">{tr("回放第一次请求里多出的内容（")}{r.result.fidelity.samples.length}）</summary>
              {r.result.fidelity.samples.map((x, i) => (
                <div key={i} className="mt-0.5 flex gap-1">
                  <Badge>{EXTRA_LABEL[x.kind] ?? x.kind}</Badge>
                  <span className="shrink-0 font-mono text-zinc-400">{x.chars}{tr("字")}</span>
                  <span className="min-w-0 flex-1 truncate text-zinc-500">{x.preview}</span>
                </div>
              ))}
            </details>
          ) : null}
          {s?.finalAnswer && <div className="line-clamp-6 whitespace-pre-wrap rounded bg-zinc-50 p-1.5 dark:bg-zinc-900">{s.finalAnswer}</div>}
          {r.result?.stderrTail && r.status === 'failed' && <pre className="max-h-32 overflow-auto whitespace-pre-wrap rounded bg-zinc-100 p-1 font-mono text-[10.5px] dark:bg-zinc-900">{r.result.stderrTail}</pre>}
        </div>
      )}
    </div>
  );
}

export function ReplayList({ replays, onCancel, onDelete }: { replays: ReplayRecord[]; onCancel: (id: string) => void; onDelete: (id: string) => void }) {
  useLocale();
  const arms = [...new Set(replays.map((r) => r.arm))];
  if (!replays.length) return <div className="p-3 text-[12px] text-zinc-500">{tr("还没有回放")}</div>;
  return (
    <div>
      {arms.map((arm) => {
        const list = replays.filter((r) => r.arm === arm);
        const done = list.filter((r) => r.checks?.length);
        const passed = done.filter((r) => r.checks!.every((c) => c.status !== 'fail')).length;
        return (
          <div key={arm}>
            <div className={cx('flex items-center gap-2 bg-zinc-50 px-2 py-1 text-[11.5px] font-medium dark:bg-zinc-900/60')}>
              {arm}
              <span className="font-normal text-zinc-500">
                {list.length}{tr("次")}{done.length ? tr` · ${passed}/${done.length} 全部检查通过` : ''}
              </span>
            </div>
            {list.map((r) => (
              <ReplayRow key={r.id} r={r} onCancel={() => onCancel(r.id)} onDelete={() => onDelete(r.id)} />
            ))}
          </div>
        );
      })}
    </div>
  );
}

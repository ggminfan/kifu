import { useLocale } from '../../../shared/i18n/react';
import { tr } from '../../../shared/i18n';
import { useState } from 'react';
import { postJson } from '../../lib/api';
import type { PreviewResult, SkillLine } from '../../lib/labApi';
import { Badge, Button, ErrorBox, Spinner } from '../ui';

function LineView({ title, line }: { title: string; line: SkillLine }) {
  useLocale();
  return (
    <div className="rounded border border-zinc-200 p-2 dark:border-zinc-800">
      <div className="mb-1 flex items-center gap-1.5 text-[12px]">
        <span className="font-medium">{title}</span>
        {line.truncated === true && <Badge tone="red">{tr("被截断")}</Badge>}
        {line.truncated === false && <Badge tone="green">{tr("完整显示")}</Badge>}
        {!line.entry && <Badge tone="amber">{tr("不在列表中")}</Badge>}
        <span className="flex-1" />
        <span className="text-[11px] text-zinc-400">
          {line.snapshot.count}{tr("个 skill · 预算")}{line.snapshot.cap ?? tr("未截断")}
          {!line.snapshot.budgetParity && tr(" · ⚠ 路径长度不一致")}
        </span>
      </div>
      {line.entry ? (
        <div className="font-mono text-[11.5px] leading-relaxed">
          <span className="text-zinc-500">- {line.entry.name}: </span>
          <span>{line.entry.description}</span>
          {line.hiddenTail && <span className="bg-red-50 text-red-400 line-through dark:bg-red-950/40">{line.hiddenTail}</span>}
        </div>
      ) : (
        <div className="text-[12px] text-zinc-500">{tr("渲染出的 skill 列表里没有这个 skill（可能被禁用、改名或预算挤掉）")}</div>
      )}
    </div>
  );
}

export function PreviewPanel({
  skillKey,
  variantId,
  prompt,
  cwd,
  onCap,
}: {
  skillKey: string;
  variantId?: string;
  prompt?: string;
  cwd?: string;
  onCap: (cap: number | undefined) => void;
}) {
  useLocale();
  const [res, setRes] = useState<PreviewResult>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<unknown>();
  const run = async () => {
    setLoading(true);
    setError(undefined);
    try {
      const r = await postJson<PreviewResult>(`/skills/${encodeURIComponent(skillKey)}/preview`, { variantId, prompt, cwd });
      setRes(r);
      onCap(r.base.snapshot.cap);
    } catch (e) {
      setError(e);
    } finally {
      setLoading(false);
    }
  };
  return (
    <div className="space-y-2 p-2">
      <div className="text-[12px] text-zinc-600 dark:text-zinc-400">{tr("用 agent 自己的")}<code className="rounded bg-zinc-100 px-1 dark:bg-zinc-800">debug prompt-input</code>{tr("在隔离的 home 中离线渲染模型看到的 skill 列表（不调模型、不改真实目录），看描述会不会被截断、会不会挤占其他 skill。")}</div>
      <Button variant="primary" onClick={run} disabled={loading}>
        {loading ? tr("渲染中…") : variantId ? tr("预览：原版 vs 当前变体") : tr("预览原版")}
      </Button>
      {loading && <Spinner label={tr("准备隔离的 home 并渲染（约 5 秒）")} />}
      {error ? <ErrorBox error={error} /> : null}
      {res && (
        <div className="space-y-2">
          <LineView title={tr("原版")} line={res.base} />
          {res.variant && <LineView title={tr`变体（${res.variant.name}）`} line={res.variant} />}
          {res.othersChanged.length > 0 && (
            <div className="rounded border border-amber-300 bg-amber-50 p-2 text-[11.5px] dark:border-amber-800 dark:bg-amber-950/40">
              <div className="font-medium text-amber-800 dark:text-amber-300">{tr("共享预算：另外")}{res.othersChanged.length}{tr("个 skill 的可见描述发生了变化")}</div>
              {res.othersChanged.slice(0, 6).map((o) => (
                <div key={o.name} className="mt-1 font-mono text-[11px]">
                  {o.name}：{(o.before ?? '').length} → {(o.after ?? '').length}{tr("字")}</div>
              ))}
            </div>
          )}
          <div className="text-[10.5px] text-zinc-400">{tr("耗时")}{(res.ms / 1000).toFixed(1)}s</div>
        </div>
      )}
    </div>
  );
}

import { useLocale } from '../../../shared/i18n/react';
import { localized, tr } from '../../../shared/i18n';
import { useQueryClient } from '@tanstack/react-query';
import { diffWords } from 'diff';
import { useEffect, useState } from 'react';
import { Link } from 'wouter';
import { postJson } from '../../lib/api';
import { fmtDuration, fmtTokens } from '../../lib/format';
import { useCompare, useEvaluation, type ExecSummary } from '../../lib/labApi';
import { Button, Empty, ErrorBox, Spinner, cx } from '../ui';

type Metric = { label: string; get: (s: ExecSummary) => number | string | boolean | undefined; fmt?: (v: number) => string; better?: 'lower' | 'higher' };

const METRICS: Metric[] = localized([
  { label: '加载了 skill', get: (s) => s.skillLoaded },
  { label: '加载方式', get: (s) => s.skillModes.join(', ') || '–' },
  { label: '首次加载于 Step', get: (s) => (s.firstSkillCall !== undefined ? s.firstSkillCall + 1 : undefined), better: 'lower' },
  { label: '步数（LLM 调用）', get: (s) => s.calls, better: 'lower' },
  { label: '工具调用', get: (s) => s.tools, better: 'lower' },
  { label: '工具失败', get: (s) => s.toolErrors, better: 'lower' },
  { label: '失败命令', get: (s) => s.failedCommands, better: 'lower' },
  { label: '输入 tokens', get: (s) => s.usage.input, fmt: fmtTokens, better: 'lower' },
  { label: '输出 tokens', get: (s) => s.usage.output, fmt: fmtTokens, better: 'lower' },
  { label: '耗时', get: (s) => s.durationMs, fmt: (v) => fmtDuration(v), better: 'lower' },
  { label: '其他 skill', get: (s) => s.otherSkills.join(', ') || '–' },
]);

function show(v: ReturnType<Metric['get']>, fmt?: (v: number) => string): string {
  if (v === undefined) return '–';
  if (typeof v === 'boolean') return v ? tr("✓ 是") : tr("✗ 否");
  if (typeof v === 'number') return fmt ? fmt(v) : String(v);
  return v;
}

function delta(m: Metric, a?: ExecSummary, b?: ExecSummary): { text: string; good?: boolean } {
  if (!a || !b) return { text: '' };
  const x = m.get(a);
  const y = m.get(b);
  if (typeof x === 'boolean' && typeof y === 'boolean') return x === y ? { text: '' } : { text: y ? tr("变为加载") : tr("变为未加载"), good: y };
  if (typeof x !== 'number' || typeof y !== 'number') return { text: x === y ? '' : tr("不同") };
  const d = y - x;
  if (!d) return { text: '=' };
  const good = m.better ? (m.better === 'lower' ? d < 0 : d > 0) : undefined;
  return { text: `${d > 0 ? '+' : ''}${m.fmt ? m.fmt(Math.abs(d)).replace(/^/, d < 0 ? '−' : '') : d}`, good };
}

const VERDICTS = [
  { id: 'leftBetter', label: tr("左边更好") },
  { id: 'rightBetter', label: tr("右边更好") },
  { id: 'tie', label: tr("持平") },
  { id: 'pass', label: tr("通过") },
  { id: 'fail', label: tr("不通过") },
] as const;

export function ComparePanel({ skillKey, refs }: { skillKey: string; refs: string[] }) {
  useLocale();
  const [left, right] = refs;
  const qc = useQueryClient();
  const { data, isLoading, error } = useCompare(skillKey, left, right);
  const evaluation = useEvaluation(left, right);
  const [note, setNote] = useState('');
  useEffect(() => setNote(evaluation.data?.note ?? ''), [evaluation.data?.id, evaluation.data?.note]);

  if (refs.length < 2) return <Empty>{tr("在\"运行\"里勾选两条记录（可以包括原始会话 A）进行对比")}</Empty>;
  if (isLoading) return <div className="p-3"><Spinner label={tr("计算对比…")} /></div>;
  if (error) return <ErrorBox error={error} />;
  if (!data) return null;
  const a = data.left.summary;
  const b = data.right.summary;

  const save = async (verdict: string) => {
    await postJson('/evaluations', { left, right, verdict, note });
    await qc.invalidateQueries({ queryKey: ['evaluation', left, right] });
  };

  return (
    <div className="h-full space-y-3 overflow-auto p-2 text-[12px]">
      <table className="w-full border-collapse">
        <thead>
          <tr className="text-left text-[11px] text-zinc-500">
            <th className="py-1 font-medium">{tr("指标")}</th>
            <th className="py-1 font-medium">
              {data.left.label}
              {data.left.threadId && (
                <Link href={`/s/${data.left.threadId}`} className="ml-1 text-indigo-600 dark:text-indigo-400">
                  ↗
                </Link>
              )}
            </th>
            <th className="py-1 font-medium">
              {data.right.label}
              {data.right.threadId && (
                <Link href={`/s/${data.right.threadId}`} className="ml-1 text-indigo-600 dark:text-indigo-400">
                  ↗
                </Link>
              )}
            </th>
            <th className="py-1 font-medium">{tr("变化")}</th>
          </tr>
        </thead>
        <tbody>
          {METRICS.map((m) => {
            const d = delta(m, a, b);
            return (
              <tr key={m.label} className="border-t border-zinc-100 dark:border-zinc-800">
                <td className="py-0.5 text-zinc-500">{m.label}</td>
                <td className="py-0.5 font-mono text-[11.5px]">{a ? show(m.get(a), m.fmt) : '–'}</td>
                <td className="py-0.5 font-mono text-[11.5px]">{b ? show(m.get(b), m.fmt) : '–'}</td>
                <td className={cx('py-0.5 font-mono text-[11px]', d.good === true && 'text-emerald-600', d.good === false && 'text-red-500')}>{d.text}</td>
              </tr>
            );
          })}
        </tbody>
      </table>

      {data.alignment && (
        <div>
          <div className="mb-1 font-medium">{tr("工具调用序列对齐 · 相似度")}{(data.alignment.similarity * 100).toFixed(0)}%
            {data.alignment.firstDivergence !== undefined && <span className="ml-1 text-amber-600">{tr`首次分歧在第${data.alignment.firstDivergence + 1}个位置`}</span>}
          </div>
          <div className="max-h-72 overflow-auto rounded border border-zinc-200 dark:border-zinc-800">
            {data.alignment.rows.map((r, i) => (
              <div key={i} className={cx('grid grid-cols-2 gap-2 px-1.5 py-0.5 font-mono text-[10.5px]', !r.same && 'bg-amber-50 dark:bg-amber-950/30', i === data.alignment!.firstDivergence && 'border-t-2 border-amber-500')}>
                <span className={cx('truncate', !r.a && 'text-zinc-300')}>{r.a ?? '—'}</span>
                <span className={cx('truncate', !r.b && 'text-zinc-300')}>{r.b ?? '—'}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {(a?.finalAnswer || b?.finalAnswer) && (
        <div>
          <div className="mb-1 font-medium">{tr("最终回答差异")}</div>
          <div className="max-h-72 overflow-auto whitespace-pre-wrap rounded border border-zinc-200 p-2 leading-relaxed dark:border-zinc-800">
            {diffWords(a?.finalAnswer ?? '', b?.finalAnswer ?? '').map((p, i) => (
              <span key={i} className={cx(p.added && 'bg-emerald-100 dark:bg-emerald-900/50', p.removed && 'bg-red-100 text-red-700 line-through dark:bg-red-900/40 dark:text-red-300')}>
                {p.value}
              </span>
            ))}
          </div>
        </div>
      )}

      <div className="rounded border border-zinc-200 p-2 dark:border-zinc-800">
        <div className="mb-1 font-medium">{tr("评价")}{evaluation.data && <span className="font-normal text-zinc-500">{tr("（已记录：")}{VERDICTS.find((v) => v.id === evaluation.data!.verdict)?.label}）</span>}</div>
        <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} placeholder={tr("备注：为什么这样判断")} className="w-full rounded border border-zinc-300 bg-white px-2 py-1 dark:border-zinc-700 dark:bg-zinc-900" />
        <div className="mt-1 flex flex-wrap gap-1">
          {VERDICTS.map((v) => (
            <Button key={v.id} size="xs" variant={evaluation.data?.verdict === v.id ? 'primary' : 'default'} onClick={() => void save(v.id)}>
              {v.label}
            </Button>
          ))}
        </div>
      </div>
    </div>
  );
}

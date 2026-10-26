import { getLocale, tr } from '../../../shared/i18n';
import { useLocale } from '../../../shared/i18n/react';
import { diffWords } from 'diff';
import { useMemo, useState } from 'react';
import { alignSequences, seqLabel } from '../../../core/compare/summary';
import { checkText, type CheckDef, type CheckResult, type TurnSummary } from '../../../shared/replay';
import type { ReplayRecord } from '../../lib/casesApi';
import { fmtTokens } from '../../lib/format';
import { Empty, cx } from '../ui';
import { CheckChip } from './Checks';

interface Column {
  id: string;
  label: string;
  summary?: TurnSummary;
  checks?: CheckResult[];
}

function median(xs: number[]): number | undefined {
  if (!xs.length) return undefined;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor((s.length - 1) / 2)];
}

/**
 * The original turn K next to each group of replays: every check with its pass
 * count, a few numbers (medians), then any two runs side by side — tool calls
 * aligned to their first divergence, and the final answers diffed.
 */
export function CompareView({ checks, original, replays }: { checks: CheckDef[]; original?: { summary?: TurnSummary; checks: CheckResult[] }; replays: ReplayRecord[] }) {
  useLocale();
  const done = replays.filter((r) => r.status === 'completed' && r.result?.summary);
  const arms = [...new Set(done.map((r) => r.arm))];
  const columns: Column[] = [
    ...(original ? [{ id: 'original', label: tr("原始"), summary: original.summary, checks: original.checks }] : []),
    ...done.map((r) => ({ id: r.id, label: r.label, summary: r.result!.summary, checks: r.checks })),
  ];
  const [left, setLeft] = useState<string>();
  const [right, setRight] = useState<string>();
  const l = columns.find((c) => c.id === (left ?? columns[0]?.id));
  const r = columns.find((c) => c.id === (right ?? columns[columns.length - 1]?.id));
  const alignment = useMemo(() => (l?.summary && r?.summary ? alignSequences(l.summary.toolSeq, r.summary.toolSeq) : undefined), [l, r, getLocale()]);

  if (!done.length) return <Empty>{tr("回放完成后在这里对比")}</Empty>;
  const armRuns = (arm: string) => done.filter((x) => x.arm === arm);
  const metric = (get: (s: TurnSummary) => number, fmt = (n: number) => String(n)) => [
    original?.summary ? fmt(get(original.summary)) : '–',
    ...arms.map((a) => {
      const m = median(armRuns(a).map((x) => get(x.result!.summary!)));
      return m === undefined ? '–' : fmt(m);
    }),
  ];

  return (
    <div className="space-y-3 p-2 text-[12px]">
      <table className="w-full border-collapse">
        <thead>
          <tr className="text-left text-[11px] text-zinc-500">
            <th className="py-1 font-medium">{tr("检查 / 指标")}</th>
            {original && <th className="py-1 font-medium">{tr("原始")}</th>}
            {arms.map((a) => (
              <th key={a} className="py-1 font-medium">
                {a} <span className="font-normal">×{armRuns(a).length}</span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {checks.map((def, i) => (
            <tr key={i} className="border-t border-zinc-100 dark:border-zinc-800">
              <td className="py-0.5 text-zinc-600 dark:text-zinc-300">{checkText(def)}</td>
              {original && (
                <td className="py-0.5">
                  <CheckChip r={original.checks[i]} compact />
                </td>
              )}
              {arms.map((a) => {
                const results = armRuns(a).map((x) => x.checks?.[i]);
                const judged = results.filter((x) => x && x.status !== 'na');
                const pass = judged.filter((x) => x!.status === 'pass').length;
                return (
                  <td key={a} className={cx('py-0.5 font-mono text-[11px]', judged.length > 0 && (pass === judged.length ? 'text-emerald-600' : pass === 0 ? 'text-red-500' : 'text-amber-600'))}>
                    {judged.length ? `${pass}/${judged.length}` : '–'}
                    {results.length > judged.length && <span className="text-zinc-400"> ({results.length - judged.length}{tr("无法判断)")}</span>}
                  </td>
                );
              })}
            </tr>
          ))}
          {[
            [tr("步数（中位数）"), metric((s) => s.steps)],
            [tr("工具调用"), metric((s) => s.tools)],
            [tr("失败命令"), metric((s) => s.failedCommands)],
            [tr("输入 tokens"), metric((s) => s.inputTokens, fmtTokens)],
          ].map(([label, cells]) => (
            <tr key={label as string} className="border-t border-zinc-100 text-zinc-500 dark:border-zinc-800">
              <td className="py-0.5">{label as string}</td>
              {(cells as string[]).map((c, i) => (
                <td key={i} className="py-0.5 font-mono text-[11px]">
                  {c}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>

      <div className="flex flex-wrap items-center gap-2 text-[11.5px]">
        <span className="font-medium">{tr("逐条对比")}</span>
        {([tr("左"), tr("右")] as const).map((side) => (
          <select
            key={side}
            value={(side === '左' ? l : r)?.id ?? ''}
            onChange={(e) => (side === '左' ? setLeft : setRight)(e.target.value)}
            className="rounded border border-zinc-300 bg-white px-1 py-0.5 dark:border-zinc-700 dark:bg-zinc-900"
          >
            {columns.map((c) => (
              <option key={c.id} value={c.id}>
                {side}：{c.label}
              </option>
            ))}
          </select>
        ))}
      </div>
      {alignment && (
        <div>
          <div className="mb-1">{tr("工具调用对齐 · 相似度")}{(alignment.similarity * 100).toFixed(0)}%
            {alignment.firstDivergence !== undefined && <span className="ml-1 text-amber-600">{tr`第${alignment.firstDivergence + 1}个位置开始不同`}</span>}
          </div>
          <div className="max-h-72 overflow-auto rounded border border-zinc-200 dark:border-zinc-800">
            {alignment.rows.map((row, i) => (
              <div key={i} className={cx('grid grid-cols-2 gap-2 px-1.5 py-0.5 font-mono text-[10.5px]', !row.same && 'bg-amber-50 dark:bg-amber-950/30', i === alignment.firstDivergence && 'border-t-2 border-amber-500')}>
                <span className={cx('truncate', !row.a && 'text-zinc-300')} title={row.a}>{row.a ? seqLabel(row.a) : '—'}</span>
                <span className={cx('truncate', !row.b && 'text-zinc-300')} title={row.b}>{row.b ? seqLabel(row.b) : '—'}</span>
              </div>
            ))}
            {!alignment.rows.length && <div className="p-2 text-zinc-400">{tr("两边都没有工具调用")}</div>}
          </div>
        </div>
      )}
      {(l?.summary?.finalAnswer || r?.summary?.finalAnswer) && (
        <div>
          <div className="mb-1">{tr("最终回答差异")}</div>
          <div className="max-h-72 overflow-auto whitespace-pre-wrap rounded border border-zinc-200 p-2 leading-relaxed dark:border-zinc-800">
            {diffWords(l?.summary?.finalAnswer ?? '', r?.summary?.finalAnswer ?? '').map((p, i) => (
              <span key={i} className={cx(p.added && 'bg-emerald-100 dark:bg-emerald-900/50', p.removed && 'bg-red-100 text-red-700 line-through dark:bg-red-900/40 dark:text-red-300')}>
                {p.value}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

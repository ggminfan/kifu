import { useLocale } from '../../../shared/i18n/react';
import { tr } from '../../../shared/i18n';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useRef } from 'react';
import { ROLE_LABEL, type CaseRole, type CellStats } from '../../../shared/replay';
import { fmtTokens } from '../../lib/format';
import type { ReportView } from '../../lib/evalsApi';
import { Badge, cx, type Tone } from '../ui';

export const ROLE_TONE: Record<CaseRole, Tone> = { positive: 'green', negative: 'red', control: 'violet' };

const ROW_H = 40;

/** Background of a cell by its share of runs passing all checks. */
function shade(c: CellStats | undefined): string {
  if (!c || !c.runs) return 'bg-zinc-50 dark:bg-zinc-900/40';
  if (!c.judged) return c.errors && !c.pending ? 'bg-red-50/60 dark:bg-red-950/20' : 'bg-zinc-50 dark:bg-zinc-900/40';
  const r = c.passed / c.judged;
  if (r === 1) return 'bg-emerald-100 dark:bg-emerald-950/60';
  if (r >= 0.5) return 'bg-amber-100 dark:bg-amber-950/50';
  return 'bg-red-100 dark:bg-red-950/50';
}

function CellBox({ c, skill, selected, flagged, onClick }: { c?: CellStats; skill?: string; selected: boolean; flagged?: 'worse' | 'better'; onClick: () => void }) {
  useLocale();
  const title = c
    ? [
        tr`${c.runs} 次：${c.passed} 通过、${c.failed} 不通过${c.errors ? tr`、${c.errors} 次没跑成` : ''}${c.pending ? tr`、${c.pending} 次还在排队或运行` : ''}${c.runs - c.judged - c.errors - c.pending > 0 ? tr`、${c.runs - c.judged - c.errors - c.pending} 次无法判断` : ''}`,
        c.medianSteps !== undefined ? tr`中位 ${c.medianSteps} 步 · ${fmtTokens(c.medianInput)} 输入` : '',
        skill && c.runs - c.errors - c.pending > 0 ? tr`${c.skillLoaded}/${c.runs - c.errors - c.pending} 次加载了 ${skill}` : '',
        flagged === 'worse' ? tr("比基线差（回归）") : flagged === 'better' ? tr("比基线好") : '',
      ]
        .filter(Boolean)
        .join('\n')
    : tr("没有运行");
  return (
    <button
      onClick={onClick}
      title={title}
      className={cx(
        'flex h-[34px] w-full items-center justify-center gap-1 rounded text-[11.5px] tabular-nums',
        shade(c),
        selected ? 'ring-2 ring-indigo-500' : 'hover:ring-1 hover:ring-zinc-400',
        flagged === 'worse' && !selected && 'ring-1 ring-red-500',
      )}
    >
      {c?.judged ? (
        <span className="font-medium">
          {c.passed}/{c.judged}
        </span>
      ) : (
        <span className="text-zinc-400">{c?.runs ? (c.pending ? '…' : c.errors ? '✗' : '–') : '–'}</span>
      )}
      {skill && c && c.runs - c.errors - c.pending > 0 ? <span className={cx('text-[10px]', c.skillLoaded ? 'text-amber-700 dark:text-amber-300' : 'text-zinc-400')}>⚑{c.skillLoaded}</span> : null}
      {c?.errors ? <span className="text-[10px] text-red-600">!{c.errors}</span> : null}
      {c?.judged && c.pending ? <span className="text-[10px] text-zinc-400">+{c.pending}…</span> : null}
    </button>
  );
}

/**
 * Cases × groups of changes. Each cell: runs passing all checks / runs judged,
 * how often the set's skill loaded; red outline where a group did worse than
 * the baseline. Rows are virtualized (a set can have a couple of hundred cases).
 */
export function MatrixGrid({
  report,
  selected,
  onSelect,
}: {
  report: ReportView;
  selected?: { caseId: string; arm: string };
  onSelect: (s: { caseId: string; arm: string }) => void;
}) {
  useLocale();
  const scroller = useRef<HTMLDivElement>(null);
  const rows = report.rows;
  const virtualizer = useVirtualizer({ count: rows.length, getScrollElement: () => scroller.current, estimateSize: () => ROW_H, overscan: 8 });
  const worse = new Set(report.regressions.map((d) => `${d.caseId}|${d.arm}`));
  const better = new Set(report.improvements.map((d) => `${d.caseId}|${d.arm}`));
  const cols = `minmax(220px, 1fr) repeat(${report.arms.length}, minmax(76px, 110px))`;
  const skill = report.skill?.name;
  return (
    <div className="flex min-h-0 flex-col">
      <div className="grid items-end gap-1 border-b border-zinc-200 px-2 pb-1 text-[11px] text-zinc-500 dark:border-zinc-800" style={{ gridTemplateColumns: cols }}>
        <div>{tr("用例（")}{rows.length}）</div>
        {report.arms.map((a) => (
          <div key={a} className="truncate text-center font-medium text-zinc-700 dark:text-zinc-300" title={a}>
            {a}
            {a === report.baseline ? <span className="ml-1 font-normal text-zinc-400">{tr("基线")}</span> : null}
          </div>
        ))}
      </div>
      <div ref={scroller} className="min-h-0 flex-1 overflow-auto">
        <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
          {virtualizer.getVirtualItems().map((v) => {
            const row = rows[v.index];
            return (
              <div
                key={row.caseId}
                className="absolute left-0 top-0 grid w-full items-center gap-1 border-b border-zinc-100 px-2 dark:border-zinc-900"
                style={{ height: ROW_H, transform: `translateY(${v.start}px)`, gridTemplateColumns: cols }}
              >
                <div className="flex min-w-0 items-center gap-1.5 text-[12px]">
                  <Badge tone={ROLE_TONE[row.role]}>{ROLE_LABEL[row.role]}</Badge>
                  <span className="truncate" title={report.titles[row.caseId]}>
                    {report.titles[row.caseId]}
                  </span>
                </div>
                {report.arms.map((arm) => (
                  <CellBox
                    key={arm}
                    c={row.cells[arm]}
                    skill={skill}
                    selected={selected?.caseId === row.caseId && selected.arm === arm}
                    flagged={worse.has(`${row.caseId}|${arm}`) ? 'worse' : better.has(`${row.caseId}|${arm}`) ? 'better' : undefined}
                    onClick={() => onSelect({ caseId: row.caseId, arm })}
                  />
                ))}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

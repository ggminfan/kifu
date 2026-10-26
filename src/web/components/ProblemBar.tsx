import { systemText, getLocale, tr } from '../../shared/i18n';
import { useLocale } from '../../shared/i18n/react';
import { useMemo, useState } from 'react';
import { PROBLEM_LABEL, type ProblemKind } from '../../core/analysis/problems';
import type { Problem } from '../lib/casesApi';
import { Badge, Button, cx, type Tone } from './ui';

export const PROBLEM_TONE: Record<ProblemKind, Tone> = {
  failed_tool: 'red',
  failed_command: 'red',
  loop: 'amber',
  abort: 'amber',
  request_error: 'red',
  maybe_missed: 'violet',
  trigger_truncated: 'violet',
  not_followed: 'violet',
};

/**
 * What is worth a look in this session, in step order: counts by kind, and
 * prev / next through them (each jumps to its step). Heuristic findings are
 * marked as such.
 */
export function ProblemBar({
  problems,
  onJump,
  onDebugTurn,
  canDebug,
}: {
  problems: Problem[];
  onJump: (p: Problem) => void;
  onDebugTurn?: (turnIndex: number) => void;
  canDebug?: (turnIndex: number) => boolean;
}) {
  useLocale();
  const [kind, setKind] = useState<ProblemKind>();
  const [i, setI] = useState(-1);
  const counts = useMemo(() => {
    const m = new Map<ProblemKind, number>();
    for (const p of problems) m.set(p.kind, (m.get(p.kind) ?? 0) + 1);
    return [...m];
  }, [problems, getLocale()]);
  const list = kind ? problems.filter((p) => p.kind === kind) : problems;
  if (!problems.length) return null;
  const current = i >= 0 ? list[i] : undefined;
  const go = (d: number) => {
    const next = (i + d + list.length) % list.length;
    setI(next);
    onJump(list[next]);
  };
  return (
    <div className="flex items-center gap-1.5 border-b border-zinc-200 bg-zinc-50 px-3 py-1 text-[11.5px] dark:border-zinc-800 dark:bg-zinc-900/60">
      <span className="shrink-0 font-medium text-zinc-600 dark:text-zinc-300">{tr("问题")}</span>
      {counts.map(([k, n]) => (
        <button
          key={k}
          onClick={() => {
            setKind(kind === k ? undefined : k);
            setI(-1);
          }}
          className={cx('shrink-0 rounded', kind && kind !== k && 'opacity-40')}
          title={kind === k ? tr("显示全部") : tr`只看${tr(PROBLEM_LABEL[k])}`}
        >
          <Badge tone={PROBLEM_TONE[k]}>
            {tr(PROBLEM_LABEL[k])} {n}
          </Badge>
        </button>
      ))}
      <span className="min-w-0 flex-1 truncate text-zinc-500" title={current ? `${systemText(current.title)}${current.detail ? ` · ${systemText(current.detail)}` : ''}` : undefined}>
        {current ? (
          <>
            <span className="font-mono">
              {i + 1}/{list.length}
            </span>{' '}{tr`第${current.turnIndex + 1}轮`}{current.callIndex !== undefined ? ` · Step ${current.callIndex + 1}` : ''} · {systemText(current.title)}
            {current.detail ? <span className="text-zinc-400"> · {systemText(current.detail)}</span> : null}
            {current.certainty === 'heuristic' && <span className="text-zinc-400">{tr("（启发式）")}</span>}
          </>
        ) : null}
      </span>
      <Button size="xs" variant="ghost" onClick={() => go(-1)} title={tr("上一个")}>
        ↑
      </Button>
      <Button size="xs" variant="ghost" onClick={() => go(1)} title={tr("下一个")}>
        ↓
      </Button>
      {current && onDebugTurn && canDebug?.(current.turnIndex) && (
        <Button size="xs" onClick={() => onDebugTurn(current.turnIndex)} title={tr("从这一轮开始回放调试")}>{tr("调试这一轮")}</Button>
      )}
    </div>
  );
}

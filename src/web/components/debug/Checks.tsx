import { localized, systemText, tr } from '../../../shared/i18n';
import { useLocale } from '../../../shared/i18n/react';
import { useState } from 'react';
import { CHECK_LABEL, checkText, type CheckDef, type CheckKind, type CheckResult } from '../../../shared/replay';
import { Badge, Button, cx } from '../ui';

const PARAM: Record<CheckKind, 'skill' | 'pattern' | 'n' | 'text' | undefined> = {
  skill_loaded: 'skill',
  skill_not_loaded: 'skill',
  tool_called: 'pattern',
  tool_not_called: 'pattern',
  no_failed_commands: undefined,
  no_tool_errors: undefined,
  no_loops: undefined,
  max_steps: 'n',
  max_input_tokens: 'n',
  answer_contains: 'text',
  answer_not_contains: 'text',
  no_question: undefined,
};

const PLACEHOLDER = localized({ skill: "skill 名", pattern: "工具名或命令片段，/正则/ 也可以", n: "数字", text: "文本，/正则/ 也可以" } as const);

function build(kind: CheckKind, value: string): CheckDef | undefined {
  const p = PARAM[kind];
  const v = value.trim();
  if (p && !v) return undefined;
  switch (kind) {
    case 'skill_loaded':
    case 'skill_not_loaded':
      return { kind, skill: v };
    case 'tool_called':
    case 'tool_not_called':
      return { kind, pattern: v };
    case 'max_steps':
    case 'max_input_tokens': {
      const n = Number(v);
      return Number.isFinite(n) && n > 0 ? { kind, n: Math.floor(n) } : undefined;
    }
    case 'answer_contains':
    case 'answer_not_contains':
      return { kind, text: v };
    default:
      return { kind } as CheckDef;
  }
}

export function CheckChip({ r, compact }: { r?: CheckResult; compact?: boolean }) {
  useLocale();
  if (!r) return <span className="text-zinc-300">·</span>;
  const tone = r.status === 'pass' ? 'green' : r.status === 'fail' ? 'red' : 'zinc';
  const mark = r.status === 'pass' ? '✓' : r.status === 'fail' ? '✗' : '–';
  return (
    <Badge tone={tone} title={`${checkText(r.def)}${r.detail ? `：${systemText(r.detail)}` : ''}${r.status === 'na' ? tr("（无法判断）") : ''}`}>
      {mark}
      {!compact && ` ${checkText(r.def)}`}
    </Badge>
  );
}

/** The checks every replay of the case is judged by. */
export function ChecksEditor({ checks, onChange, skills }: { checks: CheckDef[]; onChange: (c: CheckDef[]) => void; skills: string[] }) {
  useLocale();
  const [kind, setKind] = useState<CheckKind>('skill_loaded');
  const [value, setValue] = useState('');
  const next = build(kind, value);
  const param = PARAM[kind];
  return (
    <div className="space-y-1">
      {!checks.length && <div className="text-[11.5px] text-zinc-500">{tr("还没有检查项：回放只记录结果，不判断对错")}</div>}
      <div className="flex flex-wrap gap-1">
        {checks.map((c, i) => (
          <span key={i} className="inline-flex items-center gap-0.5 rounded border border-zinc-200 bg-white px-1.5 py-0.5 text-[11.5px] dark:border-zinc-700 dark:bg-zinc-900">
            {checkText(c)}
            <button className="ml-0.5 text-zinc-400 hover:text-red-500" title={tr("删除")} onClick={() => onChange(checks.filter((_, j) => j !== i))}>
              ×
            </button>
          </span>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-1 text-[11.5px]">
        <select value={kind} onChange={(e) => setKind(e.target.value as CheckKind)} className="rounded border border-zinc-300 bg-white px-1 py-0.5 dark:border-zinc-700 dark:bg-zinc-900">
          {(Object.keys(CHECK_LABEL) as CheckKind[]).map((k) => (
            <option key={k} value={k}>
              {CHECK_LABEL[k]}
            </option>
          ))}
        </select>
        {param && (
          <>
            <input
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder={PLACEHOLDER[param]}
              list={param === 'skill' ? 'case-skills' : undefined}
              type={param === 'n' ? 'number' : 'text'}
              className={cx('rounded border border-zinc-300 bg-white px-1.5 py-0.5 dark:border-zinc-700 dark:bg-zinc-900', param === 'n' ? 'w-24' : 'w-56')}
            />
            <datalist id="case-skills">
              {skills.map((s) => (
                <option key={s} value={s} />
              ))}
            </datalist>
          </>
        )}
        <Button
          size="xs"
          disabled={!next}
          onClick={() => {
            if (!next) return;
            onChange([...checks, next]);
            setValue('');
          }}
        >{tr("添加")}</Button>
      </div>
    </div>
  );
}

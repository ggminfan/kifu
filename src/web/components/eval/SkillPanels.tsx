import { useLocale } from '../../../shared/i18n/react';
import { localized, tr } from '../../../shared/i18n';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useLocation } from 'wouter';
import { EVAL_STATUS, setFromSkill, useEvals, useEvalSets, useSkillSignals, type SignalSession } from '../../lib/evalsApi';
import { basename, relTime, shortId } from '../../lib/format';
import { Badge, Button, Empty, ErrorBox, Spinner, cx } from '../ui';

type Filter = 'all' | 'loaded' | 'missed' | 'truncated' | 'listed';

const FILTERS: Array<{ id: Filter; label: string; title: string }> = localized([
  { id: 'all', label: '全部', title: '列出过这个 skill 的会话' },
  { id: 'loaded', label: '加载了', title: '读取过它的 SKILL.md' },
  { id: 'missed', label: '可能漏触发', title: '请求和描述很相关，却没有加载' },
  { id: 'truncated', label: '描述被截断', title: 'skill 列表里它的描述被截断，触发词可能看不到' },
  { id: 'listed', label: '只列出', title: '在列表里，没加载，也和请求无关（反例的来源）' },
]);

const matches = (f: Filter) => (s: SignalSession) =>
  f === 'all' ? true : f === 'loaded' ? s.loaded : f === 'missed' ? s.missed : f === 'truncated' ? s.truncated : s.listed && !s.loaded && !s.missed && !s.truncated;

/** Build a set for the skill from the index, then open it. */
function useFromSkill(skillKey: string) {
  const [, navigate] = useLocation();
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const run = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const r = await setFromSkill(skillKey);
      await qc.invalidateQueries({ queryKey: ['evalSets'] });
      if (!r.added) throw new Error(tr`没有截取到用例${r.failed[0] ? `：${r.failed[0].error}` : tr("（索引里没有相关会话）")}`);
      navigate(`/evals/sets/${r.set.id}`);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  return { run, busy, error };
}

/** Sessions where the skill was listed, loaded, probably missed or cut off (from the index). */
export function SkillSessions({ skillKey }: { skillKey: string }) {
  useLocale();
  const signals = useSkillSignals(skillKey);
  const [filter, setFilter] = useState<Filter>('all');
  const from = useFromSkill(skillKey);
  if (signals.isLoading) return <div className="p-3"><Spinner /></div>;
  if (signals.error) return <ErrorBox error={signals.error} />;
  const d = signals.data!;
  const rows = d.sessions.filter(matches(filter));
  const n: Record<Filter, number> = {
    all: d.sessions.length,
    loaded: d.counts.loaded,
    missed: d.counts.missed,
    truncated: d.counts.truncated,
    listed: d.sessions.filter(matches('listed')).length,
  };
  if (!d.sessions.length) return <Empty>{tr("索引里还没有列出过")}{skillKey}{tr("的会话（后台索引完成后再看）。")}</Empty>;
  return (
    <div>
      <div className="flex flex-wrap items-center gap-1 border-b border-zinc-200 px-2 py-1.5 dark:border-zinc-800">
        {FILTERS.map((f) => (
          <button
            key={f.id}
            title={f.title}
            onClick={() => setFilter(f.id)}
            className={cx('rounded px-1.5 py-0.5 text-[11.5px]', filter === f.id ? 'bg-indigo-600 text-white' : 'text-zinc-600 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800')}
          >
            {f.label} {n[f.id]}
          </button>
        ))}
        <span className="flex-1" />
        {filter !== 'all' && filter !== 'listed' && (
          <Link href={`/?signal=${filter}:${encodeURIComponent(skillKey)}`} className="text-[11px] text-indigo-600 hover:underline dark:text-indigo-400" title={tr("在会话列表里只看这些会话，可以多选加入评测集")}>{tr("在会话列表打开")}</Link>
        )}
      </div>
      <div className="flex items-center gap-2 border-b border-zinc-200 bg-zinc-50 px-2 py-1.5 text-[11.5px] text-zinc-500 dark:border-zinc-800 dark:bg-zinc-900/60">
        <span className="flex-1">{tr("用这些会话做评测：加载了 / 可能漏触发的轮次做正例，只列出的做反例，相近 skill 的做对照。")}</span>
        <Button size="xs" onClick={() => void from.run()} disabled={from.busy}>
          {from.busy ? tr("生成中…") : tr("生成评测集")}
        </Button>
      </div>
      {from.error ? <ErrorBox error={from.error} /> : null}
      {rows.map((s) => (
        <Link key={s.threadId} href={`/s/${s.threadId}`} className="block border-b border-zinc-100 px-2 py-1.5 hover:bg-zinc-50 dark:border-zinc-800 dark:hover:bg-zinc-900">
          <div className="flex items-center gap-1.5 text-[12px]">
            <span className="min-w-0 flex-1 truncate">{s.title || s.threadId}</span>
            {s.loaded && <Badge tone="amber">{tr("⚑ 加载")}</Badge>}
            {s.missed && <Badge tone="red">{tr("可能漏触发")}</Badge>}
            {s.truncated && <Badge tone="violet">{tr("截断")}</Badge>}
          </div>
          <div className="mt-0.5 flex gap-1.5 text-[11px] text-zinc-500">
            <span className="font-mono">{shortId(s.threadId)}</span>
            {s.turnIndex !== undefined && <span>{tr`第${s.turnIndex + 1}轮`}</span>}
            {s.relevance !== undefined && <span title={tr("请求和描述的相关度")}>{tr("相关度")}{s.relevance.toFixed(2)}</span>}
            <span className="truncate">{basename(s.cwd)}</span>
            <span className="flex-1" />
            <span>{relTime(s.updatedAt)}</span>
          </div>
        </Link>
      ))}
    </div>
  );
}

/** Evaluation sets about this skill, with their latest evaluation. */
export function SkillEvals({ skillKey }: { skillKey: string }) {
  useLocale();
  const sets = useEvalSets();
  const evals = useEvals();
  const from = useFromSkill(skillKey);
  const mine = (sets.data ?? []).filter((s) => s.skill === skillKey);
  return (
    <div>
      <div className="flex items-center gap-2 border-b border-zinc-200 px-2 py-1.5 text-[11.5px] text-zinc-500 dark:border-zinc-800">
        <span className="flex-1">{tr("在多个会话上回放，比较改动前后的触发（召回 / 误触发）和结果。")}</span>
        <Button size="xs" onClick={() => void from.run()} disabled={from.busy}>
          {from.busy ? tr("生成中…") : tr("从会话生成评测集")}
        </Button>
      </div>
      {from.error ? <ErrorBox error={from.error} /> : null}
      {sets.isLoading && (
        <div className="p-3">
          <Spinner />
        </div>
      )}
      {!sets.isLoading && !mine.length && <div className="p-3 text-[12px] text-zinc-500">{tr("还没有关于")}{skillKey}{tr("的评测集。")}</div>}
      {mine.map((s) => {
        const list = (evals.data ?? []).filter((e) => e.setId === s.id);
        return (
          <div key={s.id} className="border-b border-zinc-100 px-2 py-1.5 dark:border-zinc-800">
            <Link href={`/evals/sets/${s.id}`} className="flex items-center gap-1.5 text-[12px]">
              <span className="min-w-0 flex-1 truncate font-medium text-indigo-700 hover:underline dark:text-indigo-300">{s.name}</span>
              <span className="text-[11px] text-zinc-500">{s.cases}{tr("个用例")}</span>
            </Link>
            {list.slice(0, 5).map((e) => (
              <Link key={e.id} href={`/evals/${e.id}`} className="mt-0.5 flex items-center gap-1.5 pl-2 text-[11.5px] hover:bg-zinc-50 dark:hover:bg-zinc-900">
                <Badge tone={EVAL_STATUS[e.status].tone}>{EVAL_STATUS[e.status].label}</Badge>
                <span className="min-w-0 flex-1 truncate">{e.name ?? e.arms.map((a) => a.label).join(' vs ')}</span>
                {e.progress && (
                  <span className="font-mono text-[11px] text-zinc-500">
                    {e.progress.done}/{e.progress.total}
                  </span>
                )}
                <span className="text-[11px] text-zinc-500">{relTime(e.createdAt)}</span>
              </Link>
            ))}
          </div>
        );
      })}
    </div>
  );
}

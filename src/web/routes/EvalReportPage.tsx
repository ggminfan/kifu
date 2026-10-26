import { useLocale } from '../../shared/i18n/react';
import { tr } from '../../shared/i18n';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useLocation, useParams } from 'wouter';
import { ROLE_LABEL, type CaseDelta, type CellStats, type RubricItem, type SkillMetrics } from '../../shared/replay';
import { CompareView } from '../components/debug/Compare';
import { ReplayRow } from '../components/debug/Replays';
import { askConfirm } from '../components/dialogs';
import { MatrixGrid, ROLE_TONE } from '../components/eval/MatrixGrid';
import { useResizable } from '../components/Resizer';
import { Badge, Button, Empty, ErrorBox, Spinner, cx } from '../components/ui';
import { api, postJson } from '../lib/api';
import { useCase, useOriginal, type ReplayRecord } from '../lib/casesApi';
import { controlEval, EVAL_STATUS, useCellRuns, useEval, useEvalReport, useEvalSet, useJudgments, type Judgment, type ReportView } from '../lib/evalsApi';
import { fmtTokens, relTime, shortId } from '../lib/format';

const pct = (x: number | undefined) => (x === undefined ? '–' : `${Math.round(x * 100)}%`);

function Progress({ p }: { p: { total: number; done: number; running: number; queued: number; paused: number; failed: number } }) {
  useLocale();
  const w = (n: number) => `${(n / Math.max(1, p.total)) * 100}%`;
  return (
    <div className="flex min-w-48 flex-1 items-center gap-2">
      <div className="flex h-1.5 flex-1 overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800">
        <div className="bg-emerald-500" style={{ width: w(p.done - p.failed) }} />
        <div className="bg-red-500" style={{ width: w(p.failed) }} />
        <div className="animate-pulse bg-sky-400" style={{ width: w(p.running) }} />
      </div>
      <span className="whitespace-nowrap font-mono text-[11px] text-zinc-500">
        {p.done}/{p.total}
        {p.running ? tr` · ${p.running} 运行中` : ''}
        {p.queued ? tr` · ${p.queued} 排队` : ''}
        {p.paused ? tr` · ${p.paused} 暂停` : ''}
        {p.failed ? tr` · ${p.failed} 没跑成` : ''}
      </span>
    </div>
  );
}

function DeltaList({ title, tone, items, report, onPick }: { title: string; tone: 'red' | 'green'; items: CaseDelta[]; report: ReportView; onPick: (d: CaseDelta) => void }) {
  useLocale();
  if (!items.length) return null;
  return (
    <div>
      <div className={cx('mb-0.5 text-[12px] font-semibold', tone === 'red' ? 'text-red-600' : 'text-emerald-600')}>
        {title}（{items.length}）
      </div>
      <div className="space-y-0.5">
        {items.slice(0, 50).map((d) => (
          <button key={`${d.caseId}|${d.arm}`} onClick={() => onPick(d)} className="flex w-full items-center gap-1.5 rounded px-1 py-0.5 text-left text-[12px] hover:bg-zinc-100 dark:hover:bg-zinc-900">
            <Badge tone={ROLE_TONE[report.rows.find((r) => r.caseId === d.caseId)?.role ?? 'positive']}>{ROLE_LABEL[report.rows.find((r) => r.caseId === d.caseId)?.role ?? 'positive']}</Badge>
            <span className="min-w-0 flex-1 truncate">{report.titles[d.caseId]}</span>
            <span className="font-mono text-[11px] text-zinc-500">
              {report.baseline} {d.basePass}/{d.baseRuns} → {d.arm} {d.armPass}/{d.armRuns}
            </span>
            {d.p !== undefined && (
              <Badge tone={d.significant ? tone : 'zinc'} title={tr("单侧 Fisher 精确检验：p < 0.05 说明差异不太可能只是随机波动")}>
                p={d.p < 0.001 ? '<0.001' : d.p.toFixed(3)}
              </Badge>
            )}
          </button>
        ))}
      </div>
    </div>
  );
}

function Totals({ report, rubric }: { report: ReportView; rubric?: RubricItem[] }) {
  useLocale();
  const skill = report.skill;
  const th = 'px-2 py-1 text-right font-medium';
  const td = 'px-2 py-1 text-right font-mono text-[11.5px]';
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-[12px]">
        <thead className="text-[11px] text-zinc-500">
          <tr>
            <th className="px-2 py-1 text-left font-medium">{tr("改动组")}</th>
            <th className={th} title={tr("所有检查都通过的次数 / 有检查结果的次数")}>{tr("通过")}</th>
            <th className={th}>{tr("没跑成")}</th>
            <th className={th}>{tr("中位步数")}</th>
            <th className={th}>{tr("中位输入")}</th>
            {skill && (
              <>
                <th className={th} title={tr`正例里加载了 ${skill.name} 的比例`}>{tr("召回")}</th>
                <th className={th} title={tr`反例和对照里加载了 ${skill.name} 的比例（越低越好）`}>{tr("误触发")}</th>
                <th className={th} title={tr`加载了 ${skill.name} 的运行里，正例的比例`}>{tr("精确率")}</th>
              </>
            )}
            {rubric?.map((r) => (
              <th key={r.id} className={th} title={r.text}>
                {r.id}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {report.arms.map((arm) => {
            const t: CellStats | undefined = report.totals[arm];
            const m: SkillMetrics | undefined = skill?.perArm[arm];
            const base = report.baseline && arm !== report.baseline ? report.totals[report.baseline] : undefined;
            const better = (a?: number, b?: number, higher = true) => (a === undefined || b === undefined || a === b ? '' : (a > b) === higher ? 'text-emerald-600' : 'text-red-600');
            const bm = base && skill ? skill.perArm[report.baseline!] : undefined;
            return (
              <tr key={arm} className="border-t border-zinc-100 dark:border-zinc-800">
                <td className="px-2 py-1 font-medium">
                  {arm}
                  {arm === report.baseline && <span className="ml-1 text-[11px] font-normal text-zinc-400">{tr("基线")}</span>}
                </td>
                <td className={cx(td, better(t?.passRate, base?.passRate))}>
                  {t?.judged ? `${t.passed}/${t.judged} · ${pct(t.passRate)}` : '–'}
                </td>
                <td className={cx(td, Boolean(t?.errors) && 'text-red-600')}>{t?.errors || '–'}</td>
                <td className={cx(td, better(t?.medianSteps, base?.medianSteps, false))}>{t?.medianSteps ?? '–'}</td>
                <td className={td}>{fmtTokens(t?.medianInput)}</td>
                {skill && (
                  <>
                    <td className={cx(td, better(m?.recall, bm?.recall))} title={m ? `${m.tp}/${m.tp + m.fn}` : undefined}>
                      {pct(m?.recall)}
                    </td>
                    <td className={cx(td, better(m?.falseTriggerRate, bm?.falseTriggerRate, false))} title={m ? `${m.fp}/${m.fp + m.tn}` : undefined}>
                      {pct(m?.falseTriggerRate)}
                    </td>
                    <td className={cx(td, better(m?.precision, bm?.precision))}>{pct(m?.precision)}</td>
                  </>
                )}
                {rubric?.map((r) => (
                  <td key={r.id} className={td}>
                    {t?.scores?.[r.id] !== undefined ? t.scores[r.id].toFixed(1) : '–'}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** Judge scores of one run, editable (a score set by hand replaces the model's). */
function Scores({ evalId, run, rubric, j }: { evalId: string; run: ReplayRecord; rubric: RubricItem[]; j?: Judgment }) {
  useLocale();
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const set = async (id: string, n: number) => {
    setBusy(true);
    try {
      await postJson(`/evals/${evalId}/judgments/${run.id}`, { scores: { ...j?.scores, [id]: n }, rationale: j?.rationale ?? {} }, 'PUT');
      await Promise.all(['judgments', 'evalReport'].map((k) => qc.invalidateQueries({ queryKey: [k, evalId] })));
    } finally {
      setBusy(false);
    }
  };
  if (run.status !== 'completed') return null;
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 pl-4 text-[11px]">
      <span className="text-zinc-500">{j ? (j.source === 'user' ? tr("人工评分") : tr("模型评分")) : tr("还没有评分")}</span>
      {j?.rationale.error && <span className="text-red-600">{j.rationale.error}</span>}
      {rubric.map((r) => (
        <label key={r.id} className="flex items-center gap-0.5" title={`${r.text}${j?.rationale[r.id] ? `\n${j.rationale[r.id]}` : ''}`}>
          <span className="font-mono text-zinc-500">{r.id}</span>
          <select disabled={busy} value={j?.scores[r.id] ?? ''} onChange={(e) => e.target.value && void set(r.id, Number(e.target.value))} className="rounded border border-zinc-300 bg-white px-0.5 dark:border-zinc-700 dark:bg-zinc-900">
            <option value="">–</option>
            {[1, 2, 3, 4, 5].map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
      ))}
    </div>
  );
}

/** One cell: its runs (with scores), compared with the baseline's runs of the same case. */
function CellDetail({ evalId, caseId, arm, baseline, running, rubric, judgments }: { evalId: string; caseId: string; arm: string; baseline?: string; running: boolean; rubric?: RubricItem[]; judgments?: Record<string, Judgment> }) {
  useLocale();
  const c = useCase(caseId);
  const original = useOriginal(caseId);
  const runs = useCellRuns(evalId, caseId, arm, running);
  const base = useCellRuns(evalId, caseId, baseline && baseline !== arm ? baseline : undefined, running);
  const all = [...(base.data ?? []), ...(runs.data ?? [])];
  const checks = [...(c.data?.checks ?? []), ...(runs.data?.[0]?.options.extraChecks ?? [])];
  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-zinc-200 py-2 pl-3 pr-7 dark:border-zinc-800">
        <div className="flex items-center gap-1.5 text-[12.5px]">
          <span className="min-w-0 flex-1 truncate font-semibold" title={c.data?.title}>
            {c.data?.title ?? caseId}
          </span>
          <Link href={`/cases/${caseId}`} className="shrink-0 text-[11px] text-indigo-600 hover:underline dark:text-indigo-400">{tr("用例 →")}</Link>
        </div>
        <div className="mt-0.5 text-[11px] text-zinc-500">
          {arm}{tr("的")}{runs.data?.length ?? '…'}{tr("次运行")}{baseline && baseline !== arm ? tr`，与基线 ${baseline} 对比` : ''}
          {c.data ? tr` · ${shortId(c.data.threadId)} 第 ${c.data.turnIndex + 1} 轮` : ''}
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {runs.isLoading && (
          <div className="p-3">
            <Spinner />
          </div>
        )}
        {runs.data?.map((r) => (
          <ReplayRow key={r.id} r={r} extra={rubric ? <Scores evalId={evalId} run={r} rubric={rubric} j={judgments?.[r.id]} /> : undefined} />
        ))}
        {all.length > 0 && (
          <div className="border-t border-zinc-200 dark:border-zinc-800">
            <div className="px-2 pt-2 text-[12px] font-semibold">{tr("对比")}</div>
            <CompareView checks={checks} original={original.data} replays={all} />
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * An evaluation's report: progress and controls, per-group totals (pass rate,
 * the set's skill: recall / false triggers / precision, judge scores), cases
 * that got worse than the baseline on top, the matrix, and a cell's runs.
 */
export function EvalReportPage() {
  useLocale();
  const { id } = useParams<{ id: string }>();
  const [, navigate] = useLocation();
  const qc = useQueryClient();
  const right = useResizable('eval-cell', 480, 340, 900, 'left');
  const e = useEval(id);
  const running = e.data?.status === 'running';
  const report = useEvalReport(id, running);
  const set = useEvalSet(e.data?.setId);
  const judging = (e.data?.judging ?? 0) > 0;
  const judgments = useJudgments(id, Boolean(e.data?.rubric), running || judging);
  const finished = Object.values(report.data?.totals ?? {}).reduce((n, t) => n + t.runs - t.errors - t.pending, 0);
  const scored = Object.values(judgments.data ?? {}).filter((j) => Object.keys(j.scores).length > 0).length;
  const [cell, setCell] = useState<{ caseId: string; arm: string }>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();

  if (e.isLoading) return <div className="p-4"><Spinner label={tr("读取评测…")} /></div>;
  if (e.error) return <ErrorBox error={e.error} />;
  if (!e.data) return null;
  const x = e.data;
  const st = EVAL_STATUS[x.status];

  const act = async (action: 'pause' | 'resume' | 'cancel') => {
    if (action === 'cancel' && !(await askConfirm({ title: tr("取消这次评测？"), body: tr("还没跑的格子不再运行；已经完成的结果保留。"), confirm: tr("取消评测"), danger: true }))) return;
    setBusy(true);
    setError(undefined);
    try {
      await controlEval(x.id, action);
      await Promise.all(['eval', 'evalReport', 'evalSet', 'evals'].map((k) => qc.invalidateQueries({ queryKey: [k] })));
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  const rejudge = async () => {
    if (!(await askConfirm({ title: tr`给 ${finished - scored} 次运行补评分？`, body: tr("每次再调用一次 agent 打分，用它自己的登录和额度。"), confirm: tr("补评分") }))) return;
    setBusy(true);
    setError(undefined);
    try {
      await postJson(`/evals/${x.id}/judge`, {});
      await Promise.all(['eval', 'judgments'].map((k) => qc.invalidateQueries({ queryKey: [k] })));
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    if (!(await askConfirm({ title: tr("删除这次评测？"), body: tr("它的所有回放和评分一起删除，用例保留。"), confirm: tr("删除"), danger: true }))) return;
    await api(`/evals/${x.id}`, { method: 'DELETE' });
    await qc.invalidateQueries({ queryKey: ['evalSet'] });
    navigate(`/evals/sets/${x.setId}`);
  };
  const r = report.data;

  return (
    <div className="flex h-full min-h-0">
      <div className="flex min-w-0 flex-1 flex-col bg-white dark:bg-zinc-950">
        <div className="space-y-1.5 border-b border-zinc-200 px-3 py-2 dark:border-zinc-800">
          <div className="flex items-center gap-2">
            <Link href={`/evals/sets/${x.setId}`} className="text-[12px] text-indigo-600 hover:underline dark:text-indigo-400">
              ← {set.data?.name ?? tr("评测集")}
            </Link>
            <h1 className="min-w-0 truncate text-[14px] font-semibold">{x.name ?? tr`评测 ${relTime(x.createdAt)}`}</h1>
            <Badge tone={st.tone}>{st.label}</Badge>
            <span className="flex-1" />
            {x.status === 'running' && (
              <Button size="xs" disabled={busy} onClick={() => void act('pause')} title={tr("排队的格子不再开始；正在运行的跑完")}>{tr("暂停")}</Button>
            )}
            {x.status === 'paused' && (
              <Button size="xs" variant="primary" disabled={busy} onClick={() => void act('resume')}>{tr("继续")}</Button>
            )}
            {(x.status === 'running' || x.status === 'paused') && (
              <Button size="xs" variant="ghost" disabled={busy} onClick={() => void act('cancel')}>{tr("取消")}</Button>
            )}
            {x.status !== 'running' && (
              <Button size="xs" variant="ghost" onClick={() => void remove()}>{tr("删除")}</Button>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-zinc-500">
            {x.progress && <Progress p={x.progress} />}
            <span>
              {x.arms.length}{tr("组 × 每格")}{x.repeats}{tr("次 · 最多")}{x.options.maxSteps}{tr("步 ·")}{x.options.model ?? tr("原模型")}
              {x.options.effort ? `（${x.options.effort}）` : ''} · {{ readonly: tr("原目录只读"), clone: tr("克隆工作区"), empty: tr("空目录") }[x.options.workspace]}
              {x.options.allowMcp ? tr(" · 允许外部工具") : ''}
              {x.rubric ? tr` · 模型评分 ${x.rubric.length} 项${judging ? tr`（${x.judging} 次评分进行中）` : ''}` : ''}
              {x.estimate ? tr` · 预计 ${fmtTokens(x.estimate.tokens)} tokens` : ''}
            </span>
          </div>
          {x.status === 'paused' && x.progress?.paused ? <div className="text-[11.5px] text-amber-600">{tr("已暂停（手动暂停或服务重启）：")}{x.progress.paused}{tr("格等待继续。继续会用掉剩余的额度。")}</div> : null}
          {x.rubric && !running && !judging && judgments.data && scored < finished ? (
            <div className="flex items-center gap-2 text-[11.5px] text-amber-600">
              {finished - scored}{tr("次运行没有评分（评分失败，或服务重启时还没评）。")}<Button size="xs" disabled={busy} onClick={() => void rejudge()}>{tr("补评分")}</Button>
            </div>
          ) : null}
          {error ? <ErrorBox error={error} /> : null}
        </div>
        {!r ? (
          report.error ? (
            <ErrorBox error={report.error} />
          ) : (
            <div className="p-3">
              <Spinner />
            </div>
          )
        ) : (
          <div className="flex min-h-0 flex-1 flex-col">
            <div className="max-h-[50%] shrink-0 space-y-3 overflow-auto border-b border-zinc-200 p-3 dark:border-zinc-800">
              <Totals report={r} rubric={x.rubric} />
              <DeltaList title={tr("变差了（回归）")} tone="red" items={r.regressions} report={r} onPick={(d) => setCell({ caseId: d.caseId, arm: d.arm })} />
              <DeltaList title={tr("变好了")} tone="green" items={r.improvements} report={r} onPick={(d) => setCell({ caseId: d.caseId, arm: d.arm })} />
              {!r.baseline && <div className="text-[11.5px] text-zinc-500">{tr("没有不改动的基线组（A′），无法判断回归。")}</div>}
            </div>
            <div className="min-h-0 flex-1">
              {r.rows.length ? <MatrixGrid report={r} selected={cell} onSelect={setCell} /> : <Empty>{tr("评测集里没有用例")}</Empty>}
            </div>
          </div>
        )}
      </div>
      {cell && (
        <>
          {right.handle}
          <div style={{ width: right.width }} className="relative shrink-0 border-l border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
            <button className="absolute right-2 top-2 z-10 text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200" onClick={() => setCell(undefined)} title={tr("关闭")}>
              ×
            </button>
            <CellDetail key={`${cell.caseId}|${cell.arm}`} evalId={x.id} caseId={cell.caseId} arm={cell.arm} baseline={r?.baseline} running={running} rubric={x.rubric} judgments={judgments.data} />
          </div>
        </>
      )}
    </div>
  );
}

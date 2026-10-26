import { useLocale } from '../../shared/i18n/react';
import { tr } from '../../shared/i18n';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Link, useLocation, useParams, useSearch } from 'wouter';
import { AGENT_ICON } from '../../shared/agent-icons';
import { ROLE_LABEL, type CaseRole } from '../../shared/replay';
import { askConfirm } from '../components/dialogs';
import { NewEvalDialog } from '../components/eval/NewEvalDialog';
import { Badge, Button, ErrorBox, Spinner, cx } from '../components/ui';
import { api, postJson } from '../lib/api';
import { useCases } from '../lib/casesApi';
import { addCasesToSet, EVAL_STATUS, useEvalSet } from '../lib/evalsApi';
import { relTime, shortId } from '../lib/format';
import { useCatalog, useVariant } from '../lib/labApi';

const ROLES: CaseRole[] = ['positive', 'negative', 'control'];
const field = 'rounded border border-zinc-300 bg-white px-1 py-0.5 text-[12px] dark:border-zinc-700 dark:bg-zinc-900';

/** Add cases of this workspace that are not in the set yet. */
function AddCases({ setId, members }: { setId: string; members: Set<string> }) {
  useLocale();
  const qc = useQueryClient();
  const cases = useCases();
  const [pick, setPick] = useState('');
  const [role, setRole] = useState<CaseRole>('positive');
  const [busy, setBusy] = useState(false);
  const free = (cases.data ?? []).filter((c) => !members.has(c.id));
  const add = async () => {
    if (!pick) return;
    setBusy(true);
    try {
      await addCasesToSet(setId, [pick], role);
      setPick('');
      await Promise.all(['evalSet', 'evalSets', 'cases'].map((k) => qc.invalidateQueries({ queryKey: [k] })));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex flex-wrap items-center gap-1.5 text-[12px]">
      <select value={pick} onChange={(e) => setPick(e.target.value)} className={cx(field, 'max-w-80')}>
        <option value="">{tr("+ 加入已有用例…（")}{free.length}）</option>
        {free.map((c) => (
          <option key={c.id} value={c.id}>
            {c.title}{tr` · 第${c.turnIndex + 1}轮`}</option>
        ))}
      </select>
      <select value={role} onChange={(e) => setRole(e.target.value as CaseRole)} className={field}>
        {ROLES.map((r) => (
          <option key={r} value={r}>
            {ROLE_LABEL[r]}
          </option>
        ))}
      </select>
      <Button size="xs" disabled={!pick || busy} onClick={() => void add()}>{tr("加入")}</Button>
      <span className="text-[11px] text-zinc-500">{tr("也可以在会话列表里多选会话，批量加入。")}</span>
    </div>
  );
}

/**
 * A set of cases for evaluation: each case has a role for the set's skill
 * (正例 should load it, 反例 and 对照 should not); evaluations of the set.
 */
export function EvalSetPage() {
  useLocale();
  const { id } = useParams<{ id: string }>();
  const [, navigate] = useLocation();
  const search = useSearch();
  const qc = useQueryClient();
  const set = useEvalSet(id);
  const catalog = useCatalog();
  const [name, setName] = useState('');
  // ?new=<variant>: open the new-evaluation dialog comparing A′ with that variant (from the distill page)
  const preset = new URLSearchParams(search).get('new') ?? undefined;
  const presetVariant = useVariant(preset);
  const [creating, setCreating] = useState(Boolean(preset));
  const [error, setError] = useState<unknown>();
  useEffect(() => {
    if (set.data) setName(set.data.name);
  }, [set.data?.name]);
  if (set.isLoading) return <div className="p-4"><Spinner label={tr("读取评测集…")} /></div>;
  if (set.error) return <ErrorBox error={set.error} />;
  if (!set.data) return null;
  const s = set.data;
  const refresh = () => Promise.all(['evalSet', 'evalSets'].map((k) => qc.invalidateQueries({ queryKey: [k] })));
  const patch = async (body: { name?: string; skill?: string | null; note?: string }) => {
    setError(undefined);
    try {
      await postJson(`/eval-sets/${s.id}`, body, 'PATCH');
      await refresh();
    } catch (e) {
      setError(e);
    }
  };
  const setRole = async (caseId: string, role: CaseRole) => {
    await postJson(`/eval-sets/${s.id}/cases/${caseId}`, { role }, 'PATCH');
    await refresh();
  };
  const removeCase = async (caseId: string) => {
    await api(`/eval-sets/${s.id}/cases/${caseId}`, { method: 'DELETE' });
    await refresh();
  };
  const removeSet = async () => {
    if (!(await askConfirm({ title: tr`删除评测集「${s.name}」？`, body: tr("它的评测记录和评测产生的回放一起删除；用例本身保留。"), confirm: tr("删除"), danger: true }))) return;
    await api(`/eval-sets/${s.id}`, { method: 'DELETE' });
    await qc.invalidateQueries({ queryKey: ['evalSets'] });
    navigate('/evals');
  };
  const counts = Object.fromEntries(ROLES.map((r) => [r, s.members.filter((m) => m.role === r).length])) as Record<CaseRole, number>;

  return (
    <div className="h-full overflow-auto bg-white dark:bg-zinc-950">
      <div className="mx-auto max-w-5xl space-y-4 p-4">
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <Link href="/evals" className="text-[12px] text-indigo-600 hover:underline dark:text-indigo-400">{tr("← 评测")}</Link>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              onBlur={() => name.trim() && name !== s.name && void patch({ name })}
              className="min-w-0 flex-1 rounded border border-transparent bg-transparent px-1 text-[15px] font-semibold hover:border-zinc-300 focus:border-indigo-500 dark:hover:border-zinc-700"
            />
            <Button
              variant="ghost"
              disabled={!s.members.length}
              title={tr("从这些用例的会话提炼一个新 skill")}
              onClick={() => navigate(`/skills/new?from=${s.members.filter((m) => m.case && m.role === 'positive').slice(0, 20).map((m) => `case-${m.caseId}`).join(',') || s.members.slice(0, 20).map((m) => `case-${m.caseId}`).join(',')}`)}
            >{tr("提炼 skill")}</Button>
            <Button variant="primary" disabled={!s.members.length} onClick={() => setCreating(true)}>{tr("新评测")}</Button>
            <Button variant="ghost" onClick={() => void removeSet()}>{tr("删除")}</Button>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-[12px] text-zinc-600 dark:text-zinc-300">
            <label className="flex items-center gap-1">{tr("评测的 skill")}<select value={s.skill ?? ''} onChange={(e) => void patch({ skill: e.target.value || null })} className={cx(field, 'max-w-64')}>
                <option value="">{tr("（不指定）")}</option>
                {s.skill && !catalog.data?.some((k) => k.key === s.skill) && <option value={s.skill}>{s.skill}</option>}
                {(catalog.data ?? [])
                  .filter((k) => !k.shadowedBy)
                  .map((k) => (
                    <option key={k.key} value={k.key}>
                      {k.key}
                    </option>
                  ))}
              </select>
            </label>
            {s.skill ? (
              <span className="text-[11px] text-zinc-500">{tr("正例要求加载")}{s.skill}{tr("，反例和对照要求不加载；汇总里给出召回、误触发和精确率。")}<Link href={`/skills?skill=${encodeURIComponent(s.skill)}`} className="ml-1 text-indigo-600 hover:underline dark:text-indigo-400">{tr("Skills 页 →")}</Link>
              </span>
            ) : (
              <span className="text-[11px] text-zinc-500">{tr("不指定 skill 时只按每个用例自己的检查项判断。")}</span>
            )}
          </div>
          {error ? <ErrorBox error={error} /> : null}
        </div>

        <section>
          <div className="mb-1.5 flex items-center gap-2 text-[13px] font-semibold">{tr("用例（")}{s.members.length}）
            <span className="text-[11px] font-normal text-zinc-500">
              {ROLES.filter((r) => counts[r]).map((r) => `${ROLE_LABEL[r]} ${counts[r]}`).join(' · ')}
            </span>
          </div>
          <AddCases setId={s.id} members={new Set(s.members.map((m) => m.caseId))} />
          <table className="mt-2 w-full table-fixed border-collapse text-[12.5px]">
            <thead className="text-left text-[11px] text-zinc-500">
              <tr>
                <th className="w-20 py-1 font-medium">{tr("角色")}</th>
                <th className="py-1 font-medium">{tr("用例")}</th>
                <th className="w-36 py-1 font-medium">{tr("会话 / 轮次")}</th>
                <th className="w-12 py-1 font-medium">{tr("检查")}</th>
                <th className="w-20 py-1 font-medium">{tr("加入")}</th>
                <th className="w-6" />
              </tr>
            </thead>
            <tbody>
              {s.members.map((m) => (
                <tr key={m.caseId} className="border-t border-zinc-100 dark:border-zinc-800">
                  <td className="py-1">
                    <select value={m.role} onChange={(e) => void setRole(m.caseId, e.target.value as CaseRole)} className={cx(field, 'text-[11.5px]')}>
                      {ROLES.map((r) => (
                        <option key={r} value={r}>
                          {ROLE_LABEL[r]}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="py-1 pr-2">
                    {m.case ? (
                      <Link href={`/cases/${m.caseId}`} className="flex items-center gap-1.5">
                        <img src={AGENT_ICON[m.case.agent]} alt="" className="h-3.5 w-3.5 shrink-0" />
                        <span className="truncate text-indigo-700 hover:underline dark:text-indigo-300">{m.case.title}</span>
                      </Link>
                    ) : (
                      <span className="text-zinc-400">{tr("用例已删除")}</span>
                    )}
                  </td>
                  <td className="whitespace-nowrap py-1 font-mono text-[11px] text-zinc-500">{m.case ? tr`${shortId(m.case.threadId)} · 第 ${m.case.turnIndex + 1} 轮` : ''}</td>
                  <td className="py-1 text-[11px] text-zinc-500">{m.case ? tr`${m.case.checks.length} 项` : ''}</td>
                  <td className="whitespace-nowrap py-1 text-[11px] text-zinc-500">{relTime(m.addedAt)}</td>
                  <td className="py-1 text-right">
                    <button className="text-zinc-400 hover:text-red-500" title={tr("移出评测集（用例保留）")} onClick={() => void removeCase(m.caseId)}>
                      ×
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!s.members.length && <div className="py-3 text-[12px] text-zinc-500">{tr("还没有用例。")}</div>}
        </section>

        <section>
          <div className="mb-1.5 text-[13px] font-semibold">{tr("评测记录（")}{s.evals.length}）</div>
          {!s.evals.length && <div className="text-[12px] text-zinc-500">{tr("还没有评测。点\"新评测\"选择要比较的改动。")}</div>}
          <div className="divide-y divide-zinc-100 dark:divide-zinc-800">
            {s.evals.map((e) => {
              const st = EVAL_STATUS[e.status];
              return (
                <Link key={e.id} href={`/evals/${e.id}`} className="flex items-center gap-2 py-1.5 text-[12.5px] hover:bg-zinc-50 dark:hover:bg-zinc-900">
                  <Badge tone={st.tone}>{st.label}</Badge>
                  <span className="min-w-0 flex-1 truncate">
                    {e.name ?? e.arms.map((a) => a.label).join(' vs ')}
                    <span className="ml-2 text-[11px] text-zinc-500">
                      {e.arms.length}{tr("组 ×")}{e.repeats}{tr("次")}{e.rubric ? tr(" · 模型评分") : ''}
                    </span>
                  </span>
                  {e.progress && (
                    <span className="font-mono text-[11px] text-zinc-500">
                      {e.progress.done}/{e.progress.total}
                      {e.progress.failed ? tr` · ${e.progress.failed} 没跑成` : ''}
                    </span>
                  )}
                  <span className="w-20 text-right text-[11px] text-zinc-500">{relTime(e.createdAt)}</span>
                </Link>
              );
            })}
          </div>
        </section>
      </div>
      {creating && (!preset || presetVariant.data || presetVariant.error) && (
        <NewEvalDialog
          set={s}
          cases={s.members.filter((m) => m.case).length}
          initialArms={
            preset && presetVariant.data
              ? [
                  { label: 'A′', variantIds: [] },
                  { label: `+${presetVariant.data.skillName}`.slice(0, 40), variantIds: [preset] },
                ]
              : undefined
          }
          onClose={() => {
            setCreating(false);
            if (preset) navigate(`/evals/sets/${s.id}`, { replace: true });
          }}
          onStarted={(evalId) => {
            setCreating(false);
            void refresh();
            navigate(`/evals/${evalId}`);
          }}
        />
      )}
    </div>
  );
}

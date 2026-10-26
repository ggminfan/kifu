import { systemText, getLocale, tr } from '../../shared/i18n';
import { useLocale } from '../../shared/i18n/react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { Link, useLocation, useParams } from 'wouter';
import { AGENT_ICON } from '../../shared/agent-icons';
import type { Arm, CheckDef, Workspace } from '../../shared/replay';
import { seqLabel } from '../../core/compare/summary';
import { AskBox } from '../components/AskBox';
import { ArmsEditor } from '../components/debug/Arms';
import { CheckChip, ChecksEditor } from '../components/debug/Checks';
import { CompareView } from '../components/debug/Compare';
import { ReplayList } from '../components/debug/Replays';
import { askConfirm } from '../components/dialogs';
import { Markdown } from '../components/Markdown';
import { useResizable } from '../components/Resizer';
import { Badge, Button, Empty, ErrorBox, Spinner, Tabs, cx } from '../components/ui';
import { api, postJson, useSkillReport, useTrace } from '../lib/api';
import { useCase, useModels, useOriginal, useReplays } from '../lib/casesApi';
import { fmtDuration, fmtTokens } from '../lib/format';

type Tab = 'replay' | 'compare' | 'why';

function Section({ title, children, aside }: { title: string; children: React.ReactNode; aside?: React.ReactNode }) {
  useLocale();
  return (
    <div className="border-b border-zinc-200 p-2.5 dark:border-zinc-800">
      <div className="mb-1.5 flex items-center gap-2 text-[12px] font-semibold">
        {title}
        <span className="flex-1" />
        {aside}
      </div>
      {children}
    </div>
  );
}

/**
 * Debugging one turn: the original turn K on the left; on
 * the right why it went that way, what to change (input, skill variants,
 * model, checks), replays of the change against a no-change baseline A′, and
 * the comparison.
 */
export function CasePage() {
  useLocale();
  const { id } = useParams<{ id: string }>();
  const [, navigate] = useLocation();
  const qc = useQueryClient();
  const left = useResizable('case-left', 380, 280, 640, 'right');
  const c = useCase(id);
  const original = useOriginal(id);
  const allReplays = useReplays(id);
  // cells of evaluations are shown in their reports; here only the case's own replays
  const replays = { ...allReplays, data: allReplays.data?.filter((r) => !r.evalId) };
  const evalIds = [...new Set((allReplays.data ?? []).flatMap((r) => (r.evalId ? [r.evalId] : [])))];
  const caseKey = `case-${id}`;
  const trace = useTrace(caseKey);
  const skills = useSkillReport(caseKey);
  const models = useModels(id);
  const [tab, setTab] = useState<Tab>('replay');

  // what to change
  const [prompt, setPrompt] = useState<string>();
  const [arms, setArms] = useState<Arm[]>([{ label: 'A′', variantIds: [] }]);
  const [model, setModel] = useState<string>();
  const [effort, setEffort] = useState<string>();
  const [repeats, setRepeats] = useState(1);
  const [maxSteps, setMaxSteps] = useState(30);
  const [workspace, setWorkspace] = useState<Workspace>('readonly');
  const [allowMcp, setAllowMcp] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  useEffect(() => {
    if (!c.data) return;
    setPrompt((p) => p ?? c.data.prompt);
    setModel((m) => m ?? c.data.meta.model);
    setEffort((e) => e ?? c.data.meta.effort);
  }, [c.data]);

  const request = { arms, repeats, maxSteps, model, effort, workspace, allowMcp };
  const estimate = useQuery({
    queryKey: ['estimate', id, arms.length, repeats, maxSteps],
    queryFn: () => postJson<{ replays: number; perReplay: number; total: number }>(`/cases/${id}/estimate`, request),
    enabled: Boolean(c.data),
  });
  const skillNames = useMemo(() => (skills.data?.rows ?? []).map((r) => r.name), [skills.data, getLocale()]);
  const modelInfo = models.data?.find((m) => m.id === model);

  if (c.isLoading) return <div className="p-4"><Spinner label={tr("读取用例…")} /></div>;
  if (c.error) return <ErrorBox error={c.error} />;
  if (!c.data) return null;
  const x = c.data;
  const o = original.data?.summary ?? x.original;

  const refresh = async () => {
    await Promise.all(['case', 'replays', 'caseOriginal', 'cases'].map((k) => qc.invalidateQueries({ queryKey: [k] })));
  };
  const saveChecks = async (checks: CheckDef[]) => {
    await api(`/cases/${x.id}`, { method: 'PATCH', body: JSON.stringify({ checks }) });
    await refresh();
  };
  const start = async () => {
    setBusy(true);
    setError(undefined);
    try {
      if (!arms.length) throw new Error(tr("至少需要一组改动"));
      const total = estimate.data?.total ?? 0;
      if (total > 300_000 && !(await askConfirm({ title: tr`这次要回放 ${estimate.data?.replays} 次`, body: tr`预计约 ${fmtTokens(total)} tokens（多数命中缓存），用的是 ${x.agent} 自己的登录和额度。`, confirm: tr("开始回放") }))) return;
      if (prompt !== undefined && prompt !== x.prompt) await api(`/cases/${x.id}`, { method: 'PATCH', body: JSON.stringify({ prompt }) });
      await postJson(`/cases/${x.id}/replays`, { ...request, prompt });
      await refresh();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  const cancel = async (runId: string) => {
    await postJson(`/runs/${runId}/cancel`, {});
    await refresh();
  };
  const remove = async (runId: string) => {
    await api(`/cases/${x.id}/replays/${runId}`, { method: 'DELETE' });
    await refresh();
  };
  const deleteCase = async () => {
    if (!(await askConfirm({ title: tr("删除这个用例？"), body: tr("它的回放和文件一起删除。原会话不受影响。"), confirm: tr("删除"), danger: true }))) return;
    await api(`/cases/${x.id}`, { method: 'DELETE' });
    await qc.invalidateQueries({ queryKey: ['cases'] });
    navigate('/cases');
  };
  const toggleSaved = async () => {
    await api(`/cases/${x.id}`, { method: 'PATCH', body: JSON.stringify({ saved: !x.saved }) });
    await refresh();
  };
  const firstCall = original.data?.firstCall;
  const promptEdited = prompt !== undefined && prompt !== x.originalPrompt;

  return (
    <div className="flex h-full min-h-0">
      {/* ------------------------------------------------ the original turn K */}
      <div style={{ width: left.width }} className="flex shrink-0 flex-col overflow-auto border-r border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
        <div className="border-b border-zinc-200 p-2.5 dark:border-zinc-800">
          <div className="flex items-center gap-1.5">
            <img src={AGENT_ICON[x.agent]} alt="" className="h-3.5 w-3.5" />
            <span className="text-[12px] font-semibold">{tr`原始第${x.turnIndex + 1}轮`}</span>
            <span className="flex-1" />
            <Link href={`/s/${x.threadId}${firstCall !== undefined ? `?call=${firstCall}` : ''}`} className="text-[11px] text-indigo-600 hover:underline dark:text-indigo-400" title={tr("原会话（还在时）")}>{tr("原会话 →")}</Link>
            <Link href={`/s/${caseKey}${firstCall !== undefined ? `?call=${firstCall}` : ''}`} className="text-[11px] text-indigo-600 hover:underline dark:text-indigo-400" title={tr("用例保存的副本（到这一轮为止）")}>{tr("副本 →")}</Link>
          </div>
          <div className="mt-1 flex flex-wrap gap-1 text-[11px]">
            {x.meta.model && <Badge tone="indigo">{x.meta.model}{x.meta.effort ? ` · ${x.meta.effort}` : ''}</Badge>}
            {x.meta.cliVersion && <Badge>{x.agent} {x.meta.cliVersion}</Badge>}
            {x.meta.sourceLabel && <Badge tone="sky">{x.meta.sourceLabel}</Badge>}
          </div>
          {x.meta.warnings.length > 0 && <div className="mt-1 text-[11px] text-amber-600">{tr("注意：")}{x.meta.warnings.join('；')}{tr("，回放可能和原来不同")}</div>}
          {x.meta.cwd && <div className="mt-1 break-all font-mono text-[10.5px] text-zinc-400">{x.meta.cwd}</div>}
        </div>
        <Section title={tr("输入")}>
          <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded bg-zinc-50 p-1.5 text-[12px] dark:bg-zinc-900">{x.originalPrompt || tr("（空）")}</pre>
        </Section>
        <Section title={tr("这一轮做了什么")}>
          {o ? (
            <div className="space-y-1 text-[12px]">
              <div className="font-mono text-[11px] text-zinc-500">
                {o.steps}{tr("步 ·")}{tr`${o.tools} 个工具调用`}{o.toolErrors ? tr` · ${o.toolErrors} 失败` : ''}
                {o.failedCommands ? tr` · ${o.failedCommands} 失败命令` : ''}
                {o.loops ? tr` · ${o.loops} 处循环` : ''} · {fmtTokens(o.inputTokens)} in · {fmtDuration(o.durationMs)}
              </div>
              {o.skillsLoaded.length > 0 && (
                <div className="flex flex-wrap gap-1">
                  {o.skillsLoaded.map((s) => (
                    <Badge key={s} tone="amber">
                      ⚑ {s}
                    </Badge>
                  ))}
                </div>
              )}
              {o.toolSeq.length > 0 && (
                <details>
                  <summary className="cursor-pointer text-[11px] text-zinc-500">{tr("工具调用（")}{o.toolSeq.length}）</summary>
                  <div className="mt-0.5 space-y-0.5 font-mono text-[10.5px] text-zinc-500">
                    {o.toolSeq.map((t, i) => (
                      <div key={i} className="truncate" title={t}>
                        {i + 1}. {seqLabel(t)}
                      </div>
                    ))}
                  </div>
                </details>
              )}
            </div>
          ) : (
            <Spinner />
          )}
        </Section>
        <Section title={tr("检查（原始）")}>
          {original.data?.checks.length ? (
            <div className="space-y-0.5">
              {original.data.checks.map((r, i) => (
                <div key={i} className="flex items-center gap-1 text-[11.5px]">
                  <CheckChip r={r} />
                  {r.detail && <span className="text-zinc-500">{systemText(r.detail)}</span>}
                </div>
              ))}
            </div>
          ) : (
            <div className="text-[11.5px] text-zinc-500">{tr("没有检查项")}</div>
          )}
        </Section>
        {o?.finalAnswer && (
          <Section title={tr("最终回答")}>
            <div className="max-h-72 overflow-auto text-[12.5px]">
              <Markdown text={o.finalAnswer} />
            </div>
          </Section>
        )}
      </div>
      {left.handle}

      {/* ------------------------------------------------ debugging */}
      <div className="flex min-w-0 flex-1 flex-col bg-white dark:bg-zinc-950">
        <div className="flex items-center gap-2 border-b border-zinc-200 px-3 py-2 dark:border-zinc-800">
          <h1 className="min-w-0 flex-1 truncate text-[14px] font-semibold" title={x.title}>
            {x.title}
          </h1>
          <Button size="xs" variant={x.saved ? 'primary' : 'default'} onClick={() => void toggleSaved()} title={x.saved ? tr("已保存，不会被自动清理") : tr("未保存的用例和回放 14 天后自动清理")}>
            {x.saved ? tr("已保存") : tr("保存用例")}
          </Button>
          <Button size="xs" variant="ghost" onClick={() => void deleteCase()}>{tr("删除")}</Button>
        </div>
        <Tabs<Tab>
          tabs={[
            { id: 'replay', label: tr`改动与回放${replays.data?.length ? ` (${replays.data.length})` : ''}` },
            { id: 'compare', label: tr("对比") },
            { id: 'why', label: tr("为什么") },
          ]}
          value={tab}
          onChange={setTab}
        />
        <div className="min-h-0 flex-1 overflow-auto">
          {tab === 'why' &&
            (trace.data ? (
              <AskBox
                sessionId={caseKey}
                trace={trace.data}
                callIndex={firstCall}
                defaultQuestion={tr`第 ${x.turnIndex + 1} 轮为什么这样执行？哪些 skill 该触发却没有、或者执行得不对？应该怎样修改 skill 的描述或正文？`}
                onJump={(i, t) => navigate(`/s/${caseKey}?call=${i}${t ? `&tool=${encodeURIComponent(t)}` : ''}`)}
                onVariant={(v) => {
                  setArms((a) => [...a, { label: `B${a.length}`, variantIds: [v.id] }]);
                  void qc.invalidateQueries({ queryKey: ['variants'] });
                  setTab('replay');
                }}
              />
            ) : trace.error ? (
              <ErrorBox error={trace.error} />
            ) : (
              <div className="p-3">
                <Spinner />
              </div>
            ))}
          {tab === 'compare' && <CompareView checks={x.checks} original={original.data} replays={replays.data ?? []} />}
          {tab === 'replay' && (
            <>
              <Section
                title={tr("输入")}
                aside={
                  promptEdited && (
                    <Button size="xs" variant="ghost" onClick={() => setPrompt(x.originalPrompt)}>{tr("恢复原输入")}</Button>
                  )
                }
              >
                <textarea
                  value={prompt ?? ''}
                  onChange={(e) => setPrompt(e.target.value)}
                  rows={Math.min(8, Math.max(2, (prompt ?? '').split('\n').length))}
                  className={cx('w-full resize-y rounded border bg-white px-2 py-1 text-[12.5px] outline-none focus:border-indigo-500 dark:bg-zinc-900', promptEdited ? 'border-amber-400' : 'border-zinc-300 dark:border-zinc-700')}
                />
                {promptEdited && <div className="text-[11px] text-amber-600">{tr("已改动输入：所有组都会用改过的输入")}</div>}
              </Section>
              <Section title={tr("改动")}>
                <ArmsEditor
                  arms={arms}
                  onChange={setArms}
                  skills={skillNames}
                  cap={skills.data?.listing?.cap}
                  variantsSupported={x.agent !== 'claude'}
                />
              </Section>
              <Section title={tr("检查项")}>
                <ChecksEditor checks={x.checks} onChange={(ch) => void saveChecks(ch)} skills={skillNames} />
              </Section>
              <Section title={tr("回放")}>
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[12px]">
                  <label className="flex items-center gap-1">{tr("模型")}<select value={model ?? ''} onChange={(e) => setModel(e.target.value || undefined)} className="max-w-48 rounded border border-zinc-300 bg-white px-1 py-0.5 dark:border-zinc-700 dark:bg-zinc-900">
                      {model && !models.data?.some((m) => m.id === model) && <option value={model}>{model}{tr("（原会话）")}</option>}
                      {models.data?.map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.label}
                          {m.id === x.meta.model ? tr("（原会话）") : ''}
                        </option>
                      ))}
                    </select>
                  </label>
                  {(modelInfo?.efforts?.length || effort) && (
                    <label className="flex items-center gap-1">{tr("推理")}<select value={effort ?? ''} onChange={(e) => setEffort(e.target.value || undefined)} className="rounded border border-zinc-300 bg-white px-1 py-0.5 dark:border-zinc-700 dark:bg-zinc-900">
                        <option value="">{tr("默认")}</option>
                        {[...new Set([...(modelInfo?.efforts ?? []), ...(effort ? [effort] : [])])].map((e) => (
                          <option key={e} value={e}>
                            {e}
                          </option>
                        ))}
                      </select>
                    </label>
                  )}
                  <label className="flex items-center gap-1">{tr("每组")}<input type="number" min={1} max={5} value={repeats} onChange={(e) => setRepeats(Math.min(5, Math.max(1, Number(e.target.value))))} className="w-12 rounded border border-zinc-300 bg-white px-1 py-0.5 dark:border-zinc-700 dark:bg-zinc-900" />{tr("次")}</label>
                  <label className="flex items-center gap-1" title={tr("跑满这么多次模型调用就停止（这一轮可能还没结束）")}>{tr("最多")}<input type="number" min={1} max={200} value={maxSteps} onChange={(e) => setMaxSteps(Math.min(200, Math.max(1, Number(e.target.value))))} className="w-14 rounded border border-zinc-300 bg-white px-1 py-0.5 dark:border-zinc-700 dark:bg-zinc-900" />{tr("步")}</label>
                  <label className="flex items-center gap-1">{tr("工作区")}<select value={workspace} onChange={(e) => setWorkspace(e.target.value as Workspace)} className="rounded border border-zinc-300 bg-white px-1 py-0.5 dark:border-zinc-700 dark:bg-zinc-900">
                      <option value="readonly">{tr("原目录，只读")}</option>
                      <option value="clone">{tr("克隆 git 仓库，可写")}</option>
                      <option value="empty">{tr("空目录")}</option>
                    </select>
                  </label>
                  <label className="flex items-center gap-1" title={tr("默认关闭 MCP 服务器，回放不会碰外部系统")}>
                    <input type="checkbox" checked={allowMcp} onChange={(e) => setAllowMcp(e.target.checked)} />{tr("允许外部工具（MCP）")}</label>
                </div>
                <div className="mt-2 flex items-center gap-2">
                  <Button variant="primary" onClick={() => void start()} disabled={busy || !arms.length}>
                    {busy ? tr("提交中…") : tr`回放 ${arms.length * repeats} 次`}
                  </Button>
                  <span className="text-[11px] text-zinc-500">
                    {estimate.data ? tr`预计约 ${fmtTokens(estimate.data.total)} tokens（每次约 ${fmtTokens(estimate.data.perReplay)}，多数命中缓存）· ` : ''}{tr("用")}{x.agent}{tr("自己的登录和额度，在隔离的 home 里运行，不改原会话和你的配置")}</span>
                </div>
                {error ? <ErrorBox error={error} /> : null}
              </Section>
              <div>
                {evalIds.length > 0 && (
                  <div className="flex flex-wrap items-center gap-1.5 border-b border-zinc-200 px-2.5 py-1.5 text-[11.5px] text-zinc-500 dark:border-zinc-800">{tr("这个用例还在")}{evalIds.length}{tr("次评测里回放过：")}{evalIds.map((e) => (
                      <Link key={e} href={`/evals/${e}`} className="text-indigo-600 hover:underline dark:text-indigo-400">{tr("评测")}{e.slice(-5)}
                      </Link>
                    ))}
                  </div>
                )}
                {replays.error ? <ErrorBox error={replays.error} /> : null}
                {replays.data ? <ReplayList replays={replays.data} onCancel={(r) => void cancel(r)} onDelete={(r) => void remove(r)} /> : <Empty>…</Empty>}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

import { getLocale, localized, tr } from '../../../shared/i18n';
import { useLocale } from '../../../shared/i18n/react';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import type { Arm, EvalSet, RubricItem, Workspace } from '../../../shared/replay';
import { useAgentInfo, useModels } from '../../lib/casesApi';
import { estimateEval, MAX_CELLS, startEval, STRONG_CONFIRM, type EvalRequestBody } from '../../lib/evalsApi';
import { fmtTokens } from '../../lib/format';
import { useCatalog } from '../../lib/labApi';
import { ArmsEditor } from '../debug/Arms';
import { Modal } from '../Modal';
import { Button, ErrorBox, cx } from '../ui';

const DEFAULT_RUBRIC: RubricItem[] = localized([
  { id: 'goal', text: '完成了用户这一轮的请求' },
  { id: 'focus', text: '没有多余的步骤、绕路或不必要的提问' },
]);

function useDebounced<T>(v: T, ms: number): T {
  const [d, setD] = useState(v);
  useEffect(() => {
    const t = setTimeout(() => setD(v), ms);
    return () => clearTimeout(t);
  }, [v, ms]);
  return d;
}

const field = 'rounded border border-zinc-300 bg-white px-1 py-0.5 dark:border-zinc-700 dark:bg-zinc-900';

/**
 * A new evaluation of a set: groups of changes (A′ and skill variants) × the
 * set's cases × N repeats, with the agent's own model; optionally graded by
 * the agent against a short rubric. Big runs need a deliberate confirmation.
 */
export function NewEvalDialog({ set, cases, initialArms, onClose, onStarted }: { set: EvalSet; cases: number; initialArms?: Arm[]; onClose: () => void; onStarted: (evalId: string) => void }) {
  useLocale();
  const catalog = useCatalog();
  const models = useModels(undefined);
  const agent = useAgentInfo().data?.agent;
  const [name, setName] = useState('');
  const [arms, setArms] = useState<Arm[]>(
    initialArms ?? [
      { label: 'A′', variantIds: [] },
      { label: 'B1', variantIds: [] },
    ],
  );
  const [repeats, setRepeats] = useState(1);
  const [maxSteps, setMaxSteps] = useState(30);
  const [model, setModel] = useState<string>();
  const [effort, setEffort] = useState<string>();
  const [workspace, setWorkspace] = useState<Workspace>('readonly');
  const [allowMcp, setAllowMcp] = useState(false);
  const [judge, setJudge] = useState(false);
  const [rubric, setRubric] = useState<RubricItem[]>(DEFAULT_RUBRIC);
  const [aware, setAware] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();

  const body: EvalRequestBody = {
    name: name.trim() || undefined,
    arms,
    repeats,
    options: { maxSteps, model, effort, workspace, allowMcp, judge },
    rubric: judge ? rubric.filter((r) => r.text.trim()) : undefined,
  };
  const debounced = useDebounced(body, 300);
  const estimate = useQuery({
    queryKey: ['evalEstimate', set.id, JSON.stringify(debounced)],
    queryFn: () => estimateEval(set.id, debounced),
  });
  const est = estimate.data;
  // the set's skill first: that is what its variants are usually about
  const skills = useMemo(() => {
    const keys = (catalog.data ?? []).filter((s) => !s.shadowedBy).map((s) => s.key);
    return set.skill ? [set.skill, ...keys.filter((k) => k !== set.skill)] : keys;
  }, [catalog.data, set.skill, getLocale()]);
  const modelInfo = models.data?.find((m) => m.id === model);

  const emptyArms = arms.filter((a, i) => i > 0 && !a.variantIds.length && a.label !== 'A′').map((a) => a.label);
  const rubricOk = !judge || (body.rubric!.length >= 2 && body.rubric!.length <= 6);
  const tooBig = (est?.cells ?? 0) > MAX_CELLS;
  const strong = est ? est.tokens > STRONG_CONFIRM.tokens || est.cells > STRONG_CONFIRM.cells : false;
  useEffect(() => setAware(false), [est?.cells, est?.tokens]);
  const canStart = Boolean(est) && arms.length > 0 && cases > 0 && rubricOk && !tooBig && (!strong || aware) && !busy;

  const start = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const e = await startEval(set.id, body);
      onStarted(e.id);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      wide
      title={tr`新评测 · ${set.name}`}
      onClose={onClose}
      footer={
        <>
          <span className="mr-auto text-[11.5px] text-zinc-500">
            {est ? (
              <>
                {cases}{tr("个用例 ×")}{arms.length}{tr("组 ×")}{Math.max(1, Math.min(10, repeats))}{tr("次 =")}<b className={cx(tooBig && 'text-red-600')}>{est.cells}{tr("格")}</b>{tr("· 预计约")}{fmtTokens(est.tokens)} tokens
                {est.judgeCalls ? tr` + ${est.judgeCalls} 次评分` : ''}{tr("（多数命中缓存）")}</>
            ) : (
              tr("计算用量…")
            )}
          </span>
          <Button onClick={onClose}>{tr("取消")}</Button>
          <Button variant="primary" disabled={!canStart} onClick={() => void start()}>
            {busy ? tr("提交中…") : tr`开始评测（${est?.cells ?? '…'} 格）`}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <label className="flex items-center gap-2">
          <span className="w-14 shrink-0 text-zinc-500">{tr("名称")}</span>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder={tr("可选，例如：描述加上周报关键词")} className={cx(field, 'flex-1 px-2 py-1')} />
        </label>

        <div>
          <div className="mb-1 font-medium">{tr("改动")}</div>
          <ArmsEditor arms={arms} onChange={setArms} skills={skills} variantsSupported={agent !== 'claude'} />
          {emptyArms.length > 0 && <div className="mt-1 text-[11px] text-amber-600">{emptyArms.join('、')}{tr("还没有加变体，会和 A′ 一样不改动")}</div>}
          {set.skill && (
            <div className="mt-1 text-[11px] text-zinc-500">{tr("评测集的 skill 是")}<span className="font-mono">{set.skill}</span>{tr("：正例要求加载它，反例和对照要求不加载（在每个用例自己的检查项之外）。")}</div>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <label className="flex items-center gap-1" title={tr("同一用例、同一组改动跑几次；两边都 ≥5 次时才做显著性检验")}>{tr("每格")}<input type="number" min={1} max={10} value={repeats} onChange={(e) => setRepeats(Math.min(10, Math.max(1, Number(e.target.value) || 1)))} className={cx(field, 'w-12')} />{tr("次")}</label>
          <label className="flex items-center gap-1" title={tr("跑满这么多次模型调用就停止")}>{tr("最多")}<input type="number" min={1} max={200} value={maxSteps} onChange={(e) => setMaxSteps(Math.min(200, Math.max(1, Number(e.target.value) || 1)))} className={cx(field, 'w-14')} />{tr("步")}</label>
          <label className="flex items-center gap-1">{tr("模型")}<select value={model ?? ''} onChange={(e) => setModel(e.target.value || undefined)} className={cx(field, 'max-w-48')}>
              <option value="">{tr("各用例原来的模型")}</option>
              {models.data?.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </select>
          </label>
          {model && modelInfo?.efforts?.length ? (
            <label className="flex items-center gap-1">{tr("推理")}<select value={effort ?? ''} onChange={(e) => setEffort(e.target.value || undefined)} className={field}>
                <option value="">{tr("默认")}</option>
                {modelInfo.efforts.map((x) => (
                  <option key={x} value={x}>
                    {x}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          <label className="flex items-center gap-1">{tr("工作区")}<select value={workspace} onChange={(e) => setWorkspace(e.target.value as Workspace)} className={field}>
              <option value="readonly">{tr("原目录，只读")}</option>
              <option value="clone">{tr("克隆 git 仓库，可写")}</option>
              <option value="empty">{tr("空目录")}</option>
            </select>
          </label>
          <label className="flex items-center gap-1" title={tr("默认关闭 MCP 服务器，回放不会碰外部系统")}>
            <input type="checkbox" checked={allowMcp} onChange={(e) => setAllowMcp(e.target.checked)} />{tr("允许外部工具（MCP）")}</label>
        </div>

        <div className="rounded border border-zinc-200 p-2 dark:border-zinc-800">
          <label className="flex items-center gap-1.5">
            <input type="checkbox" checked={judge} onChange={(e) => setJudge(e.target.checked)} />
            <span className="font-medium">{tr("模型评分")}</span>
            <span className="text-[11px] text-zinc-500">{tr("完成的每一格再调用一次")}{agent ?? 'agent'}{tr("按评分项打 1–5 分（额外消耗额度，可以人工改分）")}</span>
          </label>
          {judge && (
            <div className="mt-1.5 space-y-1">
              {rubric.map((r, i) => (
                <div key={i} className="flex items-center gap-1">
                  <input
                    value={r.id}
                    onChange={(e) => setRubric(rubric.map((x, j) => (j === i ? { ...x, id: e.target.value.replace(/[^\w-]/g, '').slice(0, 24) } : x)))}
                    className={cx(field, 'w-20 font-mono text-[11px]')}
                    title={tr("评分项的短名（字母、数字）")}
                  />
                  <input value={r.text} onChange={(e) => setRubric(rubric.map((x, j) => (j === i ? { ...x, text: e.target.value } : x)))} className={cx(field, 'flex-1 px-1.5')} placeholder={tr("评分标准")} />
                  <button className="text-zinc-400 hover:text-red-500" disabled={rubric.length <= 2} onClick={() => setRubric(rubric.filter((_, j) => j !== i))} title={tr("删除")}>
                    ×
                  </button>
                </div>
              ))}
              <div className="flex items-center gap-2">
                <Button size="xs" disabled={rubric.length >= 6} onClick={() => setRubric([...rubric, { id: `r${rubric.length + 1}`, text: '' }])}>{tr("+ 评分项")}</Button>
                {!rubricOk && <span className="text-[11px] text-red-600">{tr("需要 2–6 条评分项")}</span>}
              </div>
            </div>
          )}
        </div>

        {tooBig && <div className="text-[12px] text-red-600">{tr("一次评测最多")}{MAX_CELLS}{tr("格：减少用例、改动组或每格次数")}</div>}
        {strong && !tooBig && (
          <label className="flex items-start gap-1.5 rounded border border-amber-300 bg-amber-50 p-2 text-[12px] text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
            <input type="checkbox" className="mt-0.5" checked={aware} onChange={(e) => setAware(e.target.checked)} />
            <span>{tr("这次评测比较大：")}{est!.cells}{tr("格，预计约")}{fmtTokens(est!.tokens)}{tr("tokens，用的是")}{agent ?? 'agent'}{tr("自己的登录和额度。在后台按队列运行，可以随时暂停或取消。我确认要运行。")}</span>
          </label>
        )}
        {cases === 0 && <div className="text-[12px] text-amber-600">{tr("评测集里还没有用例")}</div>}
        {estimate.error ? <ErrorBox error={estimate.error} /> : null}
        {error ? <ErrorBox error={error} /> : null}
      </div>
    </Modal>
  );
}

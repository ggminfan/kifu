import { systemText, getLocale, tr } from '../../shared/i18n';
import { useLocale } from '../../shared/i18n/react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { Link, useLocation, useSearch } from 'wouter';
import { CodeEditor } from '../components/CodeEditor';
import { askConfirm } from '../components/dialogs';
import { DescriptionEditor } from '../components/lab/SkillWorkbench';
import { Badge, Button, ErrorBox, Spinner, cx } from '../components/ui';
import { api, postJson, useHealth } from '../lib/api';
import { BLANK_BODY, checkDraft, draftSet, saveDraft, startDraft, useDraftJob, useMined, type Draft, type DraftCheck } from '../lib/distillApi';
import { useEvalSets } from '../lib/evalsApi';
import { fmtTokens } from '../lib/format';
import { useVariant, type VariantDetail } from '../lib/labApi';

function Section({ n, title, children, aside, muted }: { n: number; title: string; children: React.ReactNode; aside?: React.ReactNode; muted?: boolean }) {
  useLocale();
  return (
    <section className={cx('rounded-lg border border-zinc-200 p-3 dark:border-zinc-800', muted && 'opacity-60')}>
      <div className="mb-2 flex items-center gap-2">
        <span className="flex h-5 w-5 items-center justify-center rounded-full bg-indigo-600 text-[11px] font-semibold text-white">{n}</span>
        <span className="text-[13px] font-semibold">{title}</span>
        <span className="flex-1" />
        {aside}
      </div>
      {children}
    </section>
  );
}

const field = 'rounded border border-zinc-300 bg-white px-2 py-1 text-[12.5px] outline-none focus:border-indigo-500 dark:border-zinc-700 dark:bg-zinc-900';

function useDebounced<T>(v: T, ms: number): T {
  const [d, setD] = useState(v);
  useEffect(() => {
    const t = setTimeout(() => setD(v), ms);
    return () => clearTimeout(t);
  }, [v, ms]);
  return d;
}

interface Form {
  name: string;
  description: string;
  body: string;
  triggers: string;
}

const split = (s: string) =>
  s
    .split(/[,，、\n]/)
    .map((x) => x.trim())
    .filter(Boolean);

/** The listing shares one budget: adding a skill shortens what the model sees of others. */
function Squeeze({ others }: { others: Array<{ name: string; before?: string; after?: string }> }) {
  useLocale();
  const lost = others.map((o) => (o.before?.length ?? 0) - (o.after?.length ?? 0)).filter((n) => n > 0).sort((a, b) => a - b);
  const gone = others.filter((o) => o.before && !o.after).length;
  return (
    <div className="text-amber-600" title={others.map((o) => o.name).join('\n')}>{tr("skill 列表共用一份预算：加上它以后，")}{others.length}{tr("个其它 skill 的描述变短了")}{lost.length ? tr`（每个少 ${lost[0]}–${lost[lost.length - 1]} 字，中位 ${lost[Math.floor(lost.length / 2)]} 字）` : ''}
      {gone ? tr`，${gone} 个不再显示` : ''}{tr("。描述末尾的触发词可能因此看不到。")}</div>
  );
}

/** How the draft shows in the agent's skill listing, and its name. */
function CheckView({ c }: { c: DraftCheck }) {
  useLocale();
  const l = c.listing;
  return (
    <div className="space-y-1.5 text-[12px]">
      <div className="flex items-center gap-1.5">
        <Badge tone={c.name.ok ? 'green' : 'red'}>{c.name.ok ? '✓' : '✗'}{tr("名称")}</Badge>
        {c.name.message && <span className="text-red-600">{systemText(c.name.message)}</span>}
      </div>
      {l ? (
        <div className="space-y-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge tone={l.truncated ? 'red' : l.truncated === false ? 'green' : 'zinc'}>{l.truncated ? tr("描述被截断") : l.truncated === false ? tr("描述完整显示") : tr("不在列表里")}</Badge>
            <span className="text-zinc-500">{tr("列表里共")}{l.count}{tr("个 skill")}{l.cap ? tr` · 每条描述约 ${l.cap} 字` : ''}
              {!l.budgetParity && tr(" · 预览环境和真实环境的预算可能不同")}
            </span>
          </div>
          {l.visible !== undefined && (
            <div className="rounded bg-zinc-50 p-1.5 dark:bg-zinc-900">
              <span className="text-zinc-500">{tr("模型看到：")}</span>
              {l.visible}
              {l.hiddenTail && <span className="bg-red-50 text-red-400 line-through dark:bg-red-950/40"> {l.hiddenTail}</span>}
            </div>
          )}
          {l.othersChanged.length > 0 && <Squeeze others={l.othersChanged} />}
        </div>
      ) : null}
      {c.triggers.length > 0 && (
        <div className="flex flex-wrap items-center gap-1">
          <span className="text-zinc-500">{tr("触发词")}</span>
          {c.triggers.map((t) => (
            <Badge key={t.text} tone={t.where === 'visible' ? 'green' : t.where === 'hidden' ? 'amber' : 'red'} title={{ visible: tr("在模型看得到的描述里"), hidden: tr("在描述里，但被截断了"), missing: tr("描述里没有") }[t.where]}>
              {t.text}
              {t.where === 'hidden' ? tr(" · 被截断") : t.where === 'missing' ? tr(" · 不在描述里") : ''}
            </Badge>
          ))}
        </div>
      )}
      {c.error && <div className="text-amber-600">{c.error}</div>}
    </div>
  );
}

/**
 * Distilling a skill from sessions: what they share (paths, repeated
 * clarifications, the closest skills) → a draft written by the workspace's
 * agent (or by hand) → its name and how it shows in the skill listing → saved
 * as a new skill variant and evaluated on its sources and unrelated sessions
 * → installed (undoable).
 */
export function DistillPage() {
  useLocale();
  const search = useSearch();
  const [, navigate] = useLocation();
  const qc = useQueryClient();
  const params = useMemo(() => new URLSearchParams(search), [search, getLocale()]);
  const from = useMemo(() => (params.get('from') ?? '').split(',').filter(Boolean), [params, getLocale()]);
  const jobId = params.get('job') ?? undefined;
  const variantId = params.get('v') ?? undefined;
  const health = useHealth();
  const mined = useMined(from);
  const job = useDraftJob(jobId);
  const variant = useVariant(variantId);
  const [hint, setHint] = useState('');
  const [form, setForm] = useState<Form>();
  const [draft, setDraft] = useState<Draft>();
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<unknown>();
  const [setInfo, setSetInfo] = useState<{ id: string; name: string; added: number; failed: number }>();
  const [installed, setInstalled] = useState<{ applyId: string; target: string }>();

  const setParam = (k: string, v: string | undefined) => {
    const p = new URLSearchParams(search);
    if (v) p.set(k, v);
    else p.delete(k);
    navigate(`/skills/new?${p}`, { replace: true });
  };

  // a finished draft fills the form once
  useEffect(() => {
    const d = job.data?.draft;
    if (job.data?.status !== 'completed' || !d || draft) return;
    setDraft(d);
    setForm({ name: d.name, description: d.description, body: d.body, triggers: d.triggers.positive.join('，') });
  }, [job.data, draft]);
  // a saved variant: the form shows what it holds
  useEffect(() => {
    const v = variant.data;
    if (!v || form) return;
    setForm({ name: v.skillName, description: v.description ?? '', body: v.body, triggers: '' });
  }, [variant.data, form]);
  useEffect(() => {
    const live = variant.data?.applies?.find((a) => !a.undoneAt);
    setInstalled(live ? { applyId: live.id, target: live.target } : undefined);
  }, [variant.data]);

  const checkInput = useDebounced(form ? { name: form.name, description: form.description, body: form.body, triggers: split(form.triggers) } : undefined, 600);
  const check = useQuery({
    queryKey: ['distillCheck', JSON.stringify(checkInput)],
    queryFn: () => checkDraft(checkInput!),
    enabled: Boolean(checkInput?.name && checkInput.description),
    staleTime: 60_000,
  });

  const run = async (what: string, fn: () => Promise<void>) => {
    setBusy(what);
    setError(undefined);
    try {
      await fn();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(undefined);
    }
  };
  const generate = () =>
    run('draft', async () => {
      setDraft(undefined);
      setForm(undefined);
      const j = await startDraft(from, hint);
      setParam('job', j.id);
    });
  const save = () =>
    run('save', async () => {
      if (!form) return;
      const v = await saveDraft({ name: form.name.trim(), description: form.description, body: form.body, note: tr`从 ${from.length} 个会话提炼` });
      const s = await draftSet(v.id, from);
      setSetInfo({ id: s.set.id, name: s.set.name, added: s.added, failed: s.failed.length });
      await Promise.all(['variants', 'evalSets', 'catalog'].map((k) => qc.invalidateQueries({ queryKey: [k] })));
      setParam('v', v.id);
    });
  const saveEdits = () =>
    run('edit', async () => {
      if (!form || !variantId) return;
      await api<VariantDetail>(`/variants/${variantId}`, { method: 'PUT', body: JSON.stringify({ description: form.description, body: form.body }) });
      await qc.invalidateQueries({ queryKey: ['variant', variantId] });
    });
  const install = () =>
    run('install', async () => {
      if (!variantId || !form) return;
      if (!(await askConfirm({ title: tr`安装 skill ${form.name}？`, body: tr`写入 ${health.data?.agent ?? 'agent'} 的 skills 目录，之后的会话都会看到它。可以撤销。`, confirm: tr("安装") }))) return;
      const r = await postJson<{ mode: 'applied'; applyId: string; target: string }>(`/variants/${variantId}/apply`, {});
      setInstalled({ applyId: r.applyId, target: r.target });
      await Promise.all(['variant', 'catalog'].map((k) => qc.invalidateQueries({ queryKey: [k] })));
    });
  const uninstall = () =>
    run('install', async () => {
      if (!installed) return;
      await postJson(`/applies/${installed.applyId}/undo`, {});
      setInstalled(undefined);
      await Promise.all(['variant', 'catalog'].map((k) => qc.invalidateQueries({ queryKey: [k] })));
    });

  const m = mined.data;
  const saved = Boolean(variantId);
  const sets = useEvalSets();
  const setsOfSkill = (sets.data ?? []).filter((x) => form?.name && x.skill === form.name);
  // the saved SKILL.md has a blank line after its frontmatter
  const lead = (b: string) => b.replace(/^\n+/, '');
  const dirty = saved && variant.data && form ? form.description !== (variant.data.description ?? '') || lead(form.body) !== lead(variant.data.body) : false;

  return (
    <div className="h-full overflow-auto bg-white dark:bg-zinc-950">
      <div className="mx-auto max-w-4xl space-y-3 p-4">
        <div className="flex items-center gap-2">
          <Link href="/skills" className="text-[12px] text-indigo-600 hover:underline dark:text-indigo-400">
            ← Skills
          </Link>
          <h1 className="text-[15px] font-semibold">{tr("从会话提炼 skill")}</h1>
          <span className="text-[12px] text-zinc-500">{from.length ? tr`${from.length} 个会话` : ''}</span>
        </div>

        {!from.length && !saved && (
          <div className="rounded-lg border border-dashed border-zinc-300 p-4 text-[12.5px] text-zinc-600 dark:border-zinc-700 dark:text-zinc-300">{tr("在")}<Link href="/" className="mx-1 text-indigo-600 hover:underline dark:text-indigo-400">{tr("会话列表")}</Link>{tr("点\"多选\"，选几个做同一类事情的会话（或者一个反复澄清的会话），再点\"提炼 skill\"。这里会找出它们共有的执行路径和反复的澄清，交给 agent 写成 skill 草稿；校验、评测之后再安装。")}</div>
        )}

        {from.length > 0 && (
          <Section n={1} title={tr("素材")}>
            {mined.isLoading && <Spinner label={tr("分析会话…")} />}
            {mined.error ? <ErrorBox error={mined.error} /> : null}
            {m && (
              <div className="space-y-3 text-[12.5px]">
                <div className={cx('rounded p-2', m.suggestion.mode === 'improve' ? 'bg-amber-50 text-amber-900 dark:bg-amber-950/40 dark:text-amber-200' : 'bg-indigo-50 text-indigo-900 dark:bg-indigo-950/40 dark:text-indigo-200')}>
                  {m.suggestion.mode === 'improve' ? (
                    <>{tr("建议改已有的 skill：")}{systemText(m.suggestion.reason)}。
                      <Link href={`/skills?skill=${encodeURIComponent(m.suggestion.skill)}`} className="ml-1 underline">{tr("打开")}{m.suggestion.skill} →
                      </Link>
                    </>
                  ) : (
                    <>{tr("建议新建：")}{systemText(m.suggestion.reason)}。</>
                  )}
                </div>
                <div>
                  <div className="mb-1 font-medium">{tr("会话")}</div>
                  {from.map((id, i) => (
                    <div key={id} className="flex items-center gap-1.5">
                      <Badge>S{i + 1}</Badge>
                      <Link href={`/s/${id}`} className="truncate text-indigo-700 hover:underline dark:text-indigo-300">
                        {m.titles[id] ?? id}
                      </Link>
                    </div>
                  ))}
                </div>
                <div>
                  <div className="mb-1 font-medium">{tr("共有的执行路径")}{m.paths.length ? `（${m.paths.length}）` : ''}</div>
                  {!m.paths.length && <div className="text-zinc-500">{tr("没有")}{from.length > 1 ? tr("几个会话共有") : tr("重复出现")}{tr("的工具调用路径。")}</div>}
                  {m.paths.map((p, i) => (
                    <div key={i} className="flex flex-wrap items-center gap-1 py-0.5">
                      {p.steps.map((s, j) => (
                        <span key={j} className="flex items-center gap-1">
                          {j > 0 && <span className="text-zinc-400">→</span>}
                          <code className="rounded bg-zinc-100 px-1 text-[11.5px] dark:bg-zinc-800">{s}</code>
                        </span>
                      ))}
                      <span className="ml-1 text-[11px] text-zinc-500">{from.length > 1 ? tr`${p.support} 个会话` : tr`${p.support} 次`}</span>
                      {p.at.slice(0, 4).map((a, k) => (
                        <Link key={k} href={`/s/${a.sessionId}?call=${a.callIndex}`} className="text-[11px] text-indigo-600 hover:underline dark:text-indigo-400">
                          S{from.indexOf(a.sessionId) + 1}·{a.turnIndex + 1}
                        </Link>
                      ))}
                    </div>
                  ))}
                </div>
                <div>
                  <div className="mb-1 font-medium">{tr("反复的澄清和纠正")}{m.clarifications.length ? `（${m.clarifications.length}）` : ''}</div>
                  {!m.clarifications.length && <div className="text-zinc-500">{tr("没有发现 agent 反问后用户回答、或用户纠正 agent 的地方。")}</div>}
                  {m.clarifications.map((c, i) => (
                    <div key={i} className="border-l-2 border-amber-300 py-0.5 pl-2">
                      <div>
                        「{c.label}」<span className="text-[11px] text-zinc-500">{c.items.length}{tr("次 ·")}{c.sessions}{tr("个会话")}</span>
                      </div>
                      {c.items.slice(0, 3).map((it, k) => (
                        <div key={k} className="text-[11.5px] text-zinc-500">
                          <Link href={`/s/${it.sessionId}${it.callIndex !== undefined ? `?call=${it.callIndex}` : ''}`} className="text-indigo-600 hover:underline dark:text-indigo-400">
                            S{from.indexOf(it.sessionId) + 1}·{it.turnIndex + 1}
                          </Link>{' '}
                          {it.question ? tr`agent 问「${it.question.slice(-80)}」→ ` : tr("纠正：")}「{it.reply}」
                        </div>
                      ))}
                    </div>
                  ))}
                </div>
                {m.similar.length > 0 && (
                  <div>
                    <div className="mb-1 font-medium">{tr("相近的 skill")}</div>
                    {m.similar.map((s) => (
                      <div key={s.key} className="flex items-center gap-1.5 text-[12px]">
                        <Link href={`/skills?skill=${encodeURIComponent(s.key)}`} className="font-mono text-indigo-700 hover:underline dark:text-indigo-300">
                          {s.key}
                        </Link>
                        <span className="text-[11px] text-zinc-500">{tr("相关度")}{s.score} · {s.matched.join('、')}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </Section>
        )}

        <Section
          n={2}
          title={tr("草稿")}
          aside={
            !saved &&
            !form && (
              <Button size="xs" variant="ghost" onClick={() => setForm({ name: '', description: '', body: BLANK_BODY, triggers: '' })}>{tr("自己写")}</Button>
            )
          }
        >
          {!saved && from.length > 0 && (
            <div className="space-y-1.5">
              <textarea value={hint} onChange={(e) => setHint(e.target.value)} rows={2} placeholder={tr("可选：补充说明，例如这个 skill 给谁用、什么时候用、要遵守的约定")} className={cx(field, 'w-full resize-y')} />
              <div className="flex items-center gap-2">
                <Button variant="primary" disabled={busy === 'draft' || job.data?.status === 'running'} onClick={() => void generate()}>
                  {job.data?.status === 'running' ? tr("生成中…") : form ? tr("重新生成") : tr("生成草稿")}
                </Button>
                <span className="text-[11px] text-zinc-500">{tr("调用一次")}{health.data?.agent ?? 'agent'}{tr("（作为不带 skill 的分析员，用它自己的登录和额度），根据上面的素材写草稿")}</span>
              </div>
            </div>
          )}
          {job.data?.status === 'running' && (
            <div className="mt-2">
              <Spinner label={tr`agent 正在写草稿…（${Math.round((Date.now() - job.data.startedAt) / 1000)} 秒）`} />
            </div>
          )}
          {job.data?.status === 'failed' && <ErrorBox error={new Error(job.data.error ?? tr("生成失败"))} />}
          {job.data?.usage && <div className="mt-1 text-[11px] text-zinc-500">{tr("用量：")}{fmtTokens(job.data.usage.input_tokens)}{tr("输入 ·")}{fmtTokens(job.data.usage.output_tokens)}{tr("输出")}</div>}
          {form && (
            <div className="mt-2 space-y-2">
              <label className="flex items-center gap-2">
                <span className="w-16 shrink-0 text-[12px] text-zinc-500">{tr("名称")}</span>
                <input value={form.name} disabled={saved} onChange={(e) => setForm({ ...form, name: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '-') })} className={cx(field, 'flex-1 font-mono')} placeholder="release-notes" />
              </label>
              <div>
                <div className="mb-0.5 text-[12px] text-zinc-500">{tr("description（决定会不会被触发：先写什么时候用、用户会说的词，再写什么时候不用）")}</div>
                <DescriptionEditor value={form.description} onChange={(d) => setForm({ ...form, description: d })} cap={check.data?.listing?.cap} noCapHint={tr("下面的校验会给出 skill 列表的截断预算")} />
              </div>
              <label className="flex items-center gap-2">
                <span className="w-16 shrink-0 text-[12px] text-zinc-500">{tr("触发词")}</span>
                <input value={form.triggers} onChange={(e) => setForm({ ...form, triggers: e.target.value })} className={cx(field, 'flex-1')} placeholder={tr("用户会说的词，逗号分隔：用来检查它们在描述里看不看得到")} />
              </label>
              <div>
                <div className="mb-0.5 text-[12px] text-zinc-500">{tr("正文（加载后照着做）")}</div>
                <CodeEditor value={form.body} onChange={(b) => setForm({ ...form, body: b })} className="h-64 overflow-auto rounded border border-zinc-200 dark:border-zinc-800" />
              </div>
              {draft && draft.evidence.length > 0 && (
                <details>
                  <summary className="cursor-pointer text-[12px] text-zinc-500">{tr("依据（")}{draft.evidence.filter((e) => e.verified).length}/{draft.evidence.length}{tr("条在会话里核对到）")}</summary>
                  {draft.evidence.map((e, i) => (
                    <div key={i} className="mt-0.5 flex items-center gap-1.5 text-[11.5px]">
                      <Badge tone={e.verified ? 'green' : 'red'} title={e.verified ? tr("在素材里找到了原文") : tr("没在素材里找到：可能是模型编的")}>
                        {e.verified ? '✓' : '✗'}
                      </Badge>
                      {e.sessionId ? (
                        <Link href={`/s/${e.sessionId}`} className="text-indigo-600 hover:underline dark:text-indigo-400">
                          {e.session}·{e.turn}
                        </Link>
                      ) : (
                        <span className="text-zinc-400">{e.session}</span>
                      )}
                      <span className="truncate text-zinc-600 dark:text-zinc-300">「{e.quote}」</span>
                    </div>
                  ))}
                </details>
              )}
            </div>
          )}
        </Section>

        <Section n={3} title={tr("校验")} muted={!form}>
          {!form ? (
            <div className="text-[12px] text-zinc-500">{tr("有了草稿后，检查名称，并用 agent 自己的 skill 列表渲染（不调模型）看描述会不会被截断、触发词看不看得到、会不会挤掉其它 skill。")}</div>
          ) : check.isFetching ? (
            <Spinner label={tr("渲染 skill 列表…")} />
          ) : check.data ? (
            <CheckView c={check.data} />
          ) : check.error ? (
            <ErrorBox error={check.error} />
          ) : (
            <div className="text-[12px] text-zinc-500">{tr("填好名称和描述后自动校验")}</div>
          )}
        </Section>

        <Section n={4} title={tr("评测")} muted={!form}>
          {!saved ? (
            <div className="space-y-1.5 text-[12px]">
              <div className="text-zinc-500">{tr("保存成\"新 skill 变体\"（不写入 skills 目录），并建评测集：来源会话的请求做正例（要求加载它、不再反问），几个无关的近期会话做反例。然后比较不加它（A′）和加上它的回放。")}</div>
              <Button variant="primary" disabled={!form || !check.data?.name.ok || busy === 'save'} onClick={() => void save()}>
                {busy === 'save' ? tr("保存中…") : from.length ? tr("保存，并建评测集") : tr("保存为新 skill 变体")}
              </Button>
            </div>
          ) : (
            <div className="space-y-1.5 text-[12px]">
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone="green">{tr("已保存为变体")}{variant.data?.label}</Badge>
                {dirty && (
                  <Button size="xs" variant="primary" disabled={busy === 'edit'} onClick={() => void saveEdits()}>{tr("保存修改")}</Button>
                )}
                <Link href={`/skills?skill=${encodeURIComponent(form?.name ?? '')}`} className="text-indigo-600 hover:underline dark:text-indigo-400">{tr("在 Skills 页编辑 →")}</Link>
              </div>
              {setInfo && (
                <div className="flex flex-wrap items-center gap-2">
                  <span>{tr("评测集「")}{setInfo.name}」：{setInfo.added}{tr("个用例")}{setInfo.failed ? tr`（${setInfo.failed} 个会话没截取到）` : ''}
                  </span>
                  <Button size="xs" variant="primary" onClick={() => navigate(`/evals/sets/${setInfo.id}?new=${variantId}`)}>{tr("开始评测…")}</Button>
                </div>
              )}
              {!setInfo &&
                (setsOfSkill.length ? (
                  setsOfSkill.map((x) => (
                    <div key={x.id} className="flex flex-wrap items-center gap-2">
                      <Link href={`/evals/sets/${x.id}`} className="text-indigo-600 hover:underline dark:text-indigo-400">{tr("评测集「")}{x.name}」（{x.cases}{tr("个用例）")}</Link>
                      <Button size="xs" variant="primary" onClick={() => navigate(`/evals/sets/${x.id}?new=${variantId}`)}>{tr("开始评测…")}</Button>
                    </div>
                  ))
                ) : (
                  <Link href="/evals" className="text-indigo-600 hover:underline dark:text-indigo-400">{tr("到评测页建评测集 →")}</Link>
                ))}
            </div>
          )}
        </Section>

        <Section n={5} title={tr("安装")} muted={!saved}>
          <div className="space-y-1.5 text-[12px]">
            <div className="text-zinc-500">{tr("评测满意后写入")}{health.data?.agent ?? 'agent'}{tr("的 skills 目录，之后的会话都会看到它。可以撤销。")}</div>
            {installed ? (
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone="green">{tr("已安装")}</Badge>
                <span className="break-all font-mono text-[11px] text-zinc-500">{installed.target}</span>
                <Button size="xs" disabled={busy === 'install'} onClick={() => void uninstall()}>{tr("撤销安装")}</Button>
              </div>
            ) : (
              <Button disabled={!saved || dirty || busy === 'install'} onClick={() => void install()}>{tr("安装到 skills 目录")}</Button>
            )}
          </div>
        </Section>
        {error ? <ErrorBox error={error} /> : null}
      </div>
    </div>
  );
}

import { useLocale } from '../../shared/i18n/react';
import { tr } from '../../shared/i18n';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useLocation } from 'wouter';
import { Modal } from '../components/Modal';
import { Badge, Button, Empty, ErrorBox, Spinner, cx } from '../components/ui';
import { createSet, EVAL_STATUS, setFromSkill, useEvals, useEvalSets } from '../lib/evalsApi';
import { relTime, shortId } from '../lib/format';
import { useCatalog } from '../lib/labApi';

const field = 'rounded border border-zinc-300 bg-white px-2 py-1 text-[12.5px] dark:border-zinc-700 dark:bg-zinc-900';

/** A new set: empty (cases added later), or built for a skill from the session index. */
function NewSetDialog({ fromSkill, onClose }: { fromSkill: boolean; onClose: () => void }) {
  useLocale();
  const [, navigate] = useLocation();
  const qc = useQueryClient();
  const catalog = useCatalog();
  const [name, setName] = useState('');
  const [skill, setSkill] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const [failed, setFailed] = useState<Array<{ sessionId: string; error: string }>>();
  const skills = (catalog.data ?? []).filter((s) => !s.shadowedBy).sort((a, b) => b.sessionsUsed - a.sessionsUsed);
  const go = async () => {
    setBusy(true);
    setError(undefined);
    try {
      if (fromSkill) {
        const r = await setFromSkill(skill);
        await qc.invalidateQueries({ queryKey: ['evalSets'] });
        if (r.failed.length && !r.added) {
          setFailed(r.failed);
          return;
        }
        navigate(`/evals/sets/${r.set.id}`);
      } else {
        const s = await createSet({ name: name.trim() || tr("评测集"), skill: skill || undefined });
        await qc.invalidateQueries({ queryKey: ['evalSets'] });
        navigate(`/evals/sets/${s.id}`);
      }
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title={fromSkill ? tr("从 skill 生成评测集") : tr("新建评测集")}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>{tr("取消")}</Button>
          <Button variant="primary" disabled={busy || (fromSkill && !skill)} onClick={() => void go()}>
            {busy ? (fromSkill ? tr("挑选会话、截取用例…") : tr("创建中…")) : tr("创建")}
          </Button>
        </>
      }
    >
      <div className="space-y-2.5">
        {!fromSkill && (
          <label className="flex items-center gap-2">
            <span className="w-16 shrink-0 text-zinc-500">{tr("名称")}</span>
            <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder={tr("评测集")} className={cx(field, 'flex-1')} />
          </label>
        )}
        <label className="flex items-center gap-2">
          <span className="w-16 shrink-0 text-zinc-500">skill</span>
          <select value={skill} onChange={(e) => setSkill(e.target.value)} className={cx(field, 'flex-1')}>
            <option value="">{fromSkill ? tr("选择 skill…") : tr("（不指定）")}</option>
            {skills.map((s) => (
              <option key={s.key} value={s.key}>
                {s.key}
                {s.sessionsUsed ? tr`（${s.sessionsUsed} 个会话用过）` : ''}
              </option>
            ))}
          </select>
        </label>
        {fromSkill ? (
          <div className="space-y-1 text-[12px] text-zinc-500">
            <div>{tr("按会话索引挑选这个 skill 相关的轮次，截成用例：")}</div>
            <div>
              <Badge tone="green">{tr("正例")}</Badge>{tr("加载了它，或者可能该加载却没加载、描述被截断的轮次（最多 8 个）")}</div>
            <div>
              <Badge tone="red">{tr("反例")}</Badge>{tr("它在 skill 列表里、但和请求无关的会话（最多 4 个）")}</div>
            <div>
              <Badge tone="violet">{tr("对照")}</Badge>{tr("描述最相近的 2–3 个 skill 被加载的轮次：改了描述后不能抢它们的触发（最多 3 个）")}</div>
            <div>{tr("之后可以在评测集里调整角色、增删用例。")}</div>
          </div>
        ) : (
          <div className="text-[12px] text-zinc-500">{tr("指定 skill 后，正例要求加载它、反例和对照要求不加载。用例之后从会话列表多选加入，或在评测集里加入已有用例。")}</div>
        )}
        {failed && (
          <div className="text-[12px] text-amber-600">{tr("没有截取到用例：")}{failed.slice(0, 5).map((f) => (
              <div key={f.sessionId} className="font-mono text-[11px]">
                {shortId(f.sessionId)} {f.error}
              </div>
            ))}
          </div>
        )}
        {error ? <ErrorBox error={error} /> : null}
      </div>
    </Modal>
  );
}

/** Sets of cases and their evaluations. */
export function EvalsPage() {
  useLocale();
  const sets = useEvalSets();
  const evals = useEvals();
  const [dialog, setDialog] = useState<'new' | 'skill'>();
  const setName = new Map((sets.data ?? []).map((s) => [s.id, s.name]));
  const lastEval = new Map<string, NonNullable<typeof evals.data>[number]>();
  for (const e of evals.data ?? []) if (!lastEval.has(e.setId)) lastEval.set(e.setId, e);

  return (
    <div className="h-full overflow-auto bg-white dark:bg-zinc-950">
      <div className="mx-auto max-w-5xl space-y-5 p-4">
        <div className="flex items-center gap-2">
          <h1 className="text-[15px] font-semibold">{tr("评测")}</h1>
          <span className="text-[12px] text-zinc-500">{tr("一组用例 × 几组改动 × 多次回放：看 skill 改动带来的提升和回归")}</span>
          <span className="flex-1" />
          <Button onClick={() => setDialog('skill')}>{tr("从 skill 生成…")}</Button>
          <Button variant="primary" onClick={() => setDialog('new')}>{tr("新建评测集")}</Button>
        </div>

        <section>
          <div className="mb-1.5 text-[13px] font-semibold">{tr("评测集")}</div>
          {sets.isLoading && <Spinner />}
          {sets.error ? <ErrorBox error={sets.error} /> : null}
          {sets.data && !sets.data.length && (
            <div className="h-40">
              <Empty>
                <div className="max-w-md space-y-1.5 text-[12.5px]">
                  <div className="font-medium text-zinc-700 dark:text-zinc-300">{tr("还没有评测集")}</div>
                  <div>{tr("\"从 skill 生成\"会按会话索引挑出某个 skill 的正例、反例和对照；也可以新建空的评测集，再从会话列表多选加入。")}</div>
                </div>
              </Empty>
            </div>
          )}
          <div className="divide-y divide-zinc-100 dark:divide-zinc-800">
            {sets.data?.map((s) => {
              const e = lastEval.get(s.id);
              return (
                <Link key={s.id} href={`/evals/sets/${s.id}`} className="flex items-center gap-2 py-2 text-[12.5px] hover:bg-zinc-50 dark:hover:bg-zinc-900">
                  <span className="min-w-0 flex-1 truncate font-medium text-indigo-700 dark:text-indigo-300">{s.name}</span>
                  {s.skill && <Badge tone="amber">⚑ {s.skill}</Badge>}
                  <span className="w-16 text-right text-[11px] text-zinc-500">{s.cases}{tr("个用例")}</span>
                  <span className="w-40 text-right text-[11px] text-zinc-500">
                    {e ? (
                      <>
                        <Badge tone={EVAL_STATUS[e.status].tone}>{EVAL_STATUS[e.status].label}</Badge> {relTime(e.createdAt)}
                      </>
                    ) : (
                      tr("还没有评测")
                    )}
                  </span>
                </Link>
              );
            })}
          </div>
        </section>

        {evals.data && evals.data.length > 0 && (
          <section>
            <div className="mb-1.5 text-[13px] font-semibold">{tr("最近的评测")}</div>
            <div className="divide-y divide-zinc-100 dark:divide-zinc-800">
              {evals.data.slice(0, 30).map((e) => (
                <Link key={e.id} href={`/evals/${e.id}`} className="flex items-center gap-2 py-1.5 text-[12.5px] hover:bg-zinc-50 dark:hover:bg-zinc-900">
                  <Badge tone={EVAL_STATUS[e.status].tone}>{EVAL_STATUS[e.status].label}</Badge>
                  <span className="min-w-0 flex-1 truncate">
                    {e.name ?? e.arms.map((a) => a.label).join(' vs ')}
                    <span className="ml-2 text-[11px] text-zinc-500">{setName.get(e.setId) ?? ''}</span>
                  </span>
                  {e.progress && (
                    <span className="font-mono text-[11px] text-zinc-500">
                      {e.progress.done}/{e.progress.total}
                    </span>
                  )}
                  <span className="w-20 text-right text-[11px] text-zinc-500">{relTime(e.createdAt)}</span>
                </Link>
              ))}
            </div>
          </section>
        )}
      </div>
      {dialog && <NewSetDialog fromSkill={dialog === 'skill'} onClose={() => setDialog(undefined)} />}
    </div>
  );
}

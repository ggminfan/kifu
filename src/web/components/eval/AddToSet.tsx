import { systemText, localized, tr } from '../../../shared/i18n';
import { useLocale } from '../../../shared/i18n/react';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useLocation } from 'wouter';
import { ROLE_LABEL, type CaseRole } from '../../../shared/replay';
import { addTurnsToSet, createSet, resolveTurns, useEvalSets, type TurnStrategy } from '../../lib/evalsApi';
import { useCatalog } from '../../lib/labApi';
import { Modal } from '../Modal';
import { Button, ErrorBox, cx } from '../ui';
import { shortId } from '../../lib/format';

const field = 'rounded border border-zinc-300 bg-white px-2 py-1 text-[12.5px] dark:border-zinc-700 dark:bg-zinc-900';

const STRATEGY: Array<{ id: TurnStrategy; label: string; title: string }> = localized([
  { id: 'last', label: '最后一轮', title: '每个会话最后一个可以回放的轮次' },
  { id: 'first', label: '第一轮', title: '每个会话第一个可以回放的轮次' },
  { id: 'skill', label: 'skill 相关的那一轮', title: '加载了（或可能该加载）这个 skill 的轮次；没有时用最后一轮' },
]);

/** Selected sessions into an evaluation set: one turn of each becomes a case. */
export function AddToSetDialog({ sessionIds, skillHint, onClose, onDone }: { sessionIds: string[]; skillHint?: string; onClose: () => void; onDone: () => void }) {
  useLocale();
  const [, navigate] = useLocation();
  const qc = useQueryClient();
  const sets = useEvalSets();
  const catalog = useCatalog();
  const [target, setTarget] = useState('');
  const [name, setName] = useState(skillHint ? tr`${skillHint} 评测` : '');
  const [skill, setSkill] = useState(skillHint ?? '');
  const [role, setRole] = useState<CaseRole>('positive');
  const [strategy, setStrategy] = useState<TurnStrategy>(skillHint ? 'skill' : 'last');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const [resolved, setResolved] = useState<{ items: Array<{ sessionId: string; turnIndex: number }>; skipped: Array<{ sessionId: string; reason: string }> }>();
  const existing = target ? sets.data?.find((s) => s.id === target) : undefined;
  const turnSkill = existing?.skill ?? (skill || undefined);

  const add = async (items: Array<{ sessionId: string; turnIndex: number }>) => {
    const setId = existing?.id ?? (await createSet({ name: name.trim() || tr("评测集"), skill: skill || undefined })).id;
    const r = await addTurnsToSet(setId, items, role);
    await Promise.all(['evalSets', 'evalSet', 'cases'].map((k) => qc.invalidateQueries({ queryKey: [k] })));
    if (r.failed.length && !r.added.length) throw new Error(r.failed[0].error);
    onDone();
    navigate(`/evals/sets/${setId}`);
  };

  const go = async () => {
    setBusy(true);
    setError(undefined);
    try {
      if (resolved) return await add(resolved.items);
      const turns = await resolveTurns(sessionIds, strategy, strategy === 'skill' ? turnSkill : undefined);
      const items = turns.flatMap((t) => (t.turnIndex === undefined ? [] : [{ sessionId: t.sessionId, turnIndex: t.turnIndex }]));
      const skipped = turns.flatMap((t) => (t.turnIndex === undefined ? [{ sessionId: t.sessionId, reason: t.reason ?? tr("没有可以回放的轮次") }] : []));
      if (!items.length) throw new Error(tr`没有可以回放的轮次${skipped[0] ? `：${skipped[0].reason}` : ''}`);
      if (skipped.length) setResolved({ items, skipped });
      else await add(items);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={tr`把 ${sessionIds.length} 个会话加入评测集`}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>{tr("取消")}</Button>
          <Button variant="primary" disabled={busy || (strategy === 'skill' && !turnSkill)} onClick={() => void go()}>
            {busy ? tr("处理中…") : resolved ? tr`跳过它们，加入 ${resolved.items.length} 个` : tr("加入")}
          </Button>
        </>
      }
    >
      <div className="space-y-2.5">
        <label className="flex items-center gap-2">
          <span className="w-16 shrink-0 text-zinc-500">{tr("评测集")}</span>
          <select value={target} onChange={(e) => setTarget(e.target.value)} className={cx(field, 'flex-1')}>
            <option value="">{tr("新建评测集")}</option>
            {sets.data?.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}（{s.cases}{tr("个用例")}{s.skill ? ` · ${s.skill}` : ''}）
              </option>
            ))}
          </select>
        </label>
        {!target && (
          <>
            <label className="flex items-center gap-2">
              <span className="w-16 shrink-0 text-zinc-500">{tr("名称")}</span>
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder={tr("评测集")} className={cx(field, 'flex-1')} />
            </label>
            <label className="flex items-center gap-2">
              <span className="w-16 shrink-0 text-zinc-500">skill</span>
              <select value={skill} onChange={(e) => setSkill(e.target.value)} className={cx(field, 'flex-1')}>
                <option value="">{tr("（不指定）")}</option>
                {(catalog.data ?? [])
                  .filter((s) => !s.shadowedBy)
                  .map((s) => (
                    <option key={s.key} value={s.key}>
                      {s.key}
                    </option>
                  ))}
              </select>
            </label>
          </>
        )}
        <div className="flex items-center gap-2">
          <span className="w-16 shrink-0 text-zinc-500">{tr("作为")}</span>
          {(['positive', 'negative', 'control'] as CaseRole[]).map((r) => (
            <label key={r} className="flex items-center gap-1">
              <input type="radio" checked={role === r} onChange={() => setRole(r)} />
              {ROLE_LABEL[r]}
            </label>
          ))}
        </div>
        <div className="text-[11px] text-zinc-500 sm:pl-[72px]">{tr("正例：应该加载评测的 skill；反例：不应该加载；对照：相近 skill 的会话，改动后不能抢它们的触发。")}</div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="w-16 shrink-0 text-zinc-500">{tr("取哪一轮")}</span>
          {STRATEGY.map((x) => (
            <label key={x.id} className="flex items-center gap-1" title={x.title}>
              <input
                type="radio"
                checked={strategy === x.id}
                onChange={() => {
                  setStrategy(x.id);
                  setResolved(undefined);
                }}
              />
              {x.label}
            </label>
          ))}
        </div>
        {strategy === 'skill' && !turnSkill && <div className="text-[11.5px] text-amber-600">{tr("先指定评测的 skill")}</div>}
        {resolved && (
          <div className="rounded border border-amber-300 bg-amber-50 p-2 text-[12px] text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
            {resolved.skipped.length}{tr("个会话没有可以回放的轮次，会跳过：")}{resolved.skipped.slice(0, 6).map((x) => (
              <div key={x.sessionId} className="font-mono text-[11px]">
                {shortId(x.sessionId)} {systemText(x.reason)}
              </div>
            ))}
          </div>
        )}
        {error ? <ErrorBox error={error} /> : null}
      </div>
    </Modal>
  );
}

import { systemText, tr } from '../../../shared/i18n';
import { useLocale } from '../../../shared/i18n/react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Link } from 'wouter';
import type { Arm } from '../../../shared/replay';
import { api, postJson } from '../../lib/api';
import { useVariant, type CatalogSkill, type Variant, type VariantDetail } from '../../lib/labApi';
import { CodeEditor } from '../CodeEditor';
import { askConfirm } from '../dialogs';
import { DescriptionEditor } from '../lab/SkillWorkbench';
import { Badge, Button, ErrorBox, Spinner, cx } from '../ui';

/** Variants of this workspace's skills. */
export function useAllVariants() {
  return useQuery({ queryKey: ['variants'], queryFn: () => api<Variant[]>('/variants'), staleTime: 10_000 });
}

const variantName = (v: Variant) => `${v.skillKey} · ${v.label}`;

/** Catalog key of a skill as the session named it (`name` or `plugin:name`). */
export async function resolveSkillKey(name: string): Promise<string> {
  const catalog = await api<CatalogSkill[]>('/skills');
  const hit = catalog.find((s) => s.key === name) ?? catalog.find((s) => s.key.endsWith(`:${name}`)) ?? catalog.find((s) => s.name === name);
  if (!hit) throw new Error(tr`skill 目录里找不到 ${name}`);
  return hit.key;
}

/** Edit a variant's description (with the listing's cut-off ruler) and body, in place; apply it to the real skill (backed up, undoable). */
export function VariantEditor({ id, cap, onClose }: { id: string; cap?: number; onClose: () => void }) {
  useLocale();
  const qc = useQueryClient();
  const v = useVariant(id);
  const [draft, setDraft] = useState<{ description: string; body: string }>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const [msg, setMsg] = useState<{ text: string; patch?: string }>();
  useEffect(() => {
    if (v.data) setDraft({ description: v.data.description ?? '', body: v.data.body });
  }, [v.data?.id, v.data?.updatedAt]);
  if (v.isLoading) return <Spinner label={tr("读取变体…")} />;
  if (v.error) return <ErrorBox error={v.error} />;
  if (!v.data || !draft) return null;
  const dirty = draft.description !== (v.data.description ?? '') || draft.body !== v.data.body;
  const live = v.data.applies?.find((a) => !a.undoneAt);
  const apply = async () => {
    if (dirty) return setError(new Error(tr("请先保存变体")));
    if (!(await askConfirm({ title: tr`把变体 ${v.data!.label} 写回真实 skill？`, body: tr`${v.data!.skillKey}\n会先备份，之后可以撤销。插件 / 系统 skill 只导出补丁。`, confirm: tr("写回") }))) return;
    setBusy(true);
    setError(undefined);
    try {
      const res = await postJson<{ mode: 'applied'; backup: string } | { mode: 'patch'; reason: string; patch: string }>(`/variants/${id}/apply`, {});
      setMsg(res.mode === 'patch' ? { text: res.reason, patch: res.patch } : { text: tr`已写回，备份在 ${res.backup}` });
      await qc.invalidateQueries({ queryKey: ['variant', id] });
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  const undo = async (applyId: string) => {
    setBusy(true);
    setError(undefined);
    try {
      await postJson(`/applies/${applyId}/undo`, {});
      setMsg({ text: tr("已撤销，恢复为写回前的内容") });
      await qc.invalidateQueries({ queryKey: ['variant', id] });
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  const save = async () => {
    setBusy(true);
    setError(undefined);
    try {
      await api<VariantDetail>(`/variants/${id}`, { method: 'PUT', body: JSON.stringify(draft) });
      await qc.invalidateQueries({ queryKey: ['variant', id] });
      await qc.invalidateQueries({ queryKey: ['variants'] });
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-1.5 rounded border border-indigo-200 bg-indigo-50/40 p-2 dark:border-indigo-900 dark:bg-indigo-950/20">
      <div className="flex items-center gap-1.5 text-[12px]">
        <span className="font-medium">{tr("变体")}{v.data.label}</span>
        <span className="font-mono text-zinc-500">{v.data.skillKey}</span>
        {v.data.baseChanged && <Badge tone="amber">{tr("真实 SKILL.md 后来改过")}</Badge>}
        <span className="flex-1" />
        <Link href={`/skills?skill=${encodeURIComponent(v.data.skillKey)}&v=${id}`} className="text-[11px] text-indigo-600 hover:underline dark:text-indigo-400">{tr("在 Skills 页打开")}</Link>
        <Button size="xs" variant="primary" disabled={!dirty || busy} onClick={() => void save()}>
          {busy ? '…' : dirty ? tr("保存") : tr("已保存")}
        </Button>
        {live ? (
          <Button size="xs" onClick={() => void undo(live.id)} disabled={busy} title={tr`${new Date(live.createdAt).toLocaleString()} 写回到 ${live.target}`}>{tr("撤销写回")}</Button>
        ) : (
          <Button size="xs" onClick={() => void apply()} disabled={busy} title={tr("改得满意后写回真实 skill（先备份，可撤销）")}>{tr("应用到真实 skill")}</Button>
        )}
        <Button size="xs" variant="ghost" onClick={onClose}>{tr("收起")}</Button>
      </div>
      <div>
        <div className="mb-0.5 text-[11px] text-zinc-500">{tr("description（决定会不会被触发）")}</div>
        <DescriptionEditor value={draft.description} onChange={(d) => setDraft({ ...draft, description: d })} cap={cap} noCapHint={tr("这个会话的 skill 列表没有截断描述")} />
      </div>
      <div>
        <div className="mb-0.5 text-[11px] text-zinc-500">{tr("正文（加载后照着做）")}</div>
        <CodeEditor value={draft.body} onChange={(b) => setDraft({ ...draft, body: b })} className="h-56 overflow-auto rounded border border-zinc-200 dark:border-zinc-800" />
      </div>
      {msg && (
        <div className="text-[11px] text-emerald-600">
          {systemText(msg.text)}
          {msg.patch && <pre className="mt-1 max-h-48 overflow-auto rounded bg-zinc-100 p-2 font-mono text-[11px] text-zinc-800 dark:bg-zinc-900 dark:text-zinc-200">{msg.patch}</pre>}
        </div>
      )}
      {error ? <ErrorBox error={error} /> : null}
    </div>
  );
}

/**
 * Groups of changes to replay: A′ (none) and B… (skill variants). Each group
 * is replayed the same number of times so they can be compared.
 */
export function ArmsEditor({
  arms,
  onChange,
  skills,
  cap,
  variantsSupported,
}: {
  arms: Arm[];
  onChange: (a: Arm[]) => void;
  /** Skills of this session (its listing), for new variants. */
  skills: string[];
  cap?: number;
  variantsSupported: boolean;
}) {
  useLocale();
  const qc = useQueryClient();
  const variants = useAllVariants();
  const [editing, setEditing] = useState<string>();
  const [error, setError] = useState<unknown>();
  const byId = new Map((variants.data ?? []).map((v) => [v.id, v]));
  const set = (i: number, arm: Arm) => onChange(arms.map((a, j) => (j === i ? arm : a)));
  const hasBaseline = arms.some((a) => !a.variantIds.length);

  const createVariant = async (armIndex: number, skill: string) => {
    setError(undefined);
    try {
      const v = await postJson<VariantDetail>(`/skills/${encodeURIComponent(await resolveSkillKey(skill))}/variants`, {});
      await qc.invalidateQueries({ queryKey: ['variants'] });
      set(armIndex, { ...arms[armIndex], variantIds: [...arms[armIndex].variantIds, v.id], label: arms[armIndex].label });
      setEditing(v.id);
    } catch (e) {
      setError(e);
    }
  };

  return (
    <div className="space-y-1.5">
      {arms.map((arm, i) => (
        <div key={i} className="flex flex-wrap items-center gap-1 rounded border border-zinc-200 px-1.5 py-1 text-[12px] dark:border-zinc-800">
          <input
            value={arm.label}
            onChange={(e) => set(i, { ...arm, label: e.target.value })}
            className="w-16 rounded border border-transparent bg-transparent px-1 font-medium hover:border-zinc-300 focus:border-indigo-500 dark:hover:border-zinc-700"
            title={tr("这组改动的名字")}
          />
          {!arm.variantIds.length && <span className="text-zinc-500">{tr("不改动（基线）")}</span>}
          {arm.variantIds.map((vid) => {
            const v = byId.get(vid);
            return (
              <span key={vid} className={cx('inline-flex items-center gap-1 rounded px-1.5 py-0.5', editing === vid ? 'bg-indigo-600 text-white' : 'bg-indigo-50 text-indigo-700 dark:bg-indigo-950 dark:text-indigo-300')}>
                <button onClick={() => setEditing(editing === vid ? undefined : vid)} title={tr("编辑这个变体")}>
                  {v ? variantName(v) : vid}
                </button>
                <button className="opacity-60 hover:opacity-100" title={tr("移出这组")} onClick={() => set(i, { ...arm, variantIds: arm.variantIds.filter((x) => x !== vid) })}>
                  ×
                </button>
              </span>
            );
          })}
          {variantsSupported && arm.label !== 'A′' ? (
            <>
              <select
                value=""
                onChange={(e) => e.target.value && set(i, { ...arm, variantIds: [...arm.variantIds, e.target.value] })}
                className="rounded border border-zinc-300 bg-white px-1 py-0.5 text-[11.5px] dark:border-zinc-700 dark:bg-zinc-900"
              >
                <option value="">{tr("+ 已有变体…")}</option>
                {(variants.data ?? [])
                  .filter((v) => !arm.variantIds.includes(v.id))
                  .map((v) => (
                    <option key={v.id} value={v.id}>
                      {variantName(v)}
                    </option>
                  ))}
              </select>
              <select
                value=""
                onChange={(e) => e.target.value && void createVariant(i, e.target.value)}
                className="rounded border border-zinc-300 bg-white px-1 py-0.5 text-[11.5px] dark:border-zinc-700 dark:bg-zinc-900"
              >
                <option value="">{tr("+ 新建变体：选择 skill…")}</option>
                {[...new Set(skills)].map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </>
          ) : null}
          <span className="flex-1" />
          {arms.length > 1 && (
            <button className="text-zinc-400 hover:text-red-500" title={tr("删除这组")} onClick={() => onChange(arms.filter((_, j) => j !== i))}>
              ×
            </button>
          )}
        </div>
      ))}
      <div className="flex flex-wrap items-center gap-2 text-[11.5px]">
        {variantsSupported ? (
          <Button size="xs" onClick={() => onChange([...arms, { label: `B${arms.filter((a) => a.variantIds.length || a.label.startsWith('B')).length + 1}`, variantIds: [] }])}>{tr("+ 一组改动")}</Button>
        ) : (
          <span className="text-zinc-500">{tr("这个工作区的 skill 变体还不能用于回放；可以改输入、模型和检查项。")}</span>
        )}
        {!hasBaseline && (
          <Button size="xs" variant="ghost" onClick={() => onChange([{ label: 'A′', variantIds: [] }, ...arms])}>{tr("+ 基线 A′")}</Button>
        )}
        <span className="text-zinc-400">{tr("A′ 用同样的回放方式、不做任何改动，用来分辨\"改动的效果\"和\"回放本身的差异\"。")}</span>
      </div>
      {editing && <VariantEditor id={editing} cap={cap} onClose={() => setEditing(undefined)} />}
      {error ? <ErrorBox error={error} /> : null}
    </div>
  );
}

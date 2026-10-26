import { systemText, getLocale, tr } from '../../../shared/i18n';
import { useLocale } from '../../../shared/i18n/react';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'wouter';
import { parseSkillMdClient, updateSkillMdClient } from '../../lib/skillmd';
import { postJson, api } from '../../lib/api';
import { useSkill, useVariant, type CatalogSkill, type VariantDetail } from '../../lib/labApi';
import { CodeEditor, MergeEditor } from '../CodeEditor';
import { askConfirm } from '../dialogs';
import { Badge, Button, ErrorBox, Spinner, cx } from '../ui';

function normalize(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/** Description field with a ruler showing what the skill catalog will cut off. */
export function DescriptionEditor({ value, onChange, cap, readOnly, noCapHint = tr("点右侧\"预览\"获取 skill 列表的截断预算") }: { value: string; onChange?: (v: string) => void; cap?: number; readOnly?: boolean; noCapHint?: string }) {
  useLocale();
  const n = normalize(value);
  const visible = cap ? n.slice(0, cap) : n;
  const hidden = cap && n.length > cap ? n.slice(cap) : '';
  return (
    <div>
      <textarea
        value={value}
        readOnly={readOnly}
        onChange={(e) => onChange?.(e.target.value)}
        rows={3}
        className={cx('w-full resize-y rounded border border-zinc-300 bg-white px-2 py-1 text-[12.5px] leading-relaxed outline-none focus:border-indigo-500 dark:border-zinc-700 dark:bg-zinc-900', readOnly && 'bg-zinc-50 dark:bg-zinc-900/60')}
      />
      <div className="mt-0.5 flex items-start gap-2 text-[11px]">
        <span className={cx('shrink-0 font-mono', hidden ? 'text-red-500' : 'text-zinc-500')}>
          {n.length}{tr("字")}{cap ? tr` / 预算 ${cap}` : ''}
        </span>
        {cap ? (
          <span className="min-w-0 flex-1 text-zinc-500">{tr("模型看到：")}<span className="text-zinc-700 dark:text-zinc-300">{visible}</span>
            {hidden && <span className="bg-red-50 text-red-400 line-through dark:bg-red-950/40">{hidden}</span>}
          </span>
        ) : (
          <span className="text-zinc-400">{noCapHint}</span>
        )}
      </div>
    </div>
  );
}

export function SkillWorkbench({
  skillKey,
  variantId,
  onVariant,
  cap,
}: {
  skillKey: string;
  variantId?: string;
  onVariant: (id: string | undefined) => void;
  cap?: number;
}) {
  useLocale();
  const qc = useQueryClient();
  const skill = useSkill(skillKey);
  const variant = useVariant(variantId);
  const [draft, setDraft] = useState<{ description: string; body: string } | undefined>();
  const [showDiff, setShowDiff] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'ok' | 'err'; text: string; patch?: string }>();

  const baseRaw = skill.data?.raw ?? '';
  const base = useMemo(() => parseSkillMdClient(baseRaw), [baseRaw, getLocale()]);
  const current: VariantDetail | undefined = variantId ? variant.data : undefined;

  useEffect(() => {
    setDraft(current ? { description: current.description ?? '', body: current.body } : undefined);
    setMsg(undefined);
  }, [current?.id, current?.updatedAt]);

  if (skill.isLoading) return <div className="p-4"><Spinner label={tr("读取 skill…")} /></div>;
  if (skill.error) return <ErrorBox error={skill.error} />;
  if (!skill.data) return null;
  const s: CatalogSkill = skill.data.skill;
  const variants = skill.data.variants;
  const dirty = Boolean(current && draft && (draft.description !== (current.description ?? '') || draft.body !== current.body));
  const draftRaw = current && draft ? updateSkillMdClient(current.raw, draft) : undefined;

  const refresh = async () => {
    await qc.invalidateQueries({ queryKey: ['skill', skillKey] });
    await qc.invalidateQueries({ queryKey: ['variant', variantId] });
    await qc.invalidateQueries({ queryKey: ['catalog'] });
  };
  const act = async (fn: () => Promise<void>) => {
    setBusy(true);
    setMsg(undefined);
    try {
      await fn();
    } catch (e) {
      setMsg({ tone: 'err', text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const createVariant = () =>
    act(async () => {
      const v = await postJson<VariantDetail>(`/skills/${encodeURIComponent(skillKey)}/variants`, variantId ? { fromVariant: variantId } : {});
      await refresh();
      onVariant(v.id);
    });
  const save = () =>
    act(async () => {
      await api(`/variants/${variantId}`, { method: 'PUT', body: JSON.stringify(draft) });
      await refresh();
      setMsg({ tone: 'ok', text: tr("已保存变体") });
    });
  const remove = () =>
    act(async () => {
      if (!(await askConfirm({ title: tr("删除这个变体？"), body: tr("不影响真实 skill。"), confirm: tr("删除"), danger: true }))) return;
      await api(`/variants/${variantId}`, { method: 'DELETE' });
      onVariant(undefined);
      await refresh();
    });
  const apply = () =>
    act(async () => {
      if (dirty) throw new Error(tr("请先保存变体"));
      const ok = s.writable
        ? await askConfirm({ title: tr`把变体 ${current?.label ?? ''} 写回真实 skill？`, body: tr`${s.file}\n会先备份，之后可以撤销。`, confirm: tr("写回") })
        : await askConfirm({ title: tr("导出补丁？"), confirm: tr("导出") });
      if (!ok) return;
      const res = await postJson<{ mode: 'applied'; applyId: string; backup: string } | { mode: 'patch'; reason: string; patch: string }>(`/variants/${variantId}/apply`, {});
      if (res.mode === 'patch') setMsg({ tone: 'ok', text: res.reason, patch: res.patch });
      else setMsg({ tone: 'ok', text: tr`已写回，备份在 ${res.backup}` });
      await refresh();
    });
  const undo = (applyId: string) =>
    act(async () => {
      await postJson(`/applies/${applyId}/undo`, {});
      setMsg({ tone: 'ok', text: tr("已撤销，恢复为应用前的内容") });
      await refresh();
    });

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-zinc-200 bg-white px-3 py-2 dark:border-zinc-800 dark:bg-zinc-950">
        <div className="flex min-w-0 items-center gap-2 whitespace-nowrap">
          <h1 className="min-w-0 truncate font-mono text-[14px] font-semibold" title={s.key}>
            {s.key}
          </h1>
          <Badge tone={s.writable ? 'green' : 'zinc'} title={s.writable ? tr("可以写回") : tr("插件 / 系统 skill，只能导出补丁")}>
            {s.writable ? tr("可写回") : tr("只读来源")}
          </Badge>
          {s.sessionsUsed > 0 && (
            <Link href={`/?skill=${encodeURIComponent(s.key)}`} className="shrink-0 text-[11px] text-indigo-600 hover:underline dark:text-indigo-400">
              {s.sessionsUsed}{tr("个会话用过 →")}</Link>
          )}
        </div>
        {/* the path on its own line, its end visible (the skill's folder) */}
        <div className="mt-0.5 truncate font-mono text-[10.5px] text-zinc-400 [direction:rtl] [text-align:left]" title={s.file}>
          <bdi>{s.file}</bdi>
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-1">
          <button onClick={() => onVariant(undefined)} className={cx('rounded px-2 py-0.5 text-[12px]', !variantId ? 'bg-zinc-800 text-white dark:bg-zinc-200 dark:text-zinc-900' : 'bg-zinc-100 dark:bg-zinc-800')}>{tr("原版")}</button>
          {variants.map((v) => (
            <button key={v.id} onClick={() => onVariant(v.id)} className={cx('rounded px-2 py-0.5 text-[12px]', variantId === v.id ? 'bg-indigo-600 text-white' : 'bg-indigo-50 text-indigo-700 dark:bg-indigo-950 dark:text-indigo-300')}>
              {v.label}
            </button>
          ))}
          <Button size="xs" onClick={createVariant} disabled={busy}>
            + {variantId ? tr("复制为新变体") : tr("新建变体")}
          </Button>
          <span className="flex-1" />
          {current && (
            <>
              <Button size="xs" variant="ghost" onClick={() => setShowDiff(!showDiff)}>
                {showDiff ? tr("编辑") : tr("与原版对比")}
              </Button>
              <Button size="xs" variant="primary" onClick={save} disabled={!dirty || busy}>{tr("保存")}</Button>
              <Button size="xs" onClick={apply} disabled={busy}>
                {s.writable ? tr("应用到真实 skill") : tr("导出补丁")}
              </Button>
              <Button size="xs" variant="ghost" onClick={remove} disabled={busy}>{tr("删除")}</Button>
            </>
          )}
        </div>
        {current?.baseChanged && <div className="mt-1 text-[11px] text-amber-600">{tr("注意：真实 SKILL.md 在创建这个变体之后被修改过，应用前请先对比。")}</div>}
        {msg && (
          <div className={cx('mt-1 text-[11px]', msg.tone === 'err' ? 'text-red-600' : 'text-emerald-600')}>
            {systemText(msg.text)}
            {msg.patch && (
              <pre className="mt-1 max-h-48 overflow-auto rounded bg-zinc-100 p-2 font-mono text-[11px] text-zinc-800 dark:bg-zinc-900 dark:text-zinc-200">{msg.patch}</pre>
            )}
          </div>
        )}
        {current?.applies?.filter((a) => !a.undoneAt).slice(0, 1).map((a) => (
          <div key={a.id} className="mt-1 text-[11px] text-zinc-500">
            {new Date(a.createdAt).toLocaleString()}{tr("已写回 ·")}{' '}
            <button className="text-indigo-600 hover:underline dark:text-indigo-400" onClick={() => undo(a.id)}>{tr("撤销")}</button>
          </div>
        ))}
      </div>

      <div className="min-h-0 flex-1 overflow-auto p-3">
        {variantId && variant.isLoading && <Spinner label={tr("读取变体…")} />}
        {showDiff && current && draftRaw !== undefined ? (
          <MergeEditor original={baseRaw} modified={draftRaw} className="h-full overflow-auto rounded border border-zinc-200 dark:border-zinc-800" />
        ) : (
          <div className="flex h-full flex-col gap-2">
            <div>
              <div className="mb-0.5 text-[11px] font-medium text-zinc-500">{tr("description（决定会不会被触发）")}</div>
              <DescriptionEditor
                value={current && draft ? draft.description : (base.description ?? '')}
                readOnly={!current}
                onChange={(v) => setDraft((d) => (d ? { ...d, description: v } : d))}
                cap={cap}
              />
            </div>
            <div className="flex min-h-0 flex-1 flex-col">
              <div className="mb-0.5 text-[11px] font-medium text-zinc-500">{tr("正文（加载后模型照着做）")}{!current && tr(" · 原版只读，新建变体后编辑")}</div>
              <CodeEditor
                value={current && draft ? draft.body : base.body}
                readOnly={!current}
                onChange={(v) => setDraft((d) => (d ? { ...d, body: v } : d))}
                className="min-h-[240px] flex-1 overflow-auto rounded border border-zinc-200 dark:border-zinc-800"
              />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

import { getLocale, localized, tr } from '../../../shared/i18n';
import { useLocale } from '../../../shared/i18n/react';
import { useMemo, useState } from 'react';
import { Link } from 'wouter';
import { useHealth } from '../../lib/api';
import { useCatalog, type CatalogSkill } from '../../lib/labApi';
import { useAllVariants } from '../debug/Arms';
import { Badge, ErrorBox, Spinner, cx } from '../ui';

const SOURCE: Record<CatalogSkill['source'], { label: string; tone: 'indigo' | 'green' | 'zinc' | 'violet' }> = localized({
  user: { label: '用户', tone: 'indigo' },
  agents: { label: 'agents', tone: 'green' },
  system: { label: '系统', tone: 'zinc' },
  plugin: { label: '插件', tone: 'violet' },
});

export function SkillCatalog({ selected, onSelect }: { selected?: string; onSelect: (key: string) => void }) {
  useLocale();
  const { data, isLoading, error } = useCatalog();
  const health = useHealth();
  // distilling and evaluating new skills replays with the workspace's agent (Codex)
  const distill = health.data !== undefined && health.data.agent !== 'claude';
  const variants = useAllVariants();
  const drafts = distill ? (variants.data ?? []).filter((v) => !v.originalPath) : [];
  const [q, setQ] = useState('');
  const [usedOnly, setUsedOnly] = useState(false);
  const list = useMemo(() => {
    const ql = q.toLowerCase();
    return (data ?? []).filter((s) => !s.shadowedBy && (!usedOnly || s.sessionsUsed > 0 || s.variants > 0) && (!ql || s.key.toLowerCase().includes(ql) || (s.description ?? '').toLowerCase().includes(ql)));
  }, [data, q, usedOnly, getLocale()]);
  return (
    <div className="flex h-full flex-col bg-white dark:bg-zinc-950">
      <div className="space-y-1.5 border-b border-zinc-200 p-2 dark:border-zinc-800">
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={tr("搜索 skill…")} className="w-full rounded border border-zinc-300 bg-white px-2 py-1 text-[12px] outline-none focus:border-indigo-500 dark:border-zinc-700 dark:bg-zinc-900" />
        <label className="flex items-center gap-1 text-[11px] text-zinc-500">
          <input type="checkbox" checked={usedOnly} onChange={(e) => setUsedOnly(e.target.checked)} />{tr("只看用过 / 有变体的")}<span className="ml-auto">{list.length}{tr("个")}</span>
        </label>
        {distill && (
          <Link href="/skills/new" className="block text-[11.5px] text-indigo-600 hover:underline dark:text-indigo-400" title={tr("从会话里反复的做法和澄清提炼一个新 skill")}>{tr("+ 从会话提炼新 skill")}</Link>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {drafts.length > 0 && (
          <div className="border-b border-zinc-200 py-1 dark:border-zinc-800">
            <div className="px-3 text-[10px] font-medium uppercase tracking-wide text-zinc-400">{tr("新 skill（还没安装）")}</div>
            {drafts.map((v) => (
              <Link key={v.id} href={`/skills/new?v=${v.id}`} className="flex items-center gap-1.5 px-3 py-1 text-[12px] hover:bg-zinc-100 dark:hover:bg-zinc-900">
                <span className="min-w-0 flex-1 truncate font-mono">{v.skillKey}</span>
                <Badge tone="amber">{v.label}</Badge>
              </Link>
            ))}
          </div>
        )}
        {isLoading && <div className="p-3"><Spinner label={tr("扫描 skill…")} /></div>}
        {error && <ErrorBox error={error} />}
        {list.map((s) => (
          <button key={s.key} onClick={() => onSelect(s.key)} className={cx('block w-full border-b border-zinc-100 px-3 py-1.5 text-left hover:bg-zinc-100 dark:border-zinc-900 dark:hover:bg-zinc-900', selected === s.key && 'bg-indigo-50 dark:bg-indigo-950/50')}>
            <div className="flex items-center gap-1.5">
              <span className="min-w-0 flex-1 truncate font-mono text-[12px] font-medium">{s.key}</span>
              {s.variants > 0 && <Badge tone="amber">{s.variants}{tr("变体")}</Badge>}
              <Badge tone={SOURCE[s.source].tone}>{SOURCE[s.source].label}</Badge>
            </div>
            <div className="mt-0.5 line-clamp-2 text-[11px] text-zinc-500">{s.description}</div>
            <div className="mt-0.5 text-[10.5px] text-zinc-400">
              {s.sessionsUsed ? tr`${s.sessionsUsed} 个会话用过` : tr("未被使用")}{tr("· 描述")}{s.descriptionChars}{tr("字")}</div>
          </button>
        ))}
      </div>
    </div>
  );
}

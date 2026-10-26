import { systemText, tr } from '../../shared/i18n';
import { useLocale } from '../../shared/i18n/react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'wouter';
import { AGENT_ICON } from '../../shared/agent-icons';
import { askConfirm } from '../components/dialogs';
import { Badge, Button, Empty, ErrorBox, Spinner, cx } from '../components/ui';
import { api, postJson } from '../lib/api';
import { useCases } from '../lib/casesApi';
import { fmtBytes, relTime, shortId } from '../lib/format';

interface StorageReport {
  categories: Array<{ id: string; label: string; bytes: number; count: number }>;
  total: number;
  softLimit: number;
  orphanOverlays: number;
  expiring: number;
  expireDays: number;
}

/** What debugging keeps on disk, and cleanup. */
function StorageBar() {
  useLocale();
  const qc = useQueryClient();
  const report = useQuery({ queryKey: ['storage'], queryFn: () => api<StorageReport>('/maintenance/storage'), staleTime: 30_000 });
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string>();
  const r = report.data;
  if (!r) return null;
  const run = async (what: { expired?: boolean; overlays?: boolean; cache?: boolean }, title: string) => {
    if (!(await askConfirm({ title, confirm: tr("清理") }))) return;
    setBusy(true);
    try {
      const done = await postJson<{ cases: number; overlays: number; cache: number }>('/maintenance/cleanup', what);
      setMsg(tr`已清理：${[done.cases && tr`${done.cases} 个用例`, done.overlays && tr`${done.overlays} 个残留的隔离目录`, done.cache && tr`${done.cache} 个缓存文件`].filter(Boolean).join('、') || tr("没有需要清理的")}`);
      await Promise.all(['storage', 'cases'].map((k) => qc.invalidateQueries({ queryKey: [k] })));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-zinc-200 bg-zinc-50 px-3 py-1.5 text-[11.5px] text-zinc-500 dark:border-zinc-800 dark:bg-zinc-900/60">
      <span className={cx('font-medium', r.total > r.softLimit ? 'text-red-600' : 'text-zinc-600 dark:text-zinc-300')} title={tr("逻辑大小：APFS 克隆和原文件共享的部分不重复占用磁盘")}>{tr("占用")}{fmtBytes(r.total)}
        {r.total > r.softLimit ? tr`（超过 ${fmtBytes(r.softLimit)} 上限）` : ''}
      </span>
      {r.categories
        .filter((c) => c.bytes > 0)
        .map((c) => (
          <span key={c.id}>
            {systemText(c.label)} {fmtBytes(c.bytes)}
          </span>
        ))}
      <span className="flex-1" />
      {msg && <span className="text-emerald-600">{msg}</span>}
      <Button size="xs" variant="ghost" disabled={busy || !r.expiring} onClick={() => void run({ expired: true }, tr`删除 ${r.expiring} 个超过 ${r.expireDays} 天没动过、也没保存的用例？`)} title={tr`没保存的用例 ${r.expireDays} 天后也会自动清理`}>{tr("清理过期用例")}{r.expiring ? ` (${r.expiring})` : ''}
      </Button>
      <Button size="xs" variant="ghost" disabled={busy || !r.orphanOverlays} onClick={() => void run({ overlays: true }, tr`删除 ${r.orphanOverlays} 个中断的运行留下的隔离目录？`)} title={tr("中断的运行留在 /tmp 里的隔离 home（含配置副本）")}>{tr("清理残留目录")}{r.orphanOverlays ? ` (${r.orphanOverlays})` : ''}
      </Button>
      <Button size="xs" variant="ghost" disabled={busy} onClick={() => void run({ cache: true }, tr("清空解析缓存？（之后打开大会话会重新解析）"))}>{tr("清空解析缓存")}</Button>
    </div>
  );
}

/** All cases of this workspace: turns being debugged by replay. */
export function CasesPage() {
  useLocale();
  const { data, isLoading, error } = useCases();
  if (isLoading) return <div className="p-4"><Spinner label={tr("读取用例…")} /></div>;
  if (error) return <ErrorBox error={error} />;
  if (!data?.length) {
    return (
      <div className="flex h-full flex-col">
        <div className="min-h-0 flex-1">
          <Empty>
            <div className="max-w-md space-y-2 text-[13px]">
              <div className="font-medium text-zinc-700 dark:text-zinc-300">{tr("还没有用例")}</div>
              <div>{tr("在会话里找到执行不对的那一轮，点\"调试这一轮\"：会把会话到这一轮之前的部分拷一份，之后可以改 skill、输入或模型，回放这一轮并对比。")}</div>
            </div>
          </Empty>
        </div>
        <StorageBar />
      </div>
    );
  }
  return (
    <div className="flex h-full flex-col">
      <div className="min-h-0 flex-1 overflow-auto">
        <table className="w-full border-collapse text-[12.5px]">
          <thead className="sticky top-0 bg-zinc-50 text-left text-[11px] text-zinc-500 dark:bg-zinc-900">
            <tr>
              <th className="px-3 py-1.5 font-medium">{tr("用例")}</th>
              <th className="px-2 py-1.5 font-medium">{tr("会话 / 轮次")}</th>
              <th className="px-2 py-1.5 font-medium">{tr("检查")}</th>
              <th className="px-2 py-1.5 font-medium">{tr("回放")}</th>
              <th className="px-2 py-1.5 font-medium">{tr("更新")}</th>
            </tr>
          </thead>
          <tbody>
            {data.map((c) => (
              <tr key={c.id} className="border-t border-zinc-100 hover:bg-zinc-50 dark:border-zinc-800 dark:hover:bg-zinc-900/60">
                <td className="max-w-0 px-3 py-1.5">
                  <Link href={`/cases/${c.id}`} className="flex items-center gap-1.5">
                    <img src={AGENT_ICON[c.agent]} alt="" className="h-3.5 w-3.5 shrink-0" />
                    <span className="truncate font-medium text-indigo-700 hover:underline dark:text-indigo-300">{c.title}</span>
                    {c.saved && <Badge tone="green">{tr("已保存")}</Badge>}
                  </Link>
                </td>
                <td className="whitespace-nowrap px-2 py-1.5 font-mono text-[11px] text-zinc-500">
                  {shortId(c.threadId)}{tr` · 第${c.turnIndex + 1}轮`}</td>
                <td className="px-2 py-1.5 text-[11px] text-zinc-500">{c.checks.length}{tr("项")}</td>
                <td className="px-2 py-1.5 text-[11px] text-zinc-500">{c.replays ? tr`${c.replays} 次` : '–'}</td>
                <td className="whitespace-nowrap px-2 py-1.5 text-[11px] text-zinc-500">{relTime(c.lastReplayAt ?? c.updatedAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <StorageBar />
    </div>
  );
}

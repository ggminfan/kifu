import { useLocale } from '../../../shared/i18n/react';
import { localized, tr } from '../../../shared/i18n';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Link } from 'wouter';
import { postJson } from '../../lib/api';
import { fmtDuration, fmtTokens, relTime } from '../../lib/format';
import { useRuns, type RunRecord, type Variant } from '../../lib/labApi';
import { Badge, Button, ErrorBox, cx } from '../ui';

const STATUS: Record<RunRecord['status'], { label: string; tone: 'zinc' | 'sky' | 'green' | 'red' | 'amber' }> = localized({
  queued: { label: '排队', tone: 'zinc' },
  running: { label: '运行中', tone: 'sky' },
  completed: { label: '完成', tone: 'green' },
  failed: { label: '失败', tone: 'red' },
  cancelled: { label: '已取消', tone: 'amber' },
});

function LiveLog({ runId }: { runId: string }) {
  useLocale();
  const [lines, setLines] = useState<string[]>([]);
  useEffect(() => {
    const es = new EventSource(`/api/runs/${runId}/events`);
    const push = (s: string) => setLines((l) => [...l.slice(-80), s]);
    es.addEventListener('exec', (e) => {
      const ev = JSON.parse((e as MessageEvent).data) as { type: string; item?: { type: string; command?: string; text?: string; status?: string } };
      const it = ev.item;
      push(it ? `${ev.type} ${it.type}${it.command ? `: ${it.command}` : it.text ? `: ${it.text.slice(0, 80)}` : ''}` : ev.type);
    });
    es.addEventListener('log', (e) => push(`· ${(JSON.parse((e as MessageEvent).data) as { message: string }).message}`));
    es.addEventListener('status', (e) => push(tr`状态 → ${(JSON.parse((e as MessageEvent).data) as { status: string }).status}`));
    es.addEventListener('done', () => es.close());
    return () => es.close();
  }, [runId]);
  return <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded bg-zinc-950 p-2 font-mono text-[10.5px] text-zinc-200">{lines.join('\n') || tr("等待事件…")}</pre>;
}

function RunRow({ run, checked, onCheck }: { run: RunRecord; checked: boolean; onCheck: (v: boolean) => void }) {
  useLocale();
  const [open, setOpen] = useState(run.status === 'running');
  const s = run.result?.summary;
  const active = run.status === 'running' || run.status === 'queued';
  return (
    <div className="border-b border-zinc-100 px-2 py-1.5 dark:border-zinc-800">
      <div className="flex items-center gap-1.5 text-[12px]">
        <input type="checkbox" checked={checked} onChange={(e) => onCheck(e.target.checked)} disabled={!s} title={tr("选中两个进行对比")} />
        <button className="w-3 text-zinc-400" onClick={() => setOpen(!open)}>
          {open ? '▾' : '▸'}
        </button>
        <span className="font-medium">{run.label}</span>
        <Badge tone={STATUS[run.status].tone}>{STATUS[run.status].label}</Badge>
        {s && (s.skillLoaded ? <Badge tone="green" title={s.skillModes.join(', ')}>{tr("已加载 skill")}</Badge> : <Badge tone="red">{tr("未加载 skill")}</Badge>)}
        <span className="flex-1" />
        {s && (
          <span className="font-mono text-[11px] text-zinc-500">
            {s.calls}{tr("步 ·")}{tr`${s.tools} 个工具调用`}{s.toolErrors ? ` (${s.toolErrors}✗)` : ''} · {fmtTokens(s.usage.input)} in · {fmtDuration(run.result?.wallMs)}
          </span>
        )}
        {active && (
          <Button size="xs" variant="ghost" onClick={() => void postJson(`/runs/${run.id}/cancel`, {})}>{tr("取消")}</Button>
        )}
      </div>
      {open && (
        <div className="mt-1 space-y-1 pl-8 text-[11px]">
          <div className="text-zinc-500">
            {relTime(run.createdAt)} · {run.options.testType === 'content' ? tr("内容测试") : tr("触发测试")} · {{ readonly: tr("只读"), clone: tr("克隆"), inplace: tr("原地") }[run.options.isolation]}
            {run.options.model ? ` · ${run.options.model}` : ''}
            {run.threadId && (
              <>
                {' · '}
                <Link href={`/s/${run.threadId}`} className="text-indigo-600 hover:underline dark:text-indigo-400">{tr("打开 trace →")}</Link>
              </>
            )}
          </div>
          {active && <LiveLog runId={run.id} />}
          {run.error && <div className="text-red-600">{run.error}</div>}
          {run.result?.notes.map((n, i) => (
            <div key={i} className="text-amber-600">
              {n}
            </div>
          ))}
          {s?.finalAnswer && <div className="line-clamp-4 whitespace-pre-wrap rounded bg-zinc-50 p-1.5 dark:bg-zinc-900">{s.finalAnswer}</div>}
        </div>
      )}
    </div>
  );
}

export function RunPanel({
  skillKey,
  variants,
  variantId,
  defaults,
  selected,
  onSelected,
}: {
  skillKey: string;
  variants: Variant[];
  variantId?: string;
  defaults: { prompt?: string; cwd?: string; sessionRef?: string; gitSha?: string };
  selected: string[];
  onSelected: (refs: string[]) => void;
}) {
  useLocale();
  const qc = useQueryClient();
  const runs = useRuns(skillKey);
  const [prompt, setPrompt] = useState(defaults.prompt ?? '');
  const [cwd, setCwd] = useState(defaults.cwd ?? '');
  const [testType, setTestType] = useState<'trigger' | 'content'>('trigger');
  const [isolation, setIsolation] = useState<'readonly' | 'clone' | 'inplace'>('readonly');
  const [confirmInplace, setConfirmInplace] = useState(false);
  const [model, setModel] = useState('');
  const [repeats, setRepeats] = useState(1);
  const [withBaseline, setWithBaseline] = useState(true);
  const [allowMcp, setAllowMcp] = useState(false);
  const [error, setError] = useState<unknown>();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (defaults.prompt && !prompt) setPrompt(defaults.prompt);
    if (defaults.cwd && !cwd) setCwd(defaults.cwd);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [defaults.prompt, defaults.cwd]);

  const start = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const list: Array<string | null> = [];
      if (withBaseline) list.push(null);
      if (variantId) list.push(variantId);
      if (!list.length) throw new Error(tr("至少选择基线或一个变体"));
      await postJson('/runs', {
        skillKey,
        prompt,
        cwd,
        testType,
        isolation,
        confirmInplace,
        model,
        repeats,
        allowMcp,
        variants: list,
        sessionRef: defaults.sessionRef,
        gitSha: defaults.gitSha,
      });
      await qc.invalidateQueries({ queryKey: ['runs', skillKey] });
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  const toggle = (ref: string, v: boolean) => {
    const next = v ? [...selected.filter((x) => x !== ref), ref].slice(-2) : selected.filter((x) => x !== ref);
    onSelected(next);
  };
  const variantLabel = variants.find((v) => v.id === variantId)?.label;

  return (
    <div className="flex h-full flex-col">
      <div className="space-y-1.5 border-b border-zinc-200 p-2 text-[12px] dark:border-zinc-800">
        <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={4} placeholder={tr("发给 agent 的 prompt（默认取原会话第一条用户消息）")} className="w-full resize-y rounded border border-zinc-300 bg-white px-2 py-1 outline-none focus:border-indigo-500 dark:border-zinc-700 dark:bg-zinc-900" />
        <input value={cwd} onChange={(e) => setCwd(e.target.value)} placeholder={tr("工作目录")} className="w-full rounded border border-zinc-300 bg-white px-2 py-1 font-mono text-[11px] outline-none focus:border-indigo-500 dark:border-zinc-700 dark:bg-zinc-900" />
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <label className="flex items-center gap-1" title={tr("原样发送 prompt，看 agent 会不会自己加载这个 skill")}>
            <input type="radio" checked={testType === 'trigger'} onChange={() => setTestType('trigger')} />{tr("触发测试")}</label>
          <label className="flex items-center gap-1" title={tr`prompt 前加 /${skillKey} 强制加载，只测正文`}>
            <input type="radio" checked={testType === 'content'} onChange={() => setTestType('content')} />{tr("内容测试")}</label>
          <span className="text-zinc-300">|</span>
          {(['readonly', 'clone', 'inplace'] as const).map((iso) => (
            <label key={iso} className="flex items-center gap-1" title={{ readonly: tr("原目录 + 只读 sandbox（最安全）"), clone: tr("git clone --shared 到临时目录，可写"), inplace: tr("直接在原目录可写运行") }[iso]}>
              <input type="radio" checked={isolation === iso} onChange={() => setIsolation(iso)} />
              {{ readonly: tr("只读"), clone: tr("克隆"), inplace: tr("原地") }[iso]}
            </label>
          ))}
        </div>
        {isolation === 'inplace' && (
          <label className="flex items-center gap-1 text-amber-700 dark:text-amber-400">
            <input type="checkbox" checked={confirmInplace} onChange={(e) => setConfirmInplace(e.target.checked)} />{tr("我确认 agent 可以修改")}{cwd || tr("工作目录")}{tr("里的文件")}</label>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <input value={model} onChange={(e) => setModel(e.target.value)} placeholder={tr("模型（默认）")} className="w-32 rounded border border-zinc-300 bg-white px-2 py-0.5 text-[11px] dark:border-zinc-700 dark:bg-zinc-900" />
          <label className="flex items-center gap-1">{tr("重复")}<input type="number" min={1} max={5} value={repeats} onChange={(e) => setRepeats(Number(e.target.value))} className="w-12 rounded border border-zinc-300 bg-white px-1 py-0.5 text-[11px] dark:border-zinc-700 dark:bg-zinc-900" />{tr("次")}</label>
          <label className="flex items-center gap-1" title={tr("用零改动的隔离 home 跑一次，消除 hook / 环境差异")}>
            <input type="checkbox" checked={withBaseline} onChange={(e) => setWithBaseline(e.target.checked)} />{tr("基线 A′")}</label>
          <label className="flex items-center gap-1" title={tr("默认关闭 MCP 服务器，试跑不会碰外部系统")}>
            <input type="checkbox" checked={allowMcp} onChange={(e) => setAllowMcp(e.target.checked)} />{tr("允许外部工具（MCP）")}</label>
          <span className="text-zinc-500">{variantLabel ? tr`+ 变体 ${variantLabel}` : tr("（选择变体后可同时运行变体）")}</span>
          <span className="flex-1" />
          <Button variant="primary" onClick={start} disabled={busy || !prompt.trim() || !cwd.trim() || (isolation === 'inplace' && !confirmInplace)}>
            {busy ? tr("提交中…") : tr("开始运行")}
          </Button>
        </div>
        <div className="text-[10.5px] text-zinc-400">{tr("每次运行都会真实调用模型（用 agent 自己的登录和额度）；默认关闭 hook 和 MCP，结束后检查真实目录有没有被改动。")}</div>
        {error ? <ErrorBox error={error} /> : null}
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {defaults.sessionRef && (
          <label className="flex items-center gap-1.5 border-b border-zinc-100 px-2 py-1.5 text-[12px] dark:border-zinc-800">
            <input type="checkbox" checked={selected.includes(`session:${defaults.sessionRef}`)} onChange={(e) => toggle(`session:${defaults.sessionRef}`, e.target.checked)} />
            <span className="font-medium">A</span>
            <span className="text-zinc-500">{tr("原始会话（第 1 轮）")}</span>
            <Link href={`/s/${defaults.sessionRef}`} className="ml-auto text-[11px] text-indigo-600 hover:underline dark:text-indigo-400">{tr("打开 →")}</Link>
          </label>
        )}
        {runs.error && <ErrorBox error={runs.error} />}
        {runs.data?.map((r) => (
          <RunRow key={r.id} run={r} checked={selected.includes(`run:${r.id}`)} onCheck={(v) => toggle(`run:${r.id}`, v)} />
        ))}
        {!runs.data?.length && <div className={cx('p-3 text-[12px] text-zinc-500')}>{tr("还没有运行记录")}</div>}
      </div>
    </div>
  );
}

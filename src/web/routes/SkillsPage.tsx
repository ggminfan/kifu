import { getLocale, tr } from '../../shared/i18n';
import { useLocale } from '../../shared/i18n/react';
import { useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { Link, useLocation, useSearch } from 'wouter';
import type { SessionSummary } from '../../shared/api';
import { ComparePanel } from '../components/lab/ComparePanel';
import { PreviewPanel } from '../components/lab/PreviewPanel';
import { RunPanel } from '../components/lab/RunPanel';
import { SkillCatalog } from '../components/lab/SkillCatalog';
import { SkillWorkbench } from '../components/lab/SkillWorkbench';
import { useResizable } from '../components/Resizer';
import { Badge, Empty, Tabs } from '../components/ui';
import { api, useHealth, useTrace } from '../lib/api';
import { useCasesOfSkill } from '../lib/casesApi';
import { relTime, shortId } from '../lib/format';
import { useSkill } from '../lib/labApi';
import { SkillEvals, SkillSessions } from '../components/eval/SkillPanels';

type SideTab = 'preview' | 'run' | 'compare' | 'sessions' | 'evals' | 'cases';

/**
 * Skills of this workspace's agent (Codex, Claude Code): browse, edit
 * variants, preview the skill list (Codex), trial-run a prompt with and
 * without a variant (Codex), compare, apply; and the cases that check the
 * skill.
 */
export function SkillsPage() {
  useLocale();
  const search = useSearch();
  const [, navigate] = useLocation();
  const params = useMemo(() => new URLSearchParams(search), [search, getLocale()]);
  const skillKey = params.get('skill') ?? undefined;
  const variantId = params.get('v') ?? undefined;
  const sessionRef = params.get('session') ?? undefined;
  const left = useResizable('lab-catalog', 280, 200, 480, 'right');
  const right = useResizable('lab-side', 520, 360, 900, 'left');
  const agent = useHealth().data?.agent;
  // listing previews and trial runs need the agent's CLI (not Claude Code)
  const runnable = agent !== 'claude';
  const [tab, setTab] = useState<SideTab>('preview');
  // Claude Code: no listing preview, trial runs or evaluations (replays need Codex)
  const shown: SideTab = runnable || !['preview', 'run', 'compare', 'evals'].includes(tab) ? tab : 'sessions';
  const [cap, setCap] = useState<number>();
  const [compareRefs, setCompareRefs] = useState<string[]>([]);
  const skill = useSkill(skillKey);
  const session = useQuery({ queryKey: ['sessionSummary', sessionRef], queryFn: () => api<SessionSummary>(`/sessions/${sessionRef}`), enabled: Boolean(sessionRef) });
  const trace = useTrace(sessionRef);

  const setParam = (k: string, v: string | undefined) => {
    const p = new URLSearchParams(search);
    if (v) p.set(k, v);
    else p.delete(k);
    if (k === 'skill') p.delete('v');
    navigate(`/skills?${p}`);
  };

  const defaults = {
    prompt: trace.data?.turns[0]?.input?.preview ?? session.data?.firstUserMessage,
    cwd: trace.data?.meta.cwd ?? session.data?.cwd,
    sessionRef,
  };

  return (
    <div className="flex h-full min-h-0">
      <div style={{ width: left.width }} className="shrink-0 border-r border-zinc-200 dark:border-zinc-800">
        <SkillCatalog
          selected={skillKey}
          onSelect={(k) => {
            setCap(undefined);
            setCompareRefs([]);
            setParam('skill', k);
          }}
        />
      </div>
      {left.handle}
      <div className="min-w-0 flex-1">
        {skillKey ? (
          <SkillWorkbench skillKey={skillKey} variantId={variantId} onVariant={(id) => setParam('v', id)} cap={cap} />
        ) : (
          <Empty>
            <div className="max-w-md space-y-2 text-[13px]">
              <div className="font-medium text-zinc-700 dark:text-zinc-300">{tr("Skills：改 skill → 预览 → 试跑 → 对比 → 应用")}</div>
              <div>{tr("从左侧选择一个 skill，或从会话的\"技能\"面板带着原会话进来（会预填 prompt 和工作目录）。要验证改动在真实会话里的效果，用会话里的\"调试这一轮\"；在一批会话上比较改动前后，用 skill 的\"评测\"；把反复的澄清和共性做法沉淀成新 skill，点左上的\"从会话提炼新 skill\"。")}</div>
              <div className="text-[12px]">{tr("所有修改都保存在变体里，运行在隔离的 home 中，只有点\"应用\"才会写回真实 skill（自动备份、可撤销）。")}</div>
            </div>
          </Empty>
        )}
      </div>
      {skillKey && (
        <>
          {right.handle}
          <div style={{ width: right.width }} className="flex shrink-0 flex-col border-l border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
            <Tabs<SideTab>
              tabs={[
                ...(runnable
                  ? [
                      { id: 'preview' as const, label: tr("预览列表") },
                      { id: 'run' as const, label: tr("试跑") },
                      { id: 'compare' as const, label: tr`对比${compareRefs.length ? ` (${compareRefs.length})` : ''}` },
                    ]
                  : []),
                { id: 'sessions', label: tr("相关会话") },
                ...(runnable ? [{ id: 'evals' as const, label: tr("评测") }] : []),
                { id: 'cases', label: tr("用例") },
              ]}
              value={shown}
              onChange={setTab}
            />
            {sessionRef && (
              <div className="border-b border-zinc-200 px-2 py-1 text-[11px] text-zinc-500 dark:border-zinc-800">{tr("来自会话：")}<span className="font-mono">{shortId(sessionRef)}</span> {session.data?.title ?? ''}
              </div>
            )}
            <div className="min-h-0 flex-1 overflow-auto">
              {shown === 'preview' && <PreviewPanel skillKey={skillKey} variantId={variantId} prompt={defaults.prompt} cwd={defaults.cwd} onCap={setCap} />}
              {shown === 'run' && (
                <RunPanel
                  skillKey={skillKey}
                  variants={skill.data?.variants ?? []}
                  variantId={variantId}
                  defaults={defaults}
                  selected={compareRefs}
                  onSelected={(r) => {
                    setCompareRefs(r);
                    if (r.length === 2) setTab('compare');
                  }}
                />
              )}
              {shown === 'compare' && <ComparePanel skillKey={skillKey} refs={compareRefs} />}
              {shown === 'sessions' && <SkillSessions skillKey={skillKey} />}
              {shown === 'evals' && <SkillEvals skillKey={skillKey} />}
              {shown === 'cases' && <SkillCases skillKey={skillKey} />}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

/** Cases that check this skill, or replayed a variant of it. */
function SkillCases({ skillKey }: { skillKey: string }) {
  useLocale();
  const { data, isLoading } = useCasesOfSkill(skillKey);
  if (isLoading) return null;
  if (!data?.length) return <Empty>{tr("还没有和这个 skill 有关的用例。在会话里\"调试这一轮\"，再把检查项设成\"加载了 skill")}{skillKey}"。</Empty>;
  return (
    <div>
      {data.map((c) => (
        <Link key={c.id} href={`/cases/${c.id}`} className="block border-b border-zinc-100 px-2 py-1.5 hover:bg-zinc-50 dark:border-zinc-800 dark:hover:bg-zinc-900">
          <div className="flex items-center gap-1.5 text-[12px]">
            <span className="min-w-0 flex-1 truncate font-medium text-indigo-700 dark:text-indigo-300">{c.title}</span>
            {c.saved && <Badge tone="green">{tr("已保存")}</Badge>}
            <span className="shrink-0 text-[11px] text-zinc-500">{c.replays ? tr`${c.replays} 次回放` : tr("未回放")}</span>
          </div>
          <div className="mt-0.5 text-[11px] text-zinc-500">
            {shortId(c.threadId)}{tr` · 第${c.turnIndex + 1}轮 · `}{relTime(c.lastReplayAt ?? c.updatedAt)}
          </div>
        </Link>
      ))}
    </div>
  );
}

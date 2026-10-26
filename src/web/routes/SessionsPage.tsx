import { getLocale, tr } from '../../shared/i18n';
import { useLocale } from '../../shared/i18n/react';
import { useQuery } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useParams, useSearch } from 'wouter';
import { Inspector, type InspectorTab } from '../components/Inspector';
import { ProblemBar } from '../components/ProblemBar';
import { useResizable } from '../components/Resizer';
import { SessionSidebar } from '../components/SessionSidebar';
import { SkillsPanel } from '../components/SkillsPanel';
import { StepList } from '../components/StepList';
import { Timeline } from '../components/Timeline';
import { TraceHeader } from '../components/TraceHeader';
import { Empty, ErrorBox, Spinner } from '../components/ui';
import { api, useTrace } from '../lib/api';
import { createCase, useCase, useCuts, useProblems, type Problem } from '../lib/casesApi';

interface RunRef {
  id: string;
  kind?: 'lab' | 'replay';
  label: string;
  experiment: string;
  caseId?: string;
}

export function SessionsPage() {
  useLocale();
  const params = useParams<{ id?: string }>();
  const [, navigate] = useLocation();
  const id = params.id;
  const left = useResizable('sidebar', 300, 220, 520, 'right');
  const right = useResizable('inspector', 460, 320, 900, 'left');
  const { data: trace, isLoading, error } = useTrace(id);
  const run = useQuery({
    queryKey: ['runByThread', id],
    queryFn: () => api<RunRef | null>(`/runs/by-thread/${id}`),
    enabled: Boolean(id),
    retry: false,
    staleTime: 60_000,
  });
  const replayOf = useCase(run.data?.kind === 'replay' ? run.data.caseId : undefined);
  const problems = useProblems(trace ? id : undefined);
  const cuts = useCuts(trace ? id : undefined);
  const cutMap = useMemo(() => new Map((cuts.data ?? []).map((c) => [c.turnIndex, c])), [cuts.data, getLocale()]);
  const problemCalls = useMemo(() => {
    const m = new Map<number, 'fact' | 'heuristic'>();
    for (const p of problems.data ?? []) if (p.callIndex !== undefined && m.get(p.callIndex) !== 'fact') m.set(p.callIndex, p.certainty);
    return m;
  }, [problems.data, getLocale()]);
  const [debugBusy, setDebugBusy] = useState<number>();
  const [debugError, setDebugError] = useState<unknown>();
  // 本机 and SSH dev machines replay where they are
  const debugTurn = useCallback(
    async (turnIndex: number) => {
      if (!id) return;
      setDebugBusy(turnIndex);
      setDebugError(undefined);
      try {
        const c = await createCase(id, turnIndex);
        navigate(`/cases/${c.id}`);
      } catch (e) {
        setDebugError(e);
      } finally {
        setDebugBusy(undefined);
      }
    },
    [id, navigate],
  );

  const [callIndex, setCallIndex] = useState<number>();
  const [toolId, setToolId] = useState<string>();
  const [tab, setTab] = useState<InspectorTab>('context');
  const [scrollTo, setScrollTo] = useState<{ index: number; nonce: number }>();

  useEffect(() => {
    setCallIndex(undefined);
    setToolId(undefined);
    setDebugError(undefined);
  }, [id]);

  const open = useCallback((threadId: string) => navigate(`/s/${threadId}`), [navigate]);
  const selectCall = useCallback((i: number) => {
    setCallIndex(i);
    setToolId(undefined);
    setTab((t) => (t === 'tool' ? 'context' : t));
  }, []);
  const selectTool = useCallback((i: number, tid: string) => {
    setCallIndex(i);
    setToolId(tid);
    // the context tab with a tool selected is the relevance view: stay there
    setTab((t) => (t === 'context' ? t : 'tool'));
  }, []);
  const jump = useCallback((i: number, tid?: string) => {
    setCallIndex(i);
    setToolId(tid);
    setScrollTo({ index: i, nonce: Date.now() });
  }, []);
  // the selected step lives in the URL (/s/<id>?call=<n>&tool=<id>): deep links from cases and
  // reports land on it, and the desktop app reopens a tab where it was
  const search = useSearch();
  useEffect(() => {
    if (!trace) return;
    const q = new URLSearchParams(search);
    const call = q.get('call');
    if (call === null || !Number.isFinite(Number(call))) return;
    const tool = q.get('tool') ?? undefined;
    if (Number(call) === callIndex && tool === toolId) return;
    jump(Number(call), tool);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trace?.meta.threadId, search]);
  const urlFor = useRef(id);
  useEffect(() => {
    // switching sessions: the old selection is being reset, not chosen here
    if (urlFor.current !== id) {
      urlFor.current = id;
      return;
    }
    if (!id || callIndex === undefined) return;
    const q = new URLSearchParams(search);
    if (q.get('call') === String(callIndex) && (q.get('tool') ?? undefined) === toolId) return;
    q.set('call', String(callIndex));
    if (toolId) q.set('tool', toolId);
    else q.delete('tool');
    navigate(`/s/${id}?${q}`, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, callIndex, toolId]);
  // j / k: next / previous step; J / K: next / previous turn (not while typing)
  useEffect(() => {
    if (!trace) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || !['j', 'k', 'J', 'K'].includes(e.key)) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      const n = trace.calls.length;
      if (!n) return;
      e.preventDefault();
      let next: number | undefined;
      if (e.key === 'j' || e.key === 'k') {
        const cur = callIndex ?? (e.key === 'j' ? -1 : n);
        next = Math.max(0, Math.min(n - 1, cur + (e.key === 'j' ? 1 : -1)));
      } else {
        const turns = trace.turns.filter((x) => x.calls.length);
        const cur = callIndex === undefined ? (e.key === 'J' ? -1 : turns.length) : turns.findIndex((x) => x.calls.includes(callIndex));
        next = turns[Math.max(0, Math.min(turns.length - 1, cur + (e.key === 'J' ? 1 : -1)))]?.calls[0];
      }
      if (next === undefined) return;
      selectCall(next);
      setScrollTo({ index: next, nonce: Date.now() });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [trace, callIndex, selectCall]);
  // the session list folds away (narrow windows): a thin rail brings it back
  const [listOpen, setListOpen] = useState(() => {
    try {
      return localStorage.getItem('kifu.sessions.list') !== '0';
    } catch {
      return true;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem('kifu.sessions.list', listOpen ? '1' : '0');
    } catch {
      // storage unavailable
    }
  }, [listOpen]);
  const jumpToProblem = useCallback(
    (p: Problem) => {
      const call = p.callIndex ?? trace?.turns[p.turnIndex]?.calls[0];
      if (call !== undefined) jump(call, p.toolId);
    },
    [jump, trace],
  );

  return (
    <div className="flex h-full min-h-0">
      {listOpen ? (
        <>
          <div style={{ width: left.width }} className="shrink-0 border-r border-zinc-200 dark:border-zinc-800">
            <SessionSidebar selectedId={id} onOpen={open} onCollapse={() => setListOpen(false)} />
          </div>
          {left.handle}
        </>
      ) : (
        <button
          className="flex w-6 shrink-0 flex-col items-center gap-1 border-r border-zinc-200 bg-white pt-2 text-[11px] text-zinc-400 hover:bg-zinc-50 hover:text-zinc-700 dark:border-zinc-800 dark:bg-zinc-950 dark:hover:bg-zinc-900 dark:hover:text-zinc-200"
          onClick={() => setListOpen(true)}
          title={tr("展开会话列表")}
        >
          »<span className="[writing-mode:vertical-rl]">{tr("会话")}</span>
        </button>
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        {!id && <Empty>{tr("从左侧选择一个会话")}</Empty>}
        {id && isLoading && (
          <div className="p-4">
            <Spinner label={tr("解析 rollout…（大文件首次需要几秒）")} />
          </div>
        )}
        {id && error && <ErrorBox error={error} />}
        {trace && (
          <>
            <TraceHeader trace={trace} onOpenThread={open} />
            {run.data && run.data.kind !== 'replay' && (
              <div className="border-b border-indigo-200 bg-indigo-50 px-3 py-1 text-[11.5px] text-indigo-800 dark:border-indigo-900 dark:bg-indigo-950/40 dark:text-indigo-300">{tr("这是 Skills 页的试跑")}{run.data.label}（skill {run.data.experiment}）。{' '}
                <a className="underline" href={`/skills?skill=${encodeURIComponent(run.data.experiment)}`}>{tr("回到 Skills →")}</a>
              </div>
            )}
            {run.data?.kind === 'replay' && (
              <div className="border-b border-violet-200 bg-violet-50 px-3 py-1 text-[11.5px] text-violet-800 dark:border-violet-900 dark:bg-violet-950/40 dark:text-violet-300">{tr("这是用例")}{replayOf.data ? `「${replayOf.data.title ?? ''}」` : ''}{tr("的回放")}{run.data.label}{tr("，只显示回放自己的轮次。")}{' '}
                <Link className="underline" href={`/cases/${run.data.caseId}`}>{tr("回到用例 →")}</Link>
              </div>
            )}
            {problems.data && problems.data.length > 0 && (
              <ProblemBar problems={problems.data} onJump={jumpToProblem} onDebugTurn={debugTurn} canDebug={(t) => Boolean(cutMap.get(t)?.replayable)} />
            )}
            {debugError ? <ErrorBox error={debugError} /> : null}
            <Timeline
              trace={trace}
              problemCalls={problemCalls}
              selectedCall={callIndex}
              onSelect={(i, tid) => {
                if (tid) selectTool(i, tid);
                else selectCall(i);
                setScrollTo({ index: i, nonce: Date.now() });
              }}
            />
            <StepList
              sessionId={id!}
              trace={trace}
              selectedCall={callIndex}
              selectedTool={toolId}
              scrollToCall={scrollTo}
              onSelectCall={selectCall}
              onSelectTool={selectTool}
              onOpenThread={open}
              problems={problems.data}
              debug={cuts.data?.some((c) => c.replayable) && run.data?.kind !== 'replay' ? { cuts: cutMap, busy: debugBusy, onDebug: (t) => void debugTurn(t) } : undefined}
            />
          </>
        )}
      </div>
      {trace && (
        <>
          {right.handle}
          <div style={{ width: right.width }} className="shrink-0 border-l border-zinc-200 dark:border-zinc-800">
            <Inspector
              sessionId={id!}
              trace={trace}
              tab={tab}
              onTab={setTab}
              callIndex={callIndex}
              toolId={toolId}
              onOpenThread={open}
              onJump={jump}
              extraTabs={[{ id: 'skills', label: tr("技能") }]}
              renderExtra={(t) =>
                t === 'skills' ? (
                  <SkillsPanel sessionId={id!} onJump={jump} onDebugTurn={(ti) => void debugTurn(ti)} canDebug={(ti) => Boolean(cutMap.get(ti)?.replayable)} />
                ) : null
              }
            />
          </div>
        </>
      )}
    </div>
  );
}

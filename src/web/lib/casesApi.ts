import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import type { Problem } from '../../core/analysis/problems';
import type { AgentKind } from '../../shared/agents';
import type { AgentModel, CaseView, CheckResult, ReplayOptions, ReplayResult, TurnSummary } from '../../shared/replay';
import { api, postJson } from './api';

/* Cases, replays and the session page's problem list (server: routes/cases.ts, routes/analysis.ts). */

export type { Problem };

export interface TurnCutView {
  turnIndex: number;
  replayable: boolean;
  reasons: string[];
  warnings: string[];
}

export type RunStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'paused';

export interface ReplayRecord {
  kind: 'replay';
  id: string;
  caseId: string;
  arm: string;
  rep: number;
  label: string;
  /** A cell of this evaluation (not a replay started on the case page). */
  evalId?: string;
  status: RunStatus;
  prompt: string;
  options: ReplayOptions;
  threadId?: string;
  rollout?: string;
  bundle?: string;
  result?: ReplayResult;
  checks?: CheckResult[];
  error?: string;
  createdAt: number;
  finishedAt?: number;
}

export interface AgentInfo {
  agent: AgentKind;
  replayable: boolean;
  bin?: string;
  version?: string;
}

export const isActive = (s: RunStatus) => s === 'queued' || s === 'running';

export function useProblems(sessionId: string | undefined) {
  return useQuery({ queryKey: ['problems', sessionId], queryFn: () => api<Problem[]>(`/sessions/${sessionId}/problems`), enabled: Boolean(sessionId), staleTime: 30_000 });
}

export function useCuts(sessionId: string | undefined) {
  return useQuery({ queryKey: ['cuts', sessionId], queryFn: () => api<TurnCutView[]>(`/sessions/${sessionId}/cuts`), enabled: Boolean(sessionId), staleTime: 30_000 });
}

export function useAgentInfo() {
  return useQuery({ queryKey: ['agentInfo'], queryFn: () => api<AgentInfo>('/agent'), staleTime: 5 * 60_000 });
}

export function useModels(caseId: string | undefined) {
  return useQuery({ queryKey: ['models', caseId], queryFn: () => api<AgentModel[]>(`/agent/models${caseId ? `?case=${caseId}` : ''}`), staleTime: 5 * 60_000 });
}

export function useCases() {
  return useQuery({ queryKey: ['cases'], queryFn: () => api<CaseView[]>('/cases'), refetchInterval: 15_000 });
}

export function useCasesOfSkill(skillKey: string | undefined) {
  return useQuery({ queryKey: ['cases', 'skill', skillKey], queryFn: () => api<CaseView[]>(`/cases?skill=${encodeURIComponent(skillKey!)}`), enabled: Boolean(skillKey) });
}

export function useCase(id: string | undefined) {
  return useQuery({ queryKey: ['case', id], queryFn: () => api<CaseView>(`/cases/${id}`), enabled: Boolean(id) });
}

export function useOriginal(id: string | undefined) {
  return useQuery({
    queryKey: ['caseOriginal', id],
    queryFn: () => api<{ summary?: TurnSummary; checks: CheckResult[]; firstCall?: number }>(`/cases/${id}/original`),
    enabled: Boolean(id),
  });
}

export function useReplays(caseId: string | undefined) {
  return useQuery({
    queryKey: ['replays', caseId],
    queryFn: () => api<ReplayRecord[]>(`/cases/${caseId}/replays`),
    enabled: Boolean(caseId),
    refetchInterval: (q) => (q.state.data?.some((r) => isActive(r.status)) ? 2000 : false),
  });
}

export function createCase(sessionId: string, turnIndex: number): Promise<CaseView> {
  return postJson<CaseView>('/cases', { sessionId, turnIndex });
}

/** Live progress of a running replay (steps so far), from the run's event stream. */
export function useReplayProgress(runId: string, active: boolean): { steps?: number; log: string[] } {
  const [state, setState] = useState<{ steps?: number; log: string[] }>({ log: [] });
  useEffect(() => {
    if (!active) return;
    const es = new EventSource(`/api/runs/${runId}/events`);
    const push = (s: string) => setState((x) => ({ ...x, log: [...x.log.slice(-40), s] }));
    es.addEventListener('progress', (e) => setState((x) => ({ ...x, steps: (JSON.parse((e as MessageEvent).data) as { steps: number }).steps })));
    es.addEventListener('log', (e) => push((JSON.parse((e as MessageEvent).data) as { message: string }).message));
    es.addEventListener('exec', (e) => {
      const ev = JSON.parse((e as MessageEvent).data) as { type: string; item?: { type: string; command?: string; text?: string } };
      if (ev.item) push(`${ev.item.type}${ev.item.command ? `: ${ev.item.command}` : ev.item.text ? `: ${ev.item.text.slice(0, 80)}` : ''}`);
    });
    es.addEventListener('done', () => es.close());
    return () => es.close();
  }, [runId, active]);
  return state;
}

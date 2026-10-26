import { useQuery } from '@tanstack/react-query';
import type { Arm, CaseRole, CaseView, EvalOptions, EvalRecord, EvalReport, EvalSet, RubricItem } from '../../shared/replay';
import { api, postJson } from './api';
import type { ReplayRecord } from './casesApi';

/* Sets of cases and their evaluations (server: routes/evals.ts), and skill signals from the index. */

export interface SetMember {
  caseId: string;
  role: CaseRole;
  addedAt: number;
  case?: CaseView;
}

export type SetDetail = EvalSet & { members: SetMember[]; evals: EvalRecord[] };

export type ReportView = EvalReport & { titles: Record<string, string> };

export interface Judgment {
  scores: Record<string, number>;
  rationale: Record<string, string>;
  source: string;
}

export interface EvalRequestBody {
  name?: string;
  arms: Arm[];
  repeats: number;
  options: EvalOptions;
  rubric?: RubricItem[];
}

export interface Estimate {
  cells: number;
  tokens: number;
  judgeCalls: number;
}

export interface SignalSession {
  threadId: string;
  listed: boolean;
  loaded: boolean;
  missed: boolean;
  truncated: boolean;
  turnIndex?: number;
  relevance?: number;
  title?: string;
  updatedAt?: number;
  cwd?: string;
}

export type TurnStrategy = 'skill' | 'last' | 'first';

const live = (e: Pick<EvalRecord, 'status'> | undefined) => e?.status === 'running';

export function useEvalSets() {
  return useQuery({ queryKey: ['evalSets'], queryFn: () => api<EvalSet[]>('/eval-sets'), refetchInterval: 15_000 });
}

export function useEvalSet(id: string | undefined) {
  return useQuery({
    queryKey: ['evalSet', id],
    queryFn: () => api<SetDetail>(`/eval-sets/${id}`),
    enabled: Boolean(id),
    refetchInterval: (q) => (q.state.data?.evals.some(live) ? 3000 : false),
  });
}

export function useEvals(setId?: string) {
  return useQuery({
    queryKey: ['evals', setId ?? ''],
    queryFn: () => api<EvalRecord[]>(`/evals${setId ? `?set=${setId}` : ''}`),
    refetchInterval: (q) => (q.state.data?.some(live) ? 3000 : 30_000),
  });
}

export function useEval(id: string | undefined) {
  return useQuery({
    queryKey: ['eval', id],
    queryFn: () => api<EvalRecord>(`/evals/${id}`),
    enabled: Boolean(id),
    refetchInterval: (q) => (live(q.state.data) || (q.state.data?.judging ?? 0) > 0 ? 2000 : false),
  });
}

export function useEvalReport(id: string | undefined, running: boolean) {
  return useQuery({
    queryKey: ['evalReport', id],
    queryFn: () => api<ReportView>(`/evals/${id}/report`),
    enabled: Boolean(id),
    refetchInterval: running ? 3000 : false,
  });
}

export function useCellRuns(evalId: string | undefined, caseId: string | undefined, arm: string | undefined, running: boolean) {
  return useQuery({
    queryKey: ['evalCell', evalId, caseId, arm],
    queryFn: () => api<ReplayRecord[]>(`/evals/${evalId}/cells?case=${encodeURIComponent(caseId!)}&arm=${encodeURIComponent(arm!)}`),
    enabled: Boolean(evalId && caseId && arm),
    refetchInterval: running ? 3000 : false,
  });
}

/** Scores of an evaluation's runs; polled while judge calls are waiting or running (they run after their cells). */
export function useJudgments(evalId: string | undefined, enabled: boolean, busy: boolean) {
  return useQuery({
    queryKey: ['judgments', evalId],
    queryFn: () => api<Record<string, Judgment>>(`/evals/${evalId}/judgments`),
    enabled: Boolean(evalId) && enabled,
    refetchInterval: busy ? 4000 : false,
  });
}

export function useSkillSignals(key: string | undefined) {
  return useQuery({
    queryKey: ['skillSignals', key],
    queryFn: () => api<{ counts: Record<'listed' | 'loaded' | 'missed' | 'truncated', number>; sessions: SignalSession[] }>(`/skills/${encodeURIComponent(key!)}/signals`),
    enabled: Boolean(key),
    staleTime: 30_000,
  });
}

export function createSet(body: { name: string; skill?: string; note?: string }): Promise<EvalSet> {
  return postJson<EvalSet>('/eval-sets', body);
}

export function setFromSkill(skill: string): Promise<{ set: EvalSet; added: number; failed: Array<{ sessionId: string; error: string }> }> {
  return postJson('/eval-sets/from-skill', { skill });
}

export function resolveTurns(sessionIds: string[], strategy: TurnStrategy, skill?: string): Promise<Array<{ sessionId: string; turnIndex?: number; reason?: string }>> {
  return postJson('/eval-sets/resolve-turns', { sessionIds, strategy, skill });
}

export function addTurnsToSet(setId: string, items: Array<{ sessionId: string; turnIndex: number }>, role: CaseRole): Promise<{ added: string[]; failed: Array<{ sessionId: string; error: string }> }> {
  return postJson(`/eval-sets/${setId}/cases`, { items, role });
}

export function addCasesToSet(setId: string, caseIds: string[], role: CaseRole): Promise<unknown> {
  return postJson(`/eval-sets/${setId}/cases`, { caseIds, role });
}

export function estimateEval(setId: string, body: EvalRequestBody): Promise<Estimate> {
  return postJson<Estimate>(`/eval-sets/${setId}/estimate`, body);
}

export function startEval(setId: string, body: EvalRequestBody): Promise<EvalRecord> {
  return postJson<EvalRecord>(`/eval-sets/${setId}/evals`, body);
}

export function controlEval(id: string, action: 'pause' | 'resume' | 'cancel'): Promise<EvalRecord> {
  return postJson<EvalRecord>(`/evals/${id}/${action}`, {});
}

export const EVAL_STATUS: Record<EvalRecord['status'], { label: string; tone: 'sky' | 'amber' | 'green' | 'zinc' }> = {
  running: { label: '运行中', tone: 'sky' },
  paused: { label: '已暂停', tone: 'amber' },
  completed: { label: '完成', tone: 'green' },
  cancelled: { label: '已取消', tone: 'zinc' },
};

/** Above these a run asks for a deliberate confirmation (quota). */
export const STRONG_CONFIRM = { tokens: 2_000_000, cells: 20 };
export const MAX_CELLS = 200;

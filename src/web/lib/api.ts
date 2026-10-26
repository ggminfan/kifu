import { useQuery } from '@tanstack/react-query';
import type {
  CallContextResponse,
  ContextSeriesResponse,
  EvidenceResponse,
  SkillReportResponse,
  HealthResponse,
  SessionListResponse,
  SessionTreeNode,
  TextResponse,
  TraceResponse,
} from '../../shared/api';
import type { TextRef, ToolCall } from '../../shared/types';

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`/api${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', 'x-kifu': '1', ...(init.headers ?? {}) },
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new ApiError(body.error ?? res.statusText, res.status);
  }
  return (await res.json()) as T;
}

export function postJson<T>(path: string, body: unknown, method = 'POST'): Promise<T> {
  return api<T>(path, { method, body: JSON.stringify(body) });
}

export function useHealth() {
  return useQuery({ queryKey: ['health'], queryFn: () => api<HealthResponse>('/health'), staleTime: 60_000 });
}

export interface SessionFilters {
  q: string;
  sub: boolean;
  errors: boolean;
  skill?: string;
  /** Only sessions of this source (a Codex home, a Claude Code project). */
  src?: string;
  /** `<listed|loaded|missed|truncated>:<skill>`: sessions with that skill signal (index). */
  signal?: string;
  /** Sessions whose record file is gone: left out (exclude) or only those (only). */
  missing?: 'exclude' | 'only';
}

export function useSessions(f: SessionFilters, enabled = true) {
  return useQuery({
    queryKey: ['sessions', f],
    queryFn: () => {
      const p = new URLSearchParams({ q: f.q, sub: f.sub ? '1' : '0', limit: '400' });
      if (f.errors) p.set('errors', '1');
      if (f.skill) p.set('skill', f.skill);
      if (f.src) p.set('src', f.src);
      if (f.signal) p.set('signal', f.signal);
      if (f.missing) p.set('missing', f.missing);
      return api<SessionListResponse>(`/sessions?${p}`);
    },
    enabled,
    refetchInterval: 15_000,
  });
}

export function useIndexStatus() {
  return useQuery({
    queryKey: ['indexStatus'],
    queryFn: () => api<{ total: number; done: number; running: boolean; errors: number }>('/sessions/_index/status'),
    refetchInterval: (q) => (q.state.data?.running ? 2000 : 30_000),
  });
}

export function useSkillUsage() {
  return useQuery({ queryKey: ['skillUsage'], queryFn: () => api<Array<{ skill: string; sessions: number }>>('/skills/usage'), refetchInterval: 30_000 });
}

export function useTree(id: string | undefined) {
  return useQuery({
    queryKey: ['tree', id],
    queryFn: () => api<SessionTreeNode>(`/sessions/${id}/tree`),
    enabled: Boolean(id),
    staleTime: 30_000,
  });
}

export function useTrace(id: string | undefined) {
  return useQuery({
    queryKey: ['trace', id],
    queryFn: () => api<TraceResponse>(`/sessions/${id}/trace`),
    enabled: Boolean(id),
    staleTime: 30_000,
  });
}

/** Every step's input by category; `steps` (the trace's call count) refetches it as a live session grows. */
export function useContextSeries(id: string | undefined, steps: number | undefined) {
  return useQuery({
    queryKey: ['contextSeries', id, steps],
    queryFn: () => api<ContextSeriesResponse>(`/sessions/${id}/context-series`),
    enabled: Boolean(id) && steps !== undefined,
    staleTime: Infinity,
    placeholderData: (prev) => prev,
  });
}

export function useCallContext(id: string | undefined, callIndex: number | undefined) {
  return useQuery({
    queryKey: ['context', id, callIndex],
    queryFn: () => api<CallContextResponse>(`/sessions/${id}/calls/${callIndex}/context`),
    enabled: Boolean(id) && callIndex !== undefined,
    staleTime: Infinity,
  });
}

/** A tool call in full (the trace only has briefs): arguments, output, inner events with their output. */
export function useTool(id: string | undefined, toolId: string | undefined) {
  return useQuery({
    queryKey: ['tool', id, toolId],
    queryFn: () => api<ToolCall>(`/sessions/${id}/tools/${encodeURIComponent(toolId!)}`),
    enabled: Boolean(id) && Boolean(toolId),
    staleTime: Infinity,
  });
}

export function textUrl(sessionId: string, ref: TextRef): string {
  const p = new URLSearchParams({ line: String(ref.line), ptr: ref.ptr });
  if (ref.json) p.set('json', ref.json);
  return `/sessions/${sessionId}/text?${p}`;
}

export function fetchText(sessionId: string, ref: TextRef): Promise<TextResponse> {
  return api<TextResponse>(textUrl(sessionId, ref));
}

export function useRaw(sessionId: string | undefined, line: number | undefined) {
  return useQuery({
    queryKey: ['raw', sessionId, line],
    queryFn: () => api<TextResponse>(`/sessions/${sessionId}/raw?line=${line}`),
    enabled: Boolean(sessionId) && line !== undefined,
    staleTime: Infinity,
  });
}

export function blobUrl(sessionId: string, blobId: string): string {
  const [, line, k] = blobId.split(':');
  return `/api/sessions/${sessionId}/blob/${line}/${k}`;
}

export function useSkillReport(id: string | undefined) {
  return useQuery({
    queryKey: ['skills', id],
    queryFn: () => api<SkillReportResponse>(`/sessions/${id}/skills`),
    enabled: Boolean(id),
    staleTime: 30_000,
  });
}

export function useEvidence(id: string | undefined, toolId: string | undefined) {
  return useQuery({
    queryKey: ['evidence', id, toolId],
    queryFn: () => api<EvidenceResponse>(`/sessions/${id}/tools/${encodeURIComponent(toolId!)}/evidence`),
    enabled: Boolean(id) && Boolean(toolId),
    staleTime: Infinity,
  });
}

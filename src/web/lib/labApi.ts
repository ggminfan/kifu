import { useQuery } from '@tanstack/react-query';
import { api } from './api';

/* Types mirrored from the server services (kept loose on purpose). */

export interface CatalogSkill {
  key: string;
  name: string;
  source: 'user' | 'agents' | 'system' | 'plugin';
  plugin?: string;
  marketplace?: string;
  dir: string;
  realDir: string;
  file: string;
  description?: string;
  descriptionChars: number;
  hash: string;
  mtimeMs: number;
  lines: number;
  writable: boolean;
  shadowedBy?: string;
  sessionsUsed: number;
  variants: number;
}

export interface Variant {
  id: string;
  skillKey: string;
  skillName: string;
  originalPath: string;
  baseHash: string;
  label: string;
  note?: string;
  createdAt: number;
  updatedAt: number;
  dir: string;
}

export interface VariantDetail extends Variant {
  raw: string;
  description?: string;
  body: string;
  baseRaw?: string;
  baseChanged: boolean;
  applies?: Array<{ id: string; createdAt: number; undoneAt?: number; target: string }>;
}

export interface SkillEntry {
  name: string;
  description: string;
  file?: string;
  path?: string;
}

export interface SkillLine {
  entry?: SkillEntry;
  full?: string;
  truncated: boolean | null;
  hiddenTail?: string;
  snapshot: { format?: string; count: number; cap?: number; entries: SkillEntry[]; budgetParity: boolean };
}

export interface PreviewResult {
  skill: string;
  base: SkillLine;
  variant?: SkillLine & { name: string };
  othersChanged: Array<{ name: string; before?: string; after?: string }>;
  ms: number;
}

export interface ExecSummary {
  threadId: string;
  turns: number;
  calls: number;
  tools: number;
  toolErrors: number;
  failedCommands: number;
  usage: { input: number; cached: number; output: number; reasoning: number; total: number; cacheWrite: number };
  durationMs: number;
  ttftMs?: number;
  skillLoaded: boolean;
  skillModes: string[];
  firstSkillCall?: number;
  skillLines: Array<[number, number]>;
  otherSkills: string[];
  finalAnswer?: string;
  toolSeq: string[];
}

export interface RunRecord {
  id: string;
  experiment: string;
  variantId?: string;
  label: string;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
  prompt: string;
  options: {
    skillKey: string;
    variantId?: string;
    prompt: string;
    testType: 'trigger' | 'content';
    isolation: 'readonly' | 'clone' | 'inplace';
    cwd: string;
    model?: string;
    sessionRef?: string;
  };
  threadId?: string;
  rollout?: string;
  result?: {
    exitCode: number | null;
    wallMs: number;
    summary?: ExecSummary;
    guard?: { added: string[]; removed: string[]; changed: string[] };
    authLinked: boolean;
    budgetParity: boolean;
    notes: string[];
    stderrTail?: string;
  };
  error?: string;
  createdAt: number;
  finishedAt?: number;
}

export interface CompareSide {
  ref: string;
  label: string;
  summary?: ExecSummary;
  threadId?: string;
}

export interface CompareResponse {
  left: CompareSide;
  right: CompareSide;
  alignment?: { rows: Array<{ a?: string; b?: string; same: boolean }>; firstDivergence?: number; similarity: number };
}

export function useCatalog() {
  return useQuery({ queryKey: ['catalog'], queryFn: () => api<CatalogSkill[]>('/skills'), staleTime: 10_000 });
}

export function useSkill(key: string | undefined) {
  return useQuery({
    queryKey: ['skill', key],
    queryFn: () => api<{ skill: CatalogSkill; raw: string; variants: Variant[] }>(`/skills/${encodeURIComponent(key!)}`),
    enabled: Boolean(key),
  });
}

export function useVariant(id: string | undefined) {
  return useQuery({ queryKey: ['variant', id], queryFn: () => api<VariantDetail>(`/variants/${id}`), enabled: Boolean(id) });
}

export function useRuns(experiment: string | undefined) {
  return useQuery({
    queryKey: ['runs', experiment],
    queryFn: () => api<RunRecord[]>(`/runs?experiment=${encodeURIComponent(experiment!)}`),
    enabled: Boolean(experiment),
    refetchInterval: (q) => (q.state.data?.some((r) => r.status === 'running' || r.status === 'queued') ? 2000 : false),
  });
}

export function useCompare(skill: string | undefined, left?: string, right?: string) {
  return useQuery({
    queryKey: ['compare', skill, left, right],
    queryFn: () => api<CompareResponse>(`/compare?skill=${encodeURIComponent(skill!)}&left=${encodeURIComponent(left!)}&right=${encodeURIComponent(right!)}`),
    enabled: Boolean(skill && left && right),
  });
}

export function useEvaluation(left?: string, right?: string) {
  return useQuery({
    queryKey: ['evaluation', left, right],
    queryFn: () => api<{ id: string; verdict: string; note?: string } | null>(`/evaluations?left=${encodeURIComponent(left!)}&right=${encodeURIComponent(right!)}`),
    enabled: Boolean(left && right),
  });
}

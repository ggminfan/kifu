import { tr } from '../../shared/i18n';
import { useQuery } from '@tanstack/react-query';
import type { MineResult } from '../../core/distill/mine';
import type { Arm, EvalSet } from '../../shared/replay';
import { api, postJson } from './api';
import type { Variant } from './labApi';

/* Distilling a skill from sessions (server: routes/distill.ts). */

export type Mined = MineResult & { titles: Record<string, string> };

export interface DraftEvidence {
  session: string;
  turn: number;
  quote: string;
  sessionId?: string;
  verified: boolean;
}

export interface Draft {
  name: string;
  description: string;
  triggers: { positive: string[]; negative: string[] };
  steps: string[];
  clarifications: Array<{ question: string; answer: string }>;
  pitfalls: string[];
  evidence: DraftEvidence[];
  body: string;
}

export interface DraftJob {
  id: string;
  sessionIds: string[];
  status: 'running' | 'completed' | 'failed';
  startedAt: number;
  finishedAt?: number;
  draft?: Draft;
  usage?: { input_tokens?: number; cached_input_tokens?: number; output_tokens?: number };
  error?: string;
}

export interface DraftCheck {
  name: { ok: boolean; message?: string };
  listing?: {
    visible?: string;
    hiddenTail?: string;
    truncated: boolean | null;
    cap?: number;
    count: number;
    budgetParity: boolean;
    othersChanged: Array<{ name: string; before?: string; after?: string }>;
  };
  triggers: Array<{ text: string; where: 'visible' | 'hidden' | 'missing' }>;
  error?: string;
}

export function useMined(sessionIds: string[]) {
  return useQuery({
    queryKey: ['distillMine', sessionIds.join(',')],
    queryFn: () => postJson<Mined>('/distill/mine', { sessionIds }),
    enabled: sessionIds.length > 0,
    staleTime: 60_000,
  });
}

export function useDraftJob(id: string | undefined) {
  return useQuery({
    queryKey: ['draftJob', id],
    queryFn: () => api<DraftJob>(`/distill/drafts/${id}`),
    enabled: Boolean(id),
    refetchInterval: (q) => (q.state.data?.status === 'running' ? 1500 : false),
  });
}

export function startDraft(sessionIds: string[], hint?: string): Promise<DraftJob> {
  return postJson<DraftJob>('/distill/drafts', { sessionIds, hint });
}

export function checkDraft(d: { name: string; description: string; body: string; triggers: string[] }): Promise<DraftCheck> {
  return postJson<DraftCheck>('/distill/check', d);
}

export function saveDraft(d: { name: string; description: string; body: string; note?: string }): Promise<Variant> {
  return postJson<Variant>('/distill/variants', d);
}

export function draftSet(variantId: string, sessionIds: string[]): Promise<{ set: EvalSet; added: number; failed: Array<{ sessionId: string; error: string }>; arms: Arm[] }> {
  return postJson('/distill/eval-set', { variantId, sessionIds });
}

/** A skill's SKILL.md body template for writing one by hand. */
export const BLANK_BODY = tr("# 名称\n\n## 步骤\n\n1. \n\n## 默认做法（不用再问）\n\n- 问题 → 默认答案\n\n## 注意\n\n- \n");

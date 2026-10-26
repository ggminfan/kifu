import { Hono } from 'hono';
import { checkDraft, draftJob, draftSet, mine, MAX_SOURCES, saveDraft, startDraft } from '../services/distill';
import { NotFound } from '../services/sessions';

/** Distilling a skill from sessions (the /skills/new page). */
export const distillRoutes = new Hono();

const ids = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.length > 0).slice(0, MAX_SOURCES) : []);

/** Shared paths, repeated clarifications and the closest skills (rules, no model). */
distillRoutes.post('/mine', async (c) => {
  const body = (await c.req.json()) as { sessionIds?: unknown };
  const sessionIds = ids(body.sessionIds);
  if (!sessionIds.length) return c.json({ error: '需要至少一个会话' }, 400);
  return c.json(await mine(sessionIds));
});

/** A draft written by the workspace's agent (a job: poll it). */
distillRoutes.post('/drafts', async (c) => {
  const body = (await c.req.json()) as { sessionIds?: unknown; hint?: string };
  const sessionIds = ids(body.sessionIds);
  if (!sessionIds.length) return c.json({ error: '需要至少一个会话' }, 400);
  return c.json(await startDraft(sessionIds, typeof body.hint === 'string' ? body.hint.slice(0, 2000) : undefined));
});

distillRoutes.get('/drafts/:id', (c) => {
  const job = draftJob(c.req.param('id'));
  if (!job) throw new NotFound('草稿任务不存在');
  return c.json(job);
});

/** Name, and the skill listing with the draft mounted (no model call). */
distillRoutes.post('/check', async (c) => {
  const body = (await c.req.json()) as { name?: string; description?: string; body?: string; triggers?: string[] };
  return c.json(await checkDraft({ name: String(body.name ?? '').trim(), description: String(body.description ?? ''), body: String(body.body ?? ''), triggers: Array.isArray(body.triggers) ? body.triggers.map(String).slice(0, 12) : [] }));
});

/** Save the draft as a brand-new skill variant (not installed). */
distillRoutes.post('/variants', async (c) => {
  const body = (await c.req.json()) as { name?: string; description?: string; body?: string; note?: string };
  return c.json(await saveDraft({ name: String(body.name ?? '').trim(), description: String(body.description ?? ''), body: String(body.body ?? ''), note: body.note }));
});

/** An evaluation set for the new skill: its sources as positives, unrelated sessions as negatives. */
distillRoutes.post('/eval-set', async (c) => {
  const body = (await c.req.json()) as { variantId?: string; sessionIds?: unknown; negatives?: number };
  if (!body.variantId) return c.json({ error: '需要 variantId' }, 400);
  return c.json(await draftSet(body.variantId, ids(body.sessionIds), { negatives: Math.max(0, Math.min(10, Number(body.negatives ?? 4) || 0)) }));
});

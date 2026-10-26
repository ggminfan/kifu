import fs from 'node:fs/promises';
import path from 'node:path';
import { Hono } from 'hono';
import { evaluateChecks } from '../../core/eval/checks';
import type { CheckDef, Workspace } from '../../shared/replay';
import { dataPaths } from '../config';
import { adapterFor } from '../replay/adapter';
import { caseEntry, caseView, createCase, getCase, homeFor, listCases, mustGetCase, originalSummary, updateCase } from '../replay/cases';
import { cleanup, removeCase, storageReport } from '../replay/storage';
import { createReplays, DEFAULT_MAX_STEPS, estimateTokens, type ReplayRequest } from '../replay/engine';
import { cancelRun, deleteRunRecord, getRun, listReplays, saveRun } from '../services/runner';
import { getParsed, readText } from '../services/parseCache';
import { NotFound, unregisterRollout } from '../services/sessions';
import { currentAgent, sources } from '../sources/registry';

/** Cases (turn K of a session) and their replays. */
export const caseRoutes = new Hono();
/** The agent CLI of this workspace: availability and models (for the replay pickers). */
export const agentRoutes = new Hono();

const WORKSPACES: Workspace[] = ['readonly', 'clone', 'empty'];

function replayRequest(body: Record<string, unknown>): ReplayRequest {
  const arms = Array.isArray(body.arms) ? (body.arms as Array<{ label?: unknown; variantIds?: unknown }>) : [];
  return {
    arms: arms.map((a, i) => ({
      label: typeof a.label === 'string' && a.label.trim() ? a.label.trim().slice(0, 40) : i === 0 ? 'A′' : `B${i}`,
      variantIds: Array.isArray(a.variantIds) ? a.variantIds.filter((v): v is string => typeof v === 'string') : [],
    })),
    repeats: Number(body.repeats ?? 1),
    prompt: typeof body.prompt === 'string' && body.prompt.trim() ? body.prompt : undefined,
    model: typeof body.model === 'string' ? body.model : undefined,
    effort: typeof body.effort === 'string' ? body.effort : undefined,
    maxSteps: body.maxSteps === undefined ? DEFAULT_MAX_STEPS : Number(body.maxSteps),
    workspace: WORKSPACES.includes(body.workspace as Workspace) ? (body.workspace as Workspace) : 'readonly',
    allowMcp: body.allowMcp === true,
  };
}

caseRoutes.get('/', (c) => {
  // ?skill=<key>: cases that check the skill or replayed a variant of it
  const skill = c.req.query('skill');
  const short = (s: string) => s.split(':').pop()!;
  const about = (x: ReturnType<typeof listCases>[number]) =>
    !skill ||
    x.checks.some((d) => (d.kind === 'skill_loaded' || d.kind === 'skill_not_loaded') && (d.skill === skill || short(d.skill) === short(skill))) ||
    listReplays(x.id).some((r) => r.options.frozenVariants.some((v) => v.skillKey === skill));
  return c.json(listCases().filter(about).map((x) => caseView(x)));
});

caseRoutes.post('/', async (c) => {
  const body = (await c.req.json()) as { sessionId?: string; turnIndex?: number };
  if (!body.sessionId || typeof body.turnIndex !== 'number') return c.json({ error: '需要 sessionId 和 turnIndex' }, 400);
  const created = await createCase(body.sessionId, body.turnIndex);
  return c.json(caseView(created, await originalSummary(created)));
});

caseRoutes.get('/:id', async (c) => {
  const x = mustGetCase(c.req.param('id'));
  return c.json(caseView(x, await originalSummary(x)));
});

caseRoutes.patch('/:id', async (c) => {
  const body = (await c.req.json()) as { title?: string; prompt?: string; checks?: CheckDef[]; saved?: boolean };
  const x = updateCase(c.req.param('id'), { title: body.title, prompt: body.prompt, checks: Array.isArray(body.checks) ? body.checks : undefined, saved: body.saved });
  // checks changed: judge the finished replays again
  if (Array.isArray(body.checks)) {
    for (const r of listReplays(x.id)) {
      if (r.status !== 'completed' || !r.rollout || !r.result?.prefixLines) continue;
      try {
        const entry = await getParsed(r.rollout, { prefixEnd: r.result.prefixLines });
        const last = entry.trace.turns[entry.trace.turns.length - 1]?.lastAgentMessage;
        const answer = last?.ref ? (await readText(entry, last.ref)).text : last?.preview;
        r.checks = evaluateChecks(entry.trace, x.checks, { stoppedAtMax: r.result.stoppedAtMax, answer });
        saveRun(r);
      } catch {
        // the transcript may be gone; keep the old results
      }
    }
  }
  return c.json(caseView(x, await originalSummary(x)));
});

caseRoutes.delete('/:id', async (c) => {
  mustGetCase(c.req.param('id'));
  await removeCase(c.req.param('id'));
  return c.json({ ok: true });
});

/** The case's checks on the original turn K (what the replays are measured against). */
caseRoutes.get('/:id/original', async (c) => {
  const x = mustGetCase(c.req.param('id'));
  const entry = await caseEntry(x);
  const last = entry.trace.turns[x.turnIndex]?.lastAgentMessage;
  const answer = last?.ref ? (await readText(entry, last.ref)).text : last?.preview;
  return c.json({
    summary: await originalSummary(x),
    checks: evaluateChecks(entry.trace, x.checks, { from: x.turnIndex, to: x.turnIndex + 1, answer }),
    firstCall: entry.trace.turns[x.turnIndex]?.calls[0],
  });
});

caseRoutes.get('/:id/replays', (c) => {
  mustGetCase(c.req.param('id'));
  return c.json(listReplays(c.req.param('id')));
});

caseRoutes.post('/:id/estimate', async (c) => {
  const x = mustGetCase(c.req.param('id'));
  return c.json(estimateTokens(x, replayRequest((await c.req.json()) as Record<string, unknown>)));
});

caseRoutes.post('/:id/replays', async (c) => {
  const id = c.req.param('id');
  const runs = await createReplays(id, replayRequest((await c.req.json()) as Record<string, unknown>));
  return c.json(runs);
});

caseRoutes.delete('/:id/replays/:runId', async (c) => {
  const r = getRun(c.req.param('runId'));
  if (!r || r.kind !== 'replay' || r.caseId !== c.req.param('id')) throw new NotFound('回放不存在');
  cancelRun(r.id);
  if (r.threadId) unregisterRollout(r.threadId);
  deleteRunRecord(r.id);
  await fs.rm(path.join(dataPaths.runs, path.basename(r.id)), { recursive: true, force: true });
  return c.json({ ok: true });
});

// ------------------------------------------------------------------ storage

/** Disk use of debugging, and cleanup. */
export const maintenanceRoutes = new Hono();

maintenanceRoutes.get('/storage', async (c) => c.json(await storageReport()));

maintenanceRoutes.post('/cleanup', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { expired?: boolean; overlays?: boolean; cache?: boolean };
  return c.json(await cleanup({ expired: body.expired === true, overlays: body.overlays === true, cache: body.cache === true }));
});

// ------------------------------------------------------------------ agent

let modelCache: { at: number; key: string; list: unknown } | undefined;

agentRoutes.get('/', async (c) => {
  const agent = currentAgent();
  const a = adapterFor(agent);
  const bin = a?.bin();
  return c.json({ agent, replayable: Boolean(a), bin, version: bin ? await a!.version() : undefined });
});

agentRoutes.get('/models', async (c) => {
  const agent = currentAgent();
  const a = adapterFor(agent);
  if (!a?.bin()) return c.json([]);
  const caseId = c.req.query('case');
  const x = caseId ? getCase(caseId) : undefined;
  const homes = (x && homeFor(x, () => undefined)) ?? sources().find((s) => s.agent === agent);
  if (!homes) return c.json([]);
  const key = `${agent}:${homes.home}`;
  if (!modelCache || modelCache.key !== key || Date.now() - modelCache.at > 5 * 60_000) {
    modelCache = { at: Date.now(), key, list: await a.models({ home: homes.home, dataRoot: homes.dataRoot }) };
  }
  return c.json(modelCache.list);
});

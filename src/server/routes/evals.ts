import { Hono } from 'hono';
import type { Arm, CaseRole, EvalOptions, RubricItem, Workspace } from '../../shared/replay';
import { caseView } from '../replay/cases';
import {
  addCases,
  addTurns,
  cancelEval,
  cellRuns,
  createEval,
  createSet,
  deleteEval,
  deleteSet,
  estimateEval,
  evalReport,
  getSet,
  judgmentsOf,
  listEvals,
  listSets,
  mustGetEval,
  pauseEval,
  rejudge,
  removeFromSet,
  resolveTurns,
  resumeEval,
  rubricHash,
  saveJudgment,
  setCases,
  setFromSkill,
  setRole,
  updateSet,
  type TurnStrategy,
} from '../replay/evals';
import { catalog } from '../services/catalog';
import { NotFound } from '../services/sessions';

/** Sets of cases and their evaluations (the 评测 page). */
export const evalSetRoutes = new Hono();
export const evalRoutes = new Hono();

const ROLES: CaseRole[] = ['positive', 'negative', 'control'];
const role = (v: unknown): CaseRole => (ROLES.includes(v as CaseRole) ? (v as CaseRole) : 'positive');

function evalRequest(body: Record<string, unknown>) {
  const o = (body.options ?? {}) as Partial<EvalOptions>;
  const arms = (Array.isArray(body.arms) ? body.arms : []) as Array<{ label?: string; variantIds?: unknown }>;
  return {
    name: typeof body.name === 'string' ? body.name : undefined,
    arms: arms.map((a, i): Arm => ({ label: (a.label ?? '').trim().slice(0, 40) || (i === 0 ? 'A′' : `B${i}`), variantIds: Array.isArray(a.variantIds) ? a.variantIds.filter((v): v is string => typeof v === 'string') : [] })),
    repeats: Number(body.repeats ?? 1),
    options: {
      maxSteps: Number(o.maxSteps ?? 30),
      model: o.model || undefined,
      effort: o.effort || undefined,
      workspace: (['readonly', 'clone', 'empty'] as Workspace[]).includes(o.workspace as Workspace) ? (o.workspace as Workspace) : 'readonly',
      allowMcp: o.allowMcp === true,
      judge: o.judge === true,
    } satisfies EvalOptions,
    rubric: Array.isArray(body.rubric) ? (body.rubric as RubricItem[]).map((r, i) => ({ id: String(r.id || `r${i + 1}`).replace(/[^\w-]/g, '').slice(0, 24) || `r${i + 1}`, text: String(r.text ?? '').slice(0, 300) })) : undefined,
  };
}

function mustSet(id: string) {
  const s = getSet(id);
  if (!s) throw new NotFound('评测集不存在');
  return s;
}

evalSetRoutes.get('/', (c) => c.json(listSets()));

evalSetRoutes.post('/', async (c) => {
  const body = (await c.req.json()) as { name?: string; skill?: string; note?: string };
  return c.json(createSet({ name: body.name ?? '评测集', skill: body.skill, note: body.note }));
});

/** A set for a skill from the index: positives, negatives, and controls from its closest neighbours. */
evalSetRoutes.post('/from-skill', async (c) => {
  const body = (await c.req.json()) as { skill?: string; positives?: number; negatives?: number; controls?: number };
  if (!body.skill) return c.json({ error: '需要 skill' }, 400);
  const clamp = (n: unknown, d: number) => Math.max(0, Math.min(20, Number(n ?? d) || 0));
  const r = await setFromSkill(
    body.skill,
    catalog().filter((s) => !s.shadowedBy),
    { positives: clamp(body.positives, 8), negatives: clamp(body.negatives, 4), controls: clamp(body.controls, 3) },
  );
  return c.json(r);
});

/** Which turn of each session to take (any workspace: a remote one resolves before handing over). */
evalSetRoutes.post('/resolve-turns', async (c) => {
  const body = (await c.req.json()) as { sessionIds?: string[]; strategy?: TurnStrategy; skill?: string };
  const strategy: TurnStrategy = body.strategy === 'first' || body.strategy === 'skill' ? body.strategy : 'last';
  return c.json(await resolveTurns((body.sessionIds ?? []).slice(0, 100), strategy, body.skill));
});

evalSetRoutes.get('/:id', (c) => {
  const set = mustSet(c.req.param('id'));
  return c.json({
    ...set,
    members: setCases(set.id).map((m) => ({ caseId: m.caseId, role: m.role, addedAt: m.addedAt, case: m.case ? caseView(m.case) : undefined })),
    evals: listEvals(set.id),
  });
});

evalSetRoutes.patch('/:id', async (c) => {
  mustSet(c.req.param('id'));
  const body = (await c.req.json()) as { name?: string; skill?: string | null; note?: string };
  return c.json(updateSet(c.req.param('id'), body));
});

evalSetRoutes.delete('/:id', async (c) => {
  mustSet(c.req.param('id'));
  await deleteSet(c.req.param('id'));
  return c.json({ ok: true });
});

/** Add existing cases, or new ones from (session, turn) pairs. */
evalSetRoutes.post('/:id/cases', async (c) => {
  const set = mustSet(c.req.param('id'));
  const body = (await c.req.json()) as { caseIds?: string[]; items?: Array<{ sessionId: string; turnIndex: number }>; role?: string };
  if (body.caseIds?.length) addCases(set.id, body.caseIds.map((caseId) => ({ caseId, role: role(body.role) })));
  const turns = body.items?.length ? await addTurns(set.id, body.items.slice(0, 100), role(body.role)) : { added: [], failed: [] };
  return c.json(turns);
});

evalSetRoutes.patch('/:id/cases/:caseId', async (c) => {
  const body = (await c.req.json()) as { role?: string };
  setRole(c.req.param('id'), c.req.param('caseId'), role(body.role));
  return c.json({ ok: true });
});

evalSetRoutes.delete('/:id/cases/:caseId', (c) => {
  removeFromSet(c.req.param('id'), c.req.param('caseId'));
  return c.json({ ok: true });
});

evalSetRoutes.post('/:id/estimate', async (c) => {
  const set = mustSet(c.req.param('id'));
  const req = evalRequest((await c.req.json()) as Record<string, unknown>);
  return c.json(estimateEval(set.id, req));
});

evalSetRoutes.post('/:id/evals', async (c) => {
  const set = mustSet(c.req.param('id'));
  return c.json(await createEval(set.id, evalRequest((await c.req.json()) as Record<string, unknown>)));
});

evalRoutes.get('/', (c) => c.json(listEvals(c.req.query('set') || undefined)));

evalRoutes.get('/:id', (c) => c.json(mustGetEval(c.req.param('id'))));

evalRoutes.get('/:id/report', (c) => {
  mustGetEval(c.req.param('id'));
  return c.json(evalReport(c.req.param('id')));
});

evalRoutes.get('/:id/cells', (c) => {
  const caseId = c.req.query('case');
  const arm = c.req.query('arm');
  if (!caseId || !arm) return c.json({ error: '需要 case 和 arm' }, 400);
  return c.json(cellRuns(c.req.param('id'), caseId, arm));
});

evalRoutes.post('/:id/pause', (c) => c.json(pauseEval(c.req.param('id'))));
evalRoutes.post('/:id/resume', (c) => c.json(resumeEval(c.req.param('id'))));
evalRoutes.post('/:id/cancel', (c) => c.json(cancelEval(c.req.param('id'))));

evalRoutes.delete('/:id', async (c) => {
  mustGetEval(c.req.param('id'));
  await deleteEval(c.req.param('id'));
  return c.json({ ok: true });
});

evalRoutes.get('/:id/judgments', (c) => c.json(judgmentsOf(c.req.param('id'))));

/** Score finished cells that have no score (asked for by the user: it costs quota). */
evalRoutes.post('/:id/judge', (c) => c.json({ queued: rejudge(c.req.param('id')) }));

/** A score set by hand replaces the model's. */
evalRoutes.put('/:id/judgments/:runId', async (c) => {
  const e = mustGetEval(c.req.param('id'));
  if (!e.rubric) return c.json({ error: '这次评测没有评分项' }, 400);
  const body = (await c.req.json()) as { scores?: Record<string, number>; rationale?: Record<string, string> };
  const scores = Object.fromEntries(e.rubric.map((r) => [r.id, Math.min(5, Math.max(1, Math.round(Number(body.scores?.[r.id] ?? 0))))]).filter(([, v]) => Number(v) > 0));
  saveJudgment(c.req.param('runId'), rubricHash(e.rubric), scores, body.rationale ?? {}, 'user');
  return c.json({ ok: true });
});

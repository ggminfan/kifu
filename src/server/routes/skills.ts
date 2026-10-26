import fs from 'node:fs';
import { Hono } from 'hono';
import { ApplyConflict, applyVariant, listApplies, undoApply } from '../services/apply';
import { catalog, findCatalogSkill } from '../services/catalog';
import { skillSignals, skillUsage } from '../services/indexer';
import { getSession } from '../services/stateDb';
import { previewSkill } from '../services/preview';
import { createVariant, deleteVariant, getVariant, labVariants, listVariants, updateVariant, variantDetail } from '../services/variants';
import { NotFound } from '../services/sessions';

/** Skill catalog, variants, listing preview and apply/undo (Skill Lab). */
export const skillRoutes = new Hono();
export const variantRoutes = new Hono();
export const applyRoutes = new Hono();

skillRoutes.get('/usage', (c) => c.json(skillUsage()));

/** Sessions where the skill was listed, loaded, maybe missed or cut off (from the index). */
skillRoutes.get('/:key/signals', (c) => {
  const { counts, sessions } = skillSignals(c.req.param('key'));
  return c.json({
    counts,
    sessions: sessions.slice(0, 300).map((s) => {
      const meta = getSession(s.threadId);
      return { ...s, title: meta?.title ?? meta?.firstUserMessage?.slice(0, 80), updatedAt: meta?.updatedAt, cwd: meta?.cwd };
    }),
  });
});

skillRoutes.get('/', (c) => {
  const counts = new Map<string, number>();
  for (const v of labVariants()) counts.set(v.skillKey, (counts.get(v.skillKey) ?? 0) + 1);
  return c.json(catalog(c.req.query('refresh') === '1').map((s) => ({ ...s, variants: counts.get(s.key) ?? 0 })));
});

skillRoutes.get('/:key', (c) => {
  const key = c.req.param('key');
  const skill = findCatalogSkill(key);
  if (!skill) throw new NotFound(`找不到 skill ${key}`);
  return c.json({ skill, raw: fs.readFileSync(skill.file, 'utf8'), variants: labVariants(key) });
});

skillRoutes.post('/:key/variants', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { label?: string; note?: string; raw?: string; description?: string; body?: string; fromVariant?: string };
  const v = await createVariant(c.req.param('key'), body);
  return c.json(variantDetail(v));
});

skillRoutes.post('/:key/preview', async (c) => {
  const key = c.req.param('key');
  const body = (await c.req.json().catch(() => ({}))) as { variantId?: string; prompt?: string; cwd?: string };
  const skill = findCatalogSkill(key);
  if (!skill) throw new NotFound(`找不到 skill ${key}`);
  const variant = body.variantId ? getVariant(body.variantId) : undefined;
  if (body.variantId && !variant) throw new NotFound('变体不存在');
  const byName = new Map(catalog().filter((s) => !s.shadowedBy).map((s) => [s.key, s.description]));
  const res = await previewSkill({
    skillKey: key,
    baseFull: skill.description,
    variant,
    prompt: body.prompt,
    cwd: body.cwd,
    fullByName: (n) => byName.get(n),
  });
  return c.json(res);
});

/** Every variant of the workspace's skills (the change pickers). */
variantRoutes.get('/', (c) => c.json(labVariants()));

variantRoutes.get('/:id', (c) => {
  const v = getVariant(c.req.param('id'));
  if (!v) throw new NotFound('变体不存在');
  return c.json({ ...variantDetail(v), applies: listApplies(v.id) });
});

variantRoutes.put('/:id', async (c) => {
  const body = (await c.req.json()) as { raw?: string; description?: string; body?: string; label?: string; note?: string };
  return c.json(variantDetail(updateVariant(c.req.param('id'), body)));
});

variantRoutes.delete('/:id', async (c) => {
  await deleteVariant(c.req.param('id'));
  return c.json({ ok: true });
});

variantRoutes.post('/:id/apply', (c) => {
  try {
    return c.json(applyVariant(c.req.param('id')));
  } catch (e) {
    if (e instanceof ApplyConflict) return c.json({ error: e.message, current: e.current }, 409);
    throw e;
  }
});

applyRoutes.post('/:id/undo', (c) => {
  try {
    return c.json(undoApply(c.req.param('id')));
  } catch (e) {
    if (e instanceof ApplyConflict) return c.json({ error: e.message, current: e.current }, 409);
    throw e;
  }
});

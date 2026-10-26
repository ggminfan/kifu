import { Hono } from 'hono';
import { attribution } from '../../core/analysis/errors';
import { findProblems } from '../../core/analysis/problems';
import { turnCuts } from '../../core/replay/cut';
import { callInputIndices } from '../../core/analysis/context';
import { findEvidence, type EvidenceDoc } from '../../core/analysis/evidence';
import { skillReport } from '../../core/analysis/skills';
import { salientTokens } from '../../core/analysis/tokens';
import type { EvidenceResponse } from '../../shared/api';
import type { SegmentCat } from '../../shared/types';
import { getJob, startAsk } from '../services/askWhy';
import { readText } from '../services/parseCache';
import { NotFound, parsedSession } from '../services/sessions';
import { diskLookupFor } from '../services/skillFiles';
import { currentAgent } from '../sources/registry';

/** Deterministic attribution endpoints, mounted under /api/sessions. */
export const analysisRoutes = new Hono();

analysisRoutes.get('/:id/skills', async (c) => {
  const entry = await parsedSession(c.req.param('id'));
  return c.json(skillReport(entry.trace, diskLookupFor(c.req.param('id'))));
});

analysisRoutes.get('/:id/attribution', async (c) => {
  const entry = await parsedSession(c.req.param('id'));
  return c.json(attribution(entry.trace));
});

/** Everything worth a look, in step order (the problem bar and step markers). */
analysisRoutes.get('/:id/problems', async (c) => {
  const id = c.req.param('id');
  const entry = await parsedSession(id);
  return c.json(findProblems(entry.trace, attribution(entry.trace), skillReport(entry.trace, diskLookupFor(id))));
});

/** Cut points per parsed session (they only change with the file, which gives a new parse). */
const cutsCache = new WeakMap<object, Array<{ turnIndex: number; replayable: boolean; reasons: string[]; warnings: string[] }>>();

/** Which turns can be debugged by replay, and why not. */
analysisRoutes.get('/:id/cuts', async (c) => {
  const entry = await parsedSession(c.req.param('id'));
  if (currentAgent() === 'claude') return c.json(entry.trace.turns.map((t) => ({ turnIndex: t.index, replayable: false, reasons: ['暂不支持回放 Claude Code 会话'], warnings: [] })));
  let cuts = cutsCache.get(entry.trace);
  if (!cuts) {
    cuts = turnCuts(entry.trace, entry.index, 'rollout').map(({ turnIndex, replayable, reasons, warnings }) => ({ turnIndex, replayable, reasons, warnings }));
    cutsCache.set(entry.trace, cuts);
  }
  return c.json(cuts);
});

const EVIDENCE_CATS: Partial<Record<SegmentCat, EvidenceDoc['source']>> = {
  skill_content: 'skill_content',
  skills_listing: 'skills_listing',
  user: 'user',
  agents_md: 'agents_md',
  memory: 'memory',
  tool_output: 'tool_output',
  assistant: 'assistant',
  inter_agent: 'user',
};
const MAX_DOC = 40_000;

analysisRoutes.get('/:id/tools/:toolId/evidence', async (c) => {
  const entry = await parsedSession(c.req.param('id'));
  const trace = entry.trace;
  const tool = trace.tools[c.req.param('toolId')];
  if (!tool) throw new NotFound('工具调用不存在');
  const call = trace.calls[tool.callIndex];

  const argsText = tool.args.ref ? (await readText(entry, tool.args.ref)).text : tool.args.preview;
  const query = salientTokens(`${argsText}\n${tool.inner.map((e) => e.title).join('\n')}`).slice(0, 80);

  // Candidate sources visible to the call: skill text, listing, user turns, recent tool outputs …
  const indices = callInputIndices(trace, call);
  const recentOutputs = new Set(indices.filter((i) => trace.items[i].cat === 'tool_output').slice(-12));
  const recentAssistant = new Set(indices.filter((i) => trace.items[i].cat === 'assistant').slice(-6));
  const docs: EvidenceDoc[] = [];
  let scanned = 0;
  for (const idx of indices) {
    const it = trace.items[idx];
    const source = EVIDENCE_CATS[it.cat];
    if (!source) continue;
    if (it.cat === 'tool_output' && !recentOutputs.has(idx)) continue;
    if (it.cat === 'assistant' && !recentAssistant.has(idx)) continue;
    let text = it.preview;
    if (it.chars > it.preview.length) text = (await readText(entry, it.ref)).text;
    text = text.slice(0, MAX_DOC);
    scanned += text.length;
    docs.push({ source, label: it.name ? `${it.cat} · ${it.name}` : it.cat, itemIdx: idx, text });
  }
  // Skills loaded earlier in the session, as they are on disk now.
  const lookup = diskLookupFor(c.req.param('id'));
  const seen = new Set<string>();
  for (const inv of trace.invocations) {
    if (inv.callIndex > tool.callIndex || seen.has(inv.skill)) continue;
    seen.add(inv.skill);
    const d = lookup(inv.path, inv.skill);
    if (d?.body) {
      docs.push({ source: 'skill_file', label: `SKILL.md · ${inv.skill}`, skill: inv.skill, text: d.body.slice(0, MAX_DOC) });
      scanned += Math.min(d.body.length, MAX_DOC);
    }
  }

  const body: EvidenceResponse = { toolId: tool.id, query, hits: findEvidence(query, docs), scannedChars: scanned };
  return c.json(body);
});

analysisRoutes.post('/:id/ask', async (c) => {
  const body = (await c.req.json()) as { question?: string; callIndex?: number; toolId?: string };
  if (!body.question?.trim()) return c.json({ error: '请输入问题' }, 400);
  const job = await startAsk(c.req.param('id'), body.question.trim(), { callIndex: body.callIndex, toolId: body.toolId });
  return c.json(job);
});

export const jobRoutes = new Hono();
jobRoutes.get('/:id', (c) => {
  const job = getJob(c.req.param('id'));
  if (!job) throw new NotFound('任务不存在（服务重启后任务会丢失）');
  return c.json(job);
});

import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { aggregateEval, type CellInput } from '../../core/eval/aggregate';
import { turnCuts } from '../../core/replay/cut';
import type { Arm, CaseRecord, CaseRole, CheckDef, EvalOptions, EvalProgress, EvalRecord, EvalReport, EvalSet, EvalSetCase, EvalStatus, RubricItem } from '../../shared/replay';
import { dataPaths } from '../config';
import { enqueue, isPending } from '../services/execQueue';
import { skillSignals } from '../services/indexer';
import { getParsed, readText } from '../services/parseCache';
import { cancelRun, deleteRunRecord, enqueueRuns, getRun, onRunDone, pauseQueued, saveRun, type ReplayRun, type RunRecord } from '../services/runner';
import { parsedSession, unregisterRollout } from '../services/sessions';
import { tmDb } from '../services/tmDb';
import { runAnalyst } from './analyst';
import { createCase, getCase, originalSummary, updateCase } from './cases';
import { buildReplayRuns, estimateTokens, type ReplayRequest } from './engine';

/**
 * Batch evaluation: a set of cases (each with a role for the set's skill) run
 * as a matrix — every case × every group of changes × N repeats — in the batch
 * lane after interactive work. Every cell is a replay run. A restart pauses an
 * evaluation (resumed by hand: it costs quota); hitting the model's rate limit
 * backs off and retries (engine). Finished runs can be graded by the agent as
 * a judge against a short rubric; scores can be overridden by hand.
 */

export const MAX_CELLS = 200;

// ------------------------------------------------------------------ sets

interface SetRow {
  id: string;
  name: string;
  skill: string | null;
  note: string | null;
  created_at: number;
  updated_at: number;
}

function setFromRow(r: SetRow, cases: number): EvalSet {
  return { id: r.id, name: r.name, skill: r.skill ?? undefined, note: r.note ?? undefined, createdAt: r.created_at, updatedAt: r.updated_at, cases };
}

const newId = (p: string) => `${p}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;

export function listSets(): EvalSet[] {
  const counts = new Map((tmDb().prepare('select set_id, count(*) as n from eval_set_cases group by set_id').all() as Array<{ set_id: string; n: number }>).map((r) => [r.set_id, r.n]));
  return (tmDb().prepare('select * from eval_sets order by updated_at desc').all() as unknown as SetRow[]).map((r) => setFromRow(r, counts.get(r.id) ?? 0));
}

export function getSet(id: string): EvalSet | undefined {
  const row = tmDb().prepare('select * from eval_sets where id = ?').get(id) as unknown as SetRow | undefined;
  if (!row) return undefined;
  return setFromRow(row, (tmDb().prepare('select count(*) as n from eval_set_cases where set_id = ?').get(id) as { n: number }).n);
}

export function mustGetSet(id: string): EvalSet {
  const s = getSet(id);
  if (!s) throw new Error('评测集不存在');
  return s;
}

export function createSet(o: { name: string; skill?: string; note?: string }): EvalSet {
  const id = newId('s');
  const now = Date.now();
  tmDb().prepare('insert into eval_sets (id, name, skill, note, created_at, updated_at) values (?, ?, ?, ?, ?, ?)').run(id, o.name.trim() || '评测集', o.skill || null, o.note ?? null, now, now);
  return mustGetSet(id);
}

export function findOrCreateSet(name: string, skill?: string): EvalSet {
  const row = tmDb().prepare('select * from eval_sets where name = ? order by updated_at desc limit 1').get(name) as unknown as SetRow | undefined;
  return row ? mustGetSet(row.id) : createSet({ name, skill });
}

export function updateSet(id: string, patch: { name?: string; skill?: string | null; note?: string }): EvalSet {
  const s = mustGetSet(id);
  tmDb()
    .prepare('update eval_sets set name = ?, skill = ?, note = ?, updated_at = ? where id = ?')
    .run(patch.name?.trim() || s.name, patch.skill === undefined ? (s.skill ?? null) : patch.skill || null, patch.note ?? s.note ?? null, Date.now(), id);
  return mustGetSet(id);
}

export function setCases(setId: string): Array<EvalSetCase & { case?: CaseRecord }> {
  const rows = tmDb().prepare('select * from eval_set_cases where set_id = ? order by added_at').all(setId) as Array<{ case_id: string; role: CaseRole; added_at: number }>;
  return rows.map((r) => ({ caseId: r.case_id, role: r.role, addedAt: r.added_at, case: getCase(r.case_id) }));
}

/** Add cases to a set; a case in a set is kept (it no longer expires). */
export function addCases(setId: string, items: Array<{ caseId: string; role: CaseRole }>): void {
  mustGetSet(setId);
  const ins = tmDb().prepare('insert into eval_set_cases (set_id, case_id, role, added_at) values (?, ?, ?, ?) on conflict(set_id, case_id) do update set role = excluded.role');
  for (const it of items) {
    if (!getCase(it.caseId)) continue;
    ins.run(setId, it.caseId, it.role, Date.now());
    updateCase(it.caseId, { saved: true });
  }
  tmDb().prepare('update eval_sets set updated_at = ? where id = ?').run(Date.now(), setId);
}

export function setRole(setId: string, caseId: string, role: CaseRole): void {
  tmDb().prepare('update eval_set_cases set role = ? where set_id = ? and case_id = ?').run(role, setId, caseId);
}

export function removeFromSet(setId: string, caseId: string): void {
  tmDb().prepare('delete from eval_set_cases where set_id = ? and case_id = ?').run(setId, caseId);
}

/** A case deleted: out of every set. */
export function forgetCase(caseId: string): void {
  tmDb().prepare('delete from eval_set_cases where case_id = ?').run(caseId);
}

export async function deleteSet(id: string): Promise<void> {
  for (const e of listEvals(id)) await deleteEval(e.id);
  tmDb().prepare('delete from eval_set_cases where set_id = ?').run(id);
  tmDb().prepare('delete from eval_sets where id = ?').run(id);
}

// ------------------------------------------------------------------ cases from sessions

export type TurnStrategy = 'skill' | 'last' | 'first';

/** Which turn of each session to evaluate: where the skill mattered, or the last / first replayable one. */
export async function resolveTurns(sessionIds: string[], strategy: TurnStrategy, skill?: string): Promise<Array<{ sessionId: string; turnIndex?: number; reason?: string }>> {
  const signals = skill ? new Map(skillSignals(skill).sessions.map((s) => [s.threadId, s])) : new Map();
  const out: Array<{ sessionId: string; turnIndex?: number; reason?: string }> = [];
  for (const sessionId of sessionIds) {
    try {
      const entry = await parsedSession(sessionId);
      const cuts = turnCuts(entry.trace, entry.index, 'rollout').filter((c) => c.replayable);
      if (!cuts.length) {
        out.push({ sessionId, reason: '没有可以回放的轮次' });
        continue;
      }
      const wanted = strategy === 'skill' ? signals.get(sessionId)?.turnIndex : undefined;
      const cut = (wanted !== undefined ? cuts.find((c) => c.turnIndex === wanted) : undefined) ?? (strategy === 'first' ? cuts[0] : cuts[cuts.length - 1]);
      out.push({ sessionId, turnIndex: cut.turnIndex });
    } catch (e) {
      out.push({ sessionId, reason: (e as Error).message });
    }
  }
  return out;
}

/** New cases for these turns, added to the set with a role. */
export async function addTurns(setId: string, items: Array<{ sessionId: string; turnIndex: number }>, role: CaseRole): Promise<{ added: string[]; failed: Array<{ sessionId: string; error: string }> }> {
  const added: string[] = [];
  const failed: Array<{ sessionId: string; error: string }> = [];
  for (const it of items) {
    try {
      const c = await createCase(it.sessionId, it.turnIndex);
      added.push(c.id);
    } catch (e) {
      failed.push({ sessionId: it.sessionId, error: (e as Error).message });
    }
  }
  addCases(
    setId,
    added.map((caseId) => ({ caseId, role })),
  );
  return { added, failed };
}

function tokens(s: string): Set<string> {
  return new Set((s.toLowerCase().match(/[a-z][a-z0-9_-]{2,}|[一-鿿]{2}/g) ?? []).filter((t) => !STOP.has(t)));
}
const STOP = new Set(['the', 'and', 'for', 'with', 'when', 'use', 'this', 'that', 'from', 'skill', 'user', 'asks']);

/** The skills whose descriptions are closest to `skill`'s (they may lose their turn to it after an edit). */
export function similarSkills(skill: string, catalog: Array<{ key: string; description?: string }>, n = 3): string[] {
  const me = catalog.find((s) => s.key === skill);
  if (!me?.description) return [];
  const a = tokens(me.description);
  return catalog
    .filter((s) => s.key !== skill && s.description)
    .map((s) => {
      const b = tokens(s.description!);
      const inter = [...a].filter((t) => b.has(t)).length;
      return { key: s.key, score: inter / Math.max(1, Math.min(a.size, b.size)) };
    })
    .filter((x) => x.score > 0)
    .sort((x, y) => y.score - x.score)
    .slice(0, n)
    .map((x) => x.key);
}

/**
 * A set for one skill from the index: positives where it loaded or probably
 * should have, negatives where it was listed but had nothing to do, and
 * controls where its closest neighbours loaded (it must not take their turn).
 */
export async function setFromSkill(skill: string, catalog: Array<{ key: string; description?: string }>, o: { positives?: number; negatives?: number; controls?: number } = {}) {
  const set = createSet({ name: `${skill} 评测`, skill });
  const sig = skillSignals(skill).sessions;
  const pos = sig.filter((s) => s.loaded || s.missed || s.truncated).slice(0, o.positives ?? 8);
  // a neighbour's session is a control (not also a negative); each session once
  const used = new Set(pos.map((s) => s.threadId));
  const ctrl = similarSkills(skill, catalog)
    .flatMap((k) =>
      skillSignals(k)
        .sessions.filter((s) => s.loaded && !used.has(s.threadId))
        .slice(0, Math.max(1, Math.ceil((o.controls ?? 3) / 3))),
    )
    .filter((s, i, all) => all.findIndex((x) => x.threadId === s.threadId) === i)
    .slice(0, o.controls ?? 3);
  for (const s of ctrl) used.add(s.threadId);
  const neg = sig.filter((s) => !used.has(s.threadId) && s.listed && !s.loaded && !s.missed && !s.truncated && (s.relevance ?? 0) < 1).slice(0, o.negatives ?? 4);
  const result = { set, added: 0, failed: [] as Array<{ sessionId: string; error: string }> };
  for (const [list, role] of [
    [pos, 'positive'],
    [neg, 'negative'],
    [ctrl, 'control'],
  ] as const) {
    const turns = await resolveTurns(
      list.map((s) => s.threadId),
      role === 'negative' ? 'last' : 'skill',
      role === 'control' ? undefined : skill,
    );
    // controls: the neighbour's own turn
    const items = turns.flatMap((t, i) => {
      const at = role === 'control' ? (list[i].turnIndex ?? t.turnIndex) : t.turnIndex;
      return at === undefined ? [] : [{ sessionId: t.sessionId, turnIndex: at }];
    });
    const r = await addTurns(set.id, items, role);
    result.added += r.added.length;
    result.failed.push(...r.failed);
  }
  return { ...result, set: mustGetSet(set.id) };
}

// ------------------------------------------------------------------ evaluations

interface EvalRow {
  id: string;
  set_id: string;
  name: string | null;
  status: EvalStatus;
  arms: string;
  repeats: number;
  options: string;
  rubric: string | null;
  estimate: string | null;
  created_at: number;
  finished_at: number | null;
}

function cellsOf(evalId: string): ReplayRun[] {
  const ids = tmDb().prepare("select id from runs where kind = 'replay' and eval_id = ? order by created_at").all(evalId) as Array<{ id: string }>;
  return ids.map((r) => getRun(r.id)).filter((r): r is ReplayRun => r?.kind === 'replay');
}

function progressOf(cells: ReplayRun[]): EvalProgress {
  const n = (s: string[]) => cells.filter((c) => s.includes(c.status)).length;
  return { total: cells.length, done: n(['completed', 'failed', 'cancelled']), running: n(['running']), queued: n(['queued']), paused: n(['paused']), failed: n(['failed']) };
}

function evalFromRow(r: EvalRow, withProgress = true): EvalRecord {
  const cells = withProgress ? cellsOf(r.id) : [];
  return {
    id: r.id,
    setId: r.set_id,
    name: r.name ?? undefined,
    status: r.status,
    arms: JSON.parse(r.arms) as Arm[],
    repeats: r.repeats,
    options: JSON.parse(r.options) as EvalOptions,
    rubric: r.rubric ? (JSON.parse(r.rubric) as RubricItem[]) : undefined,
    estimate: r.estimate ? (JSON.parse(r.estimate) as EvalRecord['estimate']) : undefined,
    createdAt: r.created_at,
    finishedAt: r.finished_at ?? undefined,
    progress: withProgress ? progressOf(cells) : undefined,
    judging: r.rubric && withProgress ? cells.filter((c) => isPending(`judge-${c.id}`)).length : undefined,
  };
}

export function getEval(id: string): EvalRecord | undefined {
  const row = tmDb().prepare('select * from evals where id = ?').get(id) as unknown as EvalRow | undefined;
  return row ? evalFromRow(row) : undefined;
}

export function mustGetEval(id: string): EvalRecord {
  const e = getEval(id);
  if (!e) throw new Error('评测不存在');
  return e;
}

export function listEvals(setId?: string): EvalRecord[] {
  const rows = (setId ? tmDb().prepare('select * from evals where set_id = ? order by created_at desc').all(setId) : tmDb().prepare('select * from evals order by created_at desc limit 200').all()) as unknown as EvalRow[];
  return rows.map((r) => evalFromRow(r));
}

function setStatus(id: string, status: EvalStatus): void {
  tmDb()
    .prepare('update evals set status = ?, finished_at = ? where id = ?')
    .run(status, status === 'completed' || status === 'cancelled' ? Date.now() : null, id);
}

/** What the set's skill asks of a case in its role (beyond the case's own checks). */
export function roleChecks(c: CaseRecord, role: CaseRole, skill?: string): CheckDef[] {
  if (!skill) return [];
  const want: CheckDef = role === 'positive' ? { kind: 'skill_loaded', skill } : { kind: 'skill_not_loaded', skill };
  const same = c.checks.some((d) => d.kind === want.kind && 'skill' in d && d.skill === skill);
  return same ? [] : [want];
}

export interface EvalRequest {
  name?: string;
  arms: Arm[];
  repeats: number;
  options: EvalOptions;
  rubric?: RubricItem[];
}

export function estimateEval(setId: string, req: Pick<EvalRequest, 'arms' | 'repeats' | 'options'>): { cells: number; tokens: number; judgeCalls: number } {
  const cases = setCases(setId).flatMap((x) => (x.case ? [x.case] : []));
  const repeats = Math.max(1, Math.min(10, Math.floor(req.repeats)));
  const cells = cases.length * req.arms.length * repeats;
  const tokens = cases.reduce((sum, c) => sum + estimateTokens(c, { arms: req.arms, repeats, maxSteps: req.options.maxSteps }).total, 0);
  return { cells, tokens, judgeCalls: req.options.judge ? cells : 0 };
}

export async function createEval(setId: string, req: EvalRequest): Promise<EvalRecord> {
  const set = mustGetSet(setId);
  const members = setCases(setId).filter((x) => x.case);
  if (!members.length) throw new Error('评测集里还没有用例');
  if (!req.arms.length) throw new Error('至少需要一组改动');
  const repeats = Math.max(1, Math.min(10, Math.floor(req.repeats)));
  const est = estimateEval(setId, { ...req, repeats });
  if (est.cells > MAX_CELLS) throw new Error(`一次评测最多 ${MAX_CELLS} 格（现在是 ${est.cells}）：减少用例、改动组或重复次数`);
  const rubric = req.options.judge ? (req.rubric ?? []).filter((r) => r.text.trim()).slice(0, 6) : undefined;
  if (req.options.judge && (!rubric || rubric.length < 2)) throw new Error('模型评分需要 2–6 条评分项');
  const id = newId('e');
  tmDb()
    .prepare('insert into evals (id, set_id, name, status, arms, repeats, options, rubric, estimate, created_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, setId, req.name ?? null, 'running', JSON.stringify(req.arms), repeats, JSON.stringify(req.options), rubric ? JSON.stringify(rubric) : null, JSON.stringify({ cells: est.cells, tokens: est.tokens }), Date.now());
  const runs: ReplayRun[] = [];
  const replayReq: ReplayRequest = { arms: req.arms, repeats, maxSteps: req.options.maxSteps, model: req.options.model, effort: req.options.effort, workspace: req.options.workspace, allowMcp: req.options.allowMcp };
  try {
    for (const m of members) runs.push(...(await buildReplayRuns(m.case!, replayReq, { evalId: id, extraChecks: roleChecks(m.case!, m.role, set.skill) })));
  } catch (e) {
    tmDb().prepare('delete from evals where id = ?').run(id);
    for (const r of runs) await fs.rm(path.join(dataPaths.runs, r.id), { recursive: true, force: true });
    throw e;
  }
  // case by case, so partial results cover whole cases early
  enqueueRuns(runs, 'batch');
  tmDb().prepare('update eval_sets set updated_at = ? where id = ?').run(Date.now(), setId);
  return mustGetEval(id);
}

export function pauseEval(id: string): EvalRecord {
  const e = mustGetEval(id);
  if (e.status !== 'running') return e;
  pauseQueued(cellsOf(id).map((c) => c.id));
  setStatus(id, 'paused');
  return mustGetEval(id);
}

export function resumeEval(id: string): EvalRecord {
  const e = mustGetEval(id);
  if (e.status === 'completed' || e.status === 'cancelled') return e;
  const paused = cellsOf(id).filter((c) => c.status === 'paused');
  for (const c of paused) c.error = undefined;
  setStatus(id, 'running');
  enqueueRuns(paused, 'batch');
  const p = mustGetEval(id).progress!;
  if (p.queued + p.running + p.paused === 0) setStatus(id, 'completed');
  return mustGetEval(id);
}

export function cancelEval(id: string): EvalRecord {
  mustGetEval(id);
  for (const c of cellsOf(id)) {
    if (c.status === 'queued' || c.status === 'running') cancelRun(c.id);
    else if (c.status === 'paused') {
      c.status = 'cancelled';
      c.finishedAt = Date.now();
      saveRun(c);
    }
  }
  setStatus(id, 'cancelled');
  return mustGetEval(id);
}

export async function deleteEval(id: string): Promise<void> {
  cancelEval(id);
  for (const c of cellsOf(id)) {
    if (c.threadId) unregisterRollout(c.threadId);
    deleteRunRecord(c.id);
    tmDb().prepare('delete from judgments where run_id = ?').run(c.id);
    await fs.rm(path.join(dataPaths.runs, path.basename(c.id)), { recursive: true, force: true });
  }
  tmDb().prepare('delete from evals where id = ?').run(id);
}

/** A cell ended: grade it if asked, and close the evaluation when nothing is left. */
function cellDone(r: RunRecord): void {
  if (r.kind !== 'replay' || !r.evalId) return;
  const e = getEval(r.evalId);
  if (!e) return;
  if (r.status === 'completed' && e.options.judge && e.rubric?.length) queueJudge(e, r);
  const p = e.progress!;
  // paused while its last cells were already running: those finishing ends it too
  if ((e.status === 'running' || e.status === 'paused') && p.queued + p.running + p.paused === 0) setStatus(e.id, 'completed');
}

onRunDone(cellDone);

/** On startup: evaluations whose cells a restart paused wait for the user. */
export function initEvals(): void {
  tmDb().prepare("update evals set status = 'paused' where status = 'running' and id in (select eval_id from runs where status = 'paused' and eval_id is not null)").run();
}

// ------------------------------------------------------------------ judge

export const JudgeSchema = z.object({
  scores: z.record(z.string(), z.coerce.number()),
  rationale: z.record(z.string(), z.string()).catch({}),
});

export function rubricHash(rubric: RubricItem[]): string {
  return createHash('sha1').update(JSON.stringify(rubric.map((r) => [r.id, r.text]))).digest('hex').slice(0, 12);
}

function judgeInstructions(rubric: RubricItem[]): string {
  return [
    '你是 agent 执行结果的评审。下面"---"之后是一次编码 agent 对某个用户请求的执行记录：用户请求、它调用的工具、检查结果和最终回答，以及同一请求在原始会话里的最终回答（参考）。',
    '请按每条评分项给 1–5 分（5 最好），只依据记录内容，并用一句话说明理由。只输出一个 JSON 对象，不要其他文字：',
    `{"scores": {${rubric.map((r) => `"${r.id}": 1-5`).join(', ')}}, "rationale": {${rubric.map((r) => `"${r.id}": "理由"`).join(', ')}}}`,
    '评分项：',
    ...rubric.map((r) => `- ${r.id}：${r.text}`),
  ].join('\n');
}

async function judgeMaterial(r: ReplayRun): Promise<string> {
  const c = getCase(r.caseId);
  const parts = [`## 用户请求\n${r.prompt}`];
  const s = r.result?.summary;
  if (s) parts.push(`## 工具调用（${s.tools} 次）\n${s.toolSeq.slice(0, 60).join('\n') || '（无）'}`);
  if (r.checks?.length) parts.push(`## 检查\n${r.checks.map((x) => `- ${x.status} ${JSON.stringify(x.def)}${x.detail ? `：${x.detail}` : ''}`).join('\n')}`);
  let answer = s?.finalAnswer ?? '';
  if (r.rollout && r.result?.prefixLines) {
    try {
      const entry = await getParsed(r.rollout, { prefixEnd: r.result.prefixLines });
      const last = entry.trace.turns[entry.trace.turns.length - 1]?.lastAgentMessage;
      if (last?.ref) answer = (await readText(entry, last.ref)).text;
    } catch {
      // keep the preview
    }
  }
  parts.push(`## 最终回答\n${answer.slice(0, 20_000) || '（没有回答）'}`);
  const o = c ? await originalSummary(c) : undefined;
  if (o?.finalAnswer) parts.push(`## 原始会话的最终回答（参考）\n${o.finalAnswer}`);
  return parts.join('\n\n');
}

function queueJudge(e: EvalRecord, r: ReplayRun): void {
  const rubric = e.rubric!;
  const hash = rubricHash(rubric);
  const done = tmDb().prepare('select 1 from judgments where run_id = ? and rubric_hash = ?').get(r.id, hash);
  if (done) return;
  enqueue({
    id: `judge-${r.id}`,
    lane: 'batch',
    start: async () => {
      try {
        const res = await runAnalyst({ jobDir: path.join(dataPaths.jobs, `judge-${r.id}`), instructions: judgeInstructions(rubric), input: await judgeMaterial(r) });
        const text = res.text.replace(/^```(?:json)?\s*/m, '').replace(/```\s*$/m, '');
        const parsed = JudgeSchema.safeParse(JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)));
        if (!parsed.success) throw new Error('评分不是约定的 JSON');
        const scores = Object.fromEntries(rubric.map((it) => [it.id, Math.min(5, Math.max(1, Math.round(parsed.data.scores[it.id] ?? 0)))]).filter(([, v]) => Number(v) > 0));
        saveJudgment(r.id, hash, scores, parsed.data.rationale, 'model');
      } catch (err) {
        saveJudgment(r.id, hash, {}, { error: (err as Error).message }, 'model');
      } finally {
        await fs.rm(path.join(dataPaths.jobs, `judge-${r.id}`), { recursive: true, force: true }).catch(() => undefined);
      }
    },
  });
}

/** Score the finished cells that have no score yet (judge calls lost to a restart, or a judge that failed): asked for by the user, it costs quota. */
export function rejudge(evalId: string): number {
  const e = mustGetEval(evalId);
  if (!e.rubric?.length) throw new Error('这次评测没有评分项');
  const hash = rubricHash(e.rubric);
  const scored = new Set(
    (tmDb().prepare("select j.run_id, j.scores from judgments j join runs r on r.id = j.run_id where r.eval_id = ? and j.rubric_hash = ?").all(evalId, hash) as Array<{ run_id: string; scores: string }>)
      // a failed judge left empty scores: it is scored again
      .filter((j) => Object.keys(JSON.parse(j.scores) as Record<string, number>).length > 0)
      .map((j) => j.run_id),
  );
  let n = 0;
  for (const c of cellsOf(evalId)) {
    if (c.status !== 'completed' || scored.has(c.id) || isPending(`judge-${c.id}`)) continue;
    tmDb().prepare('delete from judgments where run_id = ? and rubric_hash = ?').run(c.id, hash);
    queueJudge(e, c);
    n++;
  }
  return n;
}

export function saveJudgment(runId: string, hash: string, scores: Record<string, number>, rationale: Record<string, string>, source: 'model' | 'user'): void {
  const now = Date.now();
  tmDb()
    .prepare(
      `insert into judgments (run_id, rubric_hash, scores, rationale, source, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?)
       on conflict(run_id, rubric_hash) do update set scores = excluded.scores, rationale = excluded.rationale, source = excluded.source, updated_at = excluded.updated_at`,
    )
    .run(runId, hash, JSON.stringify(scores), JSON.stringify(rationale), source, now, now);
}

export function judgmentsOf(evalId: string): Record<string, { scores: Record<string, number>; rationale: Record<string, string>; source: string }> {
  const e = mustGetEval(evalId);
  if (!e.rubric) return {};
  const hash = rubricHash(e.rubric);
  const rows = tmDb()
    .prepare("select j.* from judgments j join runs r on r.id = j.run_id where r.eval_id = ? and j.rubric_hash = ?")
    .all(evalId, hash) as Array<{ run_id: string; scores: string; rationale: string | null; source: string }>;
  return Object.fromEntries(rows.map((j) => [j.run_id, { scores: JSON.parse(j.scores) as Record<string, number>, rationale: JSON.parse(j.rationale ?? '{}') as Record<string, string>, source: j.source }]));
}

// ------------------------------------------------------------------ report

export function evalReport(id: string): EvalReport & { titles: Record<string, string> } {
  const e = mustGetEval(id);
  const set = getSet(e.setId);
  const members = setCases(e.setId);
  const roles = Object.fromEntries(members.map((m) => [m.caseId, m.role]));
  const judgments = judgmentsOf(id);
  const cells: CellInput[] = cellsOf(id)
    .filter((r) => roles[r.caseId])
    .map((r) => ({
      caseId: r.caseId,
      role: roles[r.caseId],
      arm: r.arm,
      ok: r.status === 'completed',
      pending: r.status === 'queued' || r.status === 'running' || r.status === 'paused',
      unfinished: Boolean(r.result?.stoppedAtMax),
      checks: r.checks,
      summary: r.result?.summary,
      scores: judgments[r.id]?.scores,
    }));
  const arms = e.arms.map((a) => a.label);
  const baseline = e.arms.find((a) => !a.variantIds.length)?.label;
  const report = aggregateEval({ arms, baseline, skill: set?.skill, roles, cells });
  const titles = Object.fromEntries(members.map((m) => [m.caseId, m.case?.title ?? m.caseId]));
  return { ...report, titles };
}

/** The runs of one cell (case × group), for the drill-down. */
export function cellRuns(evalId: string, caseId: string, arm: string): ReplayRun[] {
  return cellsOf(evalId).filter((r) => r.caseId === caseId && r.arm === arm);
}

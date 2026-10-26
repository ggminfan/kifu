import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { config, configure, ensureDataDirs } from '../src/server/config';
import { createEval, evalReport, getEval, initEvals, judgmentsOf, listEvals, pauseEval, rejudge, resumeEval, saveJudgment, rubricHash, setCases, setFromSkill, similarSkills, createSet, addTurns, type EvalRequest } from '../src/server/replay/evals';
import '../src/server/replay/engine';
import { catalog } from '../src/server/services/catalog';
import { runIndexer, sessionsWithSignal, skillSignals } from '../src/server/services/indexer';
import { queueBusy } from '../src/server/services/execQueue';
import { getRun, initRunner, listReplays, type ReplayRun } from '../src/server/services/runner';
import { tmDb } from '../src/server/services/tmDb';
import { createVariant } from '../src/server/services/variants';
import { configureSources, refreshSources } from '../src/server/sources/registry';
import { EVAL_IDS, evalHome, FAKE_AGENT } from './fixtures/homes';

/**
 * Batch evaluation with a fake agent: skill signals from the index, a set
 * built for a skill (positives, negatives, a control), the matrix run in the
 * batch lane, the report (recall, false triggers, regressions), pause and
 * resume, rate-limit back-off, a restart, and judge scores.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kifu-evals-'));
const saved = { codexBin: config.codexBin, tmHome: config.tmHome, agentsSkillsDir: config.agentsSkillsDir, env: { ...process.env } };

async function settle(evalId: string, timeoutMs = 60_000) {
  const t0 = Date.now();
  for (;;) {
    const e = getEval(evalId)!;
    if (e.status !== 'running') return e;
    if (Date.now() - t0 > timeoutMs) throw new Error(`evaluation still running: ${JSON.stringify(e.progress)}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

const OPTIONS = { maxSteps: 10, workspace: 'readonly' as const, allowMcp: false, judge: false };

beforeAll(async () => {
  fs.chmodSync(FAKE_AGENT, 0o755);
  configure({ dataDir: path.join(tmp, 'data') });
  ensureDataDirs();
  config.codexBin = FAKE_AGENT;
  config.agentsSkillsDir = path.join(tmp, 'agents-skills');
  fs.mkdirSync(config.agentsSkillsDir, { recursive: true });
  const h = evalHome(tmp);
  configureSources({ agent: 'codex', home: h.home });
  refreshSources();
  await runIndexer();
  // the fake agent loads report-writer only when its description says 周报 (a variant adds it)
  process.env.FAKE_SKILL_WHEN = 'report-writer:周报';
  process.env.KIFU_RETRY_BASE_MS = '50';
});

afterAll(() => {
  Object.assign(config, { codexBin: saved.codexBin, tmHome: saved.tmHome, agentsSkillsDir: saved.agentsSkillsDir });
  process.env = saved.env;
  configureSources({ agent: 'codex' });
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('skill signals', () => {
  it('records per session whether a skill was listed, loaded or probably missed', () => {
    const s = skillSignals('report-writer');
    expect(s.counts).toEqual({ listed: 4, loaded: 1, missed: 1, truncated: 0 });
    expect(s.sessions[0]).toMatchObject({ threadId: EVAL_IDS.loaded, loaded: true, turnIndex: 0 });
    expect([...sessionsWithSignal('missed', 'report-writer')]).toEqual([EVAL_IDS.missed]);
    expect([...sessionsWithSignal('loaded', 'git-helper')]).toEqual([EVAL_IDS.neighbour]);
    expect(similarSkills('report-writer', catalog())).toEqual(['git-helper']);
  });
});

describe('evaluation', () => {
  let setId: string;
  let variantId: string;

  it('builds a set for a skill: positives, negatives and a control from its neighbour', async () => {
    const r = await setFromSkill('report-writer', catalog());
    expect(r.failed).toEqual([]);
    setId = r.set.id;
    const members = setCases(setId).map((m) => [m.case!.threadId, m.role]);
    expect(members).toEqual(
      expect.arrayContaining([
        [EVAL_IDS.loaded, 'positive'],
        [EVAL_IDS.missed, 'positive'],
        [EVAL_IDS.unrelated, 'negative'],
        [EVAL_IDS.neighbour, 'control'],
      ]),
    );
    expect(members).toHaveLength(4);
    // cases in a set are kept
    expect(setCases(setId).every((m) => m.case!.saved)).toBe(true);
  });

  it('runs the matrix and reports recall, false triggers and regressions', async () => {
    variantId = (await createVariant('report-writer', { description: 'Write weekly reports (周报) from git logs and commit history.' })).id;
    const req: EvalRequest = { arms: [{ label: 'A′', variantIds: [] }, { label: 'B1', variantIds: [variantId] }], repeats: 1, options: OPTIONS };
    const e = await createEval(setId, req);
    expect(e).toMatchObject({ status: 'running', estimate: { cells: 8 } });
    const done = await settle(e.id);
    expect(done.status).toBe('completed');
    expect(done.progress).toMatchObject({ total: 8, done: 8, failed: 0 });
    const r = evalReport(e.id);
    expect(r.baseline).toBe('A′');
    // the variant makes the skill trigger — on positives, and also where it should not
    expect(r.skill!.perArm['A′']).toMatchObject({ recall: 0, falseTriggerRate: 0 });
    expect(r.skill!.perArm['B1']).toMatchObject({ recall: 1, falseTriggerRate: 1, precision: 0.5 });
    expect(r.improvements.map((d) => d.caseId).sort()).toEqual(setCases(setId).filter((m) => m.role === 'positive').map((m) => m.caseId).sort());
    expect(r.regressions.map((d) => d.caseId)).toEqual(setCases(setId).filter((m) => m.role === 'negative').map((m) => m.caseId));
    expect(r.titles[r.rows[0].caseId]).toBeTruthy();
    // each cell is a replay of its case in the evaluation, with what the case's role asks for
    const negative = setCases(setId).find((m) => m.role === 'negative')!;
    const cell = listReplays(negative.caseId).find((x) => x.evalId === e.id)!;
    expect(cell.options.extraChecks).toEqual([{ kind: 'skill_not_loaded', skill: 'report-writer' }]);
  });

  it('pauses and resumes; a restart pauses it too', async () => {
    process.env.FAKE_STEPS = '2';
    process.env.FAKE_STEP_MS = '300';
    try {
      const e = await createEval(setId, { arms: [{ label: 'A′', variantIds: [] }], repeats: 1, options: OPTIONS });
      await new Promise((r) => setTimeout(r, 150));
      const paused = pauseEval(e.id);
      expect(paused.status).toBe('paused');
      expect(paused.progress!.paused).toBeGreaterThan(0);
      // nothing more starts while paused
      await new Promise((r) => setTimeout(r, 1500));
      expect(getEval(e.id)!.progress!.paused).toBe(paused.progress!.paused);
      resumeEval(e.id);
      expect((await settle(e.id)).status).toBe('completed');

      // a restart: queued / running cells pause and wait for the user
      const e2 = await createEval(setId, { arms: [{ label: 'A′', variantIds: [] }], repeats: 1, options: OPTIONS });
      pauseEval(e2.id);
      tmDb().prepare("update runs set status = 'queued' where eval_id = ? and status = 'paused'").run(e2.id);
      tmDb().prepare("update evals set status = 'running' where id = ?").run(e2.id);
      initRunner();
      initEvals();
      expect(getEval(e2.id)!.status).toBe('paused');
      expect(listEvals(setId).length).toBeGreaterThanOrEqual(3);
      // cells the queue had already started run to their end (a real restart has none left)
      const t0 = Date.now();
      while (queueBusy() && Date.now() - t0 < 20_000) await new Promise((r) => setTimeout(r, 100));
      expect(queueBusy()).toBe(false);
    } finally {
      delete process.env.FAKE_STEPS;
      delete process.env.FAKE_STEP_MS;
    }
  });

  it('backs off and retries when the model rate-limits', async () => {
    const one = createSet({ name: 'one' });
    await addTurns(one.id, [{ sessionId: EVAL_IDS.unrelated, turnIndex: 0 }], 'negative');
    const counter = path.join(tmp, 'rate-limit');
    fs.writeFileSync(counter, '2');
    process.env.FAKE_RATE_LIMIT_FILE = counter;
    try {
      const e = await createEval(one.id, { arms: [{ label: 'A′', variantIds: [] }], repeats: 1, options: OPTIONS });
      expect((await settle(e.id)).status).toBe('completed');
      const [caseId] = setCases(one.id).map((m) => m.caseId);
      const cell = getRun(listReplays(caseId).find((x) => x.evalId === e.id)!.id) as ReplayRun;
      expect(cell).toMatchObject({ status: 'completed', result: { retries: 2 } });
    } finally {
      delete process.env.FAKE_RATE_LIMIT_FILE;
    }
  });

  it('judges finished cells against the rubric; a score set by hand replaces the model’s', async () => {
    const answer = path.join(tmp, 'judge.json');
    fs.writeFileSync(answer, JSON.stringify({ scores: { clarity: 4, focus: 2 }, rationale: { clarity: 'clear', focus: 'drifts' } }));
    process.env.FAKE_ANSWER_FILE = answer;
    try {
      await expect(createEval(setId, { arms: [{ label: 'A′', variantIds: [] }], repeats: 1, options: { ...OPTIONS, judge: true }, rubric: [{ id: 'clarity', text: '回答清晰' }] })).rejects.toThrow(/2–6 条评分项/);
      const rubric = [
        { id: 'clarity', text: '回答清晰' },
        { id: 'focus', text: '紧扣请求' },
      ];
      const e = await createEval(setId, { arms: [{ label: 'A′', variantIds: [] }], repeats: 1, options: { ...OPTIONS, judge: true }, rubric });
      await settle(e.id);
      const t0 = Date.now();
      while (Object.keys(judgmentsOf(e.id)).length < 4 && Date.now() - t0 < 20_000) await new Promise((r) => setTimeout(r, 100));
      const j = judgmentsOf(e.id);
      expect(Object.values(j).map((x) => x.scores)).toEqual(Array(4).fill({ clarity: 4, focus: 2 }));
      expect(evalReport(e.id).totals['A′'].scores).toEqual({ clarity: 4, focus: 2 });
      const [runId] = Object.keys(j);
      saveJudgment(runId, rubricHash(rubric), { clarity: 1, focus: 5 }, {}, 'user');
      expect(judgmentsOf(e.id)[runId]).toMatchObject({ source: 'user', scores: { clarity: 1, focus: 5 } });

      // a judge that answers nonsense leaves runs unscored; scoring them again is asked for by hand
      fs.writeFileSync(answer, 'not json');
      const e2 = await createEval(setId, { arms: [{ label: 'A′', variantIds: [] }], repeats: 1, options: { ...OPTIONS, judge: true }, rubric });
      await settle(e2.id);
      const t1 = Date.now();
      while ((Object.keys(judgmentsOf(e2.id)).length < 4 || getEval(e2.id)!.judging) && Date.now() - t1 < 20_000) await new Promise((r) => setTimeout(r, 100));
      expect(Object.values(judgmentsOf(e2.id)).every((x) => x.rationale.error && !Object.keys(x.scores).length)).toBe(true);
      fs.writeFileSync(answer, JSON.stringify({ scores: { clarity: 3, focus: 3 }, rationale: {} }));
      expect(rejudge(e2.id)).toBe(4);
      const t2 = Date.now();
      while (Object.values(judgmentsOf(e2.id)).filter((x) => Object.keys(x.scores).length).length < 4 && Date.now() - t2 < 20_000) await new Promise((r) => setTimeout(r, 100));
      expect(Object.values(judgmentsOf(e2.id)).map((x) => x.scores)).toEqual(Array(4).fill({ clarity: 3, focus: 3 }));
      expect(getEval(e2.id)!.judging).toBe(0);
      expect(rejudge(e2.id)).toBe(0);
    } finally {
      delete process.env.FAKE_ANSWER_FILE;
    }
  });

  it('refuses matrices over 200 cells', async () => {
    const arms = [{ label: 'A′', variantIds: [] }, ...Array.from({ length: 5 }, (_, i) => ({ label: `B${i + 1}`, variantIds: [variantId] }))];
    // 4 cases × 6 groups × 10 repeats
    await expect(createEval(setId, { arms, repeats: 10, options: OPTIONS })).rejects.toThrow(/最多 200 格（现在是 240）/);
  });
});

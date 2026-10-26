import { describe, expect, it } from 'vitest';
import { aggregateEval, fisherLess, verdict, type CellInput } from '../src/core/eval/aggregate';
import type { CheckResult, TurnSummary } from '../src/shared/replay';

const pass: CheckResult = { def: { kind: 'no_loops' }, status: 'pass' };
const fail: CheckResult = { def: { kind: 'no_loops' }, status: 'fail' };
const na: CheckResult = { def: { kind: 'no_question' }, status: 'na' };
const sum = (steps: number, skills: string[] = []): TurnSummary => ({
  steps, tools: 0, toolErrors: 0, failedCommands: 0, loops: 0, inputTokens: steps * 100, outputTokens: 0, cachedTokens: 0, durationMs: 0, skillsLoaded: skills, toolSeq: [], status: 'completed',
});

describe('evaluation report', () => {
  it('judges a run by its checks', () => {
    expect(verdict([pass, na])).toBe('pass');
    expect(verdict([pass, fail])).toBe('fail');
    expect(verdict([na])).toBe('none');
    expect(verdict(undefined)).toBe('none');
  });

  it('matches known Fisher exact test values', () => {
    // all 5 of the arm fail, all 5 of the baseline pass
    expect(fisherLess(0, 5, 5, 0)).toBeCloseTo(1 / 252, 6);
    expect(fisherLess(5, 0, 5, 0)).toBe(1);
    expect(fisherLess(2, 3, 4, 1)).toBeCloseTo(0.2619, 3);
  });

  it('cells, totals, skill metrics, regressions and improvements', () => {
    const cells: CellInput[] = [];
    const add = (caseId: string, role: CellInput['role'], arm: string, n: number, checks: CheckResult[], skills: string[] = [], ok = true) => {
      for (let i = 0; i < n; i++) cells.push({ caseId, role, arm, ok, checks, summary: sum(3 + i, skills), scores: { clarity: 3 + (arm === 'B1' ? 1 : 0) } });
    };
    // positive: A′ misses the skill and fails, B1 loads it and passes
    add('p1', 'positive', 'A′', 5, [fail]);
    add('p1', 'positive', 'B1', 5, [pass], ['plugin:alpha']);
    // negative: A′ fine, B1 steals the turn (loads the skill) and fails
    add('n1', 'negative', 'A′', 5, [pass]);
    add('n1', 'negative', 'B1', 5, [fail], ['alpha']);
    // a run that could not run, and one still queued
    add('n1', 'negative', 'B1', 1, [], [], false);
    cells.push({ caseId: 'n1', role: 'negative', arm: 'B1', ok: false, pending: true });
    const r = aggregateEval({ arms: ['A′', 'B1'], baseline: 'A′', skill: 'alpha', roles: { p1: 'positive', n1: 'negative' }, cells });
    expect(r.rows.find((x) => x.caseId === 'p1')!.cells['B1']).toMatchObject({ runs: 5, judged: 5, passed: 5, passRate: 1, medianSteps: 5, medianInput: 500, skillLoaded: 5 });
    expect(r.rows.find((x) => x.caseId === 'n1')!.cells['B1']).toMatchObject({ runs: 7, judged: 5, failed: 5, errors: 1, pending: 1 });
    expect(r.totals['A′']).toMatchObject({ runs: 10, passed: 5, failed: 5, passRate: 0.5 });
    expect(r.totals['B1'].scores).toEqual({ clarity: 4 });
    expect(r.skill!.perArm['A′']).toMatchObject({ tp: 0, fn: 5, fp: 0, tn: 5, recall: 0, falseTriggerRate: 0 });
    expect(r.skill!.perArm['B1']).toMatchObject({ tp: 5, fn: 0, fp: 5, tn: 0, recall: 1, falseTriggerRate: 1, precision: 0.5 });
    expect(r.regressions).toEqual([expect.objectContaining({ caseId: 'n1', arm: 'B1', basePass: 5, armPass: 0, significant: true })]);
    expect(r.regressions[0].p).toBeCloseTo(1 / 252, 6);
    expect(r.improvements).toEqual([expect.objectContaining({ caseId: 'p1', arm: 'B1', significant: true })]);
  });

  it('runs stopped at their step limit before loading the skill are left out of recall and false triggers', () => {
    const cells: CellInput[] = [
      { caseId: 'p', role: 'positive', arm: 'A′', ok: true, unfinished: true, checks: [], summary: sum(1) },
      { caseId: 'p', role: 'positive', arm: 'A′', ok: true, unfinished: true, checks: [], summary: sum(1, ['alpha']) },
      { caseId: 'n', role: 'negative', arm: 'A′', ok: true, unfinished: true, checks: [], summary: sum(1) },
    ];
    const r = aggregateEval({ arms: ['A′'], baseline: 'A′', skill: 'alpha', roles: { p: 'positive', n: 'negative' }, cells });
    expect(r.skill!.perArm['A′']).toEqual({ tp: 1, fn: 0, fp: 0, tn: 0, recall: 1, precision: 1 });
  });

  it('few runs: a regression without a test', () => {
    const cells: CellInput[] = [
      { caseId: 'c', role: 'positive', arm: 'A′', ok: true, checks: [pass], summary: sum(2) },
      { caseId: 'c', role: 'positive', arm: 'B1', ok: true, checks: [fail], summary: sum(2) },
    ];
    const r = aggregateEval({ arms: ['A′', 'B1'], baseline: 'A′', roles: { c: 'positive' }, cells });
    expect(r.regressions).toEqual([{ caseId: 'c', arm: 'B1', basePass: 1, baseRuns: 1, armPass: 0, armRuns: 1 }]);
    expect(r.skill).toBeUndefined();
  });
});

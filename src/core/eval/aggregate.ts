import type { CaseDelta, CaseRole, CellStats, CheckResult, EvalReport, SkillMetrics, TurnSummary } from '../../shared/replay';

/**
 * An evaluation's matrix — cases × groups of changes × repeats — summed up:
 * per cell and per group the share of runs passing all their checks, the
 * median steps and input tokens; for the set's skill, recall on positives,
 * false triggers on negatives and controls, precision (runs stopped at their
 * step limit before loading it are left out: unknown); and which cases got
 * worse (or better) than the no-change baseline A′. With five or more runs on
 * both sides a one-sided Fisher exact test says whether that is more than
 * chance.
 */

export interface CellInput {
  caseId: string;
  role: CaseRole;
  arm: string;
  /** The run finished (a run stopped at its step limit counts as finished). */
  ok: boolean;
  /** Not ended yet (queued, running, paused): neither a result nor an error. */
  pending?: boolean;
  /** Stopped at its step limit before the turn ended: a skill it had not loaded yet may still have loaded. */
  unfinished?: boolean;
  checks?: CheckResult[];
  summary?: TurnSummary;
  scores?: Record<string, number>;
}

function median(xs: number[]): number | undefined {
  if (!xs.length) return undefined;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** `plugin:name` and `name` are the same skill. */
function sameSkill(a: string, b: string): boolean {
  const short = (x: string) => x.split(':').pop()!.toLowerCase();
  return a.toLowerCase() === b.toLowerCase() || short(a) === short(b);
}

/** pass / fail / not judged: a run passes when no judged check fails and at least one passed. */
export function verdict(checks: CheckResult[] | undefined): 'pass' | 'fail' | 'none' {
  if (!checks?.length) return 'none';
  if (checks.some((c) => c.status === 'fail')) return 'fail';
  return checks.some((c) => c.status === 'pass') ? 'pass' : 'none';
}

function stats(cells: CellInput[], skill?: string): CellStats {
  const ran = cells.filter((c) => c.ok);
  const v = ran.map((c) => verdict(c.checks));
  const passed = v.filter((x) => x === 'pass').length;
  const failed = v.filter((x) => x === 'fail').length;
  const judged = passed + failed;
  const scoreSums = new Map<string, { sum: number; n: number }>();
  for (const c of ran) {
    for (const [k, n] of Object.entries(c.scores ?? {})) {
      const s = scoreSums.get(k) ?? { sum: 0, n: 0 };
      scoreSums.set(k, { sum: s.sum + n, n: s.n + 1 });
    }
  }
  const pending = cells.filter((c) => !c.ok && c.pending).length;
  return {
    runs: cells.length,
    judged,
    passed,
    failed,
    errors: cells.length - ran.length - pending,
    pending,
    passRate: judged ? passed / judged : undefined,
    medianSteps: median(ran.flatMap((c) => (c.summary ? [c.summary.steps] : []))),
    medianInput: median(ran.flatMap((c) => (c.summary ? [c.summary.inputTokens] : []))),
    skillLoaded: skill ? ran.filter((c) => c.summary?.skillsLoaded.some((s) => sameSkill(s, skill))).length : 0,
    scores: scoreSums.size ? Object.fromEntries([...scoreSums].map(([k, s]) => [k, s.sum / s.n])) : undefined,
  };
}

// ------------------------------------------------------------------ Fisher exact test

const logFact: number[] = [0];
function lf(n: number): number {
  for (let i = logFact.length; i <= n; i++) logFact[i] = logFact[i - 1] + Math.log(i);
  return logFact[n];
}

function logChoose(n: number, k: number): number {
  return lf(n) - lf(k) - lf(n - k);
}

/**
 * One-sided Fisher exact test on [[a, b], [c, d]]: the chance of the first row
 * having `a` or fewer successes if both rows came from the same rate.
 */
export function fisherLess(a: number, b: number, c: number, d: number): number {
  const n = a + b + c + d;
  const row1 = a + b;
  const col1 = a + c;
  const denom = logChoose(n, col1);
  let p = 0;
  for (let k = Math.max(0, col1 - (n - row1)); k <= Math.min(a, row1, col1); k++) {
    p += Math.exp(logChoose(row1, k) + logChoose(n - row1, col1 - k) - denom);
  }
  return Math.min(1, p);
}

// ------------------------------------------------------------------ report

export function aggregateEval(o: { arms: string[]; baseline?: string; skill?: string; roles: Record<string, CaseRole>; cells: CellInput[] }): EvalReport {
  const caseIds = Object.keys(o.roles);
  const rows = caseIds.map((caseId) => ({
    caseId,
    role: o.roles[caseId],
    cells: Object.fromEntries(o.arms.map((arm) => [arm, stats(o.cells.filter((c) => c.caseId === caseId && c.arm === arm), o.skill)])),
  }));
  const totals = Object.fromEntries(o.arms.map((arm) => [arm, stats(o.cells.filter((c) => c.arm === arm), o.skill)]));

  let skill: EvalReport['skill'];
  if (o.skill) {
    const perArm: Record<string, SkillMetrics> = {};
    for (const arm of o.arms) {
      const m: SkillMetrics = { tp: 0, fn: 0, fp: 0, tn: 0 };
      for (const c of o.cells) {
        if (c.arm !== arm || !c.ok || !c.summary) continue;
        const loaded = c.summary.skillsLoaded.some((s) => sameSkill(s, o.skill!));
        // cut short before loading it: unknown, neither a miss nor a true negative
        if (!loaded && c.unfinished) continue;
        if (c.role === 'positive') m[loaded ? 'tp' : 'fn']++;
        else m[loaded ? 'fp' : 'tn']++;
      }
      if (m.tp + m.fn) m.recall = m.tp / (m.tp + m.fn);
      if (m.fp + m.tn) m.falseTriggerRate = m.fp / (m.fp + m.tn);
      if (m.tp + m.fp) m.precision = m.tp / (m.tp + m.fp);
      perArm[arm] = m;
    }
    skill = { name: o.skill, perArm };
  }

  const regressions: CaseDelta[] = [];
  const improvements: CaseDelta[] = [];
  const base = o.baseline;
  if (base) {
    for (const r of rows) {
      const b = r.cells[base];
      if (!b?.judged) continue;
      for (const arm of o.arms) {
        if (arm === base) continue;
        const x = r.cells[arm];
        if (!x?.judged) continue;
        const delta: CaseDelta = { caseId: r.caseId, arm, basePass: b.passed, baseRuns: b.judged, armPass: x.passed, armRuns: x.judged };
        if (b.judged >= 5 && x.judged >= 5) {
          delta.p = x.passed <= b.passed ? fisherLess(x.passed, x.failed, b.passed, b.failed) : fisherLess(b.passed, b.failed, x.passed, x.failed);
          delta.significant = delta.p < 0.05;
        }
        if (b.failed === 0 && x.failed > 0) regressions.push(delta);
        else if (b.failed > 0 && x.failed === 0) improvements.push(delta);
      }
    }
  }
  const worst = (a: CaseDelta, b: CaseDelta) => (a.p ?? 1) - (b.p ?? 1) || a.armPass / a.armRuns - b.armPass / b.armRuns;
  return { arms: o.arms, baseline: base, rows, totals, skill, regressions: regressions.sort(worst), improvements: improvements.sort(worst) };
}

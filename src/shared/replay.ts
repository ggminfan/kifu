import { localized } from './i18n';
/**
 * Debugging by replay (shared by server and web): a case is turn K of a
 * session; a replay continues a copy of the session from right before turn K
 * with the same agent, in isolation, with some changes (arm), and is checked.
 */
import type { AgentKind } from './agents';

/** What an agent added to the replay's context beyond the original (see core/replay/fidelity). */
export type ExtraKind = 'permissions' | 'environment' | 'skills' | 'agents_md' | 'model' | 'mode' | 'other';

// ------------------------------------------------------------------ checks

export type CheckDef =
  | { kind: 'skill_loaded'; skill: string }
  | { kind: 'skill_not_loaded'; skill: string }
  | { kind: 'tool_called'; pattern: string }
  | { kind: 'tool_not_called'; pattern: string }
  | { kind: 'no_failed_commands' }
  | { kind: 'no_tool_errors' }
  | { kind: 'no_loops' }
  | { kind: 'max_steps'; n: number }
  | { kind: 'max_input_tokens'; n: number }
  | { kind: 'answer_contains'; text: string }
  | { kind: 'answer_not_contains'; text: string }
  | { kind: 'no_question' };

export type CheckKind = CheckDef['kind'];

export interface CheckResult {
  def: CheckDef;
  status: 'pass' | 'fail' | 'na';
  detail?: string;
}

export const CHECK_LABEL: Record<CheckKind, string> = localized({
  skill_loaded: '加载了 skill',
  skill_not_loaded: '没有加载 skill',
  tool_called: '调用了工具',
  tool_not_called: '没有调用工具',
  no_failed_commands: '没有失败的命令',
  no_tool_errors: '没有失败的工具调用',
  no_loops: '没有循环',
  max_steps: '步数不超过',
  max_input_tokens: '输入 token 不超过',
  answer_contains: '回答包含',
  answer_not_contains: '回答不包含',
  no_question: '没有反问用户',
});

export function checkText(d: CheckDef): string {
  switch (d.kind) {
    case 'skill_loaded':
    case 'skill_not_loaded':
      return `${CHECK_LABEL[d.kind]} ${d.skill}`;
    case 'tool_called':
    case 'tool_not_called':
      return `${CHECK_LABEL[d.kind]} ${d.pattern}`;
    case 'max_steps':
    case 'max_input_tokens':
      return `${CHECK_LABEL[d.kind]} ${d.n}`;
    case 'answer_contains':
    case 'answer_not_contains':
      return `${CHECK_LABEL[d.kind]}「${d.text}」`;
    default:
      return CHECK_LABEL[d.kind];
  }
}

// ------------------------------------------------------------------ cases

export interface CaseMeta {
  agent: AgentKind;
  /** Source (home) the session came from. */
  sourceId?: string;
  sourceLabel?: string;
  /** The session's own file name (replay copies are named after it). */
  fileName: string;
  /** Path of that file below its sessions/ dir (e.g. 2026/09/07/rollout-….jsonl), when it had one. */
  sessionsRel?: string;
  /** The case's copy ends with turn K; replays continue its first `prefixBytes` (= `startLine` lines). */
  prefixBytes: number;
  startLine: number;
  totalBytes: number;
  turnId: string;
  cwd?: string;
  /** The commit the session started on, when the agent recorded it (clone workspaces check it out). */
  gitCommit?: string;
  model?: string;
  effort?: string;
  cliVersion?: string;
  /** Turn K's first model call: input tokens (≈ what one replay step costs). */
  firstCallInput?: number;
  /** Steps (model calls) of the original turn K. */
  originalSteps: number;
  /** Replayable, but the replay may differ from the original. */
  warnings: string[];
}

export interface CaseRecord {
  id: string;
  agent: AgentKind;
  threadId: string;
  turnIndex: number;
  title?: string;
  /** Turn K's input, as it will be sent (editable). */
  prompt: string;
  /** The original input, to tell an edited prompt apart. */
  originalPrompt: string;
  meta: CaseMeta;
  checks: CheckDef[];
  saved: boolean;
  createdAt: number;
  updatedAt: number;
}

// ------------------------------------------------------------------ replays

export type Workspace = 'readonly' | 'clone' | 'empty';

export interface Arm {
  /** "A′" (no changes) or a variant's label. */
  label: string;
  variantIds: string[];
}

export interface ReplayOptions {
  caseId: string;
  arm: Arm;
  /** Turn K's input for this replay (the case's prompt when not overridden). */
  prompt: string;
  model?: string;
  effort?: string;
  /** Stop after this many model calls. */
  maxSteps: number;
  workspace: Workspace;
  /** External tools (MCP servers) stay off unless allowed. */
  allowMcp: boolean;
  /** Variant directories, frozen when the replay was queued. */
  frozenVariants: Array<{ id: string; label: string; skillKey: string; name: string; originalDir?: string; dir: string }>;
  /** Checks beyond the case's own (an evaluation adds what the case's role in the set asks for). */
  extraChecks?: CheckDef[];
}

export interface TurnSummary {
  steps: number;
  tools: number;
  toolErrors: number;
  failedCommands: number;
  loops: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  durationMs: number;
  skillsLoaded: string[];
  toolSeq: string[];
  finalAnswer?: string;
  status: 'completed' | 'aborted' | 'failed' | 'open';
}

/** The replay's first request (reconstructed from its transcript) compared with the original's. */
export interface FidelitySummary {
  historyCoverage: number;
  baseCoverage: number;
  replayOnlyShare: number;
  /** Chars the replay's first request had beyond the original, by kind. */
  extras: Partial<Record<ExtraKind, number>>;
  /** What the agent put into the context on resume, chars by category. */
  added: Record<string, number>;
  missingChars: number;
  /** A few of the additions, for the page. */
  samples: Array<{ kind: ExtraKind; source?: string; chars: number; preview: string }>;
}

export interface ReplayResult {
  /** Tries after the model's rate limit was hit (evaluation cells back off and retry). */
  retries?: number;
  exitCode: number | null;
  wallMs: number;
  /** Stopped after `maxSteps` model calls (the turn was not finished). */
  stoppedAtMax: boolean;
  steps: number;
  /** Lines copied from the case (the replay's own records start here). */
  prefixLines: number;
  summary?: TurnSummary;
  fidelity?: FidelitySummary;
  guard: { originalUnchanged: boolean; realHomeChanges: string[]; truncated?: boolean };
  budgetParity: boolean;
  notes: string[];
  stderrTail?: string;
}

export interface CaseView extends CaseRecord {
  /** Original turn K, summarized. */
  original?: TurnSummary;
  replays: number;
  lastReplayAt?: number;
}

export interface AgentModel {
  id: string;
  label: string;
  description?: string;
  efforts?: string[];
  defaultEffort?: string;
}

// ------------------------------------------------------------------ evaluation

/** What a case is for in a set: the skill should trigger, should not, or a similar skill must keep its turn. */
export type CaseRole = 'positive' | 'negative' | 'control';

export const ROLE_LABEL: Record<CaseRole, string> = localized({ positive: '正例', negative: '反例', control: '对照' });

export interface EvalSet {
  id: string;
  name: string;
  /** The skill the set is about: positives should load it, negatives and controls should not. */
  skill?: string;
  note?: string;
  createdAt: number;
  updatedAt: number;
  cases: number;
}

export interface EvalSetCase {
  caseId: string;
  role: CaseRole;
  addedAt: number;
}

export interface RubricItem {
  id: string;
  text: string;
}

export interface EvalOptions {
  maxSteps: number;
  model?: string;
  effort?: string;
  workspace: Workspace;
  allowMcp: boolean;
  /** Grade finished runs with the agent as a judge (costs a model call each). */
  judge: boolean;
}

export type EvalStatus = 'running' | 'paused' | 'completed' | 'cancelled';

export interface EvalProgress {
  total: number;
  done: number;
  running: number;
  queued: number;
  paused: number;
  failed: number;
}

export interface EvalRecord {
  id: string;
  setId: string;
  name?: string;
  status: EvalStatus;
  arms: Arm[];
  repeats: number;
  options: EvalOptions;
  rubric?: RubricItem[];
  estimate?: { cells: number; tokens: number };
  createdAt: number;
  finishedAt?: number;
  progress?: EvalProgress;
  /** Judge calls waiting or running (model scoring). */
  judging?: number;
}

/** Runs of one case under one group of changes (or a group's totals). */
export interface CellStats {
  runs: number;
  /** Runs with at least one check judged. */
  judged: number;
  passed: number;
  failed: number;
  /** Runs that failed to run (not judged). */
  errors: number;
  /** Runs not ended yet (queued, running, paused). */
  pending: number;
  passRate?: number;
  medianSteps?: number;
  medianInput?: number;
  /** Runs that loaded the set's skill. */
  skillLoaded: number;
  /** Mean judge score per rubric item. */
  scores?: Record<string, number>;
}

export interface SkillMetrics {
  tp: number;
  fn: number;
  fp: number;
  tn: number;
  recall?: number;
  falseTriggerRate?: number;
  precision?: number;
}

export interface CaseDelta {
  caseId: string;
  arm: string;
  basePass: number;
  baseRuns: number;
  armPass: number;
  armRuns: number;
  /** One-sided Fisher exact test (both sides ≥ 5 runs). */
  p?: number;
  significant?: boolean;
}

export interface EvalReport {
  arms: string[];
  baseline?: string;
  rows: Array<{ caseId: string; role: CaseRole; cells: Record<string, CellStats> }>;
  totals: Record<string, CellStats>;
  skill?: { name: string; perArm: Record<string, SkillMetrics> };
  regressions: CaseDelta[];
  improvements: CaseDelta[];
}

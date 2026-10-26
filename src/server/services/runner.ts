import { execFile, spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import type { ExecSummary } from '../../core/compare/summary';
import type { CheckResult, ReplayOptions, ReplayResult } from '../../shared/replay';
import { dataPaths } from '../config';
import { dequeue, enqueue, clearQueue, queueBusy, queuePosition, type Lane } from './execQueue';
import { cloneEntry } from './overlay';
import { registerRollout } from './sessions';
import { tmDb } from './tmDb';
import { getVariant } from './variants';
import type { ManifestDiff } from './writeGuard';

const execFileP = promisify(execFile);

/**
 * Runs of an agent CLI that we launch: Skill Lab runs (`codex exec --json`
 * under an isolated home, baseline A′ = zero edits, B… = variants) and replays
 * (src/server/replay/engine.ts). This module keeps their records, live events,
 * cancellation and queueing; each kind brings its own executor.
 */

export type Isolation = 'readonly' | 'clone' | 'inplace';
/** `paused`: an evaluation cell waiting to be resumed (stopped by hand, or by a restart — never resumed on its own). */
export type RunStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'paused';

export interface RunOptions {
  skillKey: string;
  variantId?: string;
  /** External tools (MCP servers) stay off unless allowed. */
  allowMcp?: boolean;
  /** The variant's directory frozen when the run was queued (editing the variant later doesn't change the run). */
  frozenVariantDir?: string;
  prompt: string;
  testType: 'trigger' | 'content';
  isolation: Isolation;
  cwd: string;
  gitSha?: string;
  model?: string;
  sessionRef?: string;
  keepHooks?: boolean;
}

export interface RunResult {
  exitCode: number | null;
  wallMs: number;
  summary?: ExecSummary;
  guard?: ManifestDiff;
  authLinked: boolean;
  budgetParity: boolean;
  notes: string[];
  stderrTail?: string;
}

interface RunBase {
  id: string;
  /** Lab: the skill key; replays: `case:<id>`. */
  experiment: string;
  variantId?: string;
  label: string;
  status: RunStatus;
  prompt: string;
  threadId?: string;
  rollout?: string;
  error?: string;
  createdAt: number;
  finishedAt?: number;
}

export interface LabRun extends RunBase {
  kind: 'lab';
  options: RunOptions;
  result?: RunResult;
}

export interface ReplayRun extends RunBase {
  kind: 'replay';
  caseId: string;
  /** A cell of this evaluation. */
  evalId?: string;
  arm: string;
  rep: number;
  options: ReplayOptions;
  result?: ReplayResult;
  checks?: CheckResult[];
}

export type RunRecord = LabRun | ReplayRun;
export type RunKind = RunRecord['kind'];

export interface RunEvent {
  seq: number;
  event: 'status' | 'exec' | 'log' | 'progress' | 'done';
  data: unknown;
}

export interface Live<R extends RunRecord = RunRecord> {
  record: R;
  child?: ChildProcess;
  events: RunEvent[];
  listeners: Set<(e: RunEvent) => void>;
  cancelled: boolean;
  /** The queue handed the run to its executor: from here on only an interrupt stops it. */
  started?: boolean;
}

const WALL_TIMEOUT = 20 * 60_000;
const IDLE_TIMEOUT = 5 * 60_000;
const live = new Map<string, Live>();
const executors: { [K in RunKind]?: (l: Live<Extract<RunRecord, { kind: K }>>) => Promise<void> } = {};

/** The replay engine registers itself here (it imports this module, not the other way round). */
export function registerExecutor<K extends RunKind>(kind: K, fn: (l: Live<Extract<RunRecord, { kind: K }>>) => Promise<void>): void {
  (executors as Record<string, unknown>)[kind] = fn;
}

// ------------------------------------------------------------------ persistence

interface RunRow {
  id: string;
  kind: string | null;
  experiment: string;
  variant_id: string | null;
  label: string;
  status: RunStatus;
  prompt: string;
  options: string;
  thread_id: string | null;
  rollout: string | null;
  result: string | null;
  error: string | null;
  created_at: number;
  finished_at: number | null;
  case_id: string | null;
  eval_id: string | null;
  arm: string | null;
  rep: number | null;
  checks: string | null;
}

function fromRow(r: RunRow): RunRecord {
  const base: RunBase = {
    id: r.id,
    experiment: r.experiment,
    variantId: r.variant_id ?? undefined,
    label: r.label,
    status: r.status,
    prompt: r.prompt,
    threadId: r.thread_id ?? undefined,
    rollout: r.rollout ?? undefined,
    error: r.error ?? undefined,
    createdAt: r.created_at,
    finishedAt: r.finished_at ?? undefined,
  };
  if (r.kind === 'replay') {
    return {
      ...base,
      kind: 'replay',
      caseId: r.case_id ?? '',
      evalId: r.eval_id ?? undefined,
      arm: r.arm ?? '',
      rep: r.rep ?? 1,
      options: JSON.parse(r.options) as ReplayOptions,
      result: r.result ? (JSON.parse(r.result) as ReplayResult) : undefined,
      checks: r.checks ? (JSON.parse(r.checks) as CheckResult[]) : undefined,
    };
  }
  return { ...base, kind: 'lab', options: JSON.parse(r.options) as RunOptions, result: r.result ? (JSON.parse(r.result) as RunResult) : undefined };
}

export function saveRun(r: RunRecord): void {
  const replay = r.kind === 'replay' ? r : undefined;
  tmDb()
    .prepare(
      `insert into runs (id, kind, experiment, variant_id, label, status, prompt, options, thread_id, rollout, result, error, created_at, finished_at, case_id, arm, rep, checks, eval_id)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       on conflict(id) do update set status = excluded.status, thread_id = excluded.thread_id, rollout = excluded.rollout,
         result = excluded.result, error = excluded.error, finished_at = excluded.finished_at, checks = excluded.checks`,
    )
    .run(
      r.id,
      r.kind,
      r.experiment,
      r.variantId ?? null,
      r.label,
      r.status,
      r.prompt,
      JSON.stringify(r.options),
      r.threadId ?? null,
      r.rollout ?? null,
      r.result ? JSON.stringify(r.result) : null,
      r.error ?? null,
      r.createdAt,
      r.finishedAt ?? null,
      replay?.caseId ?? null,
      replay?.arm ?? null,
      replay?.rep ?? null,
      replay?.checks ? JSON.stringify(replay.checks) : null,
      replay?.evalId ?? null,
    );
}

export function getRun(id: string): RunRecord | undefined {
  const l = live.get(id);
  if (l) return l.record;
  const row = tmDb().prepare('select * from runs where id = ?').get(id) as unknown as RunRow | undefined;
  return row ? fromRow(row) : undefined;
}

/** Skill Lab runs of one skill (or all of them). */
export function listRuns(experiment?: string): LabRun[] {
  const db = tmDb();
  const rows = (experiment
    ? db.prepare("select * from runs where experiment = ? and coalesce(kind, 'lab') = 'lab' order by created_at desc limit 200").all(experiment)
    : db.prepare("select * from runs where coalesce(kind, 'lab') = 'lab' order by created_at desc limit 200").all()) as unknown as RunRow[];
  return rows.map((r) => (live.get(r.id)?.record ?? fromRow(r)) as LabRun);
}

export function listReplays(caseId: string): ReplayRun[] {
  const rows = tmDb().prepare("select * from runs where kind = 'replay' and case_id = ? order by created_at").all(caseId) as unknown as RunRow[];
  return rows.map((r) => (live.get(r.id)?.record ?? fromRow(r)) as ReplayRun);
}

export function deleteRunRecord(id: string): void {
  live.delete(id);
  tmDb().prepare('delete from runs where id = ?').run(id);
}

export function runByThread(threadId: string): RunRecord | undefined {
  for (const l of live.values()) if (l.record.threadId === threadId) return l.record;
  const row = tmDb().prepare('select * from runs where thread_id = ? order by created_at desc limit 1').get(threadId) as unknown as RunRow | undefined;
  return row ? fromRow(row) : undefined;
}

/**
 * On startup: runs interrupted by a restart are failed — evaluation cells are
 * paused instead (resumed by hand: they cost quota); finished runs get their
 * rollouts registered.
 */
export function initRunner(): void {
  const db = tmDb();
  db.prepare("update runs set status = 'paused', error = '服务重启，评测暂停' where status in ('queued', 'running') and eval_id is not null").run();
  db.prepare("update runs set status = 'failed', error = '服务重启，运行中断', finished_at = ? where status in ('queued', 'running')").run(Date.now());
  for (const row of db.prepare('select * from runs where thread_id is not null and rollout is not null').all() as unknown as RunRow[]) {
    const r = fromRow(row);
    // a replay's transcript starts with its copy of the case: only its own turns are shown
    registerRollout(r.threadId!, r.rollout!, r.kind === 'replay' && r.result?.prefixLines ? { prefixEnd: r.result.prefixLines } : undefined);
  }
}

// ------------------------------------------------------------------ events

export function emit(l: Live, event: RunEvent['event'], data: unknown): void {
  const e: RunEvent = { seq: l.events.length, event, data };
  if (l.events.length < 5000 || event !== 'exec') l.events.push(e);
  for (const fn of l.listeners) fn(e);
}

export function setStatus(l: Live, status: RunStatus): void {
  l.record.status = status;
  saveRun(l.record);
  emit(l, 'status', { status, position: status === 'queued' ? queuePosition(l.record.id) : undefined });
}

export function subscribe(id: string, fn: (e: RunEvent) => void): { backlog: RunEvent[]; unsubscribe: () => void } | undefined {
  const l = live.get(id);
  if (!l) return undefined;
  l.listeners.add(fn);
  return { backlog: [...l.events], unsubscribe: () => l.listeners.delete(fn) };
}

// ------------------------------------------------------------------ lifecycle

export function newRunId(): string {
  return `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
}

const doneHooks = new Set<(r: RunRecord) => void>();

/** Called after every run ends (finished, failed, cancelled; also cancelled while queued). */
export function onRunDone(fn: (r: RunRecord) => void): void {
  doneHooks.add(fn);
}

function ended(r: RunRecord): void {
  for (const fn of doneHooks) {
    try {
      fn(r);
    } catch (e) {
      console.error('run hook:', e);
    }
  }
}

/** Record runs (new, or paused ones going again) and queue them; each starts with its kind's executor. */
export function enqueueRuns(records: RunRecord[], lane: Lane = 'interactive', delayMs = 0): void {
  for (const record of records) {
    record.status = 'queued';
    saveRun(record);
    const l: Live = { record, events: [], listeners: new Set(), cancelled: false };
    live.set(record.id, l);
    const job = {
      id: record.id,
      lane,
      start: async () => {
        if (l.cancelled) return;
        l.started = true;
        const exec = executors[record.kind] as ((l: Live) => Promise<void>) | undefined;
        if (!exec) {
          record.error = `没有 ${record.kind} 类型的执行器`;
          record.finishedAt = Date.now();
          setStatus(l, 'failed');
          emit(l, 'done', record);
        } else await exec(l);
        ended(record);
      },
    };
    if (delayMs) setTimeout(() => !l.cancelled && enqueue(job), delayMs).unref?.();
    else enqueue(job);
  }
}

/** Take queued runs out of the queue without ending them (an evaluation paused by hand). */
export function pauseQueued(ids: string[]): number {
  let n = 0;
  for (const id of ids) {
    const l = live.get(id);
    // a run the queue already started (its status not yet 'running') goes on to its end
    if (!l || l.record.status !== 'queued' || l.started) continue;
    l.cancelled = true;
    dequeue(id);
    setStatus(l, 'paused');
    live.delete(id);
    n++;
  }
  return n;
}

export async function createRuns(base: RunOptions, variants: Array<string | undefined>, repeats: number): Promise<LabRun[]> {
  if (base.isolation === 'inplace' && !base.cwd) throw new Error('原地运行需要工作目录');
  const out: LabRun[] = [];
  for (const variantId of variants) {
    const v = variantId ? getVariant(variantId) : undefined;
    if (variantId && !v) throw new Error(`变体 ${variantId} 不存在`);
    for (let k = 1; k <= repeats; k++) {
      const id = newRunId();
      let frozenVariantDir: string | undefined;
      if (v) {
        frozenVariantDir = path.join(dataPaths.runs, id, 'variant');
        await fs.promises.mkdir(path.dirname(frozenVariantDir), { recursive: true, mode: 0o700 });
        await cloneEntry(v.dir, frozenVariantDir);
      }
      out.push({
        kind: 'lab',
        id,
        experiment: base.skillKey,
        variantId,
        label: `${v ? v.label : 'A′'}${repeats > 1 ? ` #${k}` : ''}`,
        status: 'queued',
        prompt: base.prompt,
        options: { ...base, variantId, frozenVariantDir },
        createdAt: Date.now(),
      });
    }
  }
  enqueueRuns(out);
  return out;
}

/** Is any run queued or executing? (idle-exit must not stop a busy server) */
export function runnerBusy(): boolean {
  return queueBusy();
}

/** Server shutdown: kill every running agent process group right away. */
export function killAllRuns(): void {
  clearQueue();
  for (const l of live.values()) {
    const pid = l.child?.pid;
    if (!pid) continue;
    l.cancelled = true;
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      l.child?.kill('SIGKILL');
    }
  }
}

export function cancelRun(id: string): boolean {
  const l = live.get(id);
  if (!l) return false;
  l.cancelled = true;
  if (l.record.status === 'queued' && !l.started) {
    dequeue(id);
    l.record.finishedAt = Date.now();
    setStatus(l, 'cancelled');
    emit(l, 'done', l.record);
    ended(l.record);
    return true;
  }
  interrupt(l);
  return true;
}

async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileP('git', args, { cwd, maxBuffer: 16 * 1024 * 1024 });
  return stdout.trim();
}

export { git };

export async function prepareWorkspace(o: RunOptions, runDir: string, notes: string[]): Promise<{ cwd: string; sandbox: 'read-only' | 'workspace-write' }> {
  if (!o.cwd || !fs.existsSync(o.cwd)) throw new Error(`工作目录不存在：${o.cwd || '(空)'}`);
  if (o.isolation === 'readonly') return { cwd: o.cwd, sandbox: 'read-only' };
  if (o.isolation === 'inplace') {
    notes.push('原地运行：agent 可以修改原工作区文件');
    return { cwd: o.cwd, sandbox: 'workspace-write' };
  }
  let top: string;
  try {
    top = await git(['rev-parse', '--show-toplevel'], o.cwd);
  } catch {
    throw new Error('工作目录不是 git 仓库，无法使用"克隆"隔离；请改用只读或原地');
  }
  const rel = path.relative(top, o.cwd);
  const wsRoot = path.join(runDir, 'ws');
  const sha = o.gitSha || (await git(['rev-parse', 'HEAD'], top));
  await git(['clone', '--shared', '--quiet', '--no-checkout', top, wsRoot], runDir);
  await git(['checkout', '--quiet', sha], wsRoot);
  notes.push(`克隆工作区于 ${sha.slice(0, 10)}`);
  if (await git(['status', '--porcelain'], top).catch(() => '')) notes.push('原仓库有未提交的改动，克隆中不包含');
  return { cwd: path.join(wsRoot, rel), sandbox: 'workspace-write' };
}

export interface SpawnOptions {
  bin: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  cwd: string;
  /** Written to stdin, which is then closed (prompts are never passed in argv). */
  input?: string;
  /** Called every `tickMs` (default 1000) while the process runs (replays watch their transcript here). */
  onTick?: () => void;
  tickMs?: number;
}

/** Interrupt a run's process group (SIGINT, then SIGKILL after `graceMs`). */
export function interrupt(l: Live, graceMs = 5000): void {
  const pid = l.child?.pid;
  if (!pid) return;
  try {
    process.kill(-pid, 'SIGINT');
  } catch {
    l.child?.kill('SIGINT');
  }
  setTimeout(() => {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      // already gone
    }
  }, graceMs).unref();
}

/** Run an agent CLI in its own process group, streaming its `--json` events to the run's listeners. */
export function spawnAgent(l: Live, o: SpawnOptions): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve, reject) => {
    // cancelled while it was getting ready: never start the agent
    if (l.cancelled) return resolve({ code: null, stderr: '' });
    const child = spawn(o.bin, o.args, { cwd: o.cwd, env: o.env, stdio: [o.input !== undefined ? 'pipe' : 'ignore', 'pipe', 'pipe'], detached: true });
    l.child = child;
    if (o.input !== undefined && child.stdin) {
      child.stdin.on('error', () => undefined);
      child.stdin.end(o.input);
    }
    const tick = o.onTick ? setInterval(o.onTick, o.tickMs ?? 1000) : undefined;
    let buf = '';
    let stderr = '';
    let idle: NodeJS.Timeout;
    const kill = (why: string) => {
      emit(l, 'log', { message: why });
      try {
        process.kill(-(child.pid ?? 0), 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    };
    const resetIdle = () => {
      clearTimeout(idle);
      idle = setTimeout(() => kill('空闲超时（5 分钟无输出），已终止'), IDLE_TIMEOUT);
    };
    const wall = setTimeout(() => kill('运行超时（20 分钟），已终止'), WALL_TIMEOUT);
    resetIdle();
    child.stdout!.on('data', (b: Buffer) => {
      resetIdle();
      buf += b.toString('utf8');
      let nl: number;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        try {
          const ev = JSON.parse(line) as { type?: string; thread_id?: string };
          if (ev.type === 'thread.started' && ev.thread_id && !l.record.threadId) {
            l.record.threadId = ev.thread_id;
            saveRun(l.record);
          }
          emit(l, 'exec', ev);
        } catch {
          emit(l, 'log', { message: line.slice(0, 500) });
        }
      }
    });
    child.stderr!.on('data', (b: Buffer) => {
      resetIdle();
      stderr = (stderr + b.toString('utf8')).slice(-8000);
    });
    child.on('error', (e) => {
      clearTimeout(idle);
      clearTimeout(wall);
      if (tick) clearInterval(tick);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(idle);
      clearTimeout(wall);
      if (tick) clearInterval(tick);
      resolve({ code, stderr });
    });
  });
}

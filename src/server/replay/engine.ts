import fsc from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { callInputIndices } from '../../core/analysis/context';
import { evaluateChecks, summarizeTurns } from '../../core/eval/checks';
import { blocksFromItems, compareContexts, type FidelityReport } from '../../core/replay/fidelity';
import type { Arm, CaseRecord, CheckDef, FidelitySummary, ReplayOptions, ReplayResult, Workspace } from '../../shared/replay';
import type { SessionTrace } from '../../shared/types';
import { dataPaths } from '../config';
import { cloneEntry, type VariantMount } from '../services/overlay';
import { getParsed, readText, type ParsedEntry } from '../services/parseCache';
import {
  emit,
  enqueueRuns,
  git,
  interrupt,
  newRunId,
  registerExecutor,
  saveRun,
  setStatus,
  spawnAgent,
  type Live,
  type ReplayRun,
} from '../services/runner';
import { registerRollout } from '../services/sessions';
import { getVariant, mountName } from '../services/variants';
import { diffManifests, snapshot as guardSnapshot } from '../services/writeGuard';
import { sources } from '../sources/registry';
import { adapterFor } from './adapter';
import { caseEntry, caseFile, homeFor, mustGetCase, originalFile, touchCase } from './cases';
import { newSessionId, replayCopy } from './copy';
import './codex';

/**
 * Replays of a case: continue a copy of the session from right before turn K
 * with the same agent CLI, in an isolated home, with this arm's changes; stop
 * when the turn ends or after `maxSteps` model calls; then measure what the
 * replay did (summary, checks) and how faithful its start was (fidelity).
 */

export interface ReplayRequest {
  arms: Arm[];
  repeats?: number;
  prompt?: string;
  model?: string;
  effort?: string;
  maxSteps?: number;
  workspace?: Workspace;
  allowMcp?: boolean;
}

export const DEFAULT_MAX_STEPS = 30;

/** Rough token use: each step resends the context (mostly cached). */
export function estimateTokens(c: CaseRecord, req: ReplayRequest): { replays: number; perReplay: number; total: number } {
  const replays = req.arms.length * clampRepeats(req.repeats);
  const steps = Math.min(req.maxSteps ?? DEFAULT_MAX_STEPS, Math.max(1, c.meta.originalSteps + 2));
  const perReplay = Math.round((c.meta.firstCallInput ?? 30_000) * steps * 1.05);
  return { replays, perReplay, total: perReplay * replays };
}

function clampRepeats(n: number | undefined): number {
  return Math.min(5, Math.max(1, Math.floor(n ?? 1)));
}

/** Freeze the arm's variants now: editing a variant later must not change queued replays. */
async function freezeVariants(runDir: string, arm: Arm): Promise<ReplayOptions['frozenVariants']> {
  const out: ReplayOptions['frozenVariants'] = [];
  for (const id of arm.variantIds) {
    const v = getVariant(id);
    if (!v) throw new Error(`变体 ${id} 不存在`);
    const dir = path.join(runDir, 'variants', v.id);
    await fs.mkdir(path.dirname(dir), { recursive: true, mode: 0o700 });
    await cloneEntry(v.dir, dir);
    out.push({ id: v.id, label: v.label, skillKey: v.skillKey, name: mountName(v), originalDir: v.originalPath || undefined, dir });
  }
  return out;
}

/** Replay runs of a case (one per arm × repeat), variants frozen, not queued yet. */
export async function buildReplayRuns(c: CaseRecord, req: ReplayRequest, extra: { evalId?: string; extraChecks?: CheckDef[] } = {}): Promise<ReplayRun[]> {
  if (!adapterFor(c.agent)) throw new Error(`不支持回放 ${c.agent} 会话`);
  if (!req.arms.length) throw new Error('至少需要一组改动（A′ 表示不改动）');
  const repeats = clampRepeats(req.repeats);
  const maxSteps = Math.min(200, Math.max(1, Math.floor(req.maxSteps ?? DEFAULT_MAX_STEPS)));
  const out: ReplayRun[] = [];
  for (const arm of req.arms) {
    for (let k = 1; k <= repeats; k++) {
      const id = newRunId();
      const runDir = path.join(dataPaths.runs, id);
      await fs.mkdir(runDir, { recursive: true, mode: 0o700 });
      const options: ReplayOptions = {
        caseId: c.id,
        arm,
        prompt: req.prompt ?? c.prompt,
        model: req.model || c.meta.model,
        effort: req.effort || c.meta.effort,
        maxSteps,
        workspace: req.workspace ?? 'readonly',
        allowMcp: Boolean(req.allowMcp),
        frozenVariants: await freezeVariants(runDir, arm),
        extraChecks: extra.extraChecks?.length ? extra.extraChecks : undefined,
      };
      out.push({
        kind: 'replay',
        id,
        experiment: extra.evalId ? `eval:${extra.evalId}` : `case:${c.id}`,
        caseId: c.id,
        evalId: extra.evalId,
        arm: arm.label,
        rep: k,
        label: `${arm.label}${repeats > 1 ? ` #${k}` : ''}`,
        status: 'queued',
        prompt: options.prompt,
        options,
        createdAt: Date.now(),
      });
    }
  }
  return out;
}

export async function createReplays(caseId: string, req: ReplayRequest): Promise<ReplayRun[]> {
  if (req.arms.length > 6) throw new Error('一次最多 6 组改动');
  const out = await buildReplayRuns(mustGetCase(caseId), req);
  enqueueRuns(out, 'interactive');
  touchCase(caseId);
  return out;
}

/** The model's rate limit (429): an evaluation cell waits and tries again, up to MAX_RETRIES times. */
const RATE_LIMIT = /\b429\b|rate.?limit|too many requests|quota exceeded|请求过于频繁|限流/i;
const MAX_RETRIES = 3;

// ------------------------------------------------------------------ execution

async function prepareWorkspace(kind: Workspace, cwd: string | undefined, runDir: string, notes: string[], commit?: string): Promise<{ cwd: string; sandbox: 'read-only' | 'workspace-write' }> {
  const exists = Boolean(cwd && fsc.existsSync(cwd));
  if (kind !== 'empty' && !exists) notes.push(`原工作目录${cwd ? ` ${cwd} ` : ''}不在本机，改用空目录`);
  if (kind === 'readonly' && exists) return { cwd: cwd!, sandbox: 'read-only' };
  if (kind === 'clone' && exists) {
    try {
      const top = await git(['rev-parse', '--show-toplevel'], cwd!);
      const ws = path.join(runDir, 'ws');
      await git(['clone', '--shared', '--quiet', top, ws], runDir);
      let at = 'HEAD';
      if (commit) {
        try {
          await git(['checkout', '--quiet', commit], ws);
          at = commit.slice(0, 10);
        } catch {
          notes.push(`原会话开始时的 commit ${commit.slice(0, 10)} 不在本地仓库里`);
        }
      }
      notes.push(`工作区：克隆的 ${at}（未提交的改动不在其中）`);
      return { cwd: path.join(ws, path.relative(top, cwd!)), sandbox: 'workspace-write' };
    } catch {
      notes.push('工作目录不是 git 仓库，改为只读');
      return { cwd: cwd!, sandbox: 'read-only' };
    }
  }
  const ws = path.join(runDir, 'ws');
  await fs.mkdir(ws, { recursive: true });
  return { cwd: ws, sandbox: 'workspace-write' };
}

/**
 * Model calls the agent recorded after `fromByte`: Codex writes a token_usage_record
 * per response; older versions a token_count with this call's usage.
 */
function makeStepCounter(file: string, fromByte: number) {
  let offset = fromByte;
  let tail = '';
  let counts = 0;
  let records = 0;
  return () => {
    let fd: number | undefined;
    const steps = () => (records ? records : counts);
    try {
      const size = fsc.statSync(file).size;
      if (size <= offset) return steps();
      fd = fsc.openSync(file, 'r');
      const buf = Buffer.alloc(size - offset);
      fsc.readSync(fd, buf, 0, buf.length, offset);
      offset = size;
      const lines = (tail + buf.toString('utf8')).split('\n');
      tail = lines.pop() ?? '';
      for (const l of lines) {
        if (l.includes('"type":"token_usage_record"')) {
          records++;
          continue;
        }
        if (!l.includes('"token_count"')) continue;
        try {
          const rec = JSON.parse(l) as { payload?: { type?: string; info?: { last_token_usage?: { input_tokens?: number } } } };
          if (rec.payload?.type === 'token_count' && (rec.payload.info?.last_token_usage?.input_tokens ?? 0) > 0) counts++;
        } catch {
          // not a whole record
        }
      }
    } catch {
      // the file may be moved or not written yet
    } finally {
      if (fd !== undefined) fsc.closeSync(fd);
    }
    return steps();
  };
}

async function fullTexts(entry: ParsedEntry, indices: number[]) {
  const out: Array<{ kind: string; role?: string; cat: string; text: string }> = [];
  for (const idx of indices) {
    const it = entry.trace.items[idx];
    const text = it.preview.length < it.chars ? (await readText(entry, it.ref)).text : it.preview;
    out.push({ kind: it.kind, role: it.role, cat: it.cat, text });
  }
  return out;
}

async function baseText(entry: ParsedEntry): Promise<string | undefined> {
  const b = entry.trace.meta.baseInstructions;
  if (!b) return undefined;
  return b.ref ? (await readText(entry, b.ref)).text : b.preview;
}

function firstResponse(trace: SessionTrace, turnIndex?: number) {
  const calls = turnIndex === undefined ? trace.calls : trace.turns[turnIndex]?.calls.map((i) => trace.calls[i]) ?? [];
  return calls.find((c) => c?.kind === 'response' && c.model !== '<synthetic>');
}

function summarizeFidelity(report: FidelityReport, added: Record<string, number>): FidelitySummary {
  const extras: FidelitySummary['extras'] = {};
  for (const e of report.extras) if (e.scope === 'history') extras[e.kind] = (extras[e.kind] ?? 0) + e.chars;
  return {
    historyCoverage: report.history.coverage,
    baseCoverage: report.base.coverage,
    replayOnlyShare: report.history.extraShare,
    extras,
    added,
    missingChars: report.missing.filter((m) => m.scope === 'history').reduce((s, m) => s + m.chars, 0),
    samples: report.extras
      .filter((e) => e.scope === 'history')
      .sort((a, b) => b.chars - a.chars)
      .slice(0, 8)
      .map((e) => ({ kind: e.kind, source: e.source, chars: e.chars, preview: e.preview })),
  };
}

/** How the replay's first request compares with the original turn K's first one. */
async function measureFidelity(o: { original: ParsedEntry; turnIndex: number; replay: ParsedEntry; prefixLines: number; pathMap: Array<[string, string]> }): Promise<FidelitySummary | undefined> {
  const oc = firstResponse(o.original.trace, o.turnIndex);
  const rc = firstResponse(o.replay.trace);
  if (!oc || !rc) return undefined;
  const original = blocksFromItems(await fullTexts(o.original, callInputIndices(o.original.trace, oc)), await baseText(o.original));
  const indices = callInputIndices(o.replay.trace, rc);
  const added: Record<string, number> = {};
  for (const i of indices) {
    const it = o.replay.trace.items[i];
    if (it.line >= o.prefixLines && it.cat !== 'user') added[it.cat] = (added[it.cat] ?? 0) + it.chars;
  }
  const replay = blocksFromItems(await fullTexts(o.replay, indices), await baseText(o.replay));
  return summarizeFidelity(compareContexts(original, replay, { pathMap: o.pathMap }), added);
}

function fallbackHome(agent: CaseRecord['agent']): { home: string; dataRoot: string } | undefined {
  const s = sources().find((x) => x.agent === agent);
  return s ? { home: s.home, dataRoot: s.dataRoot } : undefined;
}

function today(): string {
  const d = new Date();
  return [d.getFullYear(), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0')].join('/');
}

async function executeReplay(l: Live<ReplayRun>): Promise<void> {
  const r = l.record;
  const o = r.options;
  const runDir = path.join(dataPaths.runs, r.id);
  const notes: string[] = [];
  const t0 = Date.now();
  let cleanup: (() => Promise<(f: string) => string>) | undefined;
  const result: ReplayResult = { retries: r.result?.retries, exitCode: null, wallMs: 0, stoppedAtMax: false, steps: 0, prefixLines: 0, guard: { originalUnchanged: true, realHomeChanges: [] }, budgetParity: true, notes };
  r.result = result;
  let retry: number | undefined;
  try {
    await fs.mkdir(runDir, { recursive: true, mode: 0o700 });
    // running again (a retry, a resumed evaluation): start clean, keep the frozen variants
    for (const name of await fs.readdir(runDir)) if (name !== 'variants') await fs.rm(path.join(runDir, name), { recursive: true, force: true });
    setStatus(l, 'running');
    const c = mustGetCase(o.caseId);
    const adapter = adapterFor(c.agent);
    const bin = adapter?.bin();
    if (!adapter || !bin) throw new Error(`本机没有找到 ${c.agent} 命令行`);
    const homes = homeFor(c, () => fallbackHome(c.agent));
    if (!homes) throw new Error(`本机没有 ${c.agent} 的 home`);

    const mounts: VariantMount[] = o.frozenVariants.map((v) => ({ originalDir: v.originalDir, variantDir: v.dir, name: v.name }));
    const home = await adapter.prepare({ runDir, home: homes.home, dataRoot: homes.dataRoot, variants: mounts, allowMcp: o.allowMcp });
    cleanup = home.cleanup;
    result.budgetParity = home.budgetParity;
    notes.push(...home.notes);
    if (!o.allowMcp) notes.push('外部工具（MCP 服务器）已关闭');

    // the copy: the case up to turn K, under a new session id
    const newId = newSessionId(c.threadId);
    // agents find a session by the id in its file name, in any date dir
    const name = c.meta.fileName.includes(c.threadId) ? c.meta.fileName.split(c.threadId).join(newId) : `rollout-${newId}.jsonl`;
    const copy = path.join(home.sessionsDir, today(), name);
    const copied = await replayCopy(caseFile(c), copy, { bytes: c.meta.prefixBytes, oldId: c.threadId, newId });
    result.prefixLines = copied.lines;
    r.threadId = newId;
    r.rollout = copy;
    saveRun(r);
    registerRollout(newId, copy, { prefixEnd: copied.lines });
    emit(l, 'log', { message: `副本就绪：${copied.lines} 行，新会话 ${newId}` });

    const ws = await prepareWorkspace(o.workspace, c.meta.cwd, runDir, notes, c.meta.gitCommit);
    const original = originalFile(c);
    const originalStat = original ? await fs.stat(original).catch(() => undefined) : undefined;
    const roots = adapter.guardRoots(homes);
    const before = await guardSnapshot(roots);

    const steps = makeStepCounter(copy, copied.bytes);
    const args = adapter.argv({ newId, cwd: ws.cwd, sandbox: ws.sandbox, model: o.model, effort: o.effort });
    emit(l, 'log', { message: `${c.agent} ${args.join(' ')}（输入从 stdin 传入）` });
    let lastSteps = 0;
    const res = await spawnAgent(l, {
      bin,
      args,
      env: home.env,
      cwd: ws.cwd,
      input: o.prompt,
      // the step limit stops the agent between model calls: look often, so a quick tool call does not let one more request start
      tickMs: 250,
      onTick: () => {
        const n = steps();
        if (n !== lastSteps) {
          lastSteps = n;
          emit(l, 'progress', { steps: n, maxSteps: o.maxSteps });
        }
        if (n >= o.maxSteps && !result.stoppedAtMax) {
          result.stoppedAtMax = true;
          emit(l, 'log', { message: `已到 ${o.maxSteps} 步，停止` });
          interrupt(l);
        }
      },
    });
    result.exitCode = res.code;
    result.stderrTail = res.stderr.slice(-2000) || undefined;
    result.steps = steps();

    const after = await guardSnapshot(roots);
    const diff = diffManifests(before, after);
    result.guard.realHomeChanges = [...diff.added, ...diff.removed, ...diff.changed].slice(0, 50);
    result.guard.truncated = before.truncated || after.truncated || undefined;
    if (original && originalStat) {
      const now = await fs.stat(original).catch(() => undefined);
      result.guard.originalUnchanged = Boolean(now && now.size === originalStat.size && now.mtimeMs === originalStat.mtimeMs);
    }
    if (result.guard.realHomeChanges.length) notes.push('真实 home 里有文件变化（可能来自同时在用的 agent），请检查');
    if (!result.guard.originalUnchanged) notes.push('原会话文件在回放期间发生了变化');

    const move = await home.cleanup();
    cleanup = undefined;
    r.rollout = move(copy);
    registerRollout(newId, r.rollout, { prefixEnd: copied.lines });

    // what the replay did, and how faithful its start was
    const replay = await getParsed(r.rollout, { prefixEnd: copied.lines });
    const ran = Boolean(firstResponse(replay.trace));
    if (ran) {
      // shown next to the original: the isolated home's paths read as the real ones
      const real = (t: string) => home.pathMap.reduce((acc, [from, to]) => (from ? acc.split(from).join(to) : acc), t);
      result.summary = summarizeTurns(replay.trace, 0, replay.trace.turns.length, undefined, real);
      const finalTxt = replay.trace.turns[replay.trace.turns.length - 1]?.lastAgentMessage;
      const answer = finalTxt?.ref ? (await readText(replay, finalTxt.ref)).text : finalTxt?.preview;
      r.checks = evaluateChecks(replay.trace, [...c.checks, ...(o.extraChecks ?? [])], { stoppedAtMax: result.stoppedAtMax, answer });
      try {
        result.fidelity = await measureFidelity({
          original: await caseEntry(c),
          turnIndex: c.turnIndex,
          replay,
          prefixLines: copied.lines,
          pathMap: [...home.pathMap, [ws.cwd, c.meta.cwd ?? ws.cwd]],
        });
      } catch (e) {
        notes.push(`保真度没有算出来：${(e as Error).message}`);
      }
    }
    result.wallMs = Date.now() - t0;
    r.finishedAt = Date.now();
    if (l.cancelled) setStatus(l, 'cancelled');
    else if (ran && (res.code === 0 || result.stoppedAtMax)) setStatus(l, 'completed');
    else if (!ran && r.evalId && RATE_LIMIT.test(result.stderrTail ?? '') && (result.retries ?? 0) < MAX_RETRIES) {
      // hit the rate limit before any model call: back off and go again
      result.retries = (result.retries ?? 0) + 1;
      const wait = (Number(process.env.KIFU_RETRY_BASE_MS) || 30_000) * 2 ** (result.retries - 1);
      notes.push(`遇到限流，${Math.round(wait / 1000)} 秒后重试（第 ${result.retries} 次）`);
      r.finishedAt = undefined;
      retry = wait;
    } else {
      r.error = ran ? `${c.agent} 退出码 ${res.code}` : `${c.agent} 没有调用模型（退出码 ${res.code}）${result.stderrTail ? `：${result.stderrTail.slice(-300)}` : ''}`;
      setStatus(l, 'failed');
    }
  } catch (e) {
    r.error = (e as Error).message;
    result.wallMs = Date.now() - t0;
    r.finishedAt = Date.now();
    setStatus(l, l.cancelled ? 'cancelled' : 'failed');
  } finally {
    if (cleanup) await cleanup().catch(() => undefined);
    l.child = undefined;
    if (retry !== undefined && !l.cancelled) {
      emit(l, 'log', { message: notes[notes.length - 1] });
      enqueueRuns([r], 'batch', retry);
    } else {
      saveRun(r);
      emit(l, 'done', r);
    }
  }
}

registerExecutor('replay', executeReplay);

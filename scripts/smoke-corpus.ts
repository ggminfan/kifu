/**
 * Parse every local session of one agent and print aggregate health statistics.
 * Never prints session content — only counts, timings and id prefixes.
 *
 *   pnpm smoke                    Codex rollouts (CODEX_HOME, default ~/.codex)
 *   pnpm smoke --agent claude     Claude Code transcripts (CLAUDE_CONFIG_DIR, default ~/.claude)
 *   pnpm smoke --limit 50         newest 50 files
 *   pnpm smoke --cuts             also check replay cut points: no record of turn K
 *                                 before its cut, and a parse of the copy up to the cut
 *                                 equals the original's earlier turns
 */
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { isAgentKind, type AgentKind } from '../src/shared/agents';
import { parseSession, type LineIndex } from '../src/core/parse';
import { turnCuts } from '../src/core/replay/cut';
import type { SessionTrace } from '../src/shared/types';
import { claudeHomeDefault, listClaudeProjects, summarizeFile } from '../src/server/sources/claude';
import { codexHomeDefault } from '../src/server/sources/codex';
import { openReadOnly } from '../src/server/sources/threadsDb';

const args = process.argv.slice(2);
const opt = (name: string) => {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
};
const limit = Number(opt('--limit') ?? Infinity);
const checkCuts = args.includes('--cuts');
const agentArg = opt('--agent') ?? 'codex';
if (!isAgentKind(agentArg)) {
  console.error(`unknown agent: ${agentArg} (codex | claude)`);
  process.exit(2);
}
const agent: AgentKind = agentArg;

async function walk(dir: string, keep: (f: string) => boolean): Promise<string[]> {
  try {
    return ((await fs.readdir(dir, { recursive: true })) as string[]).filter(keep).map((f) => path.join(dir, f));
  } catch {
    return [];
  }
}

/** Session files, and the token counts the agent itself records (by session id) to compare with. */
async function corpus(): Promise<{ files: string[]; tokens: (id: string, file: string) => number | undefined }> {
  if (agent === 'claude') {
    const home = claudeHomeDefault();
    if (!home) throw new Error('no Claude Code projects found');
    const files: string[] = [];
    for (const p of listClaudeProjects(home)) files.push(...(await walk(p.dir, (f) => f.endsWith('.jsonl') && (!f.includes('/') || f.includes('/subagents/')))));
    // the session list's own count (one usage per API response)
    return { files, tokens: (_id, file) => summarizeFile(file, '').tokens || undefined };
  }
  const dataRoot = codexHomeDefault();
  if (!dataRoot) throw new Error('no Codex home found');
  const files = await walk(path.join(dataRoot, 'sessions'), (f) => f.endsWith('.jsonl') && path.basename(f).startsWith('rollout-'));
  const byId = new Map<string, number>();
  try {
    const db = openReadOnly(path.join(dataRoot, 'state_5.sqlite'));
    for (const row of db.prepare('select id, tokens_used from threads').all() as Array<{ id: string; tokens_used: number }>) byId.set(row.id, row.tokens_used);
    db.close();
  } catch {
    // no thread index: no token check
  }
  return { files, tokens: (id) => byId.get(id) };
}

/** Copies of more than this are not written to disk for the equivalence check. */
const CUT_COPY_MAX = 64 * 1024 * 1024;

interface CutStats {
  turns: number;
  replayable: number;
  reasons: Map<string, number>;
  warnings: Map<string, number>;
  checked: number;
  leaks: number;
  mismatches: number;
  skippedLarge: number;
  prefixBytes: number;
  examples: string[];
}

function cutStats(): CutStats {
  return { turns: 0, replayable: 0, reasons: new Map(), warnings: new Map(), checked: 0, leaks: 0, mismatches: 0, skippedLarge: 0, prefixBytes: 0, examples: [] };
}

const bump = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);

/** Up to three replayable turns after the first: the first, a middle and the last one. */
function sample<T>(xs: T[]): T[] {
  if (xs.length <= 3) return xs;
  return [xs[0], xs[Math.floor(xs.length / 2)], xs[xs.length - 1]];
}

async function checkFileCuts(file: string, trace: SessionTrace, index: LineIndex, c: CutStats): Promise<void> {
  const format = agent === 'claude' ? 'claude' : 'rollout';
  const cuts = turnCuts(trace, index, format);
  c.turns += cuts.length;
  for (const cut of cuts) {
    if (cut.replayable) c.replayable++;
    for (const r of cut.reasons) bump(c.reasons, r);
    for (const w of cut.warnings) bump(c.warnings, w);
  }
  const candidates = sample(cuts.filter((x) => x.replayable && x.turnIndex > 0));
  if (!candidates.length) return;
  const raw = await fs.readFile(file);
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'kifu-cut-'));
  try {
    for (const cut of candidates) {
      c.checked++;
      c.prefixBytes += cut.prefixBytes;
      // 1. nothing of turn K before the cut
      const needle = Buffer.from(format === 'claude' ? `"promptId":"${cut.turnId}"` : `"turn_id":"${cut.turnId}"`);
      const at = raw.subarray(0, cut.prefixBytes).indexOf(needle);
      if (at !== -1) {
        c.leaks++;
        if (c.examples.length < 8) c.examples.push(`leak ${trace.meta.threadId.slice(0, 8)} turn ${cut.turnIndex}`);
      }
      // 2. the copy parses into exactly the turns, calls and items before the cut
      if (cut.prefixBytes > CUT_COPY_MAX) {
        c.skippedLarge++;
        continue;
      }
      const copy = path.join(tmp, path.basename(file));
      fsSync.writeFileSync(copy, raw.subarray(0, cut.prefixBytes));
      const { trace: p } = await parseSession(copy);
      const turnIds = trace.turns.filter((t) => t.index < cut.turnIndex).map((t) => t.id);
      const calls = trace.calls.filter((x) => x.line < cut.startLine).length;
      const items = trace.items.filter((x) => x.line < cut.startLine).length;
      const same = JSON.stringify(p.turns.map((t) => t.id)) === JSON.stringify(turnIds) && p.calls.length === calls && p.items.length === items;
      if (!same) {
        c.mismatches++;
        if (c.examples.length < 8) {
          c.examples.push(
            `mismatch ${trace.meta.threadId.slice(0, 8)} turn ${cut.turnIndex}: turns ${p.turns.length}/${turnIds.length}, calls ${p.calls.length}/${calls}, items ${p.items.length}/${items}`,
          );
        }
      }
    }
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
}

async function main() {
  const { files, tokens } = await corpus();
  const stats = await Promise.all(files.map(async (f) => ({ f, st: await fs.stat(f) })));
  stats.sort((a, b) => b.st.mtimeMs - a.st.mtimeMs);
  const selected = stats.slice(0, Number.isFinite(limit) ? limit : stats.length);

  const diag = new Map<string, { count: number; files: number }>();
  const crashes: string[] = [];
  let totalMs = 0;
  let slowest = { ms: 0, mb: 0, id: '' };
  const n = { turns: 0, noInput: 0, calls: 0, orphan: 0, noUsage: 0, tools: 0, unanswered: 0, toolErrors: 0, orphanEvents: 0, forks: 0, subagents: 0, linked: 0, listings: 0, invocations: 0 };
  const tokenCheck = { compared: 0, within2: 0, worst: [] as Array<{ id: string; ours: number; theirs: number; pct: number }> };
  const cuts = cutStats();
  const t0 = Date.now();

  for (const [i, { f, st }] of selected.entries()) {
    const start = Date.now();
    try {
      const { trace, index } = await parseSession(f);
      if (checkCuts) await checkFileCuts(f, trace, index, cuts);
      const ms = Date.now() - start;
      totalMs += ms;
      if (ms > slowest.ms) slowest = { ms, mb: Math.round(st.size / 1e6), id: trace.meta.threadId.slice(0, 8) };
      n.turns += trace.turns.length;
      n.noInput += trace.turns.filter((t) => t.calls.length && !t.input).length;
      n.calls += trace.calls.length;
      n.orphan += trace.calls.filter((c) => c.kind === 'orphan').length;
      n.noUsage += trace.calls.filter((c) => !c.usage).length;
      n.tools += Object.keys(trace.tools).length;
      n.unanswered += Object.values(trace.tools).filter((t) => t.status !== 'done').length;
      n.toolErrors += trace.totals.toolErrors;
      n.orphanEvents += trace.orphanEvents.length;
      n.subagents += trace.subagents.length;
      n.linked += trace.subagents.filter((s) => s.childThreadId).length;
      n.listings += trace.listings.length;
      n.invocations += trace.invocations.length;
      if (trace.forkPrefix) n.forks++;
      for (const d of trace.diagnostics) {
        const key = `${d.kind}:${d.detail}`;
        const prev = diag.get(key) ?? { count: 0, files: 0 };
        diag.set(key, { count: prev.count + d.count, files: prev.files + 1 });
      }
      const theirs = tokens(trace.meta.threadId, f);
      if (!trace.forkPrefix && theirs && theirs > 0) {
        const ours = trace.totals.usage.total;
        const pct = Math.abs(ours - theirs) / theirs;
        tokenCheck.compared++;
        if (pct <= 0.02) tokenCheck.within2++;
        else tokenCheck.worst.push({ id: trace.meta.threadId.slice(0, 8), ours, theirs, pct });
      }
    } catch (e) {
      crashes.push(`${path.basename(f).slice(0, 40)}: ${(e as Error).message.slice(0, 160)}`);
    }
    if ((i + 1) % 100 === 0) console.log(`… ${i + 1}/${selected.length} files`);
  }

  tokenCheck.worst.sort((a, b) => b.pct - a.pct);
  console.log(`\n=== smoke-corpus (${agent})`);
  console.log(`files: ${selected.length}, crashes: ${crashes.length}, wall: ${((Date.now() - t0) / 1000).toFixed(1)}s, parse total: ${(totalMs / 1000).toFixed(1)}s`);
  console.log(`slowest: ${slowest.ms}ms (${slowest.mb} MB, session ${slowest.id}…)`);
  console.log(`turns: ${n.turns} (with calls but no input: ${n.noInput})`);
  console.log(`calls: ${n.calls} (orphan: ${n.orphan}, without usage: ${n.noUsage})`);
  console.log(`tools: ${n.tools} (no result: ${n.unanswered}, errors: ${n.toolErrors}), orphan events: ${n.orphanEvents}`);
  console.log(`subagent links: ${n.subagents} (with child session: ${n.linked}), forked subagents: ${n.forks}`);
  console.log(`skill listings: ${n.listings}, skill invocations: ${n.invocations}`);
  console.log(`token check vs ${agent === 'claude' ? 'session list' : 'threads.tokens_used'} (non-fork): ${tokenCheck.within2}/${tokenCheck.compared} within 2%`);
  for (const w of tokenCheck.worst.slice(0, 8)) {
    console.log(`  ${w.id}… ours=${w.ours} theirs=${w.theirs} (${(w.pct * 100).toFixed(1)}%)`);
  }
  console.log('diagnostics:');
  for (const [k, v] of [...diag.entries()].sort((a, b) => b[1].count - a[1].count).slice(0, 25)) {
    console.log(`  ${k}  ×${v.count} in ${v.files} files`);
  }
  if (checkCuts) {
    console.log(`replay cuts: ${cuts.replayable}/${cuts.turns} turns replayable; checked ${cuts.checked} (avg copy ${cuts.checked ? (cuts.prefixBytes / cuts.checked / 1e6).toFixed(1) : 0} MB, ${cuts.skippedLarge} too large to copy)`);
    console.log(`  turn records before the cut: ${cuts.leaks}; copy parses differently: ${cuts.mismatches}`);
    for (const [k, v] of [...cuts.reasons.entries()].sort((a, b) => b[1] - a[1])) console.log(`  not replayable: ${k} ×${v}`);
    for (const [k, v] of [...cuts.warnings.entries()].sort((a, b) => b[1] - a[1])) console.log(`  warning: ${k} ×${v}`);
    for (const e of cuts.examples) console.log(`  ${e}`);
  }
  for (const c of crashes.slice(0, 10)) console.log(`CRASH ${c}`);
  process.exit(crashes.length || (checkCuts && (cuts.leaks || cuts.mismatches)) ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});

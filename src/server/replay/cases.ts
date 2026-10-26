import fsc from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { skillReport } from '../../core/analysis/skills';
import { summarizeTurns, suggestChecks } from '../../core/eval/checks';
import { turnCuts } from '../../core/replay/cut';
import type { CaseMeta, CaseRecord, CaseView, CheckDef, TurnSummary } from '../../shared/replay';
import { dataPaths } from '../config';
import { getParsed, readRecord, readText, type ParsedEntry } from '../services/parseCache';
import { NotFound, parsedSession, registerRollout, resolveRollout, unregisterRollout } from '../services/sessions';
import { diskLookupFor } from '../services/skillFiles';
import { sourceIdOf } from '../services/stateDb';
import { tmDb } from '../services/tmDb';
import { currentAgent, sourceById } from '../sources/registry';
import { clonePrefix } from './copy';

/**
 * Cases: turn K of a session, kept as a cheap clone of the session up to the
 * end of turn K (`cases/<id>/session.jsonl`). Replays continue its first part
 * (up to turn K's start); the rest is the original turn K to compare against,
 * so a case still works when the original session is gone.
 */

interface CaseRow {
  id: string;
  agent: string;
  thread_id: string;
  turn_index: number;
  title: string | null;
  prompt: string;
  meta: string;
  checks: string;
  saved: number;
  created_at: number;
  updated_at: number;
}

interface StoredMeta extends CaseMeta {
  originalPrompt: string;
}

export function caseDir(id: string): string {
  return path.join(dataPaths.cases, path.basename(id));
}

export function caseFile(c: Pick<CaseRecord, 'id'>): string {
  return path.join(caseDir(c.id), 'session.jsonl');
}

/** The id under which the case's own copy can be opened like a session (`/s/case-<id>`). */
export function caseSessionKey(id: string): string {
  return `case-${id}`;
}

function fromRow(r: CaseRow): CaseRecord {
  const { originalPrompt, ...meta } = JSON.parse(r.meta) as StoredMeta;
  return {
    id: r.id,
    agent: meta.agent,
    threadId: r.thread_id,
    turnIndex: r.turn_index,
    title: r.title ?? undefined,
    prompt: r.prompt,
    originalPrompt,
    meta,
    checks: JSON.parse(r.checks) as CheckDef[],
    saved: Boolean(r.saved),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export function getCase(id: string): CaseRecord | undefined {
  const row = tmDb().prepare('select * from cases where id = ?').get(id) as unknown as CaseRow | undefined;
  return row ? fromRow(row) : undefined;
}

export function mustGetCase(id: string): CaseRecord {
  const c = getCase(id);
  if (!c) throw new NotFound('用例不存在');
  return c;
}

export function listCases(): CaseRecord[] {
  return (tmDb().prepare('select * from cases order by updated_at desc limit 500').all() as unknown as CaseRow[]).map(fromRow);
}

/** On startup: make every case's copy openable. */
export function registerCases(): void {
  for (const c of listCases()) if (fsc.existsSync(caseFile(c))) registerRollout(caseSessionKey(c.id), caseFile(c));
}

function newCaseId(): string {
  return `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
}

/** Model and effort of the turn starting at `line` (its turn_context, right after task_started). */
async function turnSettings(entry: Pick<ParsedEntry, 'path' | 'index'>, line: number): Promise<{ model?: string; effort?: string }> {
  for (let i = line; i < Math.min(entry.index.kinds.length, line + 8); i++) {
    if (entry.index.kinds[i] !== 'turn_context') continue;
    const p = ((await readRecord(entry, i)).payload ?? {}) as { model?: unknown; effort?: unknown };
    return { model: typeof p.model === 'string' ? p.model : undefined, effort: typeof p.effort === 'string' ? p.effort : undefined };
  }
  return {};
}

/** Path below the sessions/ dir the file sits in, if it sits in one. */
function sessionsRelative(file: string): string | undefined {
  const parts = file.split(path.sep);
  const i = parts.lastIndexOf('sessions');
  return i === -1 ? undefined : parts.slice(i + 1).join('/');
}

/** Turn K of a session, cut where the case's copy must end (the end of the turn). */
export async function turnEnd(entry: ParsedEntry, turnIndex: number) {
  const trace = entry.trace;
  const cut = turnCuts(trace, entry.index, 'rollout').find((c) => c.turnIndex === turnIndex);
  if (!cut) throw new NotFound(`没有第 ${turnIndex + 1} 轮`);
  if (!cut.replayable) throw new Error(`第 ${turnIndex + 1} 轮不能回放：${cut.reasons.join('；')}`);
  const turn = trace.turns[turnIndex];
  const endLine = turn.endLine ?? entry.index.offsets.length - 1;
  const st = await fs.stat(entry.path);
  return { cut, turn, totalBytes: Math.min(st.size, entry.index.offsets[endLine + 1] ?? st.size) };
}

export async function createCase(sessionId: string, turnIndex: number): Promise<CaseRecord> {
  if (currentAgent() === 'claude') throw new Error('暂不支持回放 Claude Code 会话');
  const entry = await parsedSession(sessionId);
  const { totalBytes } = await turnEnd(entry, turnIndex);
  const id = newCaseId();
  const file = path.join(caseDir(id), 'session.jsonl');
  await clonePrefix(entry.path, file, totalBytes);
  const sourceId = sourceIdOf(sessionId);
  return recordCase(id, await getParsed(file), turnIndex, {
    sourceId,
    sourceLabel: sourceId ? sourceById(sourceId)?.label : undefined,
    fileName: path.basename(entry.path),
    sessionsRel: sessionsRelative(entry.path),
    skillsOf: sessionId,
  });
}

/** A case for turn K of a session copy already in the case dir. */
async function recordCase(
  id: string,
  entry: ParsedEntry,
  turnIndex: number,
  o: { sourceId?: string; sourceLabel?: string; fileName: string; sessionsRel?: string; skillsOf?: string },
): Promise<CaseRecord> {
  const agent = currentAgent();
  if (agent === 'claude') throw new Error('暂不支持回放 Claude Code 会话');
  const trace = entry.trace;
  const { cut, turn, totalBytes } = await turnEnd(entry, turnIndex);
  const prompt = turn.input?.ref ? (await readText(entry, turn.input.ref)).text : (turn.input?.preview ?? '');
  const settings = await turnSettings(entry, cut.startLine);
  const firstCall = turn.calls.map((i) => trace.calls[i]).find((c) => c.kind === 'response' && c.usage);
  const git = ((await readRecord(entry, 0).catch(() => ({}))) as { payload?: { git?: { commit_hash?: unknown } } }).payload?.git?.commit_hash;
  const meta: StoredMeta = {
    agent,
    sourceId: o.sourceId,
    sourceLabel: o.sourceLabel,
    fileName: o.fileName,
    sessionsRel: o.sessionsRel,
    prefixBytes: cut.prefixBytes,
    startLine: cut.startLine,
    totalBytes,
    turnId: turn.id,
    cwd: turn.cwd ?? trace.meta.cwd,
    gitCommit: typeof git === 'string' && /^[0-9a-f]{7,40}$/.test(git) ? git : undefined,
    model: settings.model ?? turn.model,
    effort: settings.effort,
    cliVersion: trace.meta.cliVersion,
    firstCallInput: firstCall?.usage?.input,
    originalSteps: turn.calls.filter((i) => trace.calls[i]?.kind === 'response').length,
    warnings: cut.warnings,
    originalPrompt: prompt,
  };
  const checks = suggestChecks(trace, turnIndex, skillReport(trace, diskLookupFor(o.skillsOf ?? caseSessionKey(id))));
  const now = Date.now();
  const title = (turn.input?.preview ?? '').replace(/\s+/g, ' ').trim().slice(0, 80) || `第 ${turnIndex + 1} 轮`;
  tmDb()
    .prepare('insert into cases (id, agent, thread_id, turn_index, title, prompt, meta, checks, saved, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)')
    .run(id, agent, trace.meta.threadId, turnIndex, title, prompt, JSON.stringify(meta), JSON.stringify(checks), now, now);
  registerRollout(caseSessionKey(id), entry.path);
  return mustGetCase(id);
}

export interface CasePatch {
  title?: string;
  prompt?: string;
  checks?: CheckDef[];
  saved?: boolean;
}

export function updateCase(id: string, patch: CasePatch): CaseRecord {
  const c = mustGetCase(id);
  tmDb()
    .prepare('update cases set title = ?, prompt = ?, checks = ?, saved = ?, updated_at = ? where id = ?')
    .run(patch.title ?? c.title ?? null, patch.prompt ?? c.prompt, JSON.stringify(patch.checks ?? c.checks), Number(patch.saved ?? c.saved), Date.now(), id);
  return mustGetCase(id);
}

export function touchCase(id: string): void {
  tmDb().prepare('update cases set updated_at = ? where id = ?').run(Date.now(), id);
}

export async function deleteCaseFiles(id: string): Promise<void> {
  unregisterRollout(caseSessionKey(id));
  tmDb().prepare('delete from cases where id = ?').run(id);
  await fs.rm(caseDir(id), { recursive: true, force: true });
}

/** The case's copy parsed: turns 0..K, the last one being the original turn K. */
export async function caseEntry(c: CaseRecord): Promise<ParsedEntry> {
  const file = caseFile(c);
  if (!fsc.existsSync(file)) throw new NotFound('用例文件不存在');
  return getParsed(file);
}

export async function originalSummary(c: CaseRecord): Promise<TurnSummary | undefined> {
  try {
    const e = await caseEntry(c);
    return summarizeTurns(e.trace, c.turnIndex, c.turnIndex + 1);
  } catch {
    return undefined;
  }
}

export function caseView(c: CaseRecord, original?: TurnSummary): CaseView {
  const stats = tmDb().prepare("select count(*) as n, max(created_at) as last from runs where kind = 'replay' and case_id = ?").get(c.id) as { n: number; last: number | null };
  return { ...c, original, replays: stats.n, lastReplayAt: stats.last ?? undefined };
}

/** The original session file, when it is still here (local cases). */
export function originalFile(c: CaseRecord): string | undefined {
  return resolveRollout(c.threadId);
}

/** The real home the session came from: its own source, or (gone) the workspace's first one. */
export function homeFor(c: CaseRecord, fallback: () => { home: string; dataRoot: string } | undefined): { home: string; dataRoot: string } | undefined {
  const s = c.meta.sourceId ? sourceById(c.meta.sourceId) : undefined;
  return s ? { home: s.home, dataRoot: s.dataRoot } : fallback();
}

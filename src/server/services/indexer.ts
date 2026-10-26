import fs from 'node:fs';
import { skillReport } from '../../core/analysis/skills';
import type { SessionIndexSummary, SkillReportResponse } from '../../shared/api';
import { PARSER_VERSION, type SessionTrace } from '../../shared/types';
import { parseFresh } from './parseCache';
import { diskLookupFor } from './skillFiles';
import { snapshot } from './stateDb';
import { tmDb } from './tmDb';

/**
 * Background indexer: parses every rollout once (newest first) and stores a
 * small summary so the session list can be filtered by errors and skills.
 * Re-indexes a thread only when its rollout file changes.
 */

interface Status {
  total: number;
  done: number;
  running: boolean;
  current?: string;
  errors: number;
}

const status: Status = { total: 0, done: 0, running: false, errors: 0 };
const summaries = new Map<string, SessionIndexSummary>();

export function indexStatus(): Status {
  return { ...status };
}

export function summaryOf(threadId: string): SessionIndexSummary | undefined {
  return summaries.get(threadId);
}

export function summarize(trace: SessionTrace): SessionIndexSummary & { listingHash?: string; truncated: number } {
  return {
    calls: trace.totals.calls,
    tools: trace.totals.tools,
    toolErrors: trace.totals.toolErrors,
    turns: trace.totals.turns,
    durationMs: trace.totals.durationMs,
    skills: [...new Set(trace.invocations.map((i) => i.skill))],
    listingHash: trace.listings[trace.listings.length - 1]?.hash,
    truncated: 0,
  };
}

function loadFromDb(): void {
  const rows = tmDb().prepare('select thread_id, calls, tools, tool_errors, turns, duration_ms, skills from session_index where parser_version = ?').all(PARSER_VERSION) as Array<{
    thread_id: string;
    calls: number;
    tools: number;
    tool_errors: number;
    turns: number;
    duration_ms: number;
    skills: string;
  }>;
  for (const r of rows) {
    summaries.set(r.thread_id, { calls: r.calls, tools: r.tools, toolErrors: r.tool_errors, turns: r.turns, durationMs: r.duration_ms, skills: JSON.parse(r.skills) as string[] });
  }
}

/** Per skill of a session: listed, loaded, maybe missed, trigger cut off — and the turn where it mattered. */
export function signalRows(report: SkillReportResponse): Array<{ skill: string; listed: number; loaded: number; missed: number; truncated: number; turn?: number; relevance?: number }> {
  return report.rows.map((r) => ({
    skill: r.name,
    listed: Number(r.listed),
    loaded: Number(r.invocations.length > 0),
    missed: Number(r.flags.includes('maybe_missed')),
    truncated: Number(r.flags.includes('trigger_truncated')),
    turn: r.invocations[0]?.turnIndex ?? r.relevance?.turnIndex,
    relevance: r.relevance?.score,
  }));
}

export function storeSignals(threadId: string, trace: SessionTrace): void {
  const db = tmDb();
  const rows = signalRows(skillReport(trace, diskLookupFor(threadId)));
  const ins = db.prepare('insert into skill_signals (thread_id, skill, listed, loaded, maybe_missed, truncated, turn_index, relevance) values (?, ?, ?, ?, ?, ?, ?, ?)');
  db.exec('begin');
  try {
    db.prepare('delete from skill_signals where thread_id = ?').run(threadId);
    for (const r of rows) ins.run(threadId, r.skill, r.listed, r.loaded, r.missed, r.truncated, r.turn ?? null, r.relevance ?? null);
    db.prepare('update session_index set signals = 1 where thread_id = ?').run(threadId);
    db.exec('commit');
  } catch (e) {
    db.exec('rollback');
    throw e;
  }
}

function fileKey(p: string): string | undefined {
  try {
    const st = fs.statSync(p);
    return `${st.size}-${Math.round(st.mtimeMs)}`;
  } catch {
    return undefined;
  }
}

export async function runIndexer(): Promise<void> {
  if (status.running) return;
  status.running = true;
  try {
    loadFromDb();
    const db = tmDb();
    const existing = new Map(
      (db.prepare('select thread_id, file_key, parser_version, signals from session_index').all() as Array<{ thread_id: string; file_key: string; parser_version: number; signals: number }>).map((r) => [
        r.thread_id,
        r,
      ]),
    );
    const snap = snapshot();
    const todo = [...snap.byId.values()]
      .filter((s) => s.rolloutExists)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((s) => ({ id: s.id, path: snap.rolloutById.get(s.id)! }));
    status.total = todo.length;
    status.done = 0;
    const upsert = db.prepare(
      `insert into session_index (thread_id, rollout, file_key, parser_version, calls, tools, tool_errors, turns, duration_ms, skills, listing_hash, truncated, indexed_at)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       on conflict(thread_id) do update set rollout = excluded.rollout, file_key = excluded.file_key, parser_version = excluded.parser_version,
         calls = excluded.calls, tools = excluded.tools, tool_errors = excluded.tool_errors, turns = excluded.turns,
         duration_ms = excluded.duration_ms, skills = excluded.skills, listing_hash = excluded.listing_hash,
         truncated = excluded.truncated, indexed_at = excluded.indexed_at`,
    );
    for (const item of todo) {
      const key = fileKey(item.path);
      const prev = existing.get(item.id);
      if (!key || (prev && prev.file_key === key && prev.parser_version === PARSER_VERSION && prev.signals && summaries.has(item.id))) {
        status.done++;
        continue;
      }
      status.current = item.id;
      try {
        const { trace } = await parseFresh(item.path);
        const s = summarize(trace);
        upsert.run(item.id, item.path, key, PARSER_VERSION, s.calls, s.tools, s.toolErrors, s.turns, s.durationMs, JSON.stringify(s.skills), s.listingHash ?? null, s.truncated, Date.now());
        summaries.set(item.id, { calls: s.calls, tools: s.tools, toolErrors: s.toolErrors, turns: s.turns, durationMs: s.durationMs, skills: s.skills });
        storeSignals(item.id, trace);
      } catch {
        status.errors++;
      }
      status.done++;
      // Yield so interactive requests get the worker pool first.
      await new Promise((r) => setTimeout(r, 20));
    }
  } finally {
    status.running = false;
    status.current = undefined;
  }
}

/**
 * Sessions that can be read now. The index keeps the rows of sessions whose record file has since
 * been deleted or moved (they come back as they were if it returns): lists built from it skip them.
 */
function readableNow(): (threadId: string) => boolean {
  const byId = snapshot().byId;
  return (id) => byId.get(id)?.rolloutExists ?? false;
}

/** Skill usage across the indexed sessions that can be read. */
export function skillUsage(): Array<{ skill: string; sessions: number }> {
  const counts = new Map<string, number>();
  const readable = readableNow();
  for (const [id, s] of summaries) if (readable(id)) for (const k of s.skills) counts.set(k, (counts.get(k) ?? 0) + 1);
  return [...counts.entries()].map(([skill, sessions]) => ({ skill, sessions })).sort((a, b) => b.sessions - a.sessions);
}

export type SignalKind = 'listed' | 'loaded' | 'missed' | 'truncated';

const COLUMN: Record<SignalKind, string> = { listed: 'listed', loaded: 'loaded', missed: 'maybe_missed', truncated: 'truncated' };

/** Sessions where a skill has this signal (session list filter). */
export function sessionsWithSignal(kind: SignalKind, skill: string): Set<string> {
  const rows = tmDb().prepare(`select thread_id from skill_signals where skill = ? and ${COLUMN[kind]} = 1`).all(skill) as Array<{ thread_id: string }>;
  return new Set(rows.map((r) => r.thread_id));
}

export interface SkillSignalRow {
  threadId: string;
  listed: boolean;
  loaded: boolean;
  missed: boolean;
  truncated: boolean;
  turnIndex?: number;
  relevance?: number;
}

/** Every readable session that listed or used a skill, the strongest signals first. */
export function skillSignals(skill: string): { counts: Record<SignalKind, number>; sessions: SkillSignalRow[] } {
  const readable = readableNow();
  const rows = (
    tmDb()
      .prepare('select * from skill_signals where skill = ? order by loaded desc, maybe_missed desc, truncated desc, relevance desc')
      .all(skill) as Array<{ thread_id: string; listed: number; loaded: number; maybe_missed: number; truncated: number; turn_index: number | null; relevance: number | null }>
  ).filter((r) => readable(r.thread_id));
  const sessions = rows.map((r) => ({
    threadId: r.thread_id,
    listed: Boolean(r.listed),
    loaded: Boolean(r.loaded),
    missed: Boolean(r.maybe_missed),
    truncated: Boolean(r.truncated),
    turnIndex: r.turn_index ?? undefined,
    relevance: r.relevance ?? undefined,
  }));
  return {
    counts: { listed: sessions.filter((x) => x.listed).length, loaded: sessions.filter((x) => x.loaded).length, missed: sessions.filter((x) => x.missed).length, truncated: sessions.filter((x) => x.truncated).length },
    sessions,
  };
}

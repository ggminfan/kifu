import fs from 'node:fs';
import type { SessionSummary, SessionTreeNode, SourceInfo } from '../../shared/api';
import { loadClaudeProject, projectStamp } from '../sources/claude';
import { sources } from '../sources/registry';
import { loadThreadsDb, scanRollouts, stateDbPath, stateDbStamp } from '../sources/threadsDb';
import { emptySnapshot, type Snapshot, type Source } from '../sources/types';

/**
 * The sessions of this server's workspace: the union of every source's
 * sessions (Codex homes, Claude Code projects). Each source
 * keeps its own snapshot, reloaded when its files change (checked at most
 * every 2 seconds); the merged view is rebuilt when any of them changed.
 */

export type { Snapshot } from '../sources/types';

interface SourceState {
  snap: Snapshot;
  checkedAt: number;
}

const perSource = new Map<string, SourceState>();
let merged: { key: string; snap: Snapshot; sourceOf: Map<string, string> } | undefined;

function stampFor(src: Source): string {
  if (src.agent === 'claude') return projectStamp(src.dataRoot);
  return fs.existsSync(stateDbPath(src.dataRoot)) ? stateDbStamp(src.dataRoot) : `scan`;
}

function loadSource(src: Source): Snapshot {
  try {
    if (src.agent === 'claude') return loadClaudeProject(src.dataRoot);
    if (fs.existsSync(stateDbPath(src.dataRoot))) return loadThreadsDb(src.dataRoot);
    return scanRollouts(src.dataRoot);
  } catch (e) {
    return emptySnapshot('error', (e as Error).message);
  }
}

function sourceSnapshot(src: Source): Snapshot {
  const now = Date.now();
  const st = perSource.get(src.id);
  if (st && now - st.checkedAt < 2000) return st.snap;
  // a rollout scan has no cheap stamp: rescan it at most every 10 seconds
  const scanFresh = st?.snap.stamp.startsWith('scan:') && now - st.snap.loadedAt < 10_000;
  if (st && (scanFresh || (!st.snap.stamp.startsWith('scan:') && st.snap.stamp === stampFor(src)))) {
    st.checkedAt = now;
    return st.snap;
  }
  const snap = loadSource(src);
  perSource.set(src.id, { snap, checkedAt: now });
  return snap;
}

function mergeAll(): { snap: Snapshot; sourceOf: Map<string, string> } {
  const parts = sources().map((src) => ({ src, snap: sourceSnapshot(src) }));
  const key = parts.map((p) => `${p.src.id}@${p.snap.loadedAt}`).join('|');
  if (merged?.key === key) return merged;
  const out = emptySnapshot(key);
  const sourceOf = new Map<string, string>();
  for (const { src, snap } of parts) {
    for (const [id, s] of snap.byId) {
      const prev = out.byId.get(id);
      if (prev && prev.updatedAt >= s.updatedAt) continue; // same id in two homes: keep the newest
      out.byId.set(id, { ...s, sourceId: src.id, sourceLabel: src.label });
      const r = snap.rolloutById.get(id);
      if (r) out.rolloutById.set(id, r);
      sourceOf.set(id, src.id);
    }
    for (const [id, kids] of snap.children) out.children.set(id, kids);
  }
  merged = { key, snap: out, sourceOf };
  return merged;
}

export function snapshot(): Snapshot {
  return mergeAll().snap;
}

/** Which source a session belongs to. */
export function sourceIdOf(id: string): string | undefined {
  return mergeAll().sourceOf.get(resolveId(id));
}

/** Sources with their session counts (for the 来源 filter and the header). */
export function sourceInfos(): SourceInfo[] {
  return sources().map((src) => {
    const snap = sourceSnapshot(src);
    let last = 0;
    let count = 0;
    let missing = 0;
    for (const s of snap.byId.values()) {
      if (s.isSubagent) continue;
      if (!s.rolloutExists) {
        missing++;
        continue;
      }
      count++;
      last = Math.max(last, s.updatedAt);
    }
    return {
      id: src.id,
      agent: src.agent,
      kind: src.kind,
      label: src.label,
      home: src.home,
      sessions: count,
      missing: missing || undefined,
      lastActivity: last || src.lastActivity,
      ok: !snap.error,
      error: snap.error,
    };
  });
}

export function stateDbOk(): boolean {
  try {
    const all = sources();
    return all.length > 0 && all.some((src) => !sourceSnapshot(src).error);
  } catch {
    return false;
  }
}

export interface ListQuery {
  q?: string;
  cwd?: string;
  model?: string;
  from?: number;
  to?: number;
  /** Only sessions of this source. */
  source?: string;
  includeSubagents?: boolean;
  limit?: number;
  offset?: number;
}

export function listSessions(query: ListQuery): { sessions: SessionSummary[]; total: number } {
  const s = snapshot();
  const q = query.q?.toLowerCase().trim();
  let list = [...s.byId.values()].filter((x) => {
    if (!query.includeSubagents && x.isSubagent) return false;
    if (query.source && x.sourceId !== query.source) return false;
    if (query.cwd && !(x.cwd ?? '').includes(query.cwd)) return false;
    if (query.model && x.model !== query.model) return false;
    if (query.from && x.updatedAt < query.from) return false;
    if (query.to && x.updatedAt > query.to) return false;
    if (q) {
      const hay = `${x.id} ${x.title ?? ''} ${x.firstUserMessage ?? ''} ${x.cwd ?? ''} ${x.agentNickname ?? ''} ${x.agentRole ?? ''} ${x.sourceLabel ?? ''}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
  list.sort((a, b) => b.updatedAt - a.updatedAt);
  const total = list.length;
  const offset = query.offset ?? 0;
  list = list.slice(offset, offset + (query.limit ?? 500));
  return { sessions: list, total };
}

export function getSession(id: string): SessionSummary | undefined {
  return snapshot().byId.get(resolveId(id));
}

/** Accept unique id prefixes (e.g. the 8-char short id shown in the UI). */
export function resolveId(id: string): string {
  const s = snapshot();
  if (s.byId.has(id) || id.length >= 36 || id.length < 6) return id;
  let found: string | undefined;
  for (const key of s.byId.keys()) {
    if (key.startsWith(id)) {
      if (found) return id;
      found = key;
    }
  }
  return found ?? id;
}

export function rolloutPathFor(id: string): string | undefined {
  return snapshot().rolloutById.get(resolveId(id));
}

export function sessionTree(id: string, depthLimit = 6): SessionTreeNode | undefined {
  const s = snapshot();
  const build = (nodeId: string, depth: number): SessionTreeNode | undefined => {
    const session = s.byId.get(nodeId);
    if (!session) return undefined;
    const kids = depth >= depthLimit ? [] : (s.children.get(nodeId) ?? []);
    const children = kids
      .map((k) => build(k, depth + 1))
      .filter((n): n is SessionTreeNode => Boolean(n))
      .sort((a, b) => a.session.createdAt - b.session.createdAt);
    return { session, children };
  };
  return build(id, 0);
}

/** Walk up to the root of a subagent chain. */
export function rootOf(id: string): string {
  const s = snapshot();
  let cur = resolveId(id);
  for (let i = 0; i < 20; i++) {
    const p = s.byId.get(cur)?.parentId;
    if (!p) break;
    cur = p;
  }
  return cur;
}

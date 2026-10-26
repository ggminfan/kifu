import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { classifyPart } from '../../core/build/classify';
import type { SessionSummary } from '../../shared/api';
import { emptySnapshot, type Snapshot } from './types';

/**
 * Sessions of a Codex home: its own thread index (state_5.sqlite, read-only).
 * A home that has rollouts but no database (yet) is listed from the rollouts'
 * session_meta.
 */

interface ThreadRow {
  id: string;
  rollout_path: string | null;
  created_at_ms: number | null;
  updated_at_ms: number | null;
  created_at: number | null;
  updated_at: number | null;
  source: string | null;
  cwd: string | null;
  title: string | null;
  tokens_used: number | null;
  archived: number | null;
  git_branch: string | null;
  cli_version: string | null;
  first_user_message: string | null;
  agent_nickname: string | null;
  agent_role: string | null;
  agent_path: string | null;
  model: string | null;
  thread_source: string | null;
  /** The thread's name (renamed, or named by the agent) in newer versions; older databases have no such column. */
  name: string | null;
}

export function stateDbPath(dataRoot: string): string {
  return path.join(dataRoot, 'state_5.sqlite');
}

/**
 * Open another program's SQLite database read-only. A WAL database whose
 * -wal / -shm files are gone (its writer closed it cleanly) cannot be opened
 * read-only by every SQLite build — Bun's says "unable to open database
 * file". Then read it as immutable (no locks, no -shm): a consistent view
 * while nobody writes, and we re-read whenever the file's stamp changes.
 */
export function openReadOnly(file: string): DatabaseSync {
  let first: unknown;
  try {
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      db.prepare('select count(*) from sqlite_master').get(); // the first read sets up WAL access
      return db;
    } catch (e) {
      db.close();
      throw e;
    }
  } catch (e) {
    first = e;
  }
  const uri = pathToFileURL(file);
  uri.searchParams.set('immutable', '1');
  try {
    return new DatabaseSync(uri.href, { readOnly: true });
  } catch {
    throw first;
  }
}

function fileStamp(p: string): string {
  try {
    const st = fs.statSync(p);
    return `${st.size}:${st.mtimeMs}`;
  } catch {
    return '-';
  }
}

/** Changes whenever the database (or its WAL) changes. */
export function stateDbStamp(dataRoot: string): string {
  const db = stateDbPath(dataRoot);
  return `${fileStamp(db)}|${fileStamp(`${db}-wal`)}`;
}

function toMs(ms: number | null, sec: number | null): number {
  if (ms) return ms;
  if (sec) return sec < 1e12 ? sec * 1000 : sec;
  return 0;
}

export function loadThreadsDb(dataRoot: string): Snapshot {
  const stamp = stateDbStamp(dataRoot);
  const db = openReadOnly(stateDbPath(dataRoot));
  try {
    // columns newer agent versions added: read when present
    const columns = new Set((db.prepare('pragma table_info(threads)').all() as Array<{ name: string }>).map((c) => c.name));
    const optional = (c: string) => (columns.has(c) ? c : `null as ${c}`);
    const rows = db
      .prepare(
        `select id, rollout_path, created_at_ms, updated_at_ms, created_at, updated_at, source, cwd, title, tokens_used, archived,
                git_branch, cli_version, first_user_message, agent_nickname, agent_role, agent_path, model, thread_source, ${optional('name')}
         from threads`,
      )
      .all() as unknown as ThreadRow[];
    let edges: Array<{ parent_thread_id: string; child_thread_id: string }> = [];
    try {
      edges = db.prepare('select parent_thread_id, child_thread_id from thread_spawn_edges').all() as typeof edges;
    } catch {
      // older databases have no spawn edges
    }
    const parentOf = new Map<string, string>();
    const children = new Map<string, string[]>();
    for (const e of edges) {
      parentOf.set(e.child_thread_id, e.parent_thread_id);
      const list = children.get(e.parent_thread_id) ?? [];
      list.push(e.child_thread_id);
      children.set(e.parent_thread_id, list);
    }
    const byId = new Map<string, SessionSummary>();
    const rolloutById = new Map<string, string>();
    // a rollout the index points to that is gone may sit elsewhere under sessions/ (opening falls back the same way)
    let onDisk: Map<string, string> | undefined;
    for (const r of rows) {
      let rollout = r.rollout_path ?? '';
      if (!rollout || !fs.existsSync(rollout)) {
        onDisk ??= scanRolloutFiles(dataRoot);
        rollout = onDisk.get(r.id) ?? rollout;
      }
      if (rollout) rolloutById.set(r.id, rollout);
      const parentId = parentOf.get(r.id);
      byId.set(r.id, {
        id: r.id,
        title: r.name || r.title || undefined,
        firstUserMessage: r.first_user_message ? r.first_user_message.slice(0, 300) : undefined,
        cwd: r.cwd ?? undefined,
        model: r.model ?? undefined,
        tokensUsed: r.tokens_used ?? 0,
        createdAt: toMs(r.created_at_ms, r.created_at),
        updatedAt: toMs(r.updated_at_ms, r.updated_at),
        source: r.source ?? undefined,
        threadSource: r.thread_source ?? undefined,
        agentRole: r.agent_role ?? undefined,
        agentNickname: r.agent_nickname ?? undefined,
        agentPath: r.agent_path ?? undefined,
        parentId,
        childCount: children.get(r.id)?.length ?? 0,
        rolloutExists: rollout ? fs.existsSync(rollout) : false,
        archived: Boolean(r.archived),
        gitBranch: r.git_branch ?? undefined,
        cliVersion: r.cli_version ?? undefined,
        isSubagent: Boolean(parentId) || (r.source ?? '').includes('subagent'),
      });
    }
    return { byId, rolloutById, children, loadedAt: Date.now(), stamp };
  } finally {
    db.close();
  }
}

const ROLLOUT_RE = /rollout-.*?-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/;

/** Rollout files of a home by thread id (the file name ends with the id). */
export function scanRolloutFiles(dataRoot: string): Map<string, string> {
  const byId = new Map<string, string>();
  const root = path.join(dataRoot, 'sessions');
  try {
    for (const f of fs.readdirSync(root, { recursive: true }) as string[]) {
      const m = ROLLOUT_RE.exec(f);
      if (m) byId.set(m[1], path.join(root, f));
    }
  } catch {
    // no sessions dir
  }
  return byId;
}

function readHead(file: string, bytes = 64 * 1024): string {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(bytes);
    const n = fs.readSync(fd, buf, 0, bytes, 0);
    return buf.subarray(0, n).toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

interface HeadItem {
  type?: string;
  role?: string;
  message?: unknown;
  content?: Array<{ type?: string; text?: string }>;
}

/** A user message's text, unless it is injected context (environment, AGENTS.md, reminders, summaries … — as the context view classifies them). */
function askText(it: HeadItem): string | undefined {
  if (it.type !== 'message' || it.role !== 'user') return undefined;
  const text = (it.content ?? []).map((c) => c.text ?? '').join('\n').trim();
  return text && classifyPart('user', text) === 'user' ? text.slice(0, 300) : undefined;
}

/** The user's first request in the head of a rollout: its `user_message` event, or the first user message item. */
function firstAsk(lines: string[]): string | undefined {
  for (const line of lines) {
    if (!line.includes('"user')) continue;
    try {
      const rec = JSON.parse(line) as { type?: string; payload?: HeadItem };
      const p = rec.payload;
      if (!p) continue;
      if (rec.type === 'event_msg' && p.type === 'user_message' && typeof p.message === 'string' && p.message.trim()) return p.message.trim().slice(0, 300);
      const text = rec.type === 'response_item' ? askText(p) : undefined;
      if (text) return text;
    } catch {
      // a cut-off line at the end of the head
    }
  }
  return undefined;
}

/** Without a database: one summary per rollout from its first line (session_meta) and first request. */
export function scanRollouts(dataRoot: string): Snapshot {
  const files = scanRolloutFiles(dataRoot);
  const snap = emptySnapshot(`scan:${files.size}`);
  let newest = 0;
  for (const [id, file] of files) {
    let st: fs.Stats;
    try {
      st = fs.statSync(file);
    } catch {
      continue;
    }
    newest = Math.max(newest, st.mtimeMs);
    let meta: Record<string, unknown> = {};
    let firstUserMessage: string | undefined;
    try {
      const lines = readHead(file).split('\n');
      const rec = JSON.parse(lines[0]) as { type?: string; payload?: Record<string, unknown> };
      if (rec.type === 'session_meta' && rec.payload) meta = rec.payload;
      firstUserMessage = firstAsk(lines.slice(1, -1));
    } catch {
      // a line longer than the head, or not JSON: list it anyway
    }
    const started = typeof meta.timestamp === 'string' ? Date.parse(meta.timestamp) : NaN;
    snap.rolloutById.set(id, file);
    snap.byId.set(id, {
      id,
      cwd: typeof meta.cwd === 'string' ? meta.cwd : undefined,
      cliVersion: typeof meta.cli_version === 'string' ? meta.cli_version : undefined,
      source: typeof meta.source === 'string' ? meta.source : undefined,
      firstUserMessage,
      tokensUsed: 0,
      createdAt: Number.isNaN(started) ? st.birthtimeMs || st.mtimeMs : started,
      updatedAt: st.mtimeMs,
      childCount: 0,
      rolloutExists: true,
      archived: false,
      isSubagent: false,
    });
  }
  snap.stamp = `scan:${files.size}:${newest}`;
  return snap;
}

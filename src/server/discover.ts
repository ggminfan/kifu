import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_SCAN, type AgentDiscovery, type AgentScan } from '../shared/remote-protocol';
import { listClaudeProjects } from './sources/claude';
import { openReadOnly, scanRolloutFiles } from './sources/threadsDb';

/**
 * Find agent homes under scan directories: Codex homes (state_5.sqlite or
 * sessions/ at the top) and Claude Code config dirs (projects/). Roots may
 * contain `*` segments (e.g. /work/x/.codex with x = *). Bounded: depth, time,
 * result count; symlinks are not followed while walking.
 */

export { DEFAULT_SCAN };

export interface DiscoverOptions {
  maxDepth?: number;
  timeoutMs?: number;
  maxResults?: number;
}

/** `~` and a leading `$VAR` (a root whose variable is unset is skipped). */
export function expandRoot(root: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  let r = root.trim();
  if (!r) return undefined;
  const v = /^\$([A-Za-z_][A-Za-z0-9_]*)/.exec(r);
  if (v) {
    const value = env[v[1]];
    if (!value) return undefined;
    r = value + r.slice(v[0].length);
  }
  if (r === '~' || r.startsWith('~/')) r = path.join(os.homedir(), r.slice(1));
  return path.resolve(r);
}

/** Expand `*` path segments by listing directories. */
function expandGlob(p: string, deadline: number, limit: number): string[] {
  const parts = p.split('/');
  let current = [parts[0] === '' ? '/' : parts[0]];
  for (const part of parts.slice(1)) {
    if (!part) continue;
    const next: string[] = [];
    for (const base of current) {
      if (Date.now() > deadline || next.length > limit) break;
      if (part.includes('*')) {
        const re = new RegExp(`^${part.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`);
        let names: string[] = [];
        try {
          names = fs.readdirSync(base);
        } catch {
          continue;
        }
        for (const n of names) if (re.test(n)) next.push(path.join(base, n));
      } else {
        next.push(path.join(base, part));
      }
    }
    current = next;
  }
  return current;
}

const exists = (p: string) => fs.existsSync(p);

function names(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

/** A Codex home (CODEX_HOME): its thread index, or rollouts filed by date (sessions/2026/…). */
function codexHome(dir: string): true | undefined {
  return exists(path.join(dir, 'state_5.sqlite')) || names(path.join(dir, 'sessions')).some((n) => /^\d{4}$/.test(n)) ? true : undefined;
}

const CLAUDE_MARKERS = ['settings.json', '.claude.json', 'history.jsonl', 'todos', 'statsig', 'shell-snapshots', 'session-env'];

/**
 * A Claude Code config dir (~/.claude, CLAUDE_CONFIG_DIR, a copy of one):
 * projects/ next to Claude's own files, or holding project dirs named after
 * absolute paths (-Users-me-work-demo).
 */
function claudeHome(dir: string): true | undefined {
  const projects = path.join(dir, 'projects');
  if (!exists(projects)) return undefined;
  if (path.basename(dir) === '.claude' || CLAUDE_MARKERS.some((m) => exists(path.join(dir, m)))) return true;
  return names(projects).some((n) => n.startsWith('-')) ? true : undefined;
}

interface Found<T> {
  dir: string;
  real: string;
  info: T;
}

/**
 * Directories under the roots for which `test` says "home", deduplicated by
 * realpath. The walk stops at a home.
 */
function findHomes<T>(roots: string[], test: (dir: string) => T | undefined, opts: DiscoverOptions = {}): Array<Found<T>> {
  const maxDepth = opts.maxDepth ?? 3;
  const maxResults = opts.maxResults ?? 500;
  const deadline = Date.now() + (opts.timeoutMs ?? 5000);
  const seen = new Set<string>();
  const out: Array<Found<T>> = [];

  const walk = (dir: string, depth: number) => {
    if (Date.now() > deadline || out.length >= maxResults) return;
    const info = test(dir);
    if (info) {
      let real: string;
      try {
        real = fs.realpathSync(dir);
      } catch {
        return;
      }
      if (!seen.has(real)) {
        seen.add(real);
        out.push({ dir, real, info });
      }
      return; // a home does not contain other homes we care about
    }
    if (depth >= maxDepth) return;
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory() || e.name === 'node_modules' || e.name === '.git') continue;
      walk(path.join(dir, e.name), depth + 1);
    }
  };

  for (const root of roots) {
    const r = expandRoot(root);
    if (!r) continue;
    for (const dir of expandGlob(r, deadline, maxResults)) {
      let st: fs.Stats;
      try {
        st = fs.statSync(dir);
      } catch {
        continue;
      }
      if (st.isDirectory()) walk(dir, 0);
      if (Date.now() > deadline || out.length >= maxResults) break;
    }
  }
  return out;
}

interface HomeStats {
  threads?: number;
  lastActivity?: number;
  latestTitle?: string;
}

/**
 * Session count (top-level sessions: subagents are listed under their parent), last activity, newest
 * title. Only sessions whose record file is still there count: the agent's index keeps the rest.
 */
function stats(dataRoot: string): HomeStats {
  try {
    const db = openReadOnly(path.join(dataRoot, 'state_5.sqlite'));
    try {
      const columns = new Set((db.prepare('pragma table_info(threads)').all() as Array<{ name: string }>).map((c) => c.name));
      const title = `coalesce(${columns.has('name') ? "nullif(name, ''), " : ''}nullif(title, ''), substr(first_user_message, 1, 80))`;
      const select = `select id, rollout_path as p, coalesce(updated_at_ms, updated_at * 1000) as t, ${title} as title from threads`;
      let rows: Array<{ id: string; p: string | null; t: number | null; title: string | null }>;
      try {
        rows = db.prepare(`${select} where coalesce(source, '') not like '%subagent%' and id not in (select child_thread_id from thread_spawn_edges)`).all() as typeof rows;
      } catch {
        rows = db.prepare(select).all() as typeof rows;
      }
      let threads = 0;
      let last = 0;
      let latestTitle: string | undefined;
      // a file the index points to that is gone may sit elsewhere under sessions/ (the session list finds it there too)
      let onDisk: Map<string, string> | undefined;
      for (const r of rows) {
        if (!r.p || !fs.existsSync(r.p)) {
          onDisk ??= scanRolloutFiles(dataRoot);
          if (!onDisk.has(r.id)) continue;
        }
        threads++;
        if ((r.t ?? 0) > last) {
          last = r.t ?? 0;
          latestTitle = r.title ?? undefined;
        }
      }
      return { threads, lastActivity: last || undefined, latestTitle };
    } finally {
      db.close();
    }
  } catch {
    return {};
  }
}

/** Codex homes under the roots. */
export function findCodexHomes(roots: string[] = DEFAULT_SCAN.codex, opts: DiscoverOptions = {}): string[] {
  return findHomes(roots, codexHome, opts).map((h) => h.dir);
}

/** Claude Code config dirs under the roots. */
export function findClaudeHomes(roots: string[] = DEFAULT_SCAN.claude, opts: DiscoverOptions = {}): string[] {
  return findHomes(roots, claudeHome, opts).map((h) => h.dir);
}

const MAX_PATHS = 50;

function newest<T extends { lastActivity?: number }>(items: T[]): T | undefined {
  return items.reduce<T | undefined>((m, x) => ((x.lastActivity ?? 0) > (m?.lastActivity ?? 0) ? x : m), undefined);
}

/**
 * What this machine has, per agent asked for: Codex homes and Claude Code
 * projects under that agent's scan directories. Session counts leave out
 * subagents.
 */
export function discoverAgents(scan: AgentScan = DEFAULT_SCAN, opts: DiscoverOptions = {}): AgentDiscovery[] {
  const out: AgentDiscovery[] = [];
  if (scan.codex) {
    const homes = findCodexHomes(scan.codex, opts).map((home) => {
      const st = exists(path.join(home, 'state_5.sqlite')) ? stats(home) : {};
      return { home, sessions: st.threads ?? scanRolloutFiles(home).size, lastActivity: st.lastActivity, latestTitle: st.latestTitle };
    });
    if (homes.length) {
      const last = newest(homes);
      out.push({
        agent: 'codex',
        home: homes[0].home,
        paths: homes.slice(0, MAX_PATHS).map((h) => h.home),
        sources: homes.length,
        sessions: homes.reduce((n, h) => n + h.sessions, 0),
        lastActivity: last?.lastActivity,
        latestTitle: last?.latestTitle ?? homes.find((h) => h.latestTitle)?.latestTitle,
      });
    }
  }
  if (scan.claude) {
    const homes = findClaudeHomes(scan.claude, opts);
    const projects = homes.flatMap((h) => listClaudeProjects(h));
    if (projects.length) {
      out.push({
        agent: 'claude',
        home: homes[0],
        paths: homes.slice(0, MAX_PATHS),
        sources: projects.length,
        sessions: projects.reduce((n, p) => n + p.sessions, 0),
        lastActivity: Math.max(...projects.map((p) => p.lastActivity)),
      });
    }
  }
  return out;
}

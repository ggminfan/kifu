import { createHash } from 'node:crypto';
import type { AgentKind, SourceKind } from '../../shared/agents';
import type { SessionSummary } from '../../shared/api';

/**
 * One place sessions come from: a Codex home (CODEX_HOME) or a Claude Code
 * project directory (~/.claude/projects/<slug>).
 */
export interface Source {
  id: string;
  agent: AgentKind;
  kind: SourceKind;
  home: string;
  /** Directory with state_5.sqlite and sessions/ (Codex: the home) or the project dir (Claude Code). */
  dataRoot: string;
  label: string;
  lastActivity?: number;
}

/** Sessions of one source, in the shape the rest of the server already uses. */
export interface Snapshot {
  byId: Map<string, SessionSummary>;
  rolloutById: Map<string, string>;
  children: Map<string, string[]>;
  loadedAt: number;
  stamp: string;
  error?: string;
}

export function emptySnapshot(stamp = '', error?: string): Snapshot {
  return { byId: new Map(), rolloutById: new Map(), children: new Map(), loadedAt: Date.now(), stamp, error };
}

export function sourceId(agent: AgentKind, realpath: string): string {
  return createHash('sha1').update(`${agent}:${realpath}`).digest('hex').slice(0, 12);
}

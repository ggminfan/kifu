import type { AgentKind } from './agents';

/**
 * Contract between the desktop shell and a kifu-server process
 * (local child process or remote over SSH). Bump PROTOCOL on breaking changes.
 */

export const PROTOCOL = 4;

/** Printed by `kifu-server serve` as `KIFU_READY <json>` once it accepts connections. */
export interface ReadyLine {
  protocol: number;
  agent?: AgentKind;
  /** Sources found at startup. */
  sources?: number;
  version: string;
  buildId: string;
  instanceId: string;
  pid: number;
  host?: string;
  port?: number;
  socket?: string;
  dataDir: string;
}

export const READY_PREFIX = 'KIFU_READY ';

export function parseReadyLine(line: string): ReadyLine | undefined {
  const i = line.indexOf(READY_PREFIX);
  if (i === -1) return undefined;
  try {
    const v = JSON.parse(line.slice(i + READY_PREFIX.length)) as ReadyLine;
    return typeof v.protocol === 'number' && typeof v.instanceId === 'string' ? v : undefined;
  } catch {
    return undefined;
  }
}

/** manifest.json inside a server package (`kifu-server-<target>.tar.gz`). */
export interface ServerManifest {
  name: 'kifu-server';
  version: string;
  buildId: string;
  protocol: number;
  target: string;
  /** sha256 of bin/kifu-server */
  sha256: string;
  builtAt: string;
}

/**
 * Scan directories per agent, searched (a few levels deep) for that agent's
 * homes: CODEX_HOMEs, Claude Code config dirs. `~`, a leading `$VAR` and `*`
 * path segments are expanded on the target machine.
 */
export const DEFAULT_SCAN: Record<AgentKind, string[]> = {
  codex: ['~/.codex', '$CODEX_HOME'],
  claude: ['~/.claude', '$CLAUDE_CONFIG_DIR'],
};

/** Which agents to look for, and where (an agent left out is not scanned). */
export type AgentScan = Partial<Record<AgentKind, string[]>>;

/** Per agent: what `kifu-server discover` found on a machine. */
export interface AgentDiscovery {
  agent: AgentKind;
  /** The first CODEX_HOME / Claude Code config dir found. */
  home?: string;
  /** Every home found (CODEX_HOMEs, Claude Code config dirs), at most 50. */
  paths?: string[];
  sessions: number;
  /** Codex homes, or Claude Code projects. */
  sources: number;
  lastActivity?: number;
  latestTitle?: string;
}

export interface DiscoverResult {
  agents: AgentDiscovery[];
}

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sourceLabel, type AgentKind } from '../../shared/agents';
import { findClaudeHomes, findCodexHomes } from '../discover';
import { listClaudeProjects, projectCwd } from './claude';
import { sourceId, type Source } from './types';

/**
 * The sources a server reads, for its one agent, rescanned every minute so
 * new ones show up (a new Claude Code project …):
 * - codex: every Codex home under the scan directories (default ~/.codex,
 *   $CODEX_HOME), or one explicit home;
 * - claude: each project of every Claude Code config dir under the scan
 *   directories (default ~/.claude, $CLAUDE_CONFIG_DIR), or of one explicit dir.
 */

export interface SourceOptions {
  agent: AgentKind;
  /** Scan these directories for the agent's homes. */
  roots?: string[];
  /** One explicit home instead: CODEX_HOME or a Claude Code config dir. */
  home?: string;
}

const REFRESH_MS = 60_000;

let opts: SourceOptions = { agent: 'codex' };
let list: Source[] | undefined;
let refreshedAt = 0;

export function configureSources(o: SourceOptions): void {
  opts = o;
  list = undefined;
}

export function sourceOptions(): SourceOptions {
  return opts;
}

export function currentAgent(): AgentKind {
  return opts.agent;
}

function real(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

function build(): Source[] {
  const homeDir = os.homedir();
  if (opts.agent === 'codex') {
    const homes = opts.home ? [opts.home].filter((h) => fs.existsSync(h)) : findCodexHomes(opts.roots);
    return homes.map((home) => ({ id: sourceId('codex', real(home)), agent: 'codex' as const, kind: 'codex' as const, home, dataRoot: home, label: sourceLabel(home, homeDir) }));
  }
  const homes = opts.home ? [opts.home] : findClaudeHomes(opts.roots);
  return homes.flatMap((home) => listClaudeProjects(home)).map((p) => {
    const cwd = projectCwd(p.dir);
    return {
      id: sourceId('claude', real(p.dir)),
      agent: 'claude' as const,
      kind: 'claude' as const,
      home: p.dir,
      dataRoot: p.dir,
      label: cwd ? sourceLabel(cwd, homeDir) : path.basename(p.dir),
      lastActivity: p.lastActivity,
    };
  });
}

/** Two sources with the same label get a short id appended. */
function disambiguate(all: Source[]): Source[] {
  const count = new Map<string, number>();
  for (const s of all) count.set(s.label, (count.get(s.label) ?? 0) + 1);
  return all.map((s) => ((count.get(s.label) ?? 0) > 1 ? { ...s, label: `${s.label} · ${s.id.slice(0, 4)}` } : s));
}

export function refreshSources(): Source[] {
  list = disambiguate(build());
  refreshedAt = Date.now();
  return list;
}

export function sources(): Source[] {
  if (!list || Date.now() - refreshedAt > REFRESH_MS) return refreshSources();
  return list;
}

export function sourceById(id: string): Source | undefined {
  return sources().find((s) => s.id === id);
}

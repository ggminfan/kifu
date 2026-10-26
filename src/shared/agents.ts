/**
 * Agents whose sessions Kifu reads. A workspace is one agent on one
 * machine; its sessions may come from several sources (Codex homes, Claude
 * Code projects).
 */

export type AgentKind = 'codex' | 'claude';

export const AGENT_KINDS: AgentKind[] = ['codex', 'claude'];

export const AGENT_LABEL: Record<AgentKind, string> = {
  codex: 'Codex',
  claude: 'Claude Code',
};

export function isAgentKind(v: unknown): v is AgentKind {
  return v === 'codex' || v === 'claude';
}

/** What kind of directory a source is. */
export type SourceKind = 'codex' | 'claude';

/** "~/.codex", "…/work/demo". */
export function sourceLabel(home: string, homeDir?: string): string {
  const p = homeDir && (home === homeDir || home.startsWith(`${homeDir}/`)) ? `~${home.slice(homeDir.length)}` : home;
  const parts = p.split('/').filter(Boolean);
  return parts.length > 3 ? `…/${parts.slice(-2).join('/')}` : p;
}

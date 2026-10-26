import type { SshOptions } from '../../shared/ssh';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isAgentKind, type AgentKind } from '../../../../src/shared/agents';
import type { ShellUi } from '../../shared/shell';

/**
 * Desktop state: ~/.kifu/desktop/connections.json (no secrets, only
 * aliases, paths and layout). Another build of the app may share the file:
 * entries it wrote that this one does not know (a kind of connection, an
 * agent) are kept as they were.
 */

/** One agent on one connection: scanned or not, and where. */
export interface StoredAgentScan {
  /** Absent = scanned. */
  enabled?: boolean;
  /** Custom scan directories; absent = the defaults. */
  roots?: string[];
}

export interface StoredConnection {
  id: string;
  kind: 'local' | 'ssh';
  /** 本机 only: turned on (it starts off on a fresh install). */
  enabled?: boolean;
  alias?: string;
  label?: string;
  ssh?: SshOptions;
  /** Per agent scan settings; an agent left out is scanned in its default directories (agents this build does not know stay as they are). */
  agents?: Partial<Record<AgentKind, StoredAgentScan>>;
  /** Recently opened agents: agent → last opened (ms). */
  recent?: Record<string, number>;
}

export interface StoredWorkspace {
  connId: string;
  agent: AgentKind;
  route?: string;
}

/** Entries written by another build sharing the store that this one does not use: written back unchanged, after its own. */
export interface ForeignEntries {
  /** Connections of kinds this build does not know. */
  connections: Array<{ id: string }>;
  /** Tabs of agents it does not know, or on those connections. */
  workspaces: Array<{ connId: string }>;
}

export interface StoredState {
  connections: StoredConnection[];
  workspaces: StoredWorkspace[];
  activeId?: string;
  ui?: Partial<ShellUi>;
  window?: { x: number; y: number; width: number; height: number; maximized?: boolean };
  /** loadState: there was no saved state (first run). */
  fresh?: boolean;
  foreign?: ForeignEntries;
}

interface StoreFile extends Omit<StoredState, 'fresh' | 'foreign'> {
  version: 1;
}

const CONN_KINDS = new Set<StoredConnection['kind']>(['local', 'ssh']);

export function storePath(): string {
  return process.env.KIFU_DESKTOP_STORE ?? path.join(os.homedir(), '.kifu', 'desktop', 'connections.json');
}

export function loadState(): StoredState {
  try {
    const data = JSON.parse(fs.readFileSync(storePath(), 'utf8')) as Partial<StoreFile>;
    if (data.version === 1 && Array.isArray(data.connections)) {
      const foreign: ForeignEntries = { connections: [], workspaces: [] };
      const connections: StoredConnection[] = [];
      for (const c of data.connections) {
        if (!c || typeof c.id !== 'string') continue;
        if (CONN_KINDS.has(c.kind)) connections.push(c);
        else foreign.connections.push(c);
      }
      const theirs = new Set(foreign.connections.map((c) => c.id));
      const workspaces: StoredWorkspace[] = [];
      for (const w of Array.isArray(data.workspaces) ? data.workspaces : []) {
        if (!w || typeof w.connId !== 'string') continue;
        if (isAgentKind(w.agent) && !theirs.has(w.connId)) workspaces.push(w);
        else foreign.workspaces.push(w);
      }
      return {
        connections,
        workspaces,
        activeId: typeof data.activeId === 'string' ? data.activeId : undefined,
        ui: data.ui,
        window: data.window,
        foreign,
      };
    }
  } catch {
    // first run or unreadable: start fresh
  }
  return { connections: [], workspaces: [], fresh: true };
}

export function saveState(state: StoredState): void {
  const file = storePath();
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp-${process.pid}`;
  const { fresh: _fresh, foreign, ...data } = state;
  const out = {
    version: 1,
    ...data,
    connections: [...data.connections, ...(foreign?.connections ?? [])],
    workspaces: [...data.workspaces, ...(foreign?.workspaces ?? [])],
  };
  fs.writeFileSync(tmp, `${JSON.stringify(out, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

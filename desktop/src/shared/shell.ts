import type { AddSshInput, SshOptions } from './ssh';
import type { RPCSchema } from 'electrobun/view';
import type { AgentKind } from '../../../src/shared/agents';
import type { LanguagePreference, Locale } from '../../../src/shared/i18n';

/**
 * State and RPC contract between the Bun main process and the main window's
 * shell (views://shell). One window: workspace tabs in the title bar, a
 * sidebar of connections (本机, SSH hosts) and their agents, and the active
 * workspace's UI in a sandboxed embedded webview. A workspace is one agent
 * (Codex, Claude Code) on one connection: all of that agent's sessions there,
 * from all of its sources.
 */

export type { AgentKind } from '../../../src/shared/agents';

export type ConnStatus = 'idle' | 'connecting' | 'hostkey' | 'installing' | 'ready' | 'reconnecting' | 'error';
export type ServerStatus = 'starting' | 'ready' | 'restarting' | 'error' | 'stopped';

export type StageId = 'config' | 'connect' | 'hostkey' | 'platform' | 'install' | 'server';
export type StageStatus = 'pending' | 'running' | 'success' | 'error' | 'skipped';

export interface StageView {
  id: StageId;
  label: string;
  status: StageStatus;
  message?: string;
}

export interface StepView {
  at: number;
  level: 'info' | 'warn' | 'error';
  text: string;
}

export interface HostKeyView {
  kind: 'unknown' | 'changed';
  keyType: string;
  fingerprint: string;
  hostId: string;
  knownHostsFile: string;
  offending?: string;
}

/** One agent found on a connection (or remembered from before). */
export interface AgentView {
  agent: AgentKind;
  label: string;
  /** Top-level sessions (subagents not counted). */
  sessions: number;
  /** Codex homes, Claude Code projects. */
  sources: number;
  /** The homes found (CODEX_HOMEs, Claude Code config dirs). */
  paths?: string[];
  lastActivity?: number;
  latestTitle?: string;
  /** Not found by the last scan (shown dimmed when remembered). */
  missing?: boolean;
  /** Open as a workspace tab. */
  workspaceId?: string;
  /** Opened before. */
  recent?: number;
}

export type ConnKind = 'local' | 'ssh';

/** Whether and where a connection looks for one agent's sessions. */
export interface AgentScanView {
  agent: AgentKind;
  label: string;
  enabled: boolean;
  /** Scan directories: the defaults unless changed. */
  roots: string[];
  defaultRoots: string[];
  custom: boolean;
}

export interface ConnectionView {
  id: string;
  kind: ConnKind;
  label: string;
  /** 本机 is used only once turned on; remotes always are (they connect on demand). */
  enabled: boolean;
  alias?: string;
  ssh?: SshOptions;
  /** e.g. "dev@10.0.0.12 · 经 ProxyCommand · Linux x86_64 · glibc 2.31" */
  detail?: string;
  /** Home directory on that machine, to show paths as ~/… */
  homeDir?: string;
  status: ConnStatus;
  error?: { kind: string; message: string; detail?: string };
  hostKey?: HostKeyView;
  progress?: { label: string; done: number; total: number };
  stages: StageView[];
  steps: StepView[];
  /** Per agent: scanned or not, and where (always Codex, Claude Code). */
  scan: AgentScanView[];
  /** Enabled agents found by the last scan (or remembered). */
  agents: AgentView[];
  discovering: boolean;
  discoveredAt?: number;
  discoverError?: string;
  maxServers?: number;
}

export type WorkspaceStatus = 'idle' | 'connecting' | 'starting' | 'ready' | 'restarting' | 'error';

export interface WorkspaceView {
  id: string;
  connId: string;
  kind: ConnKind;
  agent: AgentKind;
  /** Tab title: the agent ("Codex", "Claude Code"). */
  title: string;
  connLabel: string;
  status: WorkspaceStatus;
  error?: string;
  note?: string;
  /** Last in-app route (restored after reconnects and restarts). */
  route: string;
}

export interface ShellUi {
  language?: LanguagePreference;
  sidebarOpen: boolean;
  sidebarWidth: number;
  /** Collapsed connection groups in the sidebar. */
  collapsed: string[];
}

export interface ShellState {
  systemLocale?: Locale;
  connections: ConnectionView[];
  workspaces: WorkspaceView[];
  activeId?: string;
  /** Host aliases from ~/.ssh/config not added yet. */
  sshHosts: string[];
  ui: ShellUi;
  version: string;
  logDir: string;
}

export type ShellCommand =
  | { name: 'toggleSidebar' }
  | { name: 'openSettings'; page?: 'connections' | 'about'; adding?: boolean }
  | { name: 'closeTab' }
  | { name: 'reload' }
  | { name: 'nextTab' }
  | { name: 'prevTab' }
  | { name: 'selectTab'; index: number }
  | { name: 'devtools' }
  | { name: 'quickOpen' };

export interface Toast {
  level: 'info' | 'success' | 'warn' | 'error';
  title: string;
  description?: string;
}

export type ShellRPC = {
  bun: RPCSchema<{
    requests: {
      getState: { params: undefined; response: ShellState };
      addSsh: { params: AddSshInput; response: { id: string } };
      refreshSshHosts: { params: undefined; response: string[] };
      chooseIdentityFile: { params: undefined; response: string | undefined };
      removeConnection: { params: { id: string }; response: void };
      connect: { params: { id: string; secret?: string }; response: void };
      disconnect: { params: { id: string }; response: void };
      discover: { params: { id: string }; response: void };
      /** Turn 本机 on or off. */
      setEnabled: { params: { id: string; enabled: boolean }; response: void };
      /** Scan an agent or not, and where (`roots: []` = the defaults). */
      setAgentScan: { params: { id: string; agent: AgentKind; enabled?: boolean; roots?: string[] }; response: void };
      answerHostKey: { params: { id: string; accept: boolean }; response: void };
      openWorkspace: { params: { connId: string; agent: AgentKind }; response: { id: string } };
      activateWorkspace: { params: { id: string }; response: void };
      closeWorkspace: { params: { id: string }; response: void };
      moveWorkspace: { params: { id: string; to: number }; response: void };
      retryWorkspace: { params: { id: string }; response: void };
      /** A fresh single-use sign-in URL for the workspace's server, landing on `next`. */
      workspaceUrl: { params: { id: string; next?: string }; response: { url: string; baseUrl: string } };
      routeChanged: { params: { id: string; route: string }; response: void };
      setUi: { params: Partial<ShellUi>; response: void };
      openExternal: { params: { url: string }; response: void };
      openLogs: { params: undefined; response: void };
      /** Diagnostics from the shell (webview lifecycle), written to logs/shell.log. */
      report: { params: { event: string; id?: string; detail?: string }; response: void };
    };
    messages: {};
  }>;
  webview: RPCSchema<{
    requests: {};
    messages: {
      state: ShellState;
      workspaceRestarted: { id: string };
      command: ShellCommand;
      toast: Toast;
    };
  }>;
};

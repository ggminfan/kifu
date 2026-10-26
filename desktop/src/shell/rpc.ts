import type { AddSshInput } from '../shared/ssh';
import { Electroview } from 'electrobun/view';
import type { AgentKind, ShellCommand, ShellRPC, ShellState, ShellUi, Toast } from '../shared/shell';
import { createMockApi } from './mock';

/** Shell → main process calls. Outside the app (plain browser preview) a mock stands in. */
export interface ShellApi {
  getState(): Promise<ShellState>;
  addSsh(input: string | AddSshInput): Promise<{ id: string }>;
  removeConnection(id: string): Promise<void>;
  refreshSshHosts(): Promise<string[]>;
  chooseIdentityFile(): Promise<string | undefined>;
  connect(id: string, secret?: string): Promise<void>;
  disconnect(id: string): Promise<void>;
  discover(id: string): Promise<void>;
  setEnabled(id: string, enabled: boolean): Promise<void>;
  setAgentScan(id: string, agent: AgentKind, patch: { enabled?: boolean; roots?: string[] }): Promise<void>;
  answerHostKey(id: string, accept: boolean): Promise<void>;
  openWorkspace(connId: string, agent: AgentKind): Promise<{ id: string }>;
  activateWorkspace(id: string): Promise<void>;
  closeWorkspace(id: string): Promise<void>;
  moveWorkspace(id: string, to: number): Promise<void>;
  retryWorkspace(id: string): Promise<void>;
  workspaceUrl(id: string, next?: string): Promise<{ url: string; baseUrl: string }>;
  routeChanged(id: string, route: string): Promise<void>;
  setUi(patch: Partial<ShellUi>): Promise<void>;
  openExternal(url: string): Promise<void>;
  openLogs(): Promise<void>;
  report(event: string, id?: string, detail?: string): void;
  onState(cb: (s: ShellState) => void): () => void;
  onRestarted(cb: (id: string) => void): () => void;
  onCommand(cb: (c: ShellCommand) => void): () => void;
  onToast(cb: (t: Toast) => void): () => void;
}

function listeners<T>() {
  const set = new Set<(v: T) => void>();
  return {
    emit: (v: T) => {
      for (const l of set) l(v);
    },
    on: (cb: (v: T) => void) => {
      set.add(cb);
      return () => {
        set.delete(cb);
      };
    },
  };
}

function createElectrobunApi(): ShellApi {
  const state = listeners<ShellState>();
  const restarted = listeners<string>();
  const command = listeners<ShellCommand>();
  const toast = listeners<Toast>();
  const rpc = Electroview.defineRPC<ShellRPC>({
    maxRequestTime: 120_000,
    handlers: {
      requests: {},
      messages: {
        state: (s) => state.emit(s),
        workspaceRestarted: ({ id }) => restarted.emit(id),
        command: (c) => command.emit(c),
        toast: (t) => toast.emit(t),
      },
    },
  });
  new Electroview({ rpc });
  const r = rpc.request;
  return {
    getState: () => r.getState(),
    addSsh: (input) => r.addSsh(typeof input === 'string' ? { alias: input } : input),
    refreshSshHosts: () => r.refreshSshHosts(),
    chooseIdentityFile: () => r.chooseIdentityFile(),
    removeConnection: (id) => r.removeConnection({ id }),
    connect: (id, secret) => r.connect({ id, secret }),
    disconnect: (id) => r.disconnect({ id }),
    discover: (id) => r.discover({ id }),
    setEnabled: (id, enabled) => r.setEnabled({ id, enabled }),
    setAgentScan: (id, agent, patch) => r.setAgentScan({ id, agent, ...patch }),
    answerHostKey: (id, accept) => r.answerHostKey({ id, accept }),
    openWorkspace: (connId, agent) => r.openWorkspace({ connId, agent }),
    activateWorkspace: (id) => r.activateWorkspace({ id }),
    closeWorkspace: (id) => r.closeWorkspace({ id }),
    moveWorkspace: (id, to) => r.moveWorkspace({ id, to }),
    retryWorkspace: (id) => r.retryWorkspace({ id }),
    workspaceUrl: (id, next) => r.workspaceUrl({ id, next }),
    routeChanged: (id, route) => r.routeChanged({ id, route }),
    setUi: (patch) => r.setUi(patch),
    openExternal: (url) => r.openExternal({ url }),
    openLogs: () => r.openLogs(),
    report: (event, id, detail) => {
      void r.report({ event, id, detail }).catch(() => undefined);
    },
    onState: state.on,
    onRestarted: restarted.on,
    onCommand: command.on,
    onToast: toast.on,
  };
}

export const inApp = Boolean((window as { __electrobunWebviewId?: number }).__electrobunWebviewId);

export const api: ShellApi = inApp ? createElectrobunApi() : createMockApi();

import { normalizeSshInput } from '../shared/ssh';
import { tr } from '../../../src/shared/i18n';
import type { AgentKind, AgentScanView, AgentView, ConnectionView, ShellCommand, ShellState, StageView, Toast, WorkspaceView } from '../shared/shell';
import type { ShellApi } from './rpc';

/** Fake state for previewing the shell in a plain browser (no Electrobun). Made-up sample data only. */

const now = Date.now();
const min = 60_000;
const DEFAULTS: Record<AgentKind, string[]> = {
  codex: ['~/.codex', '$CODEX_HOME'],
  claude: ['~/.claude', '$CLAUDE_CONFIG_DIR'],
};

function stages(statuses: Array<StageView['status']>, messages: Array<string | undefined> = []): StageView[] {
  const defs: Array<[StageView['id'], string]> = [
    ['config', tr("读取 SSH 配置")],
    ['connect', tr("建立 SSH 连接")],
    ['hostkey', tr("确认主机指纹")],
    ['platform', tr("检测远端环境")],
    ['install', tr("安装服务端")],
  ];
  return defs.map(([id, label], i) => ({ id, label, status: statuses[i] ?? 'pending', message: messages[i] }));
}

const LABEL: Record<AgentKind, string> = { codex: 'Codex', claude: 'Claude Code' };

function scanView(): AgentScanView[] {
  return (['codex', 'claude'] as AgentKind[]).map((a) => ({ agent: a, label: LABEL[a], enabled: true, roots: DEFAULTS[a], defaultRoots: DEFAULTS[a], custom: false }));
}

function conn(p: Partial<ConnectionView> & Pick<ConnectionView, 'id' | 'kind' | 'label' | 'status'>): ConnectionView {
  return { enabled: true, steps: [], stages: [], scan: scanView(), agents: [], discovering: false, ...p };
}

function agent(a: AgentKind, sessions: number, sources = 1, ago?: number, title?: string): AgentView {
  const paths = { codex: ['/home/demo/.codex'], claude: ['/home/demo/.claude'] }[a];
  return { agent: a, label: LABEL[a], sessions, sources, paths, lastActivity: ago === undefined ? undefined : now - ago, latestTitle: title };
}

function tab(connId: string, kind: WorkspaceView['kind'], connLabel: string, a: AgentKind, status: WorkspaceView['status']): WorkspaceView {
  return { id: `${connId}::${a}`, connId, kind, agent: a, title: LABEL[a], connLabel, status, route: '/' };
}

export function createMockApi(): ShellApi {
  const state: ShellState = {
    version: '0.1.0',
    logDir: '/Users/demo/.kifu/desktop/logs',
    sshHosts: ['gpu-a100', 'staging', 'build-farm', 'mac-mini'],
    ui: { sidebarOpen: true, sidebarWidth: 248, collapsed: [] },
    connections: [
      conn({
        id: 'local',
        kind: 'local',
        label: tr("本机"),
        status: 'ready',
        detail: 'demo@macbook',
        homeDir: '/Users/demo',
        discoveredAt: now - 2 * min,
        agents: [agent('codex', 85, 2, 3 * min, tr("示例：排查 skill 没有被加载")), agent('claude', 29, 7, 90 * min)],
      }),
      conn({
        id: 'ssh:devbox',
        kind: 'ssh',
        label: 'devbox',
        alias: 'devbox',
        status: 'ready',
        detail: 'demo@10.0.0.12 · GSSAPI · Linux x86_64 · glibc 2.28',
        homeDir: '/home/demo',
        discoveredAt: now - min,
        maxServers: 4,
        stages: stages(['success', 'success', 'skipped', 'success', 'skipped'], ['demo@10.0.0.12 · GSSAPI', undefined, tr("已在 known_hosts 中"), 'Linux x86_64 · glibc 2.28', tr("已安装 0.1.0-demo")]),
        agents: [agent('codex', 21, 3, 5 * min, tr("示例：远端调试会话")), agent('claude', 6, 1, 3 * 60 * min)],
      }),
      conn({
        id: 'ssh:test-7',
        kind: 'ssh',
        label: 'test-7',
        alias: 'test-7',
        status: 'hostkey',
        detail: 'demo@test-7.internal',
        stages: stages(['success', 'pending', 'running'], [undefined, undefined, tr("等待你确认指纹")]),
        hostKey: { kind: 'unknown', keyType: 'ssh-ed25519', fingerprint: 'SHA256:JW6niZ6bSCvb+j59XaQUaFx3EXbMgPDyf4ptnojtszQ', hostId: 'test-7.internal', knownHostsFile: '/Users/demo/.ssh/known_hosts' },
      }),
      conn({
        id: 'ssh:gpu-box',
        kind: 'ssh',
        label: 'gpu-box',
        alias: 'gpu-box',
        status: 'error',
        detail: 'demo@gpu-box · GSSAPI',
        stages: stages(['success', 'error'], [undefined, tr("Kerberos 票据不可用或已过期")]),
        error: { kind: 'kerberos', message: tr("Kerberos 票据不可用或已过期，请先在终端执行 kinit 后重试"), detail: 'demo@gpu-box: Permission denied (gssapi-with-mic).' },
      }),
      conn({
        id: 'ssh:build',
        kind: 'ssh',
        label: 'build',
        alias: 'build',
        status: 'installing',
        detail: 'demo@build-01 · Linux aarch64 · glibc 2.35',
        stages: stages(['success', 'success', 'skipped', 'success', 'running'], [undefined, undefined, tr("已在 known_hosts 中"), 'Linux aarch64 · glibc 2.35', tr("上传 35.5MB")]),
        progress: { label: tr("上传服务端"), done: 13.2 * 1024 * 1024, total: 35.5 * 1024 * 1024 },
      }),
    ],
    workspaces: [tab('local', 'local', tr("本机"), 'codex', 'ready'), tab('local', 'local', tr("本机"), 'claude', 'ready'), tab('ssh:devbox', 'ssh', 'devbox', 'codex', 'ready'), tab('ssh:build', 'ssh', 'build', 'codex', 'connecting')],
    activeId: 'ssh:devbox::codex',
  };
  const stateL = new Set<(s: ShellState) => void>();
  const toastL = new Set<(t: Toast) => void>();
  const markOpen = () => {
    for (const x of state.connections) for (const a of x.agents) a.workspaceId = state.workspaces.find((w) => w.connId === x.id && w.agent === a.agent)?.id;
  };
  markOpen();
  const emit = () => {
    markOpen();
    const copy = structuredClone(state);
    for (const l of stateL) l(copy);
  };
  const c = (id: string) => state.connections.find((x) => x.id === id)!;
  const later = (fn: () => void, ms = 700) => setTimeout(() => (fn(), emit()), ms);
  const sub = <T,>(set: Set<(v: T) => void>) => (cb: (v: T) => void) => {
    set.add(cb);
    return () => {
      set.delete(cb);
    };
  };

  return {
    getState: async () => (markOpen(), structuredClone(state)),
    async refreshSshHosts() { return [...state.sshHosts]; },
    async chooseIdentityFile() { return '~/.ssh/id_ed25519'; },
    async addSsh(input) {
      const { alias, label, options } = normalizeSshInput(typeof input === 'string' ? { alias: input } : input);
      const id = `ssh:${alias}`;
      if (!state.connections.some((x) => x.id === id)) state.connections.push(conn({ id, kind: 'ssh', label, alias, ssh: options, status: 'idle', stages: stages([]), maxServers: 4 }));
      state.sshHosts = state.sshHosts.filter((h) => h !== alias);
      emit();
      return { id };
    },
    async removeConnection(id) {
      state.connections = state.connections.filter((x) => x.id !== id);
      state.workspaces = state.workspaces.filter((w) => w.connId !== id);
      emit();
    },
    async connect(id) {
      const x = c(id);
      x.status = 'connecting';
      x.error = undefined;
      x.stages = stages(['running']);
      emit();
      later(() => {
        x.status = 'ready';
        x.stages = stages(['success', 'success', 'skipped', 'success', 'skipped']);
        x.agents = [agent('codex', 20, 1, 9 * min)];
        x.discoveredAt = Date.now();
      }, 1200);
    },
    async disconnect(id) {
      c(id).status = 'idle';
      state.workspaces = state.workspaces.filter((w) => w.connId !== id);
      if (!state.workspaces.some((w) => w.id === state.activeId)) state.activeId = state.workspaces[0]?.id;
      emit();
    },
    async discover(id) {
      const x = c(id);
      x.discovering = true;
      emit();
      later(() => {
        x.discovering = false;
        x.discoveredAt = Date.now();
      });
    },
    async setEnabled(id, enabled) {
      const x = c(id);
      x.enabled = enabled;
      if (!enabled) {
        x.agents = [];
        x.discoveredAt = undefined;
        state.workspaces = state.workspaces.filter((w) => w.connId !== id);
        if (!state.workspaces.some((w) => w.id === state.activeId)) state.activeId = state.workspaces[0]?.id;
      } else {
        x.discovering = true;
        later(() => {
          x.discovering = false;
          x.discoveredAt = Date.now();
          x.agents = [agent('codex', 85, 2, 3 * min), agent('claude', 29, 7, 90 * min)].filter((a) => x.scan.find((s) => s.agent === a.agent)?.enabled);
        });
      }
      emit();
    },
    async setAgentScan(id, a, patch) {
      const x = c(id);
      const sc = x.scan.find((s) => s.agent === a)!;
      if (patch.enabled !== undefined) sc.enabled = patch.enabled;
      if (patch.roots !== undefined) {
        sc.custom = patch.roots.length > 0;
        sc.roots = patch.roots.length ? patch.roots : sc.defaultRoots;
      }
      if (!sc.enabled) {
        x.agents = x.agents.filter((g) => g.agent !== a);
        state.workspaces = state.workspaces.filter((w) => w.id !== `${id}::${a}`);
        if (!state.workspaces.some((w) => w.id === state.activeId)) state.activeId = state.workspaces[0]?.id;
      }
      emit();
    },
    async answerHostKey(id, accept) {
      const x = c(id);
      x.hostKey = undefined;
      x.status = accept ? 'connecting' : 'idle';
      emit();
      if (accept) later(() => (x.status = 'ready'), 900);
    },
    async openWorkspace(connId, a) {
      const id = `${connId}::${a}`;
      if (!state.workspaces.some((w) => w.id === id)) {
        const x = c(connId);
        const ws: WorkspaceView = { ...tab(connId, x.kind, x.label, a, 'starting') };
        state.workspaces.push(ws);
        later(() => (state.workspaces.find((w) => w.id === id)!.status = 'ready'), 900);
      }
      state.activeId = id;
      emit();
      return { id };
    },
    async activateWorkspace(id) {
      state.activeId = id;
      emit();
    },
    async closeWorkspace(id) {
      const i = state.workspaces.findIndex((w) => w.id === id);
      state.workspaces.splice(i, 1);
      if (state.activeId === id) state.activeId = (state.workspaces[i] ?? state.workspaces[i - 1])?.id;
      emit();
    },
    async moveWorkspace(id, to) {
      const i = state.workspaces.findIndex((w) => w.id === id);
      const [w] = state.workspaces.splice(i, 1);
      state.workspaces.splice(to, 0, w);
      emit();
    },
    async retryWorkspace() {},
    async workspaceUrl() {
      return { url: 'about:blank', baseUrl: 'about:blank' };
    },
    async routeChanged() {},
    async setUi(patch) {
      state.ui = { ...state.ui, ...patch };
      emit();
    },
    async openExternal() {},
    async openLogs() {},
    report() {},
    onState: sub(stateL),
    onRestarted: () => () => undefined,
    onCommand: (_cb: (c: ShellCommand) => void) => () => undefined,
    onToast: sub(toastL),
  };
}

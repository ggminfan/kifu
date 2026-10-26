import { createHash } from 'node:crypto';
import { normalizeSshInput, type AddSshInput } from '../../shared/ssh';
import { tr } from '../../../../src/shared/i18n';
import os from 'node:os';
import { applyDesktopLanguage, systemLocale } from './language';
import { AGENT_KINDS, AGENT_LABEL, isAgentKind, type AgentKind } from '../../../../src/shared/agents';
import { DEFAULT_SCAN, type AgentDiscovery, type AgentScan } from '../../../../src/shared/remote-protocol';
import type { AgentScanView, AgentView, ConnectionView, ShellState, ShellUi, Toast, WorkspaceStatus, WorkspaceView } from '../../shared/shell';
import { readConfigHosts, validAlias } from '../ssh/resolve';
import { fileLogger, LocalHost, logDir } from '../transport/local';
import { windowUrl } from '../transport/server-process';
import { MAX_SERVERS_PER_HOST, SshHost } from '../transport/ssh';
import type { HostRuntime, HostStatus, ManagedServer } from '../transport/types';
import type { ServerEndpoint } from '../transport/server-process';
import { loadState, saveState, type ForeignEntries, type StoredConnection, type StoredState } from './store';

/**
 * The app model behind the single main window: connections (本机, SSH hosts),
 * the agents found on each (Codex, Claude Code), and the open workspaces
 * (tabs). A workspace is one (connection, agent) pair — all of that agent's
 * sessions on the machine — served by its own server; its UI lives in a
 * sandboxed webview inside the window. Opening a tab starts the server
 * (connecting first for remotes), closing it stops it.
 *
 * Each connection says which agents to look for and where (per agent scan
 * directories). 本机 is a connection like the others, used once turned on.
 */

export interface ModelHooks {
  onChange(): void;
  /** The workspace's server came back (new process or tunnel): its webview must sign in again. */
  onRestarted(workspaceId: string): void;
  onToast(t: Toast): void;
  /** Active workspace changed (native window title). */
  onActive?(title: string): void;
}

interface Connection {
  stored: StoredConnection;
  readonly runtime: HostRuntime;
  agents: AgentDiscovery[];
  discovering: boolean;
  discovery?: Promise<void>;
  /** What the scan in flight looks for (a changed setting scans again after it). */
  discoveryKey?: string;
  discoveredAt?: number;
  discoverError?: string;
  lastStatus: HostStatus;
}

interface Workspace {
  id: string;
  connId: string;
  agent: AgentKind;
  route: string;
  server?: ManagedServer;
}

const ACTIVE = new Set(['starting', 'ready', 'restarting']);
const DEFAULT_UI: ShellUi = { sidebarOpen: true, sidebarWidth: 248, collapsed: [] };

export function workspaceId(connId: string, agent: AgentKind): string {
  return `${connId}::${agent}`;
}

/** One agent on a stored connection: scanned or not, and where. */
export function agentScan(stored: StoredConnection, agent: AgentKind): { enabled: boolean; roots: string[]; custom: boolean } {
  const a = stored.agents?.[agent];
  const custom = Boolean(a?.roots?.length);
  return { enabled: a?.enabled !== false, roots: custom ? a!.roots! : DEFAULT_SCAN[agent], custom };
}

/** What `discover` should look for on the connection: the enabled agents, each with its directories. */
export function scanOf(stored: StoredConnection): AgentScan {
  const out: AgentScan = {};
  for (const agent of AGENT_KINDS) {
    const a = agentScan(stored, agent);
    if (a.enabled) out[agent] = a.roots;
  }
  return out;
}

/** 本机 runs only once turned on; remotes are always usable (they connect on demand). */
export function connectionEnabled(stored: StoredConnection): boolean {
  return stored.kind !== 'local' || stored.enabled === true;
}

export class ConnectionManager {
  private readonly list: Connection[] = [];
  private workspaces: Workspace[] = [];
  private activeId?: string;
  private ui: ShellUi;
  private window: StoredState['window'];
  private sshHostsCache?: { at: number; hosts: string[] };
  private pushTimer?: ReturnType<typeof setTimeout>;
  private saveTimer?: ReturnType<typeof setTimeout>;
  private readonly wired = new WeakSet<ManagedServer>();
  /** What another build sharing the store keeps there: saved along, untouched. */
  private readonly foreign: ForeignEntries;

  constructor(
    private readonly hooks: ModelHooks,
    private readonly version = '0.0.0',
  ) {
    const state = loadState();
    this.foreign = state.foreign ?? { connections: [], workspaces: [] };
    const stored = state.connections;
    const local = stored.find((c) => c.kind === 'local');
    // a fresh install starts with 本机 off; before it could be turned off it always was on
    if (!local) stored.unshift({ id: 'local', kind: 'local', enabled: !state.fresh });
    else local.enabled ??= true;
    for (const s of stored) {
      if (s.kind === 'ssh') {
        if (!s.alias || !validAlias(s.alias)) continue;
        try { if (s.ssh) s.ssh = normalizeSshInput({ alias: s.alias, ...s.ssh }).options; } catch { continue; }
      }
      this.list.push(this.make(s));
    }
    this.ui = { ...DEFAULT_UI, ...(state.ui ?? {}) };
    this.ui.language = applyDesktopLanguage(this.ui.language);
    this.window = state.window;
    for (const w of state.workspaces) {
      const c = this.list.find((x) => x.stored.id === w.connId);
      if (!c || !connectionEnabled(c.stored) || !agentScan(c.stored, w.agent).enabled) continue;
      const id = workspaceId(w.connId, w.agent);
      if (!this.workspaces.some((x) => x.id === id)) this.workspaces.push({ id, connId: w.connId, agent: w.agent, route: w.route ?? '/' });
    }
    this.activeId = this.workspaces.some((w) => w.id === state.activeId) ? state.activeId : this.workspaces[0]?.id;
  }

  private make(stored: StoredConnection): Connection {
    const runtime = stored.kind === 'local' ? new LocalHost() : new SshHost({ alias: stored.alias!, label: stored.label, options: stored.ssh, log: fileLogger(`ssh-${stored.alias!.replace(/[^A-Za-z0-9_.@-]/g, '_')}`) });
    const c: Connection = { stored, runtime, agents: [], discovering: false, lastStatus: runtime.status };
    runtime.onChange(() => this.hostChanged(c));
    return c;
  }

  /** Toasts for transitions worth interrupting for; everything else is in the sidebar. */
  private hostChanged(c: Connection): void {
    const prev = c.lastStatus;
    const now = c.runtime.status;
    c.lastStatus = now;
    if (prev !== now) {
      if (prev === 'reconnecting' && now === 'ready') this.hooks.onToast({ level: 'success', title: `已重新连接 ${c.runtime.label}` });
      if (now === 'error' && c.runtime.error && c.runtime.error.kind !== 'host_key_unknown') {
        this.hooks.onToast({ level: 'error', title: `${c.runtime.label}：${c.runtime.error.message}` });
      }
      if (now === 'ready' && prev !== 'ready' && !c.discoveredAt && !c.discovering) void this.discover(c.stored.id);
    }
    this.changed();
  }

  /** Coalesce bursts of state changes (progress, steps) into one push. */
  changed(): void {
    if (this.pushTimer) return;
    this.pushTimer = setTimeout(() => {
      this.pushTimer = undefined;
      this.hooks.onChange();
    }, 60);
  }

  private save(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined;
      try {
        saveState({
          connections: this.list.map((c) => c.stored),
          workspaces: this.workspaces.map((w) => ({ connId: w.connId, agent: w.agent, route: w.route })),
          activeId: this.activeId,
          ui: this.ui,
          window: this.window,
          foreign: this.foreign,
        });
      } catch (e) {
        console.error('saving desktop state failed', e);
      }
    }, 200);
  }

  private conn(id: string): Connection {
    const c = this.list.find((x) => x.stored.id === id);
    if (!c) throw new Error(`没有这个连接：${id}`);
    return c;
  }

  private ws(id: string): Workspace {
    const w = this.workspaces.find((x) => x.id === id);
    if (!w) throw new Error('这个工作区已经关闭');
    return w;
  }

  // ---- startup / window ----------------------------------------------------

  /** Start the active workspace and scan 本机 (when on). */
  start(): void {
    if (this.activeId) this.activate(this.activeId);
    if (connectionEnabled(this.conn('local').stored)) void this.discover('local');
  }

  savedWindowFrame(): StoredState['window'] {
    return this.window;
  }

  rememberWindowFrame(frame: NonNullable<StoredState['window']>): void {
    this.window = frame;
    this.save();
  }

  // ---- connections -------------------------------------------------------------

  addSsh(input: string | AddSshInput): string {
    const { alias, label, options, secret } = normalizeSshInput(typeof input === 'string' ? { alias: input } : input);
    const configured = options.port || options.user || options.authentication !== 'auto';
    const suffix = configured ? ':' + createHash('sha256').update(JSON.stringify(options)).digest('hex').slice(0, 12) : '';
    const id = `ssh:${alias}${suffix}`;
    let connection = this.list.find((c) => c.stored.id === id);
    if (!connection) {
      connection = this.make({ id, kind: 'ssh', alias, label, ssh: options });
      this.list.push(connection);
      this.save();
      this.changed();
    }
    if (secret && connection.runtime instanceof SshHost) connection.runtime.setCredential(secret);
    return id;
  }

  refreshSshHosts(): string[] {
    this.sshHostsCache = undefined;
    const hosts = this.sshHosts();
    this.changed();
    return hosts;
  }

  async removeConnection(id: string): Promise<void> {
    const c = this.conn(id);
    if (c.stored.kind === 'local') throw new Error('本机连接不能移除');
    for (const w of this.workspaces.filter((x) => x.connId === id)) this.closeWorkspace(w.id);
    // tabs another build sharing the store had on it go too
    this.foreign.workspaces = this.foreign.workspaces.filter((w) => w.connId !== id);
    await c.runtime.disconnect();
    this.list.splice(this.list.indexOf(c), 1);
    this.save();
    this.changed();
  }

  async connect(id: string, secret?: string): Promise<void> {
    const c = this.conn(id);
    if (secret !== undefined && c.runtime instanceof SshHost) c.runtime.setCredential(secret);
    try {
      await c.runtime.connect();
    } catch {
      return; // shown through runtime.error and a toast
    }
    await this.discover(id);
  }

  /** Disconnect closes that host's tabs (like leaving a remote workspace) and stops its servers. */
  async disconnect(id: string): Promise<void> {
    const c = this.conn(id);
    for (const w of this.workspaces.filter((x) => x.connId === id)) this.closeWorkspace(w.id, false);
    await c.runtime.disconnect();
    this.changed();
  }

  /** Scan for the enabled agents in their directories; concurrent callers share the scan in flight. */
  discover(id: string): Promise<void> {
    const c = this.conn(id);
    const scan = scanOf(c.stored);
    if (!connectionEnabled(c.stored) || !Object.keys(scan).length) {
      c.agents = [];
      c.discoveredAt = connectionEnabled(c.stored) ? Date.now() : undefined;
      c.discoverError = undefined;
      this.changed();
      return Promise.resolve();
    }
    const key = JSON.stringify(scan);
    if (c.discovery && c.discoveryKey !== key) return c.discovery.then(() => this.discover(id));
    c.discoveryKey = key;
    c.discovery ??= (async () => {
      c.discovering = true;
      c.discoverError = undefined;
      this.changed();
      const t0 = Date.now();
      const log = (c.runtime as { log?: (line: string) => void }).log;
      try {
        c.agents = await c.runtime.discover(scan);
        c.discoveredAt = Date.now();
        log?.(`discover: ${c.agents.map((a) => `${a.agent} ${a.sessions}/${a.sources}`).join(', ') || 'nothing'} (${Date.now() - t0}ms)`);
      } catch (e) {
        c.discoverError = (e as Error).message;
        log?.(`discover failed after ${Date.now() - t0}ms: ${c.discoverError}`);
      } finally {
        c.discovering = false;
        c.discovery = undefined;
        this.changed();
      }
    })();
    return c.discovery;
  }

  /** Turn 本机 on (scan it) or off (close its tabs, stop its servers). */
  async setEnabled(id: string, enabled: boolean): Promise<void> {
    const c = this.conn(id);
    if (c.stored.kind !== 'local') throw new Error('只有本机可以开关；远端连接用「连接 / 断开」');
    if (c.stored.enabled === enabled) return;
    c.stored.enabled = enabled;
    this.save();
    if (enabled) {
      void this.discover(id);
      return;
    }
    for (const w of this.workspaces.filter((x) => x.connId === id)) this.closeWorkspace(w.id);
    c.agents = [];
    c.discoveredAt = undefined;
    c.discoverError = undefined;
    await c.runtime.disconnect();
    this.changed();
  }

  /**
   * Scan an agent on a connection or not, and where (`roots: []` = the
   * defaults). Turning one off closes its tab; new directories rescan, and a
   * running workspace of that agent restarts its server to pick them up.
   */
  setAgentScan(id: string, agent: AgentKind, patch: { enabled?: boolean; roots?: string[] }): void {
    if (!isAgentKind(agent)) throw new Error(`未知的 agent：${String(agent)}`);
    const c = this.conn(id);
    const before = agentScan(c.stored, agent);
    const next = { ...(c.stored.agents?.[agent] ?? {}) };
    if (patch.enabled !== undefined) next.enabled = patch.enabled ? undefined : false;
    if (patch.roots !== undefined) {
      const clean = [...new Set(patch.roots.map((r) => r.trim()).filter(Boolean))];
      next.roots = clean.length && JSON.stringify(clean) !== JSON.stringify(DEFAULT_SCAN[agent]) ? clean : undefined;
    }
    const agents = { ...(c.stored.agents ?? {}), [agent]: next };
    if (next.enabled === undefined && next.roots === undefined) delete agents[agent];
    c.stored.agents = Object.keys(agents).length ? agents : undefined;
    this.save();
    const after = agentScan(c.stored, agent);
    const w = this.workspaces.find((x) => x.id === workspaceId(id, agent));
    if (!after.enabled && w) this.closeWorkspace(w.id);
    if (after.enabled && w?.server && ACTIVE.has(w.server.status) && JSON.stringify(after.roots) !== JSON.stringify(before.roots)) this.restartServer(w);
    if (connectionEnabled(c.stored) && (c.stored.kind === 'local' || c.runtime.status === 'ready')) void this.discover(id);
    else this.changed();
  }

  answerHostKey(id: string, accept: boolean): void {
    this.conn(id).runtime.answerHostKey(accept);
  }

  // ---- workspaces ------------------------------------------------------------

  openWorkspace(connId: string, agent: AgentKind): string {
    if (!isAgentKind(agent)) throw new Error(`未知的 agent：${String(agent)}`);
    const c = this.conn(connId);
    if (!connectionEnabled(c.stored)) throw new Error('本机还没有启用：在设置 → 连接里打开它');
    if (!agentScan(c.stored, agent).enabled) throw new Error(`${c.runtime.label} 没有启用 ${AGENT_LABEL[agent]}：在设置 → 连接里打开它`);
    const id = workspaceId(connId, agent);
    if (!this.workspaces.some((w) => w.id === id)) {
      if (c.stored.kind !== 'local') {
        const running = this.workspaces.filter((w) => w.connId === connId && w.server && ACTIVE.has(w.server.status)).length;
        if (running >= MAX_SERVERS_PER_HOST) {
          this.hooks.onToast({ level: 'warn', title: `${c.runtime.label} 已打开 ${MAX_SERVERS_PER_HOST} 个工作区`, description: '先关掉一个标签再打开新的。' });
          throw new Error('too many workspaces');
        }
      }
      const at = this.activeId ? this.workspaces.findIndex((w) => w.id === this.activeId) + 1 : this.workspaces.length;
      this.workspaces.splice(at, 0, { id, connId, agent, route: '/' });
      c.stored.recent = { ...(c.stored.recent ?? {}), [agent]: Date.now() };
    }
    this.activate(id);
    return id;
  }

  activate(id: string): void {
    const w = this.ws(id);
    this.activeId = id;
    this.ensureStarted(w);
    const c = this.conn(w.connId);
    this.hooks.onActive?.(`${c.stored.kind === 'local' ? tr('本机') : c.runtime.label} · ${AGENT_LABEL[w.agent]}`);
    this.save();
    this.changed();
  }

  closeWorkspace(id: string, stop = true): void {
    const i = this.workspaces.findIndex((w) => w.id === id);
    if (i === -1) return;
    const [w] = this.workspaces.splice(i, 1);
    if (this.activeId === id) {
      const next = this.workspaces[i] ?? this.workspaces[i - 1];
      this.activeId = undefined;
      if (next) this.activate(next.id);
    }
    if (stop && w.server) void w.server.stop();
    this.save();
    this.changed();
  }

  moveWorkspace(id: string, to: number): void {
    const i = this.workspaces.findIndex((w) => w.id === id);
    if (i === -1) return;
    const [w] = this.workspaces.splice(i, 1);
    this.workspaces.splice(Math.max(0, Math.min(to, this.workspaces.length)), 0, w);
    this.save();
    this.changed();
  }

  retryWorkspace(id: string): void {
    const w = this.ws(id);
    this.ensureStarted(w, true);
  }

  async workspaceUrl(id: string, next?: string): Promise<{ url: string; baseUrl: string }> {
    const w = this.ws(id);
    const ep = w.server?.endpoint;
    if (!ep || w.server?.status !== 'ready') throw new Error('工作区还没有就绪');
    return { url: await windowUrl(ep, next ?? w.route), baseUrl: ep.baseUrl };
  }

  routeChanged(id: string, route: string): void {
    const w = this.workspaces.find((x) => x.id === id);
    if (!w || !route.startsWith('/') || w.route === route) return;
    w.route = route;
    this.save();
  }

  /** A workspace's server (the self-test calls its API). */
  endpointOf(id: string): ServerEndpoint | undefined {
    return this.workspaces.find((w) => w.id === id)?.server?.endpoint;
  }

  setUi(patch: Partial<ShellUi>): void {
    this.ui = { ...this.ui, ...patch };
    this.ui.language = applyDesktopLanguage(this.ui.language);
    const active = this.workspaces.find((w) => w.id === this.activeId);
    if (active) {
      const c = this.conn(active.connId);
      this.hooks.onActive?.(`${c.stored.kind === 'local' ? tr('本机') : c.runtime.label} · ${AGENT_LABEL[active.agent]}`);
    }
    this.save();
    this.changed();
  }

  /** A new server for the workspace (new settings); its open view then signs in to it. */
  private restartServer(w: Workspace): void {
    const server = w.server;
    if (!server) return;
    void server.stop().then(async () => {
      if (!this.workspaces.includes(w)) return;
      this.ensureStarted(w, true);
      try {
        await w.server?.start();
        if (this.workspaces.includes(w)) this.hooks.onRestarted(w.id);
      } catch {
        // shown on the tab
      }
    });
  }

  private ensureStarted(w: Workspace, force = false): void {
    const c = this.conn(w.connId);
    const server = c.runtime.server({ agent: w.agent, roots: agentScan(c.stored, w.agent).roots });
    w.server = server;
    if (!this.wired.has(server)) {
      this.wired.add(server);
      server.onRestart(() => {
        const ws = this.workspaces.find((x) => x.server === server);
        if (ws) this.hooks.onRestarted(ws.id);
      });
    }
    if (!force && (server.status === 'ready' || server.status === 'starting' || server.status === 'restarting')) return;
    this.changed();
    server.start().then(
      () => this.changed(),
      (e) => {
        if (!this.workspaces.includes(w)) return;
        // host-level failures already produced a toast
        if (c.runtime.status !== 'error') this.hooks.onToast({ level: 'error', title: `无法打开 ${c.runtime.label} 的 ${AGENT_LABEL[w.agent]}`, description: (e as Error).message });
        this.changed();
      },
    );
  }

  /** After sleep or a network change: verify links now instead of waiting for keepalives. */
  async onWake(): Promise<void> {
    for (const c of this.list) {
      const r = c.runtime;
      if (r instanceof SshHost && r.status === 'ready') {
        if (await r.verifyLink()) for (const s of r.servers()) void s.checkNow();
      }
    }
  }

  /** Self-test only: the runtime behind a connection. */
  runtimeOf(id: string): HostRuntime {
    return this.conn(id).runtime;
  }

  killAll(): void {
    for (const c of this.list) c.runtime.killAll();
  }

  // ---- view ----------------------------------------------------------------------

  private homeDir(c: Connection): string | undefined {
    if (c.runtime instanceof SshHost) return c.runtime.platform?.home;
    return os.homedir();
  }

  private sshHosts(): string[] {
    const now = Date.now();
    if (!this.sshHostsCache || now - this.sshHostsCache.at > 30_000) this.sshHostsCache = { at: now, hosts: readConfigHosts() };
    const added = new Set(this.list.map((c) => c.stored.alias));
    return this.sshHostsCache.hosts.filter((h) => !added.has(h));
  }

  /** Agents found by the last scan, plus remembered ones (open tabs, recently used) — always in the order Codex, Claude Code. */
  private agentsView(c: Connection): AgentView[] {
    if (!connectionEnabled(c.stored)) return [];
    const by = new Map<AgentKind, AgentView>();
    for (const a of c.agents) {
      by.set(a.agent, { agent: a.agent, label: AGENT_LABEL[a.agent], sessions: a.sessions, sources: a.sources, paths: a.paths, lastActivity: a.lastActivity, latestTitle: a.latestTitle });
    }
    const remembered = (agent: AgentKind): AgentView => ({ agent, label: AGENT_LABEL[agent], sessions: 0, sources: 0, missing: Boolean(c.discoveredAt) });
    for (const [k, at] of Object.entries(c.stored.recent ?? {})) {
      if (!isAgentKind(k)) continue;
      const v = by.get(k);
      if (v) v.recent = at;
      else if (!c.discoveredAt) by.set(k, { ...remembered(k), recent: at });
    }
    for (const w of this.workspaces) if (w.connId === c.stored.id && !by.has(w.agent)) by.set(w.agent, remembered(w.agent));
    for (const v of by.values()) {
      const id = workspaceId(c.stored.id, v.agent);
      if (this.workspaces.some((w) => w.id === id)) v.workspaceId = id;
    }
    return AGENT_KINDS.filter((k) => agentScan(c.stored, k).enabled)
      .map((k) => by.get(k))
      .filter((v): v is AgentView => Boolean(v));
  }

  private workspaceView(w: Workspace): WorkspaceView {
    const c = this.conn(w.connId);
    const host = c.runtime;
    const s = w.server;
    let status: WorkspaceStatus;
    let error: string | undefined;
    if (!s) status = 'idle';
    else if (c.stored.kind !== 'local' && host.status !== 'ready') {
      if (host.status === 'error') {
        status = 'error';
        error = host.error?.message;
      } else if (host.status === 'idle') status = 'idle';
      else if (host.status === 'reconnecting') status = s.endpoint ? 'restarting' : 'connecting';
      else status = 'connecting';
    } else {
      status = s.status === 'stopped' ? 'idle' : s.status;
      if (s.status === 'error') error = s.error;
    }
    return {
      id: w.id,
      connId: w.connId,
      kind: c.stored.kind,
      agent: w.agent,
      title: AGENT_LABEL[w.agent],
      connLabel: host.label,
      status,
      error,
      note: s?.note,
      route: w.route,
    };
  }

  view(): ShellState {
    const connections: ConnectionView[] = this.list.map((c) => {
      const r = c.runtime;
      return {
        id: c.stored.id,
        kind: c.stored.kind,
        label: r.label,
        enabled: connectionEnabled(c.stored),
        alias: c.stored.alias,
        ssh: c.stored.ssh ? { ...c.stored.ssh } : undefined,
        detail: r.detail,
        homeDir: this.homeDir(c),
        status: r.status,
        error: r.error,
        hostKey: r.hostKey,
        progress: r.progress,
        stages: r.stages.map((st) => ({ ...st })),
        steps: r.steps.slice(-40),
        scan: AGENT_KINDS.map((agent): AgentScanView => ({ agent, label: AGENT_LABEL[agent], ...agentScan(c.stored, agent), defaultRoots: DEFAULT_SCAN[agent] })),
        agents: this.agentsView(c),
        discovering: c.discovering,
        discoveredAt: c.discoveredAt,
        discoverError: c.discoverError,
        maxServers: c.stored.kind !== 'local' ? MAX_SERVERS_PER_HOST : undefined,
      };
    });
    return {
      connections,
      systemLocale,
      workspaces: this.workspaces.map((w) => this.workspaceView(w)),
      activeId: this.activeId,
      sshHosts: this.sshHosts(),
      ui: this.ui,
      version: this.version,
      logDir: logDir(),
    };
  }
}

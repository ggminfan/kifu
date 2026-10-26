import { validateSecret, type SshOptions } from '../../shared/ssh';
import { createHash } from 'node:crypto';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { AGENT_LABEL, type AgentKind } from '../../../../src/shared/agents';
import { parseReadyLine, type AgentDiscovery, type AgentScan, type ReadyLine } from '../../../../src/shared/remote-protocol';
import { decideInstall, findPackage, installCommand, parseInstallOutput, tarballFeeder, type LocalPackage } from '../remote/installer';
import { baseAssignment, describePlatform, loginEnv, parseProbe, probeCommand, type RemotePlatform } from '../remote/platform';
import { Backoff } from '../remote/reconnect';
import { controlPathFor, resolveArgs, shCommand, shQuote, type SshContext } from '../ssh/args';
import { classifySshError, SshError } from '../ssh/errors';
import { acceptHostKey, parseChangedHostKey, probeHostKey, promptFor, type HostKeyPrompt } from '../ssh/hostkey';
import { SshMaster } from '../ssh/master';
import { run, sleep } from '../ssh/proc';
import { parseSshG, type ResolvedHost } from '../ssh/resolve';
import { agentArgs, discoverArgs, health, newToken, parseDiscoverOutput, ServerStartError, waitHealthy, type ServerEndpoint } from './server-process';
import {
  Emitter,
  StepLog,
  type HostError,
  type HostRuntime,
  type HostStatus,
  type ManagedServer,
  type ServerSpec,
  type ServerStatus,
  type Stage,
  type StageId,
  type StageStatus,
  type Step,
} from './types';

/**
 * SSH remote: one ControlMaster per host; per agent a detached server (it
 * outlives the session and the app, so replays and evaluations go on), reached
 * through `-O forward` from a stable local port to its unix socket. A client
 * that comes back (after the link dropped, or the app restarted) takes the
 * running server over with a new token through its control socket. Reconnects
 * with backoff when the master dies; auth / host key problems stop and wait
 * for the user instead.
 */

export interface SshHostOptions {
  alias: string;
  label?: string;
  options?: SshOptions;
  sshBin?: string;
  /** Directory for ControlMaster sockets (default ~/.kifu/cm). */
  controlDir?: string;
  /** Remote data root (default $HOME/.kifu); tests point it elsewhere. */
  remoteBase?: string;
  packageDirs?: string[];
  backupDir?: string;
  log?: (line: string) => void;
}

export const MAX_SERVERS_PER_HOST = 4;

export function defaultSshBin(): string {
  return process.env.KIFU_SSH_BIN || 'ssh';
}

class HostFailure extends Error {
  constructor(
    readonly kind: string,
    message: string,
    readonly retryable: boolean,
    readonly detail?: string,
  ) {
    super(message);
  }
}

function toHostError(e: unknown): HostError & { retryable: boolean } {
  if (e instanceof SshError) return { kind: e.info.kind, message: e.info.message, detail: e.info.detail, retryable: e.info.retryable };
  if (e instanceof HostFailure) return { kind: e.kind, message: e.message, detail: e.detail, retryable: e.retryable };
  if (e instanceof ServerStartError) return { kind: 'server', message: e.message, detail: e.stderr.slice(-1200), retryable: true };
  return { kind: 'unknown', message: (e as Error)?.message ?? String(e), retryable: true };
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
  });
}

const STAGES: Array<[StageId, string]> = [
  ['config', '读取 SSH 配置'],
  ['connect', '建立 SSH 连接'],
  ['hostkey', '确认主机指纹'],
  ['platform', '检测远端环境'],
  ['install', '安装服务端'],
];

function freshStages(): Stage[] {
  return STAGES.map(([id, label]) => ({ id, label, status: 'pending' }));
}

function mb(n: number): string {
  return `${(n / 1024 / 1024).toFixed(1)}MB`;
}

/** Pick the KIFU_READY line out of the launcher's output, or explain why it is not there. */
export function parseLauncherOutput(stdout: string, stderr: string, exitCode: number | null): { ready?: ReadyLine; error?: string; detail?: string } {
  for (const line of stdout.split('\n')) {
    const ready = parseReadyLine(line);
    if (ready) return { ready };
  }
  const marker = /KIFU_START_(FAILED|TIMEOUT)/.exec(stdout);
  const tail = (marker ? stdout.slice(marker.index + marker[0].length) : `${stdout}\n${stderr}`).trim();
  const last = tail.split('\n').filter(Boolean).slice(-3).join(' ').slice(0, 400);
  if (/GLIBC_|glibc/i.test(tail)) return { error: `远端 glibc 版本过低，服务端无法运行：${last}`, detail: tail };
  if (marker?.[1] === 'TIMEOUT') return { error: '服务端 60 秒内没有就绪', detail: tail };
  return { error: last ? `服务端启动失败：${last}` : `服务端启动失败（退出码 ${exitCode ?? '?'}）`, detail: tail };
}

export class SshHost implements HostRuntime {
  readonly kind = 'ssh' as const;
  status: HostStatus = 'idle';
  error?: HostError;
  hostKey?: HostKeyPrompt;
  progress?: { label: string; done: number; total: number };
  resolved?: ResolvedHost;
  platform?: RemotePlatform;
  buildId?: string;
  master?: SshMaster;
  readonly sshBin: string;
  readonly controlDir: string;
  readonly log: (line: string) => void;
  private readonly emitter = new Emitter();
  readonly stepLog: StepLog;
  private readonly serverMap = new Map<string, RemoteServer>();
  private readonly backoff = new Backoff();
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private inflight?: Promise<void>;
  private wanted = false;
  private hostKeyAnswer?: (accept: boolean) => void;

  private credential?: string;
  setCredential(value: string): void { this.credential = validateSecret(value); }

  readonly opts: SshHostOptions;

  constructor(opts: SshHostOptions) {
    this.opts = opts;
    this.sshBin = opts.sshBin ?? defaultSshBin();
    this.controlDir = opts.controlDir ?? path.join(os.homedir(), '.kifu', 'cm');
    this.log = opts.log ?? (() => {});
    // development / tests only: keep a local test sshd's installs away from the real data root
    if (!opts.remoteBase && process.env.KIFU_REMOTE_BASE) this.opts = { ...opts, remoteBase: process.env.KIFU_REMOTE_BASE };
    this.stepLog = new StepLog(() => this.changed(), this.log);
  }

  get label(): string {
    return this.opts.label || this.opts.alias;
  }

  get steps(): Step[] {
    return this.stepLog.steps;
  }

  stages: Stage[] = freshStages();

  private stage(id: StageId, status: StageStatus, message?: string): void {
    const st = this.stages.find((x) => x.id === id);
    if (!st) return;
    st.status = status;
    st.message = message;
    this.changed();
  }

  /** Mark whatever was running as failed (the error itself is shown separately). */
  private failRunningStage(message: string): void {
    const st = this.stages.find((x) => x.status === 'running');
    if (st) this.stage(st.id, 'error', message);
  }

  get detail(): string | undefined {
    const r = this.resolved;
    if (!r) return undefined;
    const parts = [`${r.user ? `${r.user}@` : ''}${r.hostname}${r.port !== 22 ? `:${r.port}` : ''}`];
    if (r.proxyJump) parts.push(`经 ${r.proxyJump}`);
    else if (r.proxyCommand) parts.push('经 ProxyCommand');
    if (r.gssapi) parts.push('GSSAPI');
    if (this.platform) parts.push(describePlatform(this.platform));
    return parts.join(' · ');
  }

  onChange(cb: () => void): void {
    this.emitter.on(cb);
  }

  changed(): void {
    this.emitter.emit();
  }

  step(text: string, level: Step['level'] = 'info'): void {
    this.stepLog.add(text, level);
  }

  private setStatus(s: HostStatus): void {
    this.status = s;
    this.changed();
  }

  private ctx(): SshContext {
    return { sshBin: this.sshBin, alias: this.opts.alias, options: this.opts.options, controlPath: controlPathFor(this.controlDir, this.opts.alias + JSON.stringify(this.opts.options ?? {})) };
  }

  /** Connect (idempotent). Rejects when the connection cannot be established. */
  connect(): Promise<void> {
    this.wanted = true;
    if (this.status === 'ready' && this.master?.alive) return Promise.resolve();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    this.inflight ??= this.establish(this.status === 'reconnecting').finally(() => {
      this.inflight = undefined;
    });
    return this.inflight;
  }

  private async establish(isReconnect: boolean): Promise<void> {
    this.error = undefined;
    this.stages = freshStages();
    this.setStatus(isReconnect ? 'reconnecting' : 'connecting');
    try {
      this.stage('config', 'running');
      if (!this.resolved) {
        const r = await run(this.sshBin, resolveArgs(this.opts.alias, this.opts.options), { timeoutMs: 10_000 });
        if (r.code !== 0) throw new HostFailure('config', `无法解析 SSH 配置：${r.stderr.trim().slice(0, 300)}`, false);
        this.resolved = parseSshG(this.opts.alias, r.stdout);
        this.step(`SSH 配置：${this.detail}`);
      }
      this.stage('config', 'success', this.detail);
      await this.startMaster();
      await this.preparePlatform();
      this.setStatus('ready');
      this.backoff.reset();
      this.step('已连接');
      for (const s of this.serverMap.values()) if (s.wanted && s.status !== 'ready') void s.start().catch(() => undefined);
    } catch (e) {
      const err = toHostError(e);
      this.failRunningStage(err.message);
      const m = this.master;
      this.master = undefined;
      if (m) await m.stop().catch(() => undefined);
      this.progress = undefined;
      if (!this.wanted) {
        this.setStatus('idle');
        throw e;
      }
      if (isReconnect && err.retryable) {
        this.step(`重连失败：${err.message}`, 'warn');
        this.setStatus('reconnecting');
        this.scheduleReconnect();
      } else {
        this.error = err;
        this.step(err.message, 'error');
        this.setStatus('error');
        for (const s of this.serverMap.values()) s.hostFailed(err.message);
      }
      throw e;
    }
  }

  private async startMaster(): Promise<void> {
    if (this.opts.options?.authentication === 'password' && !this.credential) throw new HostFailure('password_required', '请输入 SSH 密码后连接', false);
    for (let attempt = 0; attempt < 2; attempt++) {
      const master = new SshMaster(this.ctx(), this.log, this.credential);
      this.master = master;
      this.step(attempt ? '重新建立连接' : `正在连接 ${this.opts.alias}`);
      this.stage('connect', 'running', this.resolved?.gssapi ? '使用 Kerberos / GSSAPI 认证' : undefined);
      try {
        await master.start();
        if (!this.wanted) { await master.stop(); throw new HostFailure('cancelled', '连接已取消', false); }
      } catch (e) {
        if (e instanceof SshError && (e.info.kind === 'host_key_unknown' || e.info.kind === 'host_key_changed') && attempt === 0) {
          this.stage('connect', 'pending');
          if (await this.confirmHostKey(e.info.kind, master.stderrTail())) continue;
          throw new HostFailure(e.info.kind, '已取消：没有信任远端主机指纹', false);
        }
        throw e;
      }
      this.master = master;
      master.onExit((info) => this.onMasterExit(master, info));
      this.stage('connect', 'success');
      const hk = this.stages.find((x) => x.id === 'hostkey');
      if (hk?.status === 'pending') this.stage('hostkey', 'skipped', '已在 known_hosts 中');
      return;
    }
  }

  private async confirmHostKey(kind: 'host_key_unknown' | 'host_key_changed', stderr: string): Promise<boolean> {
    const changed = kind === 'host_key_changed';
    this.step(changed ? '远端主机指纹和 known_hosts 中的记录不一致' : '第一次连接这台主机，需要确认主机指纹', changed ? 'warn' : 'info');
    let prompt: HostKeyPrompt;
    if (changed) {
      const c = parseChangedHostKey(stderr);
      const probe = c.fingerprint ? { keyType: c.keyType ?? '?', fingerprint: c.fingerprint } : await probeHostKey(this.sshBin, this.opts.alias, this.opts.options);
      prompt = promptFor(this.resolved!, probe, { offending: c.offending });
    } else {
      prompt = promptFor(this.resolved!, await probeHostKey(this.sshBin, this.opts.alias, this.opts.options));
    }
    // register the resolver before announcing the prompt: listeners may answer synchronously
    const answer = new Promise<boolean>((resolve) => {
      this.hostKeyAnswer = resolve;
    });
    this.hostKey = prompt;
    this.stage('hostkey', 'running', '等待你确认指纹');
    this.setStatus('hostkey');
    const accept = await answer;
    this.hostKeyAnswer = undefined;
    this.hostKey = undefined;
    if (!accept) {
      this.stage('hostkey', 'error', '没有信任这个指纹');
      return false;
    }
    this.setStatus('connecting');
    await acceptHostKey(this.sshBin, this.opts.alias, prompt, this.opts.backupDir ?? path.join(os.homedir(), '.kifu', 'backups'), this.opts.options);
    this.step(`已把主机指纹写入 ${prompt.knownHostsFile}`);
    this.stage('hostkey', 'success', `已写入 ${prompt.knownHostsFile}`);
    return true;
  }

  answerHostKey(accept: boolean): void {
    this.hostKeyAnswer?.(accept);
  }

  private async preparePlatform(): Promise<void> {
    this.step('检测远端环境');
    this.stage('platform', 'running');
    const r = await this.requireMaster().exec(shCommand(probeCommand(this.opts.remoteBase)), { timeoutMs: 45_000 });
    if (!r.stdout.includes('KIFU_PROBE_END')) throw new SshError(classifySshError(r.stderr, r.code));
    const p = parseProbe(r.stdout);
    this.platform = p;
    this.step(`远端 ${describePlatform(p)}`);
    const pkg = p.target ? findPackage(p.target, this.opts.packageDirs) : undefined;
    const d = decideInstall(p, pkg);
    if (d.action === 'unsupported') throw new HostFailure('unsupported', d.reason, false);
    if (d.action === 'missing-package') throw new HostFailure('missing_package', `应用里没有 ${d.target} 的服务端包（开发时先运行 pnpm build:server）`, false);
    this.stage('platform', 'success', describePlatform(p));
    if (d.action === 'reuse') {
      this.step(`服务端已安装（${d.buildId}）`);
      this.stage('install', 'skipped', `已安装 ${d.buildId}`);
    } else {
      await this.install(pkg!);
    }
    this.buildId = d.buildId;
  }

  private async install(pkg: LocalPackage): Promise<void> {
    this.setStatus('installing');
    this.step(`上传服务端 ${pkg.manifest.buildId}（${mb(pkg.size)}）`);
    const label = '上传服务端';
    this.stage('install', 'running', `上传 ${mb(pkg.size)}`);
    this.progress = { label, done: 0, total: pkg.size };
    const t0 = Date.now();
    const r = await this.requireMaster().exec(shCommand(installCommand(pkg, this.opts.remoteBase)), {
      timeoutMs: 20 * 60_000,
      feed: tarballFeeder(pkg, (done, total) => {
        this.progress = { label, done, total };
        this.changed();
      }),
    });
    this.progress = undefined;
    const res = parseInstallOutput(r.stdout, r.stderr, r.code);
    if (!res.ok) throw new HostFailure('install_failed', res.error ?? '安装失败', false, r.stderr.slice(-1200));
    this.step(`服务端安装完成（${((Date.now() - t0) / 1000).toFixed(1)} 秒）`);
    this.stage('install', 'success', `${pkg.manifest.buildId} · ${((Date.now() - t0) / 1000).toFixed(1)} 秒`);
    this.setStatus('connecting');
  }

  requireMaster(): SshMaster {
    if (!this.master?.alive) throw new HostFailure('disconnected', '连接已断开', true);
    return this.master;
  }

  private onMasterExit(master: SshMaster, info: { code: number | null; expected: boolean; stderr: string }): void {
    if (master !== this.master) return;
    this.master = undefined;
    for (const s of this.serverMap.values()) s.hostLost();
    if (info.expected) return;
    const cls = classifySshError(info.stderr, info.code);
    this.step(cls.kind === 'unknown' ? '连接已断开' : `连接已断开：${cls.message}`, 'warn');
    if (!this.wanted) {
      this.setStatus('idle');
      return;
    }
    if (!cls.retryable) {
      this.error = { kind: cls.kind, message: cls.message, detail: cls.detail };
      this.setStatus('error');
      return;
    }
    this.setStatus('reconnecting');
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    const delay = this.backoff.next();
    this.step(`${(delay / 1000).toFixed(1)} 秒后重连（第 ${this.backoff.attempts} 次）`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      if (!this.wanted || this.inflight) return;
      this.inflight = this.establish(true)
        .catch(() => undefined)
        .finally(() => {
          this.inflight = undefined;
        });
    }, delay);
  }

  /**
   * Is the link really alive? A new session needs a round trip; after sleep
   * or a network change the master process may still be running on a dead
   * TCP connection. Drop it so the reconnect logic takes over.
   */
  async verifyLink(): Promise<boolean> {
    const m = this.master;
    if (!m?.alive) return false;
    const r = await m.exec('exit 0', { timeoutMs: 8000 }).catch(() => undefined);
    if (r && r.code === 0 && !r.timedOut) return true;
    if (m === this.master) {
      this.step('连接没有响应，重新建立连接', 'warn');
      m.drop();
    }
    return false;
  }

  async discover(scan: AgentScan): Promise<AgentDiscovery[]> {
    await this.connect();
    const parts = [baseAssignment(this.opts.remoteBase), ...loginEnv(this.platform)];
    parts.push(`exec "$b/remote/versions/${this.buildId}/bin/kifu-server" ${discoverArgs(scan).map(shQuote).join(' ')}`);
    const r = await this.requireMaster().exec(shCommand(parts.join('; ')), { timeoutMs: 30_000 });
    const agents = r.code === 0 ? parseDiscoverOutput(r.stdout) : undefined;
    if (!agents) throw new HostFailure('discover', `扫描失败：${r.stderr.trim().split('\n').slice(-3).join(' ').slice(0, 300) || `退出码 ${r.code}`}`, true);
    return agents;
  }

  /**
   * Starts one detached server (setsid / nohup: it outlives the session and the
   * desktop app) and prints its KIFU_READY line. The token is the first stdin
   * line, piped on; the state file and the control socket let the next client
   * find it and take it over (`rekey`).
   */
  launcherScript(o: { spec: ServerSpec; name: string; tcp: boolean }): string {
    const p = this.platform;
    const serve = [
      '"$d/bin/kifu-server" serve',
      o.tcp ? '--port 0' : '--socket "$s"',
      '--token-stdin --control "$c" --state-file "$f"',
      `--idle-exit ${SSH_IDLE_EXIT_SEC} --ready`,
      '--web-dir "$d/web"',
      `--label ${shQuote(this.opts.alias)}`,
      agentArgs(o.spec).map(shQuote).join(' '),
    ].join(' ');
    const parts = [baseAssignment(this.opts.remoteBase), `d="$b/remote/versions/${this.buildId}"`, 'r="$b/run"', 'mkdir -p "$r"', 'chmod 700 "$b" "$r"'];
    parts.push(`f="$r/${o.name}.json"`, `log="$r/${o.name}.log"`, `s="$r/${o.name}.sock"`, `c="$r/${o.name}.ctl"`);
    // sun_path is ~104 bytes; very long homes put the sockets in a private dir under XDG_RUNTIME_DIR or /tmp
    parts.push(`if test \${#s} -gt 100; then q="\${XDG_RUNTIME_DIR:-/tmp}/kifu-$(id -u)"; mkdir -p "$q"; chmod 700 "$q"; s="$q/${o.name}.sock"; c="$q/${o.name}.ctl"; fi`);
    if (p?.loginPath) parts.push(`PATH=${shQuote(p.loginPath)}`, 'export PATH');
    // the $CODEX_HOME / $CLAUDE_CONFIG_DIR scan directories, as the login shell sets them
    parts.push(...loginEnv(p));
    parts.push('KIFU_HOME="$b"', 'export KIFU_HOME');
    if (process.env.KIFU_LOG_REQUESTS === '1') parts.push('KIFU_LOG_REQUESTS=1', 'export KIFU_LOG_REQUESTS');
    parts.push(
      'IFS= read -r t',
      'm=""',
      'if command -v setsid >/dev/null 2>&1; then if setsid -w true >/dev/null 2>&1; then m="setsid -w"; else m="setsid"; fi; fi',
    );
    // csh / fish safe (no "!", so no "$!"): a small sh records its own pid, then becomes the server
    parts.push(`pf="$r/${o.name}.pid"`, 'rm -f "$pf"');
    // a background job ends in "&", not "; " ("& ;" is a syntax error)
    const launch = `echo "$t" | $m nohup /bin/sh -c 'echo $$ > "$0"; exec "$@"' "$pf" ${serve} > "$log" 2>&1 &`;
    const ready = 'grep "^KIFU_READY " "$log" | head -n 1; exit 0';
    const failed = 'echo KIFU_START_FAILED; tail -c 1500 "$log"; exit 3';
    const wait = [
      't=""',
      'p=""',
      'i=0',
      `while test $i -lt 300; do if grep -q "^KIFU_READY " "$log" 2>/dev/null; then ${ready}; fi; if test -z "$p" && test -s "$pf"; then p=$(cat "$pf"); fi; if test -n "$p"; then if kill -0 "$p" 2>/dev/null; then :; else sleep 0.5; if grep -q "^KIFU_READY " "$log" 2>/dev/null; then ${ready}; fi; ${failed}; fi; elif test $i -gt 50; then ${failed}; fi; sleep 0.2; i=$((i+1)); done`,
      'echo KIFU_START_TIMEOUT; tail -c 1500 "$log"; if test -n "$p"; then kill "$p" 2>/dev/null; fi; exit 4',
    ];
    return `${parts.join('; ')}; ${launch} ${wait.join('; ')}`;
  }

  /** Prints the state file of the server with this name (if any) and whether its process is alive (a dead one's file is removed). */
  stateScript(name: string): string {
    return [
      baseAssignment(this.opts.remoteBase),
      `f="$b/run/${name}.json"`,
      'if test -f "$f"; then cat "$f"; echo; p=$(grep -o \'"pid":[0-9]*\' "$f" | head -n 1 | cut -d: -f2); if test -n "$p" && kill -0 "$p" 2>/dev/null; then echo KIFU_ALIVE; else echo KIFU_DEAD; rm -f "$f"; fi; fi',
    ].join('; ');
  }

  /** Runs our `rekey` helper against a server's control socket; the token comes on stdin. */
  rekeyScript(control: string): string {
    return [baseAssignment(this.opts.remoteBase), `exec "$b/remote/versions/${this.buildId}/bin/kifu-server" rekey --control ${shQuote(control)}`].join('; ');
  }

  /** Stops a server of ours by pid: TERM, then KILL after 5 s. */
  killScript(pid: number): string {
    return `kill ${pid} 2>/dev/null; i=0; while kill -0 ${pid} 2>/dev/null && test $i -lt 25; do sleep 0.2; i=$((i+1)); done; kill -9 ${pid} 2>/dev/null; true`;
  }

  /** A server of ours already running for this name (an earlier client started it), or not. */
  async existingServer(name: string): Promise<{ state: ServerState; alive: boolean } | undefined> {
    const r = await this.requireMaster().exec(shCommand(this.stateScript(name)), { timeoutMs: 20_000 });
    const line = r.stdout.split('\n').find((l) => l.startsWith('{'));
    if (!line) return undefined;
    try {
      return { state: JSON.parse(line) as ServerState, alive: r.stdout.includes('KIFU_ALIVE') };
    } catch {
      return undefined;
    }
  }

  /** Hand a running server a new token through its control socket (stdin → socket: never in argv or a file). */
  async rekeyServer(state: ServerState, token: string): Promise<boolean> {
    if (!state.control) return false;
    const r = await this.requireMaster().exec(shCommand(this.rekeyScript(state.control)), { input: `${token}\n`, timeoutMs: 20_000 });
    return r.code === 0;
  }

  async killServer(pid: number): Promise<void> {
    await this.requireMaster().exec(shCommand(this.killScript(pid)), { timeoutMs: 20_000 }).catch(() => undefined);
  }

  server(spec: ServerSpec): RemoteServer {
    let s = this.serverMap.get(spec.agent);
    if (!s) {
      s = new RemoteServer(this, spec);
      this.serverMap.set(spec.agent, s);
    } else s.update(spec);
    return s;
  }

  servers(): RemoteServer[] {
    return [...this.serverMap.values()];
  }

  async disconnect(): Promise<void> {
    this.credential = undefined;
    this.wanted = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    this.hostKeyAnswer?.(false);
    await Promise.all(this.servers().map((s) => s.stop()));
    const m = this.master;
    this.master = undefined;
    if (m) await m.stop();
    this.error = undefined;
    this.progress = undefined;
    this.step('已断开');
    this.setStatus('idle');
  }

  killAll(): void {
    this.credential = undefined;
    this.wanted = false;
    for (const s of this.serverMap.values()) s.kill();
    this.master?.kill();
  }
}

/** A detached server's state file ($base/run/<name>.json): its KIFU_READY line plus the control socket. */
export type ServerState = ReadyLine & { control?: string; startedAt?: number };

/** Exit after this long without requests and without runs, evaluations or analyses going. */
export const SSH_IDLE_EXIT_SEC = 600;

/** One server per agent and scan directories: the next client finds the same one by this name. */
export function serverName(spec: ServerSpec): string {
  return `${spec.agent}-${createHash('sha1').update(JSON.stringify(spec.roots ?? [])).digest('hex').slice(0, 10)}`;
}

export class RemoteServer implements ManagedServer {
  status: ServerStatus = 'stopped';
  error?: string;
  endpoint?: ServerEndpoint;
  note?: string;
  wanted = false;
  /** pid of the detached server on the remote. */
  remotePid?: number;
  private forwardSpec?: string;
  private localPort?: number;
  private useTcp = false;
  private everReady = false;
  private starting?: Promise<ServerEndpoint>;
  private healthTimer?: ReturnType<typeof setInterval>;
  private healthFailures = 0;
  private restartTimer?: ReturnType<typeof setTimeout>;
  private readonly restartBackoff = new Backoff(1000, 15_000);
  private readonly restartCbs: Array<(ep: ServerEndpoint) => void> = [];

  constructor(
    private readonly host: SshHost,
    private spec: ServerSpec,
  ) {}

  get agent(): AgentKind {
    return this.spec.agent;
  }

  /** New scan directories apply from the next start. */
  update(spec: ServerSpec): void {
    this.spec = spec;
  }

  onRestart(cb: (ep: ServerEndpoint) => void): void {
    this.restartCbs.push(cb);
  }

  private set(status: ServerStatus): void {
    this.status = status;
    this.host.changed();
  }

  start(): Promise<ServerEndpoint> {
    this.wanted = true;
    if (this.status === 'ready' && this.endpoint && this.forwardSpec) return Promise.resolve(this.endpoint);
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = undefined;
    }
    this.starting ??= this.launch().finally(() => {
      this.starting = undefined;
    });
    return this.starting;
  }

  private async launch(): Promise<ServerEndpoint> {
    this.set(this.everReady ? 'restarting' : 'starting');
    this.error = undefined;
    try {
      await this.host.connect();
      const ep = await this.spawnAndTunnel();
      this.endpoint = ep;
      this.set('ready');
      this.restartBackoff.reset();
      this.startHealth();
      if (this.everReady) for (const cb of this.restartCbs) cb(ep);
      this.everReady = true;
      return ep;
    } catch (e) {
      await this.teardown();
      this.error = toHostError(e).message;
      this.set(this.host.status === 'reconnecting' ? 'restarting' : 'error');
      throw e;
    }
  }

  private async spawnAndTunnel(): Promise<ServerEndpoint> {
    const master = this.host.requireMaster();
    const token = newToken();
    const name = serverName(this.spec);
    const tag = `[server ${this.spec.agent}]`;
    // an earlier client (this app before a restart, or before the link dropped) left it running: take it over
    let ready: ServerState | undefined;
    let adopted = false;
    const existing = await this.host.existingServer(name);
    if (existing?.alive) {
      if (await this.host.rekeyServer(existing.state, token)) {
        ready = existing.state;
        adopted = true;
        this.host.log(`${tag} took over the running server (pid ${ready.pid}, ${ready.buildId})`);
      } else {
        this.host.log(`${tag} the running server did not take a new token: replacing it`);
        await this.host.killServer(existing.state.pid);
      }
    }
    if (!ready) {
      const r = await master.exec(shCommand(this.host.launcherScript({ spec: this.spec, name, tcp: this.useTcp })), { input: `${token}\n`, timeoutMs: 75_000 });
      const out = parseLauncherOutput(r.stdout, r.stderr, r.code);
      if (!out.ready) {
        for (const l of (out.detail ?? '').split('\n')) if (l.trim()) this.host.log(`${tag} ${l}`);
        const cls = classifySshError(r.stderr, r.code);
        if (cls.kind !== 'unknown' && cls.kind !== 'remote_command_missing') throw new SshError(cls);
        throw new ServerStartError(out.error ?? '服务端启动失败', out.detail ?? r.stderr, r.code);
      }
      ready = out.ready;
    }
    this.remotePid = ready.pid;

    const remote = ready.socket ? ready.socket : `127.0.0.1:${ready.port}`;
    let port = this.localPort ?? (await freePort());
    try {
      await master.forward(`127.0.0.1:${port}:${remote}`);
    } catch (e) {
      if (!(e instanceof SshError) || e.info.kind !== 'port_in_use') throw e;
      port = await freePort();
      await master.forward(`127.0.0.1:${port}:${remote}`);
    }
    this.forwardSpec = `127.0.0.1:${port}:${remote}`;
    this.localPort = port;
    const ep: ServerEndpoint = { baseUrl: `http://127.0.0.1:${port}`, token, ready };
    if (await waitHealthy(ep, 4)) {
      // an older build left running: replace it unless it is still working
      if (adopted && ready.buildId !== this.host.buildId) {
        const h = await health(ep);
        if (h.ok && !h.body?.busy) {
          this.host.log(`${tag} replacing the idle older server (${ready.buildId})`);
          await this.cancelForward();
          await this.host.killServer(ready.pid);
          return this.spawnAndTunnel();
        }
        this.note = `远端旧版本（${ready.buildId}）还有任务在跑，先继续用它`;
      }
      return ep;
    }

    if (!ready.socket || !/administratively prohibited|open failed/i.test(master.stderrTail())) {
      throw new HostFailure('tunnel', '隧道已建立，但服务端没有响应', true, master.stderrTail().slice(-800));
    }
    this.host.step('远端 sshd 禁止转发 unix socket，改用 TCP 回环端口（仍然需要令牌认证）', 'warn');
    await this.teardown();
    await this.host.killServer(ready.pid);
    this.useTcp = true;
    this.note = 'TCP 端口转发（远端禁止 socket 转发，仍需令牌认证）';
    return this.spawnAndTunnel();
  }

  private scheduleRestart(): void {
    if (this.restartTimer || !this.wanted) return;
    const delay = this.restartBackoff.next();
    this.restartTimer = setTimeout(async () => {
      this.restartTimer = undefined;
      if (!this.wanted || this.status === 'ready') return;
      // the master may be dying too: let the host decide (it restarts us after reconnecting)
      if (this.host.status !== 'ready' || !(await this.host.verifyLink())) return;
      this.host.step(`重启 ${AGENT_LABEL[this.spec.agent]} 的服务端`, 'warn');
      void this.start().catch(() => this.scheduleRestart());
    }, delay);
  }

  /** The master died: the forward is gone with it; the detached server keeps running and is taken over again. */
  hostLost(): void {
    this.stopHealth();
    this.forwardSpec = undefined;
    if (this.wanted && this.status !== 'stopped') this.set('restarting');
  }

  hostFailed(message: string): void {
    if (this.wanted && this.status !== 'stopped' && this.status !== 'ready') {
      this.error = message;
      this.set('error');
    }
  }

  private startHealth(): void {
    this.stopHealth();
    this.healthFailures = 0;
    this.healthTimer = setInterval(async () => {
      const ep = this.endpoint;
      if (!ep || this.status !== 'ready') return;
      if ((await health(ep, 5000)).ok) {
        this.healthFailures = 0;
        return;
      }
      if (++this.healthFailures < 2) return;
      this.healthFailures = 0;
      this.host.log(`[server ${this.spec.agent}] health check failed twice`);
      if (!(await this.host.verifyLink())) return; // host reconnect restarts us
      await this.teardown();
      this.set('restarting');
      void this.start().catch(() => this.scheduleRestart());
    }, 15_000);
    (this.healthTimer as { unref?: () => void }).unref?.();
  }

  private stopHealth(): void {
    if (this.healthTimer) clearInterval(this.healthTimer);
    this.healthTimer = undefined;
  }

  async checkNow(): Promise<void> {
    const ep = this.endpoint;
    if (ep && this.status === 'ready' && !(await health(ep, 5000)).ok) {
      if (!(await this.host.verifyLink())) return;
      await this.teardown();
      this.set('restarting');
      void this.start().catch(() => this.scheduleRestart());
    }
  }

  private async cancelForward(): Promise<void> {
    const spec = this.forwardSpec;
    this.forwardSpec = undefined;
    if (spec && this.host.master?.alive) await this.host.master.cancel(spec);
  }

  /** Stop watching and drop the forward; the detached server itself keeps running. */
  private async teardown(): Promise<void> {
    this.stopHealth();
    await this.cancelForward();
  }

  /**
   * Disconnect: an idle server is stopped; one still running replays,
   * evaluations or analyses stays and exits by itself once idle.
   */
  async stop(): Promise<void> {
    this.wanted = false;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = undefined;
    }
    const ep = this.endpoint;
    // stop it only when it answers us (another client may have taken it over since) and has nothing running
    const h = ep && this.status === 'ready' ? await health(ep, 3000) : undefined;
    const busy = Boolean(h?.body?.busy);
    await this.teardown();
    if (busy) this.host.step(`${AGENT_LABEL[this.spec.agent]} 的服务端还有任务在跑：留在远端继续，完成并空闲 ${Math.round(SSH_IDLE_EXIT_SEC / 60)} 分钟后自动退出`);
    else if (h?.ok && this.remotePid && this.host.master?.alive) await this.host.killServer(this.remotePid);
    this.remotePid = undefined;
    this.endpoint = undefined;
    this.everReady = false;
    this.set('stopped');
  }

  /** The app quits: nothing to wait for — the server finishes what it runs, then exits when idle. */
  kill(): void {
    this.wanted = false;
    this.stopHealth();
  }
}

import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AGENT_LABEL, type AgentKind } from '../../../../src/shared/agents';
import type { AgentDiscovery, AgentScan } from '../../../../src/shared/remote-protocol';
import { Backoff } from '../remote/reconnect';
import { exited, run, sleep, Tail } from '../ssh/proc';
import { agentArgs, discoverArgs, newToken, parseDiscoverOutput, ServerStartError, waitReadyLine, type ServerEndpoint } from './server-process';
import { Emitter, StepLog, type HostRuntime, type ManagedServer, type ServerSpec, type ServerStatus, type Stage, type Step } from './types';

/**
 * 本机: kifu-server child processes, one per agent (Codex, Claude
 * Code). Each exits on its own when our stdin pipe closes (app quit or crash).
 */

const here = path.dirname(fileURLToPath(import.meta.url));

/** Server package directory: dev override, packaged app resources, or the repo build output. */
export function serverDir(): string {
  const candidates = [
    process.env.KIFU_SERVER_DIR,
    path.resolve(here, '../server'), // bundled: Resources/app/bun/index.js → Resources/app/server
    path.resolve('../Resources/app/server'), // packaged app, cwd = Contents/MacOS
    path.resolve(here, '../../../../dist/server/darwin-arm64'), // running from source
  ].filter((p): p is string => Boolean(p));
  for (const c of candidates) if (fs.existsSync(path.join(c, 'bin', 'kifu-server'))) return c;
  throw new Error(`找不到 kifu-server（查找了 ${candidates.join(', ')}）；开发时先运行 pnpm build:server`);
}

export function logDir(): string {
  const dir = path.join(os.homedir(), '.kifu', 'desktop', 'logs');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

export function fileLogger(name: string): (line: string) => void {
  const file = path.join(logDir(), `${name}.log`);
  try {
    if (fs.statSync(file).size > 5 * 1024 * 1024) fs.renameSync(file, `${file}.1`);
  } catch {
    // new file
  }
  return (line) => {
    try {
      fs.appendFileSync(file, `${new Date().toISOString()} ${line}\n`, { mode: 0o600 });
    } catch {
      // logging must never break the app
    }
  };
}

class LocalServer implements ManagedServer {
  status: ServerStatus = 'stopped';
  error?: string;
  endpoint?: ServerEndpoint;
  note?: string;
  private child?: ChildProcess;
  private wanted = false;
  private everReady = false;
  private starting?: Promise<ServerEndpoint>;
  private readonly restartCbs: Array<(ep: ServerEndpoint) => void> = [];
  private readonly backoff = new Backoff(500, 10_000);
  private crashes: number[] = [];

  constructor(
    private spec: ServerSpec,
    private readonly host: LocalHost,
  ) {}

  get agent(): AgentKind {
    return this.spec.agent;
  }

  /** New scan directories apply from the next start. */
  update(spec: ServerSpec): void {
    this.spec = spec;
  }

  private get tag(): string {
    return `[server ${this.spec.agent}]`;
  }

  onRestart(cb: (ep: ServerEndpoint) => void): void {
    this.restartCbs.push(cb);
  }

  start(): Promise<ServerEndpoint> {
    this.wanted = true;
    if (this.status === 'ready' && this.endpoint) return Promise.resolve(this.endpoint);
    this.starting ??= this.launch().finally(() => {
      this.starting = undefined;
    });
    return this.starting;
  }

  private set(status: ServerStatus): void {
    this.status = status;
    this.host.changed();
  }

  private async launch(): Promise<ServerEndpoint> {
    this.set(this.everReady ? 'restarting' : 'starting');
    this.error = undefined;
    const dir = serverDir();
    const prevPort = this.endpoint ? Number(new URL(this.endpoint.baseUrl).port) : 0;
    try {
      let ep: ServerEndpoint;
      try {
        ep = await this.spawnServer(dir, prevPort);
      } catch (e) {
        // keep the same origin (localStorage) when possible, any port otherwise
        if (!prevPort) throw e;
        ep = await this.spawnServer(dir, 0);
      }
      this.endpoint = ep;
      this.set('ready');
      if (this.everReady) for (const cb of this.restartCbs) cb(ep);
      this.everReady = true;
      return ep;
    } catch (e) {
      this.error = (e as Error).message;
      this.set('error');
      throw e;
    }
  }

  private async spawnServer(dir: string, port: number): Promise<ServerEndpoint> {
    const token = newToken();
    const log = this.host.log;
    const args = [
      'serve',
      '--port', String(port),
      '--token-stdin',
      '--exit-on-stdin-close',
      '--ready',
      '--web-dir', path.join(dir, 'web'),
      '--label', '本机',
      ...agentArgs(this.spec),
    ];
    const child = spawn(path.join(dir, 'bin', 'kifu-server'), args, { stdio: ['pipe', 'pipe', 'pipe'], env: process.env });
    child.stdin!.on('error', () => {});
    const stderr = new Tail(16 * 1024);
    child.stderr!.setEncoding('utf8');
    child.stderr!.on('data', (s: string) => {
      stderr.push(s);
      for (const l of s.split('\n')) if (l.trim()) log(`${this.tag} ${l}`);
    });
    child.stdin!.write(`${token}\n`);
    const ready = await waitReadyLine(child, 30_000, () => stderr.text(), (l) => log(`${this.tag} ${l}`));
    this.child = child;
    child.once('exit', (code) => this.onExit(child, code));
    return { baseUrl: `http://127.0.0.1:${ready.port}`, token, ready };
  }

  private onExit(child: ChildProcess, code: number | null): void {
    if (child !== this.child) return;
    this.child = undefined;
    if (!this.wanted) return;
    const now = Date.now();
    this.crashes = [...this.crashes.filter((t) => now - t < 60_000), now];
    if (this.crashes.length > 3) {
      this.error = `服务端反复退出（退出码 ${code ?? '?'}），已停止重启`;
      this.set('error');
      return;
    }
    this.host.stepLog.add(`${AGENT_LABEL[this.spec.agent]} 的服务端意外退出（${code ?? '?'}），正在重启`, 'warn');
    this.set('restarting');
    setTimeout(() => {
      if (this.wanted && !this.child) void this.start().catch(() => undefined);
    }, this.backoff.next());
  }

  async stop(): Promise<void> {
    this.wanted = false;
    const child = this.child;
    this.child = undefined;
    this.endpoint = undefined;
    this.everReady = false;
    if (child && child.exitCode === null) {
      try {
        child.stdin!.end();
      } catch {
        // closed
      }
      const gone = await Promise.race([exited(child).then(() => true), sleep(1500).then(() => false)]);
      if (!gone) child.kill('SIGKILL');
    }
    this.set('stopped');
  }

  kill(): void {
    this.wanted = false;
    const child = this.child;
    if (!child || child.exitCode !== null) return;
    try {
      child.stdin!.end();
    } catch {
      // closed
    }
  }
}

export class LocalHost implements HostRuntime {
  readonly kind = 'local' as const;
  readonly label = '本机';
  readonly status = 'ready' as const;
  readonly log = fileLogger('local');
  private readonly emitter = new Emitter();
  readonly stepLog = new StepLog(() => this.changed(), this.log);
  private readonly serverMap = new Map<string, LocalServer>();

  get steps(): Step[] {
    return this.stepLog.steps;
  }

  readonly stages: Stage[] = [];

  get detail(): string {
    return `${os.userInfo().username}@${os.hostname()}`;
  }

  changed(): void {
    this.emitter.emit();
  }

  onChange(cb: () => void): void {
    this.emitter.on(cb);
  }

  async connect(): Promise<void> {}

  async disconnect(): Promise<void> {
    await Promise.all([...this.serverMap.values()].map((s) => s.stop()));
  }

  answerHostKey(): void {}

  async discover(scan: AgentScan): Promise<AgentDiscovery[]> {
    const dir = serverDir();
    const r = await run(path.join(dir, 'bin', 'kifu-server'), discoverArgs(scan), { timeoutMs: 20_000 });
    if (r.code !== 0) throw new ServerStartError(`扫描失败：${r.stderr.trim().slice(0, 300)}`, r.stderr, r.code);
    return parseDiscoverOutput(r.stdout) ?? [];
  }

  server(spec: ServerSpec): LocalServer {
    let s = this.serverMap.get(spec.agent);
    if (!s) {
      s = new LocalServer(spec, this);
      this.serverMap.set(spec.agent, s);
    } else s.update(spec);
    return s;
  }

  servers(): ManagedServer[] {
    return [...this.serverMap.values()];
  }

  killAll(): void {
    for (const s of this.serverMap.values()) s.kill();
  }
}

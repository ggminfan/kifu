import { createAskpass } from './askpass';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { controlArgs, execArgs, masterArgs, MASTER_READY, type SshContext } from './args';
import { classifySshError, SshError, sshError } from './errors';
import { exited, onLines, run, sleep, Tail, type RunOptions, type RunResult } from './proc';

/**
 * One ControlMaster per host. It authenticates once (Kerberos, ProxyCommand,
 * keys) and carries every server session and port forward. Its own session
 * only waits for stdin EOF, so the whole connection dies with the app.
 */
export class SshMaster {
  private proc?: ChildProcess;
  private readonly stderr = new Tail(32 * 1024);
  private exitHandlers: Array<(info: { code: number | null; expected: boolean; stderr: string }) => void> = [];
  private stopping = false;
  readonly startedAt = Date.now();

  constructor(
    readonly ctx: SshContext,
    private readonly log: (line: string) => void = () => {},
    private readonly credential?: string,
  ) {}

  get pid(): number | undefined {
    return this.proc?.pid;
  }

  get alive(): boolean {
    return Boolean(this.proc && this.proc.exitCode === null && this.proc.signalCode === null);
  }

  stderrTail(): string {
    return this.stderr.text();
  }

  /** Resolves once authenticated and the mux socket accepts clients; rejects with a classified SshError. */
  async start(timeoutMs = 60_000): Promise<void> {
    if (this.proc) throw new Error('master already started');
    const dir = path.dirname(this.ctx.controlPath);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.chmodSync(dir, 0o700);
    cleanupStaleSockets(dir);
    try {
      fs.unlinkSync(this.ctx.controlPath); // a socket left by a crashed master would disable multiplexing
    } catch {
      // not there
    }

    const bridge = this.credential ? await createAskpass(this.credential) : undefined;
    if (this.stopping) { await bridge?.close(); throw sshError('unknown', '连接已取消'); }
    let child: ChildProcess;
    try { child = spawn(this.ctx.sshBin, masterArgs(this.ctx, Boolean(bridge)), { stdio: ['pipe', 'pipe', 'pipe'], env: bridge?.env }); } catch (error) { await bridge?.close(); throw error; }
    this.proc = child;
    child.stdin!.on('error', () => {});
    child.stderr!.setEncoding('utf8');
    child.stderr!.on('data', (s: string) => {
      if (this.credential) s = s.replaceAll(this.credential, '[redacted]');
      this.stderr.push(s);
      for (const line of s.split('\n')) if (line.trim()) this.log(`[ssh] ${line}`);
    });

    try { await new Promise<void>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        child.kill('SIGKILL');
        reject(sshError('timeout', `连接 ${this.ctx.alias} 超时（${Math.round(timeoutMs / 1000)} 秒）`, this.stderr.text(), true));
      }, timeoutMs);
      onLines(child.stdout!, (line) => {
        if (!settled && line.includes(MASTER_READY)) {
          settled = true;
          clearTimeout(timer);
          resolve();
        }
      });
      child.on('error', (e) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(sshError('unknown', `无法启动 ssh：${e.message}`));
      });
      child.on('exit', (code) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          // give the stderr pipe a moment to flush the reason (ProxyCommand children may hold it open, so not 'close')
          setTimeout(() => reject(new SshError(classifySshError(this.stderr.text(), code))), 100);
        }
      });
    });

    } finally { await bridge?.close(); }

    child.on('exit', (code) => {
      const info = { code, expected: this.stopping, stderr: this.stderr.text() };
      this.log(`[ssh] master exited (code ${code}${this.stopping ? ', requested' : ''})`);
      for (const h of this.exitHandlers) h(info);
    });
  }

  onExit(handler: (info: { code: number | null; expected: boolean; stderr: string }) => void): void {
    this.exitHandlers.push(handler);
  }

  async check(timeoutMs = 5000): Promise<boolean> {
    if (!this.alive) return false;
    const r = await run(this.ctx.sshBin, controlArgs(this.ctx, 'check'), { timeoutMs });
    return r.code === 0;
  }

  /** Run a short command over the master. */
  exec(remoteCommand: string, o: RunOptions = {}): Promise<RunResult> {
    return run(this.ctx.sshBin, execArgs(this.ctx, remoteCommand), { timeoutMs: 60_000, ...o });
  }

  /** Start a long-running multiplexed session (a server); the caller owns its stdio. */
  session(remoteCommand: string): ChildProcess {
    const child = spawn(this.ctx.sshBin, execArgs(this.ctx, remoteCommand), { stdio: ['pipe', 'pipe', 'pipe'] });
    child.stdin!.on('error', () => {});
    return child;
  }

  async forward(spec: string): Promise<void> {
    const r = await run(this.ctx.sshBin, controlArgs(this.ctx, 'forward', spec), { timeoutMs: 15_000 });
    if (r.code !== 0) throw new SshError(classifySshError(r.stderr, r.code));
  }

  async cancel(spec: string): Promise<void> {
    if (!this.alive) return;
    await run(this.ctx.sshBin, controlArgs(this.ctx, 'cancel', spec), { timeoutMs: 5000 }).catch(() => undefined);
  }

  /**
   * Close the connection: EOF to the master's own session, then ask the master
   * to exit (ends remaining sessions), then signals as a last resort.
   */
  async stop(): Promise<void> {
    this.stopping = true;
    const child = this.proc;
    if (!child || !this.alive) return;
    try {
      child.stdin!.end();
    } catch {
      // already closed
    }
    const done = exited(child);
    const graceful = await Promise.race([done.then(() => true), sleep(300).then(() => false)]);
    if (graceful) return;
    await run(this.ctx.sshBin, controlArgs(this.ctx, 'exit'), { timeoutMs: 3000 }).catch(() => undefined);
    const exitedNow = await Promise.race([done.then(() => true), sleep(1000).then(() => false)]);
    if (!exitedNow) child.kill('SIGTERM');
    const gone = await Promise.race([done.then(() => true), sleep(1000).then(() => false)]);
    if (!gone) child.kill('SIGKILL');
  }

  /**
   * App is exiting: end our own session so the master exits as soon as the
   * multiplexed server sessions have shut down cleanly, with SIGTERM as backup.
   */
  kill(): void {
    this.stopping = true;
    if (!this.alive) return;
    try {
      this.proc!.stdin!.end();
    } catch {
      // closed
    }
    const p = this.proc!;
    setTimeout(() => {
      if (p.exitCode === null && p.signalCode === null) p.kill('SIGTERM');
    }, 1500).unref?.();
  }

  /** The link is dead (e.g. after sleep) but ssh has not noticed: kill it so reconnect logic runs. */
  drop(): void {
    if (this.alive) this.proc!.kill('SIGKILL');
  }
}

/** Control sockets are named <hash>-<pid>; drop the ones whose app process is gone. */
function cleanupStaleSockets(dir: string): void {
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    const m = /-(\d+)$/.exec(name);
    if (!m) continue;
    const pid = Number(m[1]);
    if (pid === process.pid) continue;
    try {
      process.kill(pid, 0);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ESRCH') {
        try {
          fs.unlinkSync(path.join(dir, name));
        } catch {
          // raced with someone else
        }
      }
    }
  }
}

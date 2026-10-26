import { spawn, type ChildProcess } from 'node:child_process';
import type { Readable } from 'node:stream';

/**
 * Small process helpers on node:child_process (works in Electrobun's Bun and
 * in Node for tests). Children always get pipes: when this process dies the
 * pipes close, which is how ssh sessions and servers learn to exit.
 */

export interface RunResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface RunOptions {
  input?: string | Buffer;
  /** Stream stdin from a producer instead of a fixed buffer (e.g. a tarball with progress). */
  feed?: (stdin: NodeJS.WritableStream) => Promise<void>;
  timeoutMs?: number;
  maxStdout?: number;
  env?: NodeJS.ProcessEnv;
  onSpawn?: (child: ChildProcess) => void;
}

export function run(bin: string, args: string[], o: RunOptions = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['pipe', 'pipe', 'pipe'], env: o.env ?? process.env });
    o.onSpawn?.(child);
    const out: Buffer[] = [];
    let outLen = 0;
    const err = new Tail(32 * 1024);
    let timedOut = false;
    const max = o.maxStdout ?? 16 * 1024 * 1024;
    child.stdout!.on('data', (b: Buffer) => {
      if (outLen < max) {
        out.push(b);
        outLen += b.length;
      }
    });
    child.stderr!.on('data', (b: Buffer) => err.push(b.toString('utf8')));
    child.stdin!.on('error', () => {
      // the remote side may exit before reading all input; the exit code tells
    });
    const timer = o.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          child.kill('SIGKILL');
        }, o.timeoutMs)
      : undefined;
    child.on('error', (e) => {
      if (timer) clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code, signal) => {
      if (timer) clearTimeout(timer);
      resolve({ code, signal, stdout: Buffer.concat(out).toString('utf8'), stderr: err.text(), timedOut });
    });
    if (o.feed) {
      o.feed(child.stdin!).then(
        () => child.stdin!.end(),
        () => child.kill('SIGKILL'),
      );
    } else {
      child.stdin!.end(o.input ?? '');
    }
  });
}

/** Keep the last `limit` characters of a text stream (ssh stderr can be chatty). */
export class Tail {
  private buf = '';
  constructor(private readonly limit: number) {}
  push(s: string): void {
    this.buf += s;
    if (this.buf.length > this.limit * 2) this.buf = this.buf.slice(-this.limit);
  }
  text(): string {
    return this.buf.length > this.limit ? this.buf.slice(-this.limit) : this.buf;
  }
  clear(): void {
    this.buf = '';
  }
}

/** Call `onLine` for each complete line of a stream. */
export function onLines(stream: Readable, onLine: (line: string) => void): void {
  let buf = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk: string) => {
    buf += chunk;
    let nl: number;
    while ((nl = buf.indexOf('\n')) !== -1) {
      onLine(buf.slice(0, nl).replace(/\r$/, ''));
      buf = buf.slice(nl + 1);
    }
    if (buf.length > 1024 * 1024) buf = buf.slice(-64 * 1024);
  });
}

export function exited(child: ChildProcess): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  return new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

import fs from 'node:fs';
import path from 'node:path';

/**
 * Process lifetime helpers for servers launched by the desktop shell:
 * token on the first stdin line (stdin stays open), exit on stdin EOF (the
 * ssh session or the parent died), idle exit, and socket directory checks.
 */

let stdinBuffer = '';
let stdinEnded = false;
const lineWaiters: Array<(line: string | undefined) => void> = [];
const eofHandlers: Array<() => void> = [];
let stdinAttached = false;

function attachStdin(): void {
  if (stdinAttached) return;
  stdinAttached = true;
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk: string) => {
    stdinBuffer += chunk;
    let nl: number;
    while ((nl = stdinBuffer.indexOf('\n')) !== -1 && lineWaiters.length) {
      const line = stdinBuffer.slice(0, nl).replace(/\r$/, '');
      stdinBuffer = stdinBuffer.slice(nl + 1);
      lineWaiters.shift()!(line);
    }
  });
  const end = () => {
    if (stdinEnded) return;
    stdinEnded = true;
    for (const w of lineWaiters.splice(0)) w(undefined);
    for (const h of eofHandlers) h();
  };
  process.stdin.on('end', end);
  process.stdin.on('close', end);
  process.stdin.resume();
}

/** Read one line from stdin (the auth token). Rejects on timeout or EOF. */
export function readStdinLine(timeoutMs = 15_000): Promise<string> {
  attachStdin();
  return new Promise((resolve, reject) => {
    const nl = stdinBuffer.indexOf('\n');
    if (nl !== -1) {
      const line = stdinBuffer.slice(0, nl).replace(/\r$/, '');
      stdinBuffer = stdinBuffer.slice(nl + 1);
      resolve(line);
      return;
    }
    if (stdinEnded) {
      reject(new Error('stdin closed before the token was received'));
      return;
    }
    const timer = setTimeout(() => reject(new Error('timed out waiting for the token on stdin')), timeoutMs);
    lineWaiters.push((line) => {
      clearTimeout(timer);
      if (line === undefined) reject(new Error('stdin closed before the token was received'));
      else resolve(line);
    });
  });
}

export function onStdinEof(handler: () => void): void {
  attachStdin();
  if (stdinEnded) handler();
  else eofHandlers.push(handler);
}

let lastActivity = Date.now();

export function touchActivity(): void {
  lastActivity = Date.now();
}

/** Exit after `seconds` without requests while nothing is running. */
export function startIdleExit(seconds: number, isBusy: () => boolean, onIdle: () => void): void {
  if (!seconds || seconds <= 0) return;
  const timer = setInterval(() => {
    if (isBusy()) {
      touchActivity();
      return;
    }
    if (Date.now() - lastActivity > seconds * 1000) {
      clearInterval(timer);
      onIdle();
    }
  }, Math.min(30_000, seconds * 250));
  timer.unref?.();
}

/** Ensure the socket's directory exists, is ours and is not accessible to others. */
export function prepareSocketDir(socketPath: string): void {
  const dir = path.dirname(socketPath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = fs.statSync(dir);
  if (typeof process.getuid === 'function' && st.uid !== process.getuid()) {
    throw new Error(`socket 目录 ${dir} 不属于当前用户`);
  }
  if ((st.mode & 0o077) !== 0) fs.chmodSync(dir, 0o700);
  if (Buffer.byteLength(socketPath) > 100) throw new Error(`socket 路径过长（${Buffer.byteLength(socketPath)} 字节）：${socketPath}`);
}

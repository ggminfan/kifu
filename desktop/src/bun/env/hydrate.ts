import { createServer, type Socket } from 'node:net';
import { spawn } from 'node:child_process';
import { accessSync, constants, mkdtempSync, chmodSync, rmSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { userInfo } from 'node:os';

// A private Unix socket carries a JSON environment snapshot from a small child
// launched by the login shell. Terminal banners and exit-hook output never
// enter this channel; JSON preserves blank lines, Unicode and equals signs.
export function decodeEnvironment(bytes: Buffer): Record<string, string> | undefined {
  try {
    const snapshot: unknown = JSON.parse(bytes.toString('utf8'));
    if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return;
    const entries = Object.entries(snapshot);
    if (entries.some(([name, value]) => !name || name.includes('=') || typeof value !== 'string' || /\0/.test(name + value))) return;
    return Object.assign(Object.create(null), snapshot);
  } catch { return undefined; }
}

export function mergePath(preferred?: string, inherited?: string): string | undefined {
  if (!preferred) return inherited;
  return [...new Set([...preferred.split(':'), ...(inherited ?? '').split(':')].filter(Boolean))].join(':');
}

function executable(file: string): boolean {
  try { accessSync(file, constants.X_OK); return isAbsolute(file); } catch { return false; }
}

export function loginShell(environment: NodeJS.ProcessEnv): string | undefined {
  let accountShell: string | undefined;
  try { accountShell = userInfo().shell ?? undefined; } catch { /* no account database */ }
  // Fish supports the same login/interactive invocation. Other shell families
  // use the account's compatible shell, then a system POSIX shell.
  return [environment.SHELL, accountShell, '/bin/zsh', '/bin/bash', '/bin/sh'].find(
    (file): file is string => Boolean(file && /\/(?:zsh|bash|dash|ksh|sh|fish)$/.test(file) && executable(file)),
  );
}

export async function captureLoginEnvironment(environment: NodeJS.ProcessEnv, shell = loginShell(environment), timeoutMs = 8000): Promise<Record<string, string> | undefined> {
  if (!shell) return;
  let folder: string;
  try { folder = mkdtempSync('/tmp/kifu-env-'); } catch { return; }
  const endpoint = `${folder}/capture`;
  const sockets = new Set<Socket>();
  let child: ReturnType<typeof spawn> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let complete: (value?: Record<string, string>) => void = () => {};
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.on('close', () => sockets.delete(socket));
    const chunks: Buffer[] = [];
    let size = 0;
    socket.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > 8 * 1024 * 1024) { socket.destroy(); complete(); } else chunks.push(chunk);
    });
    socket.on('end', () => complete(decodeEnvironment(Buffer.concat(chunks))));
  });
  try {
    chmodSync(folder, 0o700);
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(endpoint, resolve); });
    chmodSync(endpoint, 0o600);
    const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
    const helper = `const s=require('node:net').connect(${JSON.stringify(endpoint)});s.on('error',()=>process.exitCode=1);s.on('connect',()=>s.end(JSON.stringify(process.env)));`;
    return await new Promise((resolve) => {
      complete = resolve;
      timer = setTimeout(() => resolve(undefined), timeoutMs);
      child = spawn(shell, ['-l', '-i', '-c', `${quote(process.execPath)} -e ${quote(helper)}`], {
        env: { ...environment, TERM: 'dumb', KIFU_RESOLVING_ENV: '1' },
        stdio: 'ignore',
      });
      child.once('error', () => resolve(undefined));
      // A failed exit hook does not invalidate a snapshot already sent. Allow
      // the socket's final read to arrive before treating early exit as failure.
      child.once('exit', () => { setTimeout(() => resolve(undefined), 25).unref(); });
    });
  } catch { return undefined; } finally {
    clearTimeout(timer);
    if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(folder, { recursive: true, force: true });
  }
}

export interface HydrateResult {
  ok: boolean;
  added: number;
  pathEntries: [before: number, after: number];
  has: Record<'SSH_AUTH_SOCK' | 'KRB5CCNAME' | 'CODEX_HOME' | 'CLAUDE_CONFIG_DIR', boolean>;
}

export function restoreEnvironment(target: NodeJS.ProcessEnv, captured?: Record<string, string>): HydrateResult {
  const original = { ...target };
  if (captured) {
    const excluded = new Set('PWD OLDPWD SHLVL _ TERM KIFU_RESOLVING_ENV __proto__ constructor prototype'.split(' '));
    for (const name of Object.keys(captured)) {
      if (!excluded.has(name)) target[name] = captured[name];
    }
    const searchPath = mergePath(captured.PATH, original.PATH);
    if (searchPath !== undefined) target.PATH = searchPath;
  }
  const entries = (value?: string) => value?.split(':').filter(Boolean).length ?? 0;
  return {
    ok: captured !== undefined,
    added: Object.keys(target).filter((name) => !Object.hasOwn(original, name)).length,
    pathEntries: [entries(original.PATH), entries(target.PATH)],
    has: Object.fromEntries(['SSH_AUTH_SOCK', 'KRB5CCNAME', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR'].map((name) => [name, Boolean(target[name])])) as HydrateResult['has'],
  };
}

let restored = false;
export async function hydrateShellEnv(): Promise<HydrateResult | undefined> {
  if (process.platform === 'win32' || restored || process.env.KIFU_RESOLVING_ENV === '1') return;
  restored = true;
  return restoreEnvironment(process.env, await captureLoginEnvironment(process.env));
}

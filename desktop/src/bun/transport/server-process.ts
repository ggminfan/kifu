import type { ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import type { AgentKind } from '../../../../src/shared/agents';
import { AGENT_KINDS } from '../../../../src/shared/agents';
import { DEFAULT_SCAN, parseReadyLine, type AgentDiscovery, type AgentScan, type ReadyLine } from '../../../../src/shared/remote-protocol';
import { onLines } from '../ssh/proc';

/**
 * A running kifu-server we talk to over HTTP (local child process,
 * or a remote one reached through an SSH tunnel). Holds the per-launch token
 * and mints single-use nonces for windows.
 */
export interface ServerEndpoint {
  /** http://127.0.0.1:<port> as seen from this machine. */
  baseUrl: string;
  token: string;
  ready: ReadyLine;
}

export function newToken(): string {
  return randomBytes(32).toString('base64url');
}

export async function mintNonce(ep: ServerEndpoint): Promise<string> {
  const res = await fetch(`${ep.baseUrl}/__kifu/nonce`, { method: 'POST', headers: { authorization: `Bearer ${ep.token}` }, signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`nonce request failed: ${res.status}`);
  return ((await res.json()) as { nonce: string }).nonce;
}

/** URL a window opens to authenticate itself and land on `next`. */
export async function windowUrl(ep: ServerEndpoint, next = '/'): Promise<string> {
  const n = await mintNonce(ep);
  return `${ep.baseUrl}/__kifu_auth?n=${encodeURIComponent(n)}&next=${encodeURIComponent(next)}`;
}

export async function health(ep: ServerEndpoint, timeoutMs = 5000): Promise<{ ok: boolean; body?: Record<string, unknown> }> {
  try {
    const res = await fetch(`${ep.baseUrl}/api/health`, { headers: { authorization: `Bearer ${ep.token}` }, signal: AbortSignal.timeout(timeoutMs) });
    return { ok: res.ok, body: res.ok ? ((await res.json()) as Record<string, unknown>) : undefined };
  } catch {
    return { ok: false };
  }
}

/** Retry health for a few seconds (a fresh tunnel may need a moment). */
export async function waitHealthy(ep: ServerEndpoint, tries = 5, delayMs = 600): Promise<boolean> {
  for (let i = 0; i < tries; i++) {
    if ((await health(ep, 5000)).ok) return true;
    await new Promise((r) => setTimeout(r, delayMs));
  }
  return false;
}

export class ServerStartError extends Error {
  constructor(
    message: string,
    readonly stderr: string,
    readonly code: number | null,
  ) {
    super(message);
  }
}

/**
 * Wait for the KIFU_READY line on a child's stdout. Rejects if the process
 * exits first (with its stderr tail) or on timeout. Other stdout lines go to
 * `onOther` (remote rc files may print banners).
 */
export function waitReadyLine(child: ChildProcess, timeoutMs: number, stderrTail: () => string, onOther?: (line: string) => void): Promise<ReadyLine> {
  return new Promise((resolve, reject) => {
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      reject(new ServerStartError(`服务端 ${Math.round(timeoutMs / 1000)} 秒内没有就绪`, stderrTail(), null));
    }, timeoutMs);
    onLines(child.stdout!, (line) => {
      if (done) {
        onOther?.(line);
        return;
      }
      const ready = parseReadyLine(line);
      if (ready) {
        done = true;
        clearTimeout(timer);
        resolve(ready);
      } else {
        onOther?.(line);
      }
    });
    child.once('exit', (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      setTimeout(() => {
        const tail = stderrTail();
        const last = tail.trim().split('\n').filter(Boolean).slice(-3).join(' ').slice(0, 400);
        reject(new ServerStartError(last ? `服务端启动失败：${last}` : `服务端启动失败（退出码 ${code ?? '?'}）`, tail, code));
      }, 100);
    });
  });
}

/** `serve` arguments selecting the agent and the directories its homes are found under. */
export function agentArgs(spec: { agent: AgentKind; roots?: string[] }): string[] {
  return ['--agent', spec.agent, '--roots', (spec.roots?.length ? spec.roots : DEFAULT_SCAN[spec.agent]).join(',')];
}

/** `discover` arguments: only the agents to look for, each with its directories. */
export function discoverArgs(scan: AgentScan): string[] {
  const out = ['discover'];
  for (const agent of AGENT_KINDS) {
    const roots = scan[agent];
    if (roots) out.push(`--${agent}-roots`, roots.join(','));
  }
  return out;
}

/** The JSON line `kifu-server discover` prints ({ agents: [...] }), among whatever else the shell printed. */
export function parseDiscoverOutput(stdout: string): AgentDiscovery[] | undefined {
  const line = stdout.split('\n').find((l) => l.startsWith('{"agents"'));
  if (!line) return undefined;
  return (JSON.parse(line) as { agents: AgentDiscovery[] }).agents;
}

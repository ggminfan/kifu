import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/**
 * One app instance per desktop store. A second instance on the same
 * connections.json (`electrobun dev` started again while the old window still
 * runs …) would overwrite the other's state with its own and keep its stale
 * servers alive. The newest instance wins: it ends the previous one (SIGTERM;
 * the app exits right away) and waits for it. Its local servers exit with it
 * (their stdin closes); servers on SSH hosts run detached and the new instance
 * takes them over.
 */

export function lockFileFor(storeFile: string): string {
  return `${storeFile}.lock`;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Is `pid` this app (not a pid the system has since given to something else)? Builds from
 * before the rename (Trace Monitor.app) count too: the first start ends them before it
 * moves their data (see legacy-home).
 */
export function looksLikeOurApp(command: string): boolean {
  return /(?:Kifu|Trace Monitor)[^/]*\.app\/Contents\/(MacOS|Resources)\//.test(command);
}

function commandOf(pid: number): string {
  const r = spawnSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8', timeout: 3000 });
  return r.stdout ?? '';
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface Takeover {
  /** The instance that held the store before us, if it was still running. */
  previous?: number;
  /** It had to be killed (did not quit within the grace period). */
  killed?: boolean;
}

/** Ends the instance that holds `lockFile`, if one still runs (SIGTERM, then SIGKILL after `graceMs`). */
export async function endPreviousInstance(lockFile: string, graceMs = 5000): Promise<Takeover> {
  let previous: number | undefined;
  try {
    previous = Number((JSON.parse(fs.readFileSync(lockFile, 'utf8')) as { pid?: number }).pid) || undefined;
  } catch {
    // no lock yet
  }
  const out: Takeover = {};
  if (previous && previous !== process.pid && alive(previous) && looksLikeOurApp(commandOf(previous))) {
    out.previous = previous;
    process.kill(previous, 'SIGTERM');
    const end = Date.now() + graceMs;
    while (alive(previous) && Date.now() < end) await sleep(100);
    if (alive(previous)) {
      process.kill(previous, 'SIGKILL');
      out.killed = true;
    }
  }
  return out;
}

export async function claimInstance(lockFile: string, graceMs = 5000): Promise<Takeover> {
  const out = await endPreviousInstance(lockFile, graceMs);
  fs.mkdirSync(path.dirname(lockFile), { recursive: true, mode: 0o700 });
  fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }), { mode: 0o600 });
  return out;
}

export function releaseInstance(lockFile: string): void {
  try {
    const held = (JSON.parse(fs.readFileSync(lockFile, 'utf8')) as { pid?: number }).pid;
    if (held === process.pid) fs.rmSync(lockFile);
  } catch {
    // already gone
  }
}

import fs from 'node:fs';
import { sources } from '../sources/registry';
import { scanRolloutFiles } from '../sources/threadsDb';
import { getParsed, type ParsedEntry } from './parseCache';
import { rolloutPathFor } from './stateDb';

export interface RolloutOptions {
  /** Replays: the first lines are the copied case, only what follows is the replay's own. */
  prefixEnd?: number;
}

/** Rollouts that live outside the real sessions dirs (Skill Lab runs, replays, cases), by thread id. */
const extraRollouts = new Map<string, { path: string; opts?: RolloutOptions }>();

export function registerRollout(threadId: string, rolloutPath: string, opts?: RolloutOptions): void {
  extraRollouts.set(threadId, { path: rolloutPath, opts });
}

export function unregisterRollout(threadId: string): void {
  extraRollouts.delete(threadId);
}

const dirIndex = new Map<string, { at: number; byId: Map<string, string> }>();

/** Rollout files by thread id across the Codex sources (10 s cache per source). */
function scanSessionsDirs(threadId: string): string | undefined {
  for (const src of sources()) {
    if (src.agent === 'claude') continue;
    let idx = dirIndex.get(src.dataRoot);
    if (!idx || Date.now() - idx.at > 10_000) {
      idx = { at: Date.now(), byId: scanRolloutFiles(src.dataRoot) };
      dirIndex.set(src.dataRoot, idx);
    }
    const hit = idx.byId.get(threadId);
    if (hit) return hit;
  }
  return undefined;
}

export function resolveRollout(threadId: string): string | undefined {
  const extra = extraRollouts.get(threadId);
  if (extra && fs.existsSync(extra.path)) return extra.path;
  const fromDb = rolloutPathFor(threadId);
  if (fromDb && fs.existsSync(fromDb)) return fromDb;
  const scanned = scanSessionsDirs(threadId);
  return scanned && fs.existsSync(scanned) ? scanned : undefined;
}

export class NotFound extends Error {}

export async function parsedSession(threadId: string): Promise<ParsedEntry> {
  const p = resolveRollout(threadId);
  if (!p) throw new NotFound(`这个会话的记录文件已经不在了（被删除或移走），读取不到内容（${threadId}）`);
  const extra = extraRollouts.get(threadId);
  return getParsed(p, extra?.path === p ? extra.opts : undefined);
}

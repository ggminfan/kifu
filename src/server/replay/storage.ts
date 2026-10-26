import fsc from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { dataPaths } from '../config';
import { OVERLAY_MARKER, TMP_BASE } from '../services/overlay';
import { cancelRun, deleteRunRecord, listReplays } from '../services/runner';
import { unregisterRollout } from '../services/sessions';
import { tmDb } from '../services/tmDb';
import { deleteCaseFiles, listCases } from './cases';
import { dirBytes } from './copy';

/**
 * Disk use of debugging and its cleanup:
 * - isolated homes in /tmp hold copies of the agent's config: removed after
 *   every run, and swept here when a run died (its process is gone) — older
 *   homes from before the marker existed after an hour;
 * - cases nobody saved, and their replays, expire after 14 days;
 * - a report by category, with a soft limit (20 GB) the page warns about.
 */

export const EXPIRE_DAYS = 14;
export const SOFT_LIMIT_BYTES = 20 * 1024 ** 3;
const LEGACY_MIN_AGE_MS = 60 * 60_000;
const MARKED_MAX_AGE_MS = 24 * 60 * 60_000;
const NAME = /^kf[a-z0-9]{4,}$/;

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Isolated homes of runs that are gone, in the shared tmp dir. */
export async function orphanOverlays(o: { now?: number } = {}): Promise<string[]> {
  const now = o.now ?? Date.now();
  const out: string[] = [];
  for (const ent of await fs.readdir(TMP_BASE, { withFileTypes: true }).catch(() => [])) {
    if (!ent.isDirectory() || !NAME.test(ent.name)) continue;
    const dir = path.join(TMP_BASE, ent.name);
    const marker = path.join(dir, OVERLAY_MARKER);
    try {
      const m = JSON.parse(await fs.readFile(marker, 'utf8')) as { pid?: number; createdAt?: number };
      if (!(m.pid && alive(m.pid)) || now - (m.createdAt ?? 0) > MARKED_MAX_AGE_MS) out.push(dir);
      continue;
    } catch {
      // no marker: an overlay made before markers existed, or not ours
    }
    const looksCodex = fsc.existsSync(path.join(dir, 'config.toml')) && fsc.existsSync(path.join(dir, 'sessions')) && fsc.existsSync(path.join(dir, 'skills'));
    if (!looksCodex) continue;
    const st = await fs.stat(dir).catch(() => undefined);
    if (st && now - st.mtimeMs > LEGACY_MIN_AGE_MS) out.push(dir);
  }
  return out;
}

export async function sweepOverlays(): Promise<string[]> {
  const dirs = await orphanOverlays();
  for (const d of dirs) await fs.rm(d, { recursive: true, force: true }).catch(() => undefined);
  return dirs;
}

/** Unsaved cases untouched for EXPIRE_DAYS, without a replay still running. */
export function expiredCases(now = Date.now()): string[] {
  const before = now - EXPIRE_DAYS * 86_400_000;
  return listCases()
    .filter((c) => !c.saved && c.updatedAt < before)
    .filter((c) => !listReplays(c.id).some((r) => r.status === 'queued' || r.status === 'running'))
    .map((c) => c.id);
}

/** Delete a case with its replays (records, transcripts, run dirs), and take it out of every set. */
export async function removeCase(id: string): Promise<void> {
  tmDb().prepare('delete from eval_set_cases where case_id = ?').run(id);
  for (const r of listReplays(id)) {
    cancelRun(r.id);
    if (r.threadId) unregisterRollout(r.threadId);
    deleteRunRecord(r.id);
    await fs.rm(path.join(dataPaths.runs, path.basename(r.id)), { recursive: true, force: true });
  }
  await deleteCaseFiles(id);
}

export interface StorageReport {
  /** Sizes are logical: APFS clones share blocks with what they were cloned from, so the disk holds less. */
  categories: Array<{ id: 'cases' | 'replays' | 'lab' | 'cache' | 'jobs'; label: string; bytes: number; count: number }>;
  total: number;
  softLimit: number;
  orphanOverlays: number;
  expiring: number;
  expireDays: number;
}

export async function storageReport(): Promise<StorageReport> {
  const runs = tmDb().prepare("select id, coalesce(kind, 'lab') as kind from runs").all() as Array<{ id: string; kind: string }>;
  const sum = async (ids: string[]) => {
    let bytes = 0;
    for (const id of ids) bytes += await dirBytes(path.join(dataPaths.runs, path.basename(id)));
    return bytes;
  };
  const replayIds = runs.filter((r) => r.kind === 'replay').map((r) => r.id);
  const labIds = runs.filter((r) => r.kind !== 'replay').map((r) => r.id);
  const cases = listCases();
  const categories: StorageReport['categories'] = [
    { id: 'cases', label: '用例', bytes: await dirBytes(dataPaths.cases), count: cases.length },
    { id: 'replays', label: '回放', bytes: await sum(replayIds), count: replayIds.length },
    { id: 'lab', label: 'Skill Lab 运行', bytes: await sum(labIds), count: labIds.length },
    { id: 'cache', label: '解析缓存', bytes: await dirBytes(dataPaths.cache), count: (await fs.readdir(dataPaths.cache).catch(() => [])).length },
    { id: 'jobs', label: '问为什么', bytes: await dirBytes(dataPaths.jobs), count: (await fs.readdir(dataPaths.jobs).catch(() => [])).length },
  ];
  return {
    categories,
    total: categories.reduce((s, c) => s + c.bytes, 0),
    softLimit: SOFT_LIMIT_BYTES,
    orphanOverlays: (await orphanOverlays()).length,
    expiring: expiredCases().length,
    expireDays: EXPIRE_DAYS,
  };
}

export async function cleanup(o: { expired?: boolean; overlays?: boolean; cache?: boolean }): Promise<{ cases: number; overlays: number; cache: number }> {
  const done = { cases: 0, overlays: 0, cache: 0 };
  if (o.expired) {
    for (const id of expiredCases()) {
      await removeCase(id);
      done.cases++;
    }
  }
  if (o.overlays) done.overlays = (await sweepOverlays()).length;
  if (o.cache) {
    for (const f of await fs.readdir(dataPaths.cache).catch(() => [])) {
      await fs.rm(path.join(dataPaths.cache, f), { recursive: true, force: true });
      done.cache++;
    }
  }
  return done;
}

/** At startup and then periodically: sweep dead overlays (every 10 min), expire old unsaved cases (every 6 h). */
export function startHousekeeping(): void {
  const sweep = () => void sweepOverlays().catch(() => undefined);
  const expire = () => void cleanup({ expired: true }).catch(() => undefined);
  setTimeout(sweep, 5_000).unref?.();
  setTimeout(expire, 60_000).unref?.();
  setInterval(sweep, 10 * 60_000).unref?.();
  setInterval(expire, 6 * 60 * 60_000).unref?.();
}

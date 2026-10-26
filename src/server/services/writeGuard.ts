import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * Write guard: an lstat manifest of the user's real agent home and skills,
 * taken before and after every run we launch. Any difference outside known
 * volatile paths means something escaped the isolated home.
 */

export interface FsEntry {
  t: 'f' | 'd' | 'l' | 'o';
  size: number;
  mtimeMs: number;
  link?: string;
}

/** `truncated` is set when the scan hit its entry or time limit. */
export type Manifest = Map<string, FsEntry> & { truncated?: boolean };

export interface GuardRoot {
  label: string;
  dir: string;
  /** Paths (relative, posix) whose changes are expected. */
  volatile?: RegExp[];
}

/** Codex home entries that change on their own (the user's Codex keeps running, tokens refresh). */
export const CODEX_VOLATILE: RegExp[] = [
  /^(archived_)?sessions(\/|$)/,
  /\.sqlite(-shm|-wal|-journal)?$/,
  /(^|\/)(log|logs|tmp|\.tmp|cache|shell_snapshots|session-env)(\/|$)/,
  /^(history\.jsonl|session_index\.jsonl|models_cache\.json|auth\.json|auth\.json\.lock|version\.json|\.codex-global-state\.json)$/,
  /^plugins\/cache(\/|$)/,
];

export async function snapshot(roots: GuardRoot[], maxEntries = 200_000, maxMs = 15_000): Promise<Manifest> {
  const manifest: Manifest = new Map();
  const deadline = Date.now() + maxMs; // slow network filesystems: compare what we managed to scan
  let truncated = false;
  for (const root of roots) {
    const stack: string[] = [''];
    while (stack.length) {
      if (manifest.size >= maxEntries || Date.now() >= deadline) {
        truncated = true;
        break;
      }
      const rel = stack.pop()!;
      let entries;
      try {
        entries = await fs.readdir(path.join(root.dir, rel), { withFileTypes: true });
      } catch {
        continue;
      }
      for (const ent of entries) {
        const childRel = rel ? `${rel}/${ent.name}` : ent.name;
        if (root.volatile?.some((re) => re.test(childRel))) continue;
        const abs = path.join(root.dir, childRel);
        let st;
        try {
          st = await fs.lstat(abs);
        } catch {
          continue;
        }
        const entry: FsEntry = {
          t: st.isSymbolicLink() ? 'l' : st.isDirectory() ? 'd' : st.isFile() ? 'f' : 'o',
          size: st.isDirectory() ? 0 : st.size,
          mtimeMs: st.isDirectory() ? 0 : Math.round(st.mtimeMs),
        };
        if (entry.t === 'l') entry.link = await fs.readlink(abs).catch(() => undefined);
        manifest.set(`${root.label}:${childRel}`, entry);
        if (entry.t === 'd') stack.push(childRel);
      }
    }
  }
  if (truncated) manifest.truncated = true;
  return manifest;
}

export interface ManifestDiff {
  added: string[];
  removed: string[];
  changed: string[];
}

export function diffManifests(before: Manifest, after: Manifest): ManifestDiff {
  const added: string[] = [];
  const removed: string[] = [];
  const changed: string[] = [];
  for (const [key, a] of before) {
    const b = after.get(key);
    if (!b) {
      // After a truncated scan a missing key is unknown, not removed.
      if (!after.truncated) removed.push(key);
    }
    else if (a.t !== b.t || a.size !== b.size || a.mtimeMs !== b.mtimeMs || a.link !== b.link) changed.push(key);
  }
  if (!before.truncated) for (const key of after.keys()) if (!before.has(key)) added.push(key);
  return { added, removed, changed };
}

export function isClean(d: ManifestDiff): boolean {
  return d.added.length + d.removed.length + d.changed.length === 0;
}

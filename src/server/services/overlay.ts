import fsc from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/**
 * Isolated agent homes let us run the agent against modified skills without
 * touching the user's real home. Files are APFS clones (copy-on-write), so
 * anything the agent writes stays inside; only the login and untouched skill
 * directories are symlinks.
 *
 * The skill catalog has a fixed character budget and contains the home's
 * paths, so a longer isolated path truncates descriptions harder and can even
 * drop skills. We therefore allocate the isolated home at a path with exactly
 * the same length as the real one.
 */

export interface VariantMount {
  /** Skill directory as discovered (may be a symlink path). Omit for brand-new skills. */
  originalDir?: string;
  /** Directory holding the variant's SKILL.md and resources. */
  variantDir: string;
  /** Directory name when the variant is mounted under the overlay skills root. */
  name: string;
}

/** SKILL.md of the skills in the roots found through $HOME here: hidden when they must not show (analysts). */
export async function homeSkillFiles(dirs: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const dir of dirs) {
    for (const ent of await readdirSafe(dir)) {
      if (ent.name.startsWith('.')) continue;
      const real = await realpathOrUndefined(path.join(dir, ent.name));
      if (real && fsc.existsSync(path.join(real, 'SKILL.md'))) out.push(path.join(real, 'SKILL.md'));
    }
  }
  return out;
}

async function realpathOrUndefined(p: string): Promise<string | undefined> {
  try {
    return await fs.realpath(p);
  } catch {
    return undefined;
  }
}

async function readdirSafe(dir: string): Promise<fsc.Dirent[]> {
  try {
    return await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

// macOS: /tmp is a symlink to /private/tmp, so use the real path; Linux: /tmp.
export const TMP_BASE = process.platform === 'darwin' ? '/private/tmp' : fsc.existsSync('/tmp') ? '/tmp' : os.tmpdir();

/** Marks an isolated home in TMP_BASE as ours (process and time), so a sweep can remove it if its run died. */
export const OVERLAY_MARKER = '.kifu-overlay';

export async function markOverlay(dir: string): Promise<void> {
  await fs.writeFile(path.join(dir, OVERLAY_MARKER), JSON.stringify({ pid: process.pid, createdAt: Date.now() }), { mode: 0o600 });
}
const ID_CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789';

/**
 * Create an empty directory whose absolute path has exactly `length` characters,
 * so catalog budgets match the real home. Falls back to `fallback` when impossible.
 */
export async function allocSameLengthDir(length: number, fallback: string): Promise<{ dir: string; parity: boolean }> {
  const prefix = `${TMP_BASE}/kf`;
  const idLen = length - prefix.length;
  if (idLen >= 4 && fsc.existsSync(TMP_BASE)) {
    for (let attempt = 0; attempt < 20; attempt++) {
      let id = '';
      for (let i = 0; i < idLen; i++) id += ID_CHARS[Math.floor(Math.random() * ID_CHARS.length)];
      const dir = `${prefix}${id}`;
      try {
        await fs.mkdir(dir, { mode: 0o700 });
        return { dir, parity: true };
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') break;
      }
    }
  }
  await fs.mkdir(fallback, { recursive: true, mode: 0o700 });
  return { dir: fallback, parity: false };
}

/** Copy-on-write clone of a file or directory; symlinks are re-pointed at their absolute target. */
export async function cloneEntry(src: string, dst: string): Promise<void> {
  const st = await fs.lstat(src);
  if (st.isSymbolicLink()) {
    const target = path.resolve(path.dirname(src), await fs.readlink(src));
    await fs.symlink(target, dst);
    return;
  }
  const opts = { recursive: true, verbatimSymlinks: true, preserveTimestamps: true, errorOnExist: true, force: false };
  try {
    // Copy-on-write where the filesystem supports it (APFS, btrfs, XFS); plain copy otherwise.
    await fs.cp(src, dst, { ...opts, mode: fsc.constants.COPYFILE_FICLONE });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') throw e;
    await fs.rm(dst, { recursive: true, force: true });
    await fs.cp(src, dst, opts);
  }
}

const TABLE = /^\s*\[\[?\s*([^\]]+?)\s*\]\]?\s*(#.*)?$/;

/** Remove top-level keys and tables of a TOML config (`mcp_servers`, `notify` …), line by line. */
export function stripTomlKeys(toml: string, keys: string[]): string {
  const out: string[] = [];
  let skipping = false;
  let topLevel = true;
  for (const line of toml.split('\n')) {
    const table = TABLE.exec(line)?.[1];
    if (table !== undefined) {
      topLevel = false;
      const head = table.split('.')[0].replace(/^"|"$/g, '');
      skipping = keys.includes(head);
      if (skipping) continue;
    } else if (skipping) continue;
    // a key of the root table (only before the first table header)
    if (topLevel && keys.some((k) => new RegExp(`^\\s*"?${k}"?\\s*=`).test(line))) continue;
    out.push(line);
  }
  return out.join('\n');
}

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Builds from before the product's rename kept everything in ~/.trace-monitor
 * (data, logs, the desktop's connections, sockets) and called the database
 * tm.sqlite. The first start of a renamed build moves them to ~/.kifu and
 * kifu.sqlite: entry by entry, so whatever already exists there stays, and
 * what could not move is left where it was. (Remotes do the same in the shell:
 * see baseAssignment.)
 */

const LEGACY_DIR = '.trace-monitor';
const LEGACY_DB = 'tm.sqlite';

function lexists(p: string): boolean {
  try {
    fs.lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

function isDir(p: string): boolean {
  try {
    return fs.lstatSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** The old directory, if this machine still has one. */
export function legacyHome(home = os.homedir()): string | undefined {
  const dir = path.join(home, LEGACY_DIR);
  return isDir(dir) ? dir : undefined;
}

export interface Migration {
  /** Moved entries, relative to the directory ('.' when it moved as a whole). */
  moved: string[];
  /** Entries both directories have: left in the old one. */
  left: string[];
}

export function migrateLegacyHome(home = os.homedir()): Migration | undefined {
  const from = legacyHome(home);
  if (!from) return undefined;
  const to = path.join(home, '.kifu');
  const out: Migration = { moved: [], left: [] };
  const merge = (src: string, dst: string, rel: string) => {
    if (!lexists(dst)) {
      try {
        fs.renameSync(src, dst);
        out.moved.push(rel || '.');
      } catch {
        out.left.push(rel || '.');
      }
      return;
    }
    if (isDir(src) && isDir(dst)) {
      for (const name of fs.readdirSync(src)) merge(path.join(src, name), path.join(dst, name), rel ? `${rel}/${name}` : name);
      try {
        fs.rmdirSync(src);
      } catch {
        // something was left in it
      }
      return;
    }
    out.left.push(rel);
  };
  merge(from, to, '');
  try {
    fs.chmodSync(to, 0o700);
  } catch {
    // nothing moved
  }
  return out;
}

/** A data dir's database under its old name: renamed (with its -wal and -shm) before it is opened. */
export function migrateLegacyDb(file: string): void {
  const legacy = path.join(path.dirname(file), LEGACY_DB);
  if (lexists(file) || !lexists(legacy)) return;
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    try {
      fs.renameSync(`${legacy}${suffix}`, `${file}${suffix}`);
    } catch {
      // not there
    }
  }
}

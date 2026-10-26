import { randomBytes } from 'node:crypto';
import fsc from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { cloneEntry } from '../services/overlay';

/**
 * Files of a case and of its replays, kept cheap on disk:
 * - a case holds the session up to the end of turn K as an APFS clone of the
 *   original, truncated (blocks are shared with the original);
 * - a replay continues a copy of the first part of it (up to turn K's start)
 *   under a new session id. The new id has the same length as the old one, so
 *   the copy is a clone patched in place: only the blocks holding the id are
 *   copied, plus whatever the agent appends.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ALNUM = 'abcdefghijklmnopqrstuvwxyz0123456789';

/** A new session id shaped like `oldId`: UUIDv7 for UUIDs (time-ordered, so agents sort it as new), else the same length. */
export function newSessionId(oldId: string): string {
  if (UUID.test(oldId)) {
    const ms = Date.now().toString(16).padStart(12, '0');
    const r = randomBytes(10).toString('hex');
    return `${ms.slice(0, 8)}-${ms.slice(8, 12)}-7${r.slice(0, 3)}-${((parseInt(r[3], 16) & 3) | 8).toString(16)}${r.slice(4, 7)}-${r.slice(7, 19)}`;
  }
  const bytes = randomBytes(oldId.length);
  return [...oldId].map((c, i) => (c === '-' || c === '_' ? c : ALNUM[bytes[i] % ALNUM.length])).join('');
}

/** Clone `src` to `dst` (copy-on-write where supported) and cut it to `bytes`. */
export async function clonePrefix(src: string, dst: string, bytes: number): Promise<void> {
  await fs.mkdir(path.dirname(dst), { recursive: true, mode: 0o700 });
  await fs.copyFile(src, dst, fsc.constants.COPYFILE_FICLONE);
  await fs.truncate(dst, bytes);
}

/** Byte offsets of every occurrence of `needle` in a file, read in chunks. */
export async function findOffsets(file: string, needle: Buffer, limitBytes?: number): Promise<number[]> {
  const out: number[] = [];
  const fh = await fs.open(file, 'r');
  try {
    const size = Math.min((await fh.stat()).size, limitBytes ?? Infinity);
    const chunk = 8 * 1024 * 1024;
    const buf = Buffer.alloc(chunk + needle.length);
    let pos = 0;
    let carry = 0;
    while (pos < size) {
      const want = Math.min(chunk, size - pos);
      const { bytesRead } = await fh.read(buf, carry, want, pos);
      if (!bytesRead) break;
      const end = carry + bytesRead;
      let i = buf.indexOf(needle, 0);
      while (i !== -1 && i + needle.length <= end) {
        out.push(pos - carry + i);
        i = buf.indexOf(needle, i + 1);
      }
      // keep the tail so a needle split across chunks is still found
      carry = Math.min(needle.length - 1, end);
      buf.copy(buf, 0, end - carry, end);
      pos += bytesRead;
    }
  } finally {
    await fh.close();
  }
  return out;
}

export interface CopyResult {
  /** Lines in the copy: the replay's own records start at this line. */
  lines: number;
  bytes: number;
}

async function countLines(file: string): Promise<number> {
  return (await findOffsets(file, Buffer.from('\n'))).length;
}

/**
 * The copy a replay continues: the first `bytes` of the case's session with the
 * session id replaced. `rewrite` (context edits) forces a full rewrite.
 */
export async function replayCopy(
  src: string,
  dst: string,
  o: { bytes: number; oldId: string; newId: string; rewrite?: (line: string) => string },
): Promise<CopyResult> {
  if (Buffer.byteLength(o.oldId) !== Buffer.byteLength(o.newId) || o.rewrite) {
    const text = (await fs.readFile(src)).subarray(0, o.bytes).toString('utf8');
    const lines = text.split('\n');
    const last = lines.pop(); // '' after the final newline
    const body = lines.map((l) => (o.rewrite ? o.rewrite(l) : l).split(o.oldId).join(o.newId));
    if (last) body.push(last);
    const out = body.length ? `${body.join('\n')}\n` : '';
    await fs.mkdir(path.dirname(dst), { recursive: true, mode: 0o700 });
    await fs.writeFile(dst, out, { mode: 0o600 });
    return { lines: body.length, bytes: Buffer.byteLength(out) };
  }
  await clonePrefix(src, dst, o.bytes);
  const needle = Buffer.from(o.oldId);
  const patch = Buffer.from(o.newId);
  const offsets = await findOffsets(dst, needle);
  const fh = await fs.open(dst, 'r+');
  try {
    for (const off of offsets) await fh.write(patch, 0, patch.length, off);
  } finally {
    await fh.close();
  }
  return { lines: await countLines(dst), bytes: o.bytes };
}

/** Disk usage of a directory (allocated blocks, so clones that share blocks are counted in full). */
export async function dirBytes(dir: string): Promise<number> {
  let total = 0;
  const walk = async (d: string): Promise<void> => {
    let entries: fsc.Dirent[];
    try {
      entries = await fs.readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else if (e.isFile()) total += (await fs.stat(p).catch(() => undefined))?.size ?? 0;
    }
  };
  await walk(dir);
  return total;
}

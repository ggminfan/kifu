import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Worker } from 'node:worker_threads';
import zlib from 'node:zlib';
import { promisify } from 'node:util';
import type { LineIndex, ParseResult } from '../../core/parse';
import { extractBlob, parseLine, readLineAt } from '../../core/reader/lines';
import { getPointer, tryJson, valueText } from '../../core/text';
import { PARSER_VERSION, type SessionTrace, type TextRef } from '../../shared/types';
import { config, dataPaths } from '../config';
import { spawnParseWorker } from '../runtime/worker';

const brotli = promisify(zlib.brotliCompress);
const unbrotli = promisify(zlib.brotliDecompress);

export interface ParsedEntry {
  path: string;
  key: string;
  trace: SessionTrace;
  index: LineIndex;
}

// ------------------------------------------------------------------ worker pool

interface Task {
  path: string;
  prefixEnd?: number;
  resolve: (r: ParseResult) => void;
  reject: (e: Error) => void;
}

class ParsePool {
  private workers: Array<{ w: Worker; busy: boolean }> = [];
  private queue: Task[] = [];
  private pending = new Map<number, Task>();
  private seq = 0;

  constructor(private readonly size: number) {}

  private spawn(): { w: Worker; busy: boolean } {
    const w = spawnParseWorker();
    const slot = { w, busy: false };
    w.on('message', (msg: { id: number; ok: boolean; result?: ParseResult; error?: string }) => {
      const task = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      slot.busy = false;
      if (task) {
        if (msg.ok && msg.result) task.resolve(msg.result);
        else task.reject(new Error(msg.error ?? 'parse failed'));
      }
      this.drain();
    });
    w.on('error', (e: unknown) => {
      for (const [id, task] of this.pending) {
        task.reject(e instanceof Error ? e : new Error(String(e)));
        this.pending.delete(id);
      }
      this.workers = this.workers.filter((x) => x !== slot);
      this.drain();
    });
    this.workers.push(slot);
    return slot;
  }

  parse(p: string, prefixEnd?: number): Promise<ParseResult> {
    return new Promise((resolve, reject) => {
      this.queue.push({ path: p, prefixEnd, resolve, reject });
      this.drain();
    });
  }

  private drain(): void {
    while (this.queue.length) {
      let slot = this.workers.find((x) => !x.busy);
      if (!slot && this.workers.length < this.size) slot = this.spawn();
      if (!slot) return;
      const task = this.queue.shift()!;
      const id = ++this.seq;
      slot.busy = true;
      this.pending.set(id, task);
      slot.w.postMessage({ id, path: task.path, homeDir: config.homeDir, prefixEnd: task.prefixEnd });
    }
  }
}

const pool = new ParsePool(2);

// ------------------------------------------------------------------ caches

const MAX_MEM_ENTRIES = 8;
const mem = new Map<string, ParsedEntry>();
const inflight = new Map<string, Promise<ParsedEntry>>();

function cacheFile(p: string, key: string): string {
  const h = createHash('sha1').update(p).digest('hex').slice(0, 20);
  return path.join(dataPaths.cache, `${h}-${key}-p${PARSER_VERSION}.json.br`);
}

async function readDiskCache(p: string, key: string): Promise<ParseResult | undefined> {
  try {
    const buf = await fs.promises.readFile(cacheFile(p, key));
    return JSON.parse((await unbrotli(buf)).toString('utf8')) as ParseResult;
  } catch {
    return undefined;
  }
}

async function writeDiskCache(p: string, key: string, res: ParseResult): Promise<void> {
  const file = cacheFile(p, key);
  const prefix = path.basename(file).split('-')[0];
  try {
    const body = await brotli(Buffer.from(JSON.stringify(res)), {
      params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 4 },
    });
    const tmp = `${file}.tmp-${process.pid}`;
    await fs.promises.writeFile(tmp, body, { mode: 0o600 });
    await fs.promises.rename(tmp, file);
    for (const f of await fs.promises.readdir(dataPaths.cache)) {
      if (f.startsWith(`${prefix}-`) && path.join(dataPaths.cache, f) !== file) {
        await fs.promises.rm(path.join(dataPaths.cache, f), { force: true });
      }
    }
  } catch {
    // cache is best-effort
  }
}

export async function getParsed(p: string, opts: { prefixEnd?: number } = {}): Promise<ParsedEntry> {
  const st = await fs.promises.stat(p);
  // a replay parsed with its copied prefix hidden is a different result from the plain file
  const key = `${st.size}-${Math.round(st.mtimeMs)}${opts.prefixEnd ? `-r${opts.prefixEnd}` : ''}`;
  const hit = mem.get(p);
  if (hit && hit.key === key) {
    mem.delete(p);
    mem.set(p, hit);
    return hit;
  }
  const flightKey = `${p}#${key}`;
  const running = inflight.get(flightKey);
  if (running) return running;
  const job = (async () => {
    const cached = await readDiskCache(p, key);
    const res = cached ?? (await pool.parse(p, opts.prefixEnd));
    if (!cached) void writeDiskCache(p, key, res);
    const entry: ParsedEntry = { path: p, key, trace: res.trace, index: res.index };
    mem.set(p, entry);
    while (mem.size > MAX_MEM_ENTRIES) mem.delete(mem.keys().next().value!);
    return entry;
  })();
  inflight.set(flightKey, job);
  try {
    return await job;
  } finally {
    inflight.delete(flightKey);
  }
}

/** Parse without touching the caches (background indexing). */
export async function parseFresh(p: string): Promise<ParseResult> {
  const hit = mem.get(p);
  if (hit) {
    const st = await fs.promises.stat(p);
    if (hit.key === `${st.size}-${Math.round(st.mtimeMs)}`) return { trace: hit.trace, index: hit.index };
  }
  return pool.parse(p);
}

export function isCachedInMemory(p: string): boolean {
  return mem.has(p);
}

// ------------------------------------------------------------------ lazy reads

export async function readRecord(entry: Pick<ParsedEntry, 'path' | 'index'>, line: number): Promise<Record<string, unknown>> {
  const offset = entry.index.offsets[line];
  const length = entry.index.lengths[line];
  if (offset === undefined || !length) throw new Error(`line ${line} out of range`);
  const buf = await readLineAt(entry.path, offset, length);
  return parseLine(buf, line).rec;
}

const MAX_TEXT = 2 * 1024 * 1024;

export async function readText(entry: ParsedEntry, ref: TextRef): Promise<{ text: string; truncated: boolean; chars: number }> {
  const rec = await readRecord(entry, ref.line);
  let value = getPointer(rec, ref.ptr);
  if (ref.json && typeof value === 'string') value = getPointer(tryJson(value), ref.json);
  const text = value === undefined ? '' : valueText(value);
  return { text: text.length > MAX_TEXT ? text.slice(0, MAX_TEXT) : text, truncated: text.length > MAX_TEXT, chars: text.length };
}

export async function readRaw(entry: ParsedEntry, line: number): Promise<{ text: string; truncated: boolean; chars: number }> {
  const rec = await readRecord(entry, line);
  const text = JSON.stringify(rec, null, 2);
  return { text: text.length > MAX_TEXT ? text.slice(0, MAX_TEXT) : text, truncated: text.length > MAX_TEXT, chars: text.length };
}

export async function readBlob(entry: ParsedEntry, line: number, k: number): Promise<{ data: Buffer; mime: string } | undefined> {
  const offset = entry.index.offsets[line];
  const length = entry.index.lengths[line];
  if (offset === undefined || !length) return undefined;
  const raw = (await readLineAt(entry.path, offset, length)).toString('utf8');
  const blob = extractBlob(raw, k);
  return blob ? { data: Buffer.from(blob.base64, 'base64'), mime: blob.mime } : undefined;
}

import fs from 'node:fs';

/**
 * Low-level rollout reading: chunked line streaming with byte offsets, cheap
 * record-kind detection from the line prefix, and base64 blob stripping so
 * screenshot-heavy lines (tens of MB) can be parsed without blowing memory.
 */

const CHUNK = 8 * 1024 * 1024;
/** Lines longer than this get their base64 payloads replaced before JSON.parse. */
export const BIG_LINE = 256 * 1024;

export interface RawLine {
  line: number;
  offset: number;
  data: Buffer;
}

export async function* streamLines(path: string, chunkSize = CHUNK): AsyncGenerator<RawLine> {
  const fd = await fs.promises.open(path, 'r');
  try {
    let pos = 0;
    let lineNo = 0;
    let lineStart = 0;
    let pending: Buffer[] = [];
    for (;;) {
      const buf = Buffer.allocUnsafe(chunkSize);
      const { bytesRead } = await fd.read(buf, 0, chunkSize, pos);
      if (bytesRead === 0) break;
      let s = 0;
      while (s < bytesRead) {
        const nl = buf.indexOf(10, s);
        if (nl === -1 || nl >= bytesRead) {
          pending.push(buf.subarray(s, bytesRead));
          break;
        }
        const part = buf.subarray(s, nl);
        const data = pending.length ? Buffer.concat([...pending, part]) : part;
        pending = [];
        if (data.length) yield { line: lineNo, offset: lineStart, data };
        lineNo++;
        lineStart = pos + nl + 1;
        s = nl + 1;
      }
      pos += bytesRead;
    }
    if (pending.length) {
      const data = Buffer.concat(pending);
      if (data.length) yield { line: lineNo, offset: lineStart, data };
    }
  } finally {
    await fd.close();
  }
}

/**
 * Record kind from the first bytes of a line, without parsing:
 * `session_meta`, `turn_context`, `response_item:message`, `event_msg:token_count`, …
 */
export function kindOf(data: Buffer): string {
  const head = data.subarray(0, 400).toString('latin1');
  const t = /"type":"([a-z_]+)"/.exec(head)?.[1];
  if (!t) return 'unknown';
  if (t === 'event_msg' || t === 'response_item') {
    const pt = /"payload":\{"type":"([a-z_]+)"/.exec(head)?.[1];
    return pt ? `${t}:${pt}` : t;
  }
  return t;
}

const B64_FIELD = /"(data|image_url|b64_json|image|url)":"(?:data:[a-z]+\/[a-z0-9.+-]+;base64,)?([A-Za-z0-9+/=]{2048,})"/g;
const DATA_URI = /data:[a-z]+\/[a-z0-9.+-]+;base64,([A-Za-z0-9+/=]{2048,})/g;

export function blobId(line: number, k: number): string {
  return `blob:${line}:${k}`;
}

/** Replace large base64 payloads with `blob:<line>:<k>` markers. */
export function stripBlobs(s: string, line: number): { text: string; blobs: string[] } {
  if (s.length < BIG_LINE) return { text: s, blobs: [] };
  const blobs: string[] = [];
  let text = s.replace(B64_FIELD, (_m, key: string) => {
    const id = blobId(line, blobs.length);
    blobs.push(id);
    return `"${key}":"${id}"`;
  });
  text = text.replace(DATA_URI, () => {
    const id = blobId(line, blobs.length);
    blobs.push(id);
    return id;
  });
  return { text, blobs };
}

/** Recover the k-th stripped payload of a line (same replacement order as stripBlobs). */
export function extractBlob(s: string, k: number): { base64: string; mime: string } | undefined {
  let i = 0;
  let found: string | undefined;
  const take = (b64: string) => {
    if (i++ === k) found = b64;
    return 'x';
  };
  const rest = s.replace(B64_FIELD, (_m, _key: string, b64: string) => take(b64));
  if (found === undefined) rest.replace(DATA_URI, (_m, b64: string) => take(b64));
  if (found === undefined) return undefined;
  return { base64: found, mime: sniffMime(found) };
}

export function sniffMime(b64: string): string {
  if (b64.startsWith('iVBOR')) return 'image/png';
  if (b64.startsWith('/9j/')) return 'image/jpeg';
  if (b64.startsWith('R0lGOD')) return 'image/gif';
  if (b64.startsWith('UklGR')) return 'image/webp';
  return 'application/octet-stream';
}

export interface ParsedLine {
  rec: Record<string, unknown>;
  blobs: string[];
}

export function parseLine(data: Buffer | string, line: number): ParsedLine {
  const raw = typeof data === 'string' ? data : data.toString('utf8');
  const { text, blobs } = stripBlobs(raw, line);
  const rec = JSON.parse(text) as Record<string, unknown>;
  return { rec, blobs };
}

export async function readLineAt(path: string, offset: number, length: number): Promise<Buffer> {
  const fd = await fs.promises.open(path, 'r');
  try {
    const buf = Buffer.allocUnsafe(length);
    const { bytesRead } = await fd.read(buf, 0, length, offset);
    return buf.subarray(0, bytesRead);
  } finally {
    await fd.close();
  }
}

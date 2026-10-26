import fs from 'node:fs';
import type { SessionTrace } from '../shared/types';
import { TraceBuilder } from './build/reducer';
import { kindOf, parseLine, streamLines } from './reader/lines';

export interface LineIndex {
  offsets: number[];
  lengths: number[];
  kinds: string[];
}

export interface ParseResult {
  trace: SessionTrace;
  index: LineIndex;
}

const CODEX_WORK = new Set(['response_item:reasoning', 'response_item:function_call', 'response_item:custom_tool_call', 'response_item:web_search_call']);

/**
 * Codex subagents that fork their parent's history start with a copy of it:
 * - since 0.153 the copy includes the parent's session_meta, and
 *   `subagent_history_start_ordinal` is the record ordinal (= line) where the
 *   subagent's own records begin (other files carry an ordinal past their end);
 * - 0.144–0.146 copy a filtered version of the parent's turn (context
 *   messages, final answers and the parent's token counts, no reasoning or
 *   tool calls); the subagent's own history starts with the turn that the
 *   parent's message triggers.
 */
export function codexForkPrefix(historyStart: number | undefined, sessionMetas: number, kinds: string[], forked: boolean): number | undefined {
  if (historyStart !== undefined && sessionMetas >= 2) return historyStart > 0 && historyStart < kinds.length ? historyStart : undefined;
  if (!forked) return undefined;
  const trigger = kinds.indexOf('inter_agent_communication_metadata');
  let start = -1;
  for (let i = trigger - 1; i > 0; i--) {
    if (kinds[i] === 'event_msg:task_started') {
      start = i;
      break;
    }
  }
  if (start <= 1) return undefined;
  for (let i = 0; i < start; i++) if (CODEX_WORK.has(kinds[i])) return undefined;
  return start;
}

export type SessionFormat = 'rollout' | 'claude';

/**
 * Codex rollout records are envelopes `{"timestamp":…,("ordinal":…,)"type":…,"payload":…}`;
 * Claude Code transcripts start with `{"parentUuid":…` or `{"type":…` records (sessionId, no payload).
 * Only the envelope is matched: message text may contain anything.
 */
export function sniffFormat(firstLine: string): SessionFormat {
  if (/^\{"timestamp":"[^"]*",(?:"ordinal":\d+,)?"type":"[a-z_]+","payload":/.test(firstLine)) return 'rollout';
  if (/^\{"(?:parentUuid|type|sessionId|uuid|leafUuid)":/.test(firstLine)) return 'claude';
  return 'rollout';
}

async function firstLine(path: string): Promise<string> {
  const fd = await fs.promises.open(path, 'r');
  try {
    const buf = Buffer.alloc(16 * 1024);
    const { bytesRead } = await fd.read(buf, 0, buf.length, 0);
    return buf.subarray(0, bytesRead).toString('utf8').split('\n', 1)[0];
  } finally {
    await fd.close();
  }
}

/** Parse any supported session file (the format is detected from its first line). */
export async function parseSession(path: string, opts: ParseOptions = {}): Promise<ParseResult> {
  if (sniffFormat(await firstLine(path)) === 'claude') {
    const { parseClaudeSession } = await import('./claude/parse');
    return parseClaudeSession(path, opts);
  }
  return parseRollout(path, opts);
}

export interface ParseOptions {
  homeDir?: string;
  onProgress?: (bytesRead: number, totalBytes: number) => void;
  /** A replay: lines before this one are its copy of the original session (context only, not its own turns). */
  prefixEnd?: number;
}

export async function parseRollout(path: string, opts: ParseOptions = {}): Promise<ParseResult> {
  const st = await fs.promises.stat(path);
  const offsets: number[] = [];
  const lengths: number[] = [];
  const kinds: string[] = [];
  let sessionMetaCount = 0;
  let firstMetaId: string | undefined;
  let forkedFrom = false;
  let historyStart: number | undefined;

  // Pass 1: offsets and kinds (no JSON parsing).
  for await (const { line, offset, data } of streamLines(path)) {
    while (kinds.length < line) {
      offsets.push(offset);
      lengths.push(0);
      kinds.push('');
    }
    const kind = kindOf(data);
    offsets.push(offset);
    lengths.push(data.length);
    kinds.push(kind);
    if (kind === 'session_meta') {
      sessionMetaCount++;
      // {"session_id":…,"id":… (older versions: {"id":…)
      const head = data.subarray(0, 600).toString('latin1');
      const id = /"payload":\{[^{}]*?"id":"([^"]+)"/.exec(head)?.[1];
      if (sessionMetaCount === 1) firstMetaId = id;
      else if (id && firstMetaId && id !== firstMetaId) forkedFrom = true;
      if (sessionMetaCount === 1) {
        const meta = data.toString('latin1', 0, Math.min(data.length, 1 << 20));
        if (/"forked_from_id":"[^"]+"/.test(meta)) forkedFrom = true;
        const ord = /"subagent_history_start_ordinal":(\d+)/.exec(meta)?.[1];
        if (ord) historyStart = Number(ord);
      }
    }
  }

  const replayEnd = opts.prefixEnd !== undefined && opts.prefixEnd > 0 && opts.prefixEnd <= kinds.length ? opts.prefixEnd : undefined;
  const forkPrefixEnd = replayEnd ?? codexForkPrefix(historyStart, sessionMetaCount, kinds, forkedFrom);
  const builder = new TraceBuilder({
    forkPrefixEnd,
    forkKind: replayEnd !== undefined ? 'replay' : forkedFrom ? 'full' : 'partial',
    homeDir: opts.homeDir,
  });

  // Pass 2: reduce.
  let bytes = 0;
  let lastReport = 0;
  for await (const { line, data } of streamLines(path)) {
    bytes += data.length + 1;
    if (opts.onProgress && bytes - lastReport > 32 * 1024 * 1024) {
      lastReport = bytes;
      opts.onProgress(bytes, st.size);
    }
    let rec: Record<string, unknown>;
    try {
      rec = parseLine(data, line).rec;
    } catch (e) {
      builder.diag('parse_error', (e as Error).message.slice(0, 120), line);
      continue;
    }
    builder.push(line, rec);
  }

  const trace = builder.finish({ path, size: st.size, mtimeMs: st.mtimeMs, lines: kinds.length });
  return { trace, index: { offsets, lengths, kinds } };
}

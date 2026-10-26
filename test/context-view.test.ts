import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CallContextResponse, ContextSearchResponse, ContextSeriesResponse, TraceResponse } from '../src/shared/api';
import type { ToolCall } from '../src/shared/types';
import { configure, ensureDataDirs } from '../src/server/config';
import { sessionRoutes } from '../src/server/routes/sessions';
import { configureSources, refreshSources } from '../src/server/sources/registry';
import { readableJson } from '../src/web/lib/format';
import { item, RolloutBuilder } from './fixtures/builder';

/**
 * What the session page loads: a trace with tool briefs (the full tool per
 * request), and per step the input with where each part came from, what a
 * compaction removed, and a search that reads full texts.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kifu-context-view-'));
const id = '0199cccc-0000-7000-8000-00000000c0de';
const LONG = `${'line of build output\n'.repeat(120)}the needle-in-output appears at the very end`;

beforeAll(() => {
  configure({ dataDir: path.join(tmp, 'data') });
  ensureDataDirs();
  const home = path.join(tmp, 'codex');
  const dir = path.join(home, 'sessions', '2026', '09', '01');
  fs.mkdirSync(dir, { recursive: true });
  const b = new RolloutBuilder().meta({ id, cwd: '/work/demo', extra: {} });
  b.taskStarted('t1').append('t1', [item.dev('<permissions instructions>\nread-only\n</permissions instructions>')]).turnContext('t1');
  b.append('t1', [item.user('build it')]);
  b.append('t1', [item.call('shell', { command: ['bash', '-lc', 'make build'] }, 'call_1')]).tokens(1000, 10);
  b.execEnd('call_1', 'make build').append('t1', [item.output('call_1', LONG)]);
  b.append('t1', [item.assistant('built')]).tokens(2500, 5).taskComplete('t1');
  b.taskStarted('t2').turnContext('t2').append('t2', [item.user('now ship it')]);
  b.append('t2', [item.call('shell', { command: ['bash', '-lc', 'make ship'] }, 'call_2')]).tokens(2700, 10);
  b.execEnd('call_2', 'make ship').append('t2', [item.output('call_2', 'shipped')]);
  // the context is compacted into a summary, then the agent goes on
  b.tokens(2800, 50).replace([item.dev('<permissions instructions>\nread-only\n</permissions instructions>'), item.user('The following is a structured summary: built and shipped.')]).event({ type: 'context_compacted' });
  b.append('t2', [item.assistant('done')]).tokens(400, 5).taskComplete('t2');
  fs.writeFileSync(path.join(dir, `rollout-2026-09-01T00-00-00-${id}.jsonl`), `${b.lines.map((l) => JSON.stringify(l)).join('\n')}\n`);
  configureSources({ agent: 'codex', home });
  refreshSources();
});

afterAll(() => {
  configureSources({ agent: 'codex' });
  fs.rmSync(tmp, { recursive: true, force: true });
});

const get = async <T>(p: string): Promise<T> => {
  const res = await sessionRoutes.request(p);
  expect(res.status).toBe(200);
  return (await res.json()) as T;
};

describe('session page data', () => {
  it('the trace has tool briefs (summary, sizes, event titles); the full tool comes per request', async () => {
    const t = await get<TraceResponse & Record<string, unknown>>(`/${id}/trace`);
    const brief = t.tools.call_1 as unknown as Record<string, unknown>;
    expect(brief).toMatchObject({ name: 'shell', summary: 'bash -lc make build', argsChars: expect.any(Number), outputChars: LONG.length });
    expect(brief).not.toHaveProperty('args');
    expect(brief).not.toHaveProperty('output');
    expect((brief.inner as Array<Record<string, unknown>>)[0]).not.toHaveProperty('output');
    expect(t).not.toHaveProperty('listings');
    const full = await get<ToolCall>(`/${id}/tools/call_1`);
    expect(full.output?.chars).toBe(LONG.length);
    expect(full.args.preview).toContain('make build');
    // (the app maps NotFound to 404; the bare routes answer with an error)
    expect((await sessionRoutes.request(`/${id}/tools/nope`)).status).toBeGreaterThanOrEqual(400);
  });

  it('each part of a step’s input says its turn and where it came from; a compaction’s removals are listed', async () => {
    const t = await get<TraceResponse>(`/${id}/trace`);
    const kinds = t.calls.map((c) => c.kind);
    expect(kinds).toEqual(['response', 'response', 'response', 'compaction', 'response']);
    const second = await get<CallContextResponse>(`/${id}/calls/1/context`);
    const call = second.items.find((i) => i.cat === 'tool_call')!;
    const out = second.items.find((i) => i.cat === 'tool_output')!;
    expect(call).toMatchObject({ turn: 0, from: 0, tool: 'call_1' });
    expect(out).toMatchObject({ turn: 0, tool: 'call_1' });
    expect(out.from).toBeUndefined();
    expect(second).toMatchObject({ prevCall: 0, newCount: 2 });
    expect(second.newTokens).toBeGreaterThan(0);
    // after the compaction: the earlier parts are gone, the summary is new
    const after = await get<CallContextResponse>(`/${id}/calls/4/context`);
    expect(after.prevCall).toBe(3);
    expect(after.removed?.length).toBeGreaterThan(3);
    expect(after.removed?.some((i) => i.tool === 'call_1')).toBe(true);
    expect(after.items.some((i) => i.cat === 'compaction_summary' && i.isNew)).toBe(true);
    expect(after.contextWindow).toBe(200000);
  });

  it('search reads full texts, not only previews', async () => {
    const ctx = await get<CallContextResponse>(`/${id}/calls/1/context`);
    const out = ctx.items.find((i) => i.cat === 'tool_output')!;
    expect(out.preview).not.toContain('needle-in-output');
    const s = await get<ContextSearchResponse>(`/${id}/calls/1/context/search?q=NEEDLE-in-output`);
    expect(s.hits).toEqual([{ idx: out.idx, count: 1, snippet: expect.stringContaining('needle-in-output') }]);
    expect((await get<ContextSearchResponse>(`/${id}/calls/1/context/search?q=`)).hits).toEqual([]);
  });

  it('the context series has every step’s composition, the same as each step’s own (a compaction drops it)', async () => {
    const series = await get<ContextSeriesResponse>(`/${id}/context-series`);
    expect(series.points.map((p) => p.call)).toEqual([0, 1, 2, 3, 4]);
    expect(series.contextWindow).toBe(200000);
    for (const p of series.points) {
      expect(p.v).toHaveLength(series.cats.length);
      // the same numbers as the step's composition
      const ctx = await get<CallContextResponse>(`/${id}/calls/${p.call}/context`);
      const byCat = Object.fromEntries(ctx.composition.map((r) => [r.cat, r.estTokens]));
      series.cats.forEach((cat, k) => expect(p.v[k]).toBe(byCat[cat] ?? 0));
    }
    const out = series.cats.indexOf('tool_output');
    expect(series.points[2].v[out]).toBeGreaterThan(0);
    // compacted: the tool outputs are gone, the summary came in
    expect(series.points[4].v[out]).toBe(0);
    expect(series.points[4].v[series.cats.indexOf('compaction_summary')]).toBeGreaterThan(0);
  });
});

describe('raw records, readable', () => {
  it('shows strings with line breaks as lines, the rest as indented JSON', () => {
    const rec = { type: 'event_msg', payload: { output: 'line 1\nline 2\u001b[0m', n: 3, empty: [], tags: ['a'] } };
    expect(readableJson(rec)).toBe(
      ['{', '  "type": "event_msg",', '  "payload": {', '    "output": """', '      line 1', '      line 2\\u001b[0m', '      """,', '    "n": 3,', '    "empty": [],', '    "tags": [', '      "a"', '    ]', '  }', '}'].join('\n'),
    );
    // without line breaks: the same as JSON.stringify(…, null, 2)
    const plain = { a: 'x', b: [1, { c: null }], d: true };
    expect(readableJson(plain)).toBe(JSON.stringify(plain, null, 2));
  });
});

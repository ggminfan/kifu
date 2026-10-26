import type { SkillFlag, SkillInvocationRef, SkillReportResponse, SkillReportRow } from '../../shared/api';
import type { SessionTrace, SkillEntry, SkillListing } from '../../shared/types';
import { normalizeText } from '../skills/frontmatter';
import { Bm25, salientTokens, tokenSet, tokenize } from './tokens';

/** What we know about a skill file on disk right now. */
export interface DiskSkill {
  path: string;
  description?: string;
  body?: string;
  lines?: number;
}

export type DiskLookup = (path: string | undefined, name: string) => DiskSkill | undefined;

function latestDistinct(listings: SkillListing[]): { latest?: SkillListing; distinct: number } {
  const hashes = new Set(listings.map((l) => l.hash));
  return { latest: listings[listings.length - 1], distinct: hashes.size };
}

function truncation(visible: string | undefined, full: string | undefined): { truncated: boolean | null; tail?: string; changed?: boolean } {
  if (!visible || !full) return { truncated: null };
  const v = normalizeText(visible);
  const f = normalizeText(full);
  if (v === f) return { truncated: false };
  if (f.startsWith(v) && v.length < f.length) return { truncated: true, tail: f.slice(v.length).trimStart() };
  return { truncated: null, changed: true };
}

function mode(values: number[]): number | undefined {
  const counts = new Map<number, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  let best: number | undefined;
  let bestN = 0;
  for (const [v, n] of counts) {
    if (n > bestN) {
      best = v;
      bestN = n;
    }
  }
  return best;
}

export function skillReport(trace: SessionTrace, disk: DiskLookup): SkillReportResponse {
  const { latest, distinct } = latestDistinct(trace.listings);
  const turnOfCall = new Map<number, number>();
  const turnIndexById = new Map(trace.turns.map((t) => [t.id, t.index]));
  for (const c of trace.calls) if (c.turnId !== undefined) turnOfCall.set(c.index, turnIndexById.get(c.turnId) ?? -1);

  const rows = new Map<string, SkillReportRow>();
  const entries: SkillEntry[] = latest?.entries ?? [];
  const listedNames = new Set(trace.listings.flatMap((l) => l.entries.map((e) => e.name)));

  for (const e of entries) {
    const d = disk(e.path, e.name);
    const t = truncation(e.description, d?.description);
    const row: SkillReportRow = {
      name: e.name,
      path: e.path ?? d?.path,
      listed: true,
      visibleDescription: e.description,
      fullDescription: d?.description,
      truncated: t.truncated,
      hiddenTail: t.tail,
      fileLines: d?.lines,
      invocations: [],
      flags: t.changed ? ['desc_changed'] : [],
    };
    rows.set(e.name, row);
  }

  for (const inv of trace.invocations) {
    let row = rows.get(inv.skill);
    if (!row) {
      const d = disk(inv.path, inv.skill);
      row = {
        name: inv.skill,
        path: inv.path ?? d?.path,
        listed: listedNames.has(inv.skill),
        fullDescription: d?.description,
        truncated: null,
        fileLines: d?.lines,
        invocations: [],
        flags: listedNames.has(inv.skill) ? [] : ['not_listed'],
      };
      rows.set(inv.skill, row);
    }
    const ref: SkillInvocationRef = { mode: inv.mode, callIndex: inv.callIndex, turnIndex: turnOfCall.get(inv.callIndex), toolCallId: inv.toolCallId, seenLines: inv.seenLines };
    row.invocations.push(ref);
  }

  // Relevance of each listed skill to the user's turns (BM25 over full descriptions).
  const docs = entries.map((e) => tokenize(`${e.name.replace(/[:_-]/g, ' ')} ${rows.get(e.name)?.fullDescription ?? e.description}`));
  const bm = new Bm25(docs);
  for (const turn of trace.turns) {
    if (!turn.input?.preview || turn.trigger === 'unknown' || turn.trigger === 'system') continue;
    const q = tokenize(turn.input.preview);
    if (!q.length) continue;
    const scored = entries.map((e, i) => ({ e, i, s: bm.score(q, i) })).sort((a, b) => b.s - a.s);
    const top = scored[0]?.s ?? 0;
    for (const { e, i, s } of scored.slice(0, 3)) {
      if (s < 2.5 || s < top * 0.5) continue;
      const row = rows.get(e.name)!;
      if (row.relevance && row.relevance.score >= s) continue;
      const matched = bm.matched(q, i);
      const visible = tokenSet(`${e.name.replace(/[:_-]/g, ' ')} ${e.description}`);
      row.relevance = { turnIndex: turn.index, score: Math.round(s * 10) / 10, matched, tailOnly: matched.filter((m) => !visible.has(m)) };
    }
  }

  // Follow evidence: do the tool calls after a load use what the skill says?
  for (const row of rows.values()) {
    if (!row.invocations.length) continue;
    const body = disk(row.path, row.name)?.body;
    if (!body) continue;
    const bodyTokens = tokenSet(body);
    let checked = 0;
    let matched = 0;
    const samples: Array<{ toolCallId: string; tokens: string[] }> = [];
    for (const inv of row.invocations) {
      const call = trace.calls[inv.callIndex];
      if (!call) continue;
      const turnCalls = trace.turns.find((t) => t.id === call.turnId)?.calls ?? [];
      const after = turnCalls.filter((i) => i >= inv.callIndex).flatMap((i) => trace.calls[i]?.tools ?? []);
      for (const id of after.filter((x) => x !== inv.toolCallId).slice(0, 8)) {
        const tool = trace.tools[id];
        if (!tool) continue;
        checked++;
        const hit = salientTokens(tool.args.preview).filter((tok) => tok.length >= 4 && bodyTokens.has(tok));
        if (hit.length >= 2) {
          matched++;
          if (samples.length < 3) samples.push({ toolCallId: id, tokens: hit.slice(0, 6) });
        }
      }
    }
    row.follow = { checked, matched, samples };
  }

  for (const row of rows.values()) {
    const flags = new Set<SkillFlag>(row.flags);
    if (row.invocations.length) flags.add('loaded');
    const invokedTurns = new Set(row.invocations.map((i) => i.turnIndex));
    if (row.relevance && !invokedTurns.has(row.relevance.turnIndex)) {
      flags.add('maybe_missed');
      if (row.truncated && row.relevance.tailOnly.length) flags.add('trigger_truncated');
    }
    if (row.fileLines && row.invocations.some((i) => i.mode === 'implicit_read' && i.seenLines && i.seenLines[1] < row.fileLines!)) {
      flags.add('partial_read');
    }
    if (row.follow && row.follow.checked >= 3 && row.follow.matched === 0) flags.add('not_followed');
    row.flags = [...flags];
  }

  const truncatedVisible = entries.filter((e) => rows.get(e.name)?.truncated).map((e) => normalizeText(e.description).length);
  const ordered = [...rows.values()].sort((a, b) => {
    const rank = (r: SkillReportRow) => (r.invocations.length ? 0 : r.flags.includes('maybe_missed') ? 1 : r.flags.length ? 2 : 3);
    const d = rank(a) - rank(b);
    if (d) return d;
    if (a.invocations.length && b.invocations.length) return a.invocations[0].callIndex - b.invocations[0].callIndex;
    return (b.relevance?.score ?? 0) - (a.relevance?.score ?? 0) || a.name.localeCompare(b.name);
  });

  return {
    listing: latest
      ? {
          format: latest.format,
          entries: latest.entries.length,
          distinct,
          truncatedCount: truncatedVisible.length,
          cap: mode(truncatedVisible),
          firstCall: trace.listings[0]?.firstCall,
        }
      : undefined,
    rows: ordered,
  };
}

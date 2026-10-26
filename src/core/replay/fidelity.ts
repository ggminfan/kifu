import type { ExtraKind } from '../../shared/replay';
import { weightedChars } from '../text';

export type { ExtraKind };

/**
 * How faithfully a replay reproduces the context the model saw in the
 * original turn: the replay's first request (or its reconstructed context)
 * against the original call's context.
 *
 * Requests and recorded histories cut the same text into different pieces
 * (base instructions split over several parts, two context items merged into
 * one, small wrappers dropped), so the comparison works line by line: each
 * side becomes a sequence of normalized lines, matched in order where
 * possible. A line that is a truncated copy of an original line (long tool
 * outputs get elided in requests) still counts.
 *
 * The base instructions (the system prompt the agent builds from its own
 * code) and the history (everything recorded in the session) are scored
 * separately: a replay must reproduce the history; base instructions may
 * legitimately differ between agent versions.
 */

export type BlockRole = 'system' | 'user' | 'assistant' | 'tool_call' | 'tool';

export interface Block {
  role: BlockRole;
  text: string;
  /** Base instructions, or part of the recorded history (default). */
  scope?: 'base' | 'history';
  /** Where the text came from: the request message's part type, or the recorded item's kind. */
  source?: string;
}


export interface ScopeScore {
  /** Share of the original (weighted chars) found in the replay. */
  coverage: number;
  /** Share of the replay the original did not have. */
  extraShare: number;
  originalChars: number;
  replayChars: number;
}

export interface FidelityReport {
  history: ScopeScore;
  base: ScopeScore;
  matchedLines: number;
  /** Matched, but truncated in the replay. */
  truncatedLines: number;
  /** Matched lines found out of order. */
  outOfOrder: number;
  extras: Array<Leftover & { kind: ExtraKind }>;
  missing: Leftover[];
}

/** Unmatched text of one block. */
export interface Leftover {
  role: BlockRole;
  scope: 'base' | 'history';
  source?: string;
  /** Where the block sits in its context, 0 (first) to 1 (last). */
  position: number;
  chars: number;
  lines: number;
  preview: string;
}

const ROLE: Record<string, BlockRole> = { system: 'system', developer: 'system', user: 'user', assistant: 'assistant', tool: 'tool' };

/** Blocks of a reconstructed context: base instructions, then the call's input items (full texts). */
export function blocksFromItems(items: Array<{ kind: string; role?: string; cat: string; text: string }>, base?: string): Block[] {
  const out: Block[] = base ? [{ role: 'system', text: base, scope: 'base', source: 'base' }] : [];
  for (const it of items) {
    if (it.kind === 'reasoning' || it.cat === 'reasoning') continue; // not re-sent as text
    const source = it.role ? `${it.kind}/${it.role}` : it.kind;
    if (it.kind === 'function_call' || it.kind === 'custom_tool_call') out.push({ role: 'tool_call', text: it.text, source });
    else if (it.cat === 'tool_output') out.push({ role: 'tool', text: it.text, source });
    else out.push({ role: ROLE[it.role ?? ''] ?? (it.cat === 'user' ? 'user' : 'system'), text: it.text, source });
  }
  return out;
}

export function classifyExtra(text: string): ExtraKind {
  const t = text.trimStart().slice(0, 600);
  if (/^<permissions instructions>|approval[_ ]policy|sandbox[_ ]mode/i.test(t)) return 'permissions';
  if (/^<environment_context>|current date|today'?s date|当前日期/i.test(t)) return 'environment';
  if (/## Host skills update|<skills_instructions>|^#+ ?Skills\b|available skills/i.test(t)) return 'skills';
  if (/^# AGENTS\.md|AGENTS\.md instructions/i.test(t)) return 'agents_md';
  if (/^<model_switch>|model (changed|switch)|you are now (using|running)|模型已切换/i.test(t)) return 'model';
  if (/^<(collaboration_mode|personality_spec)>/.test(t)) return 'mode';
  return 'other';
}

interface Line {
  role: BlockRole;
  scope: 'base' | 'history';
  block: number;
  n: string;
  w: number;
}

function toLines(blocks: Block[], pathMap: Array<[string, string]>): Line[] {
  const out: Line[] = [];
  blocks.forEach((b, block) => {
    let t = b.text;
    for (const [from, to] of pathMap) if (from && t.includes(from)) t = t.split(from).join(to);
    for (const raw of t.split('\n')) {
      const n = raw.replace(/\s+/g, ' ').trim();
      if (n) out.push({ role: b.role, scope: b.scope ?? 'history', block, n, w: weightedChars(n) });
    }
  });
  return out;
}

function score(lines: Line[], matched: Set<number>, scope: 'base' | 'history'): { total: number; hit: number } {
  let total = 0;
  let hit = 0;
  lines.forEach((l, i) => {
    if (l.scope !== scope) return;
    total += l.w;
    if (matched.has(i)) hit += l.w;
  });
  return { total, hit };
}

const PREVIEW = 160;
const WINDOW = 64;

/** Unmatched lines grouped back into the blocks they came from. */
function leftovers(lines: Line[], blocks: Block[], matched: Set<number>): Array<Leftover & { text: string }> {
  const by = new Map<number, { chars: number; lines: number; first: string }>();
  lines.forEach((l, i) => {
    if (matched.has(i)) return;
    const g = by.get(l.block) ?? { chars: 0, lines: 0, first: l.n };
    g.chars += l.n.length;
    g.lines++;
    by.set(l.block, g);
  });
  return [...by.entries()].map(([i, g]) => {
    const b = blocks[i];
    return { role: b.role, scope: b.scope ?? 'history', source: b.source, position: blocks.length > 1 ? i / (blocks.length - 1) : 0, chars: g.chars, lines: g.lines, preview: g.first.slice(0, PREVIEW), text: b.text };
  });
}

export function compareContexts(original: Block[], replay: Block[], opts: { pathMap?: Array<[string, string]> } = {}): FidelityReport {
  const pathMap = opts.pathMap ?? [];
  const orig = toLines(original, pathMap);
  const rep = toLines(replay, pathMap);

  const byText = new Map<string, number[]>();
  orig.forEach((l, i) => {
    const list = byText.get(l.n);
    if (list) list.push(i);
    else byText.set(l.n, [i]);
  });
  const mOrig = new Set<number>();
  const mRep = new Set<number>();
  let truncated = 0;
  let outOfOrder = 0;
  let last = -1;
  rep.forEach((l, j) => {
    const list = byText.get(l.n);
    if (list) {
      const next = list.find((i) => i > last && !mOrig.has(i));
      const any = next ?? list.find((i) => !mOrig.has(i));
      if (any !== undefined) {
        mOrig.add(any);
        mRep.add(j);
        if (next === undefined) outOfOrder++;
        else last = next;
        return;
      }
    }
    // a truncated copy of one of the next original lines
    if (l.n.length >= 40) {
      for (let i = last + 1; i < Math.min(orig.length, last + 1 + WINDOW); i++) {
        if (!mOrig.has(i) && orig[i].n.length > l.n.length && orig[i].n.startsWith(l.n.slice(0, Math.max(40, Math.floor(l.n.length * 0.6))))) {
          mOrig.add(i);
          mRep.add(j);
          truncated++;
          last = i;
          return;
        }
      }
    }
  });

  const scoreOf = (scope: 'base' | 'history'): ScopeScore => {
    const o = score(orig, mOrig, scope);
    const r = score(rep, mRep, scope);
    return {
      coverage: o.total ? o.hit / o.total : 1,
      extraShare: r.total ? (r.total - r.hit) / r.total : 0,
      originalChars: Math.round(o.total),
      replayChars: Math.round(r.total),
    };
  };

  return {
    history: scoreOf('history'),
    base: scoreOf('base'),
    matchedLines: mOrig.size,
    truncatedLines: truncated,
    outOfOrder,
    extras: leftovers(rep, replay, mRep).map(({ text, ...g }) => ({ ...g, kind: classifyExtra(text) })),
    missing: leftovers(orig, original, mOrig).map(({ text: _, ...g }) => g),
  };
}

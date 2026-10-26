import type { EvidenceHit } from '../../shared/api';
import { Bm25, tokenize } from './tokens';

/**
 * Lexical evidence linking: which lines of the context a tool call most likely
 * came from. Documents are split into overlapping 3-line windows and ranked with
 * BM25 against the tool call's salient tokens; long exact tokens get a bonus.
 */

export interface EvidenceDoc {
  source: EvidenceHit['source'];
  label: string;
  itemIdx?: number;
  skill?: string;
  text: string;
}

interface Chunk {
  doc: number;
  start: number;
  end: number;
  text: string;
}

const WINDOW = 3;
const STEP = 2;

export function findEvidence(query: string[], docs: EvidenceDoc[], topK = 6): EvidenceHit[] {
  const chunks: Chunk[] = [];
  docs.forEach((d, di) => {
    const lines = d.text.split('\n');
    for (let i = 0; i < lines.length; i += STEP) {
      const text = lines.slice(i, i + WINDOW).join('\n');
      if (text.trim().length < 3) continue;
      chunks.push({ doc: di, start: i + 1, end: Math.min(lines.length, i + WINDOW), text });
    }
  });
  if (!chunks.length || !query.length) return [];
  const bm = new Bm25(chunks.map((c) => tokenize(c.text)));
  const longTokens = query.filter((q) => q.length >= 8);
  const scored = chunks
    .map((c, i) => {
      let s = bm.score(query, i);
      if (s > 0) {
        const lower = c.text.toLowerCase();
        for (const t of longTokens) if (lower.includes(t)) s += 1;
      }
      return { c, i, s };
    })
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s);

  const hits: EvidenceHit[] = [];
  const taken: Array<{ doc: number; start: number; end: number }> = [];
  for (const { c, i, s } of scored) {
    if (taken.some((t) => t.doc === c.doc && c.start <= t.end && c.end >= t.start)) continue;
    taken.push({ doc: c.doc, start: c.start, end: c.end });
    const d = docs[c.doc];
    hits.push({
      source: d.source,
      label: d.label,
      itemIdx: d.itemIdx,
      skill: d.skill,
      lineStart: c.start,
      lineEnd: c.end,
      snippet: c.text.length > 500 ? `${c.text.slice(0, 500)}…` : c.text,
      score: Math.round(s * 10) / 10,
      matched: bm.matched(query, i).slice(0, 12),
    });
    if (hits.length >= topK) break;
  }
  return hits;
}

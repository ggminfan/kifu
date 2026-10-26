/**
 * Tokenization + BM25 used by the deterministic attribution heuristics.
 * Mixed Chinese/English text: ASCII words/identifiers/paths plus CJK bigrams.
 */

const STOP = new Set(
  (
    'the and for with when use this that from into your you are will can not all any its but has have was were been also only ' +
    'more than then them they their what which who how why where user users skill skills asks ask about using used should must ' +
    'like such etc via per each other these those there here just very need needs make makes run runs get set new one two let const ' +
    'return true false null undefined await async function var string number type text output input'
  ).split(' '),
);

export function tokenize(text: string): string[] {
  const out: string[] = [];
  const lower = text.toLowerCase();
  for (const m of lower.matchAll(/[a-z0-9_$][a-z0-9_$.\-/:]{1,}/g)) {
    const raw = m[0].replace(/[.\-/:]+$/, '');
    if (raw.length < 3) continue;
    if (!STOP.has(raw)) out.push(raw);
    if (/[/.:]/.test(raw)) {
      for (const part of raw.split(/[/.:]+/)) if (part.length >= 3 && !STOP.has(part)) out.push(part);
    }
  }
  for (const seg of text.matchAll(/[㐀-鿿]+/g)) {
    const s = seg[0];
    if (s.length === 1) out.push(s);
    for (let i = 0; i < s.length - 1; i++) out.push(s.slice(i, i + 2));
  }
  return out;
}

export function tokenSet(text: string): Set<string> {
  return new Set(tokenize(text));
}

/** Salient tokens of a tool call: paths, flags, identifiers, quoted strings. */
export function salientTokens(text: string): string[] {
  const toks = new Set<string>();
  for (const m of text.matchAll(/(?:~|\.{0,2})\/[\w.\-/@+]{3,}/g)) toks.add(m[0].toLowerCase());
  for (const m of text.matchAll(/--?[a-z][\w-]{2,}/gi)) toks.add(m[0].toLowerCase());
  for (const t of tokenize(text)) toks.add(t);
  return [...toks];
}

export class Bm25 {
  private df = new Map<string, number>();
  private lens: number[];
  private avg: number;
  private tf: Array<Map<string, number>>;

  constructor(docs: string[][], private readonly k1 = 1.2, private readonly b = 0.75) {
    this.tf = docs.map((d) => {
      const m = new Map<string, number>();
      for (const t of d) m.set(t, (m.get(t) ?? 0) + 1);
      for (const t of m.keys()) this.df.set(t, (this.df.get(t) ?? 0) + 1);
      return m;
    });
    this.lens = docs.map((d) => d.length);
    this.avg = this.lens.reduce((s, x) => s + x, 0) / Math.max(1, docs.length);
  }

  idf(t: string): number {
    const n = this.tf.length;
    const df = this.df.get(t) ?? 0;
    return Math.log(1 + (n - df + 0.5) / (df + 0.5));
  }

  score(query: string[], doc: number): number {
    const tf = this.tf[doc];
    if (!tf) return 0;
    let s = 0;
    const len = this.lens[doc] || 1;
    for (const q of new Set(query)) {
      const f = tf.get(q);
      if (!f) continue;
      s += this.idf(q) * ((f * (this.k1 + 1)) / (f + this.k1 * (1 - this.b + (this.b * len) / (this.avg || 1))));
    }
    return s;
  }

  matched(query: string[], doc: number): string[] {
    const tf = this.tf[doc];
    if (!tf) return [];
    return [...new Set(query)].filter((q) => tf.has(q));
  }
}

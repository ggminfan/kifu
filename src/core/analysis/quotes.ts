/**
 * Does a quote appear in a text? Models copy quotes with other punctuation,
 * spacing or case (full-width vs half-width, quotes, line breaks), so both
 * sides are compared without those; a quote must keep at least a few letters.
 */

const LOOSE = /[\s\p{P}\p{S}]+/gu;

export function looseText(s: string): string {
  return s.toLowerCase().replace(LOOSE, '');
}

export function quoteFound(hay: string, quote: string, o: { minChars?: number } = {}): boolean {
  const q = looseText(quote);
  if (q.length < (o.minChars ?? 4)) return false;
  return looseText(hay).includes(q);
}

/** The same, with the haystack prepared once (many quotes against one text). */
export function quoteFinder(hay: string, o: { minChars?: number } = {}): (quote: string) => boolean {
  const h = looseText(hay);
  return (quote) => {
    const q = looseText(quote);
    return q.length >= (o.minChars ?? 4) && h.includes(q);
  };
}

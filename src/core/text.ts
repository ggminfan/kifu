import type { TextRef, Txt } from '../shared/types';

/** Preview lengths (chars) for the different kinds of text we inline. */
export const LIMITS = {
  item: 400,
  args: 1500,
  output: 1200,
  input: 2000,
  meta: 600,
  event: 800,
} as const;

export function mkTxt(value: unknown, limit: number, ref?: TextRef): Txt | undefined {
  if (value === undefined || value === null) return undefined;
  const s = typeof value === 'string' ? value : JSON.stringify(value);
  if (s.length <= limit) return { preview: s, chars: s.length };
  return { preview: s.slice(0, limit), chars: s.length, ref };
}

function isCjk(c: number): boolean {
  return (
    (c >= 0x2e80 && c <= 0x9fff) ||
    (c >= 0xac00 && c <= 0xd7af) ||
    (c >= 0xf900 && c <= 0xfaff) ||
    (c >= 0xff00 && c <= 0xffef) ||
    (c >= 0xd800 && c <= 0xdbff) // high surrogate: astral ideographs, emoji
  );
}

/** Rough token estimate: CJK ≈ 1 token per char, other text ≈ 4 chars per token. */
export function weightedChars(s: string): number {
  let cjk = 0;
  for (let i = 0; i < s.length; i++) if (isCjk(s.charCodeAt(i))) cjk++;
  return cjk + (s.length - cjk) / 4;
}

export function partText(part: unknown): string {
  if (typeof part === 'string') return part;
  if (!part || typeof part !== 'object') return '';
  const p = part as Record<string, unknown>;
  if (typeof p.text === 'string') return p.text;
  if (p.type === 'input_image' || p.type === 'image' || p.type === 'output_image') return '[image]';
  if (p.type === 'skill' && typeof p.name === 'string') return `[skill ${p.name}]`;
  return '';
}

export function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map(partText).filter(Boolean).join('\n');
  if (content && typeof content === 'object') return partText(content);
  return '';
}

/** RFC 6901 JSON pointer lookup. */
export function getPointer(obj: unknown, ptr: string): unknown {
  if (!ptr || ptr === '/') return obj;
  let cur: unknown = obj;
  for (const raw of ptr.split('/').slice(1)) {
    const key = raw.replace(/~1/g, '/').replace(/~0/g, '~');
    if (cur === null || cur === undefined) return undefined;
    cur = Array.isArray(cur) ? cur[Number(key)] : (cur as Record<string, unknown>)[key];
  }
  return cur;
}

/** Render a fetched value as display text (strings as-is, content arrays joined, objects pretty-printed). */
export function valueText(v: unknown): string {
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) {
    if (v.every((p) => p && typeof p === 'object' && 'type' in (p as object))) return contentText(v);
    // system prompt blocks; rendered attachments ({content}) of Claude Code
    if (v.every((p) => typeof p === 'string')) return v.join('\n\n');
    if (v.every((p) => p && typeof p === 'object' && typeof (p as { content?: unknown }).content === 'string')) {
      return v.map((p) => (p as { content: string }).content).join('\n');
    }
  }
  return JSON.stringify(v, null, 2);
}

export function tryJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

export function durationToMs(d: unknown): number | undefined {
  if (typeof d === 'number') return d;
  if (d && typeof d === 'object') {
    const o = d as { secs?: number; nanos?: number };
    if (typeof o.secs === 'number') return o.secs * 1000 + Math.round((o.nanos ?? 0) / 1e6);
  }
  return undefined;
}

export function oneLine(s: string, max = 160): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

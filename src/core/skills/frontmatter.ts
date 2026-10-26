import { parseDocument } from 'yaml';

export interface ParsedSkillMd {
  /** Raw frontmatter text between the --- fences, or null when absent. */
  frontmatter: string | null;
  data: Record<string, unknown>;
  name?: string;
  description?: string;
  body: string;
}

const FM_RE = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

export function parseSkillMd(raw: string): ParsedSkillMd {
  const m = FM_RE.exec(raw);
  if (!m) return { frontmatter: null, data: {}, body: raw };
  let data: Record<string, unknown> = {};
  try {
    const parsed = parseDocument(m[1]).toJSON();
    if (parsed && typeof parsed === 'object') data = parsed as Record<string, unknown>;
  } catch {
    // malformed frontmatter: keep the body usable
  }
  return {
    frontmatter: m[1],
    data,
    name: typeof data.name === 'string' ? data.name : undefined,
    description: typeof data.description === 'string' ? data.description : undefined,
    body: raw.slice(m[0].length),
  };
}

/** Replace description and/or body while keeping the rest of the frontmatter (comments, key order) intact. */
export function updateSkillMd(raw: string, fields: { description?: string; body?: string }): string {
  const m = FM_RE.exec(raw);
  const body = fields.body ?? (m ? raw.slice(m[0].length) : raw);
  let fm = m ? m[1] : '';
  if (fields.description !== undefined) {
    const doc = parseDocument(fm);
    doc.set('description', fields.description);
    fm = doc.toString().replace(/\n$/, '');
  }
  if (!m && fields.description === undefined) return body;
  return `---\n${fm}\n---\n${body}`;
}

/** Collapse whitespace so listing text can be compared with frontmatter text. */
export function normalizeText(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

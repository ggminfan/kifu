import { createHash } from 'node:crypto';
import type { ParsedCmd, SkillEntry, SkillListing } from '../../shared/types';

/**
 * Skill catalog parsing and skill-usage detection.
 *
 * Listing formats:
 *  - Codex: developer part `<skills_instructions>\n## Skills … ### Available skills\n- name: desc (file: …)`
 *  - Claude Code: `<system-reminder>\nThe following skills are available for use with the Skill tool:\n\n- name: desc`
 *  - mid-session updates under a `## Host skills update` header
 * Skill roots may be listed as aliases (`- \`r0\` = \`/abs\``); entries are `- name: description (file: rN/dir/SKILL.md)`
 * or with absolute paths (older versions).
 */

const ENTRY_RE = /^- (\S+?): (.*?)\s*\(file: ([^)]+)\)\s*$/;
const ENTRY_NOFILE_RE = /^- (\S+?): (.+)$/;
const ROOT_RE = /^- `?(r\d+)`?\s*[=:]\s*`?([^`]+?)`?\s*$/;

export type ListingParse = Pick<SkillListing, 'format' | 'roots' | 'entries' | 'hash'>;

export function looksLikeListing(text: string): boolean {
  return (
    text.includes('<skills_instructions>') ||
    text.includes('available for use with the Skill tool') ||
    text.includes('## Host skills update')
  );
}

export function resolveSkillFile(file: string, roots: Record<string, string>): string {
  const m = /^(r\d+)\/(.*)$/.exec(file);
  if (m && roots[m[1]]) return `${roots[m[1]].replace(/\/$/, '')}/${m[2]}`;
  return file;
}

export function parseListing(text: string): ListingParse | null {
  if (!looksLikeListing(text)) return null;
  const format: SkillListing['format'] = text.includes('## Host skills update')
    ? 'host_update'
    : text.includes('<skills_instructions>')
      ? 'codex'
      : 'claudecode';
  const roots: Record<string, string> = {};
  const entries: SkillEntry[] = [];
  let inAvailable = format !== 'codex';
  for (const raw of text.split('\n')) {
    const line = raw.trimEnd();
    if (/^#+\s*Available skills/i.test(line)) inAvailable = true;
    const root = ROOT_RE.exec(line);
    if (root) {
      roots[root[1]] = root[2];
      continue;
    }
    if (!line.startsWith('- ')) continue;
    const m = ENTRY_RE.exec(line);
    if (m) {
      entries.push({ name: m[1], description: m[2].trim(), file: m[3].trim() });
      continue;
    }
    if (inAvailable) {
      const n = ENTRY_NOFILE_RE.exec(line);
      if (n && !n[1].startsWith('`')) entries.push({ name: n[1], description: n[2].trim() });
    }
  }
  if (!entries.length) return null;
  for (const e of entries) if (e.file) e.path = resolveSkillFile(e.file, roots);
  const hash = createHash('sha1')
    .update(entries.map((e) => `${e.name}\u0000${e.description}\u0000${e.path ?? ''}`).join('\n'))
    .digest('hex')
    .slice(0, 16);
  return { format, roots, entries, hash };
}

/** `<skill><name>x</name><path>p</path>…` (explicit $skill mention or Skill tool output). */
export function parseSkillBlock(text: string): { name?: string; path?: string } | null {
  const i = text.indexOf('<skill>');
  if (i === -1 || i > 400) return null;
  const name = /<name>([^<]{1,200})<\/name>/.exec(text)?.[1]?.trim();
  const path = /<path>([^<]{1,1000})<\/path>/.exec(text)?.[1]?.trim();
  if (!name && !path) return null;
  return { name, path };
}

/** Derive a display name from a SKILL.md path (plugin cache paths become plugin:skill). */
export function skillNameFromPath(p: string): string {
  const parts = p.split('/').filter(Boolean);
  const file = parts[parts.length - 1];
  const dirIdx = file && /^skill\.md$/i.test(file) ? parts.length - 2 : parts.length - 1;
  const skill = parts[dirIdx] ?? p;
  const cacheIdx = parts.lastIndexOf('cache');
  const skillsIdx = parts.lastIndexOf('skills');
  if (cacheIdx !== -1 && skillsIdx > cacheIdx + 2) {
    const plugin = parts[cacheIdx + 2];
    if (plugin) return `${plugin}:${skill}`;
  }
  return skill;
}

export interface SkillRead {
  path: string;
  lines?: [number, number];
}

/** Does this shell command read a SKILL.md? (implicit skill loading in Codex) */
export function detectSkillRead(cmd: string, parsed?: ParsedCmd[]): SkillRead | null {
  const fromParsed = parsed?.find((p) => p.type === 'read' && (p.name === 'SKILL.md' || p.path?.endsWith('SKILL.md')));
  const pathMatch = /((?:~|\/|\.{1,2}\/|[\w.-]+\/)[^\s'"`;|&]*SKILL\.md)\b/.exec(cmd);
  const path = fromParsed?.path ?? pathMatch?.[1];
  if (!path) return null;
  // Any command touching a SKILL.md counts as a read (cat, sed -n, `rtk read` rewrites, grep …) unless it writes to it.
  const esc = path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (!fromParsed && new RegExp(`(>>?|\\btee\\b(\\s+-a)?)\\s*['"]?${esc}|\\b(sed|perl)\\s+-i\\b`).test(cmd)) return null;
  let lines: [number, number] | undefined;
  const sed = /sed\s+-n\s+['"]?(\d+),(\d+)p/.exec(cmd);
  const head = /head\s+(?:-n\s*)?-?(\d+)/.exec(cmd);
  if (sed) lines = [Number(sed[1]), Number(sed[2])];
  else if (head && cmd.indexOf('head') < cmd.indexOf(path)) lines = [1, Number(head[1])];
  return { path, lines };
}

/** `skill://name` references (orchestrator skills.read). */
export function detectSkillResource(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/skill:\/\/([\w.:-]+)/g)) out.add(m[1]);
  return [...out];
}

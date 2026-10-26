import fs from 'node:fs';
import path from 'node:path';
import { parseListing } from '../../core/skills/detect';
import { normalizeText, parseSkillMd } from '../../core/skills/frontmatter';
import type { SkillEntry } from '../../shared/types';
import { dataPaths } from '../config';
import { renderPromptInput } from '../replay/adapter';
import { workspaceAgent } from '../replay/analyst';
import type { VariantMount } from './overlay';
import { mountName, type Variant } from './variants';

type PromptInputItem = { content?: Array<{ type?: string; text?: string }> };

/**
 * Listing preview: render the model-visible skill catalog with the agent's own
 * `debug prompt-input` (Codex) in an isolated home (no model call) and
 * report how one skill shows up.
 */

export interface SkillLine {
  entry?: SkillEntry;
  full?: string;
  truncated: boolean | null;
  hiddenTail?: string;
}

export interface ListingSnapshot {
  format?: string;
  count: number;
  cap?: number;
  entries: SkillEntry[];
  budgetParity: boolean;
}

export interface PreviewResult {
  skill: string;
  base: SkillLine & { snapshot: ListingSnapshot };
  variant?: SkillLine & { snapshot: ListingSnapshot; name: string };
  /** Other skills whose visible text changed between base and variant (shared budget). */
  othersChanged: Array<{ name: string; before?: string; after?: string }>;
  ms: number;
}

function listingFrom(items: PromptInputItem[]) {
  for (const it of items) {
    for (const c of it.content ?? []) {
      const parsed = c.text ? parseListing(c.text) : null;
      if (parsed) return parsed;
    }
  }
  return null;
}

function lineFor(entries: SkillEntry[], name: string, full: string | undefined): SkillLine {
  const entry = entries.find((e) => e.name === name);
  if (!entry || !full) return { entry, full, truncated: null };
  const v = normalizeText(entry.description);
  const f = normalizeText(full);
  if (v === f) return { entry, full, truncated: false };
  if (f.startsWith(v)) return { entry, full, truncated: true, hiddenTail: f.slice(v.length).trimStart() };
  return { entry, full, truncated: null };
}

function capOf(entries: SkillEntry[], fullByName: (n: string) => string | undefined): number | undefined {
  const lens: number[] = [];
  for (const e of entries) {
    const full = fullByName(e.name);
    if (full && normalizeText(full).length > normalizeText(e.description).length && normalizeText(full).startsWith(normalizeText(e.description))) {
      lens.push(normalizeText(e.description).length);
    }
  }
  if (!lens.length) return undefined;
  lens.sort((a, b) => a - b);
  return lens[Math.floor(lens.length / 2)];
}

export async function render(variants: VariantMount[], prompt: string, cwd?: string) {
  const { adapter, homes } = workspaceAgent();
  const root = path.join(dataPaths.runs, `preview-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`);
  await fs.promises.mkdir(root, { recursive: true, mode: 0o700 });
  const home = await adapter.prepare({ runDir: root, home: homes.home, dataRoot: homes.dataRoot, variants, allowMcp: false });
  try {
    const items = await renderPromptInput(adapter, home, prompt, cwd && fs.existsSync(cwd) ? cwd : root);
    return { listing: listingFrom(items), parity: home.budgetParity };
  } finally {
    await home.cleanup().catch(() => undefined);
    await fs.promises.rm(root, { recursive: true, force: true });
  }
}

export async function previewSkill(opts: {
  skillKey: string;
  baseFull?: string;
  variant?: Variant;
  prompt?: string;
  cwd?: string;
  fullByName: (name: string) => string | undefined;
}): Promise<PreviewResult> {
  const t0 = Date.now();
  const prompt = opts.prompt?.trim() || 'hello';
  const mounts: VariantMount[] = opts.variant ? [{ originalDir: opts.variant.originalPath || undefined, variantDir: opts.variant.dir, name: mountName(opts.variant) }] : [];
  const [base, variant] = await Promise.all([render([], prompt, opts.cwd), opts.variant ? render(mounts, prompt, opts.cwd) : Promise.resolve(undefined)]);
  const baseEntries = base.listing?.entries ?? [];
  const res: PreviewResult = {
    skill: opts.skillKey,
    base: {
      ...lineFor(baseEntries, opts.skillKey, opts.baseFull),
      snapshot: { format: base.listing?.format, count: baseEntries.length, cap: capOf(baseEntries, opts.fullByName), entries: baseEntries, budgetParity: base.parity },
    },
    othersChanged: [],
    ms: 0,
  };
  if (opts.variant && variant) {
    const raw = fs.readFileSync(path.join(opts.variant.dir, 'SKILL.md'), 'utf8');
    const parsed = parseSkillMd(raw);
    const plugin = opts.skillKey.includes(':') ? opts.skillKey.split(':')[0] : undefined;
    const name = parsed.name ? (plugin ? `${plugin}:${parsed.name}` : parsed.name) : opts.skillKey;
    const vEntries = variant.listing?.entries ?? [];
    const full = (n: string) => (n === name ? parsed.description : opts.fullByName(n));
    res.variant = {
      name,
      ...lineFor(vEntries, name, parsed.description),
      snapshot: { format: variant.listing?.format, count: vEntries.length, cap: capOf(vEntries, full), entries: vEntries, budgetParity: variant.parity },
    };
    const before = new Map(baseEntries.map((e) => [e.name, e.description]));
    const after = new Map(vEntries.map((e) => [e.name, e.description]));
    for (const n of new Set([...before.keys(), ...after.keys()])) {
      if (n === opts.skillKey || n === name) continue;
      if (before.get(n) !== after.get(n)) res.othersChanged.push({ name: n, before: before.get(n), after: after.get(n) });
    }
  }
  res.ms = Date.now() - t0;
  return res;
}

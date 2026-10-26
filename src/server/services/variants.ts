import fs from 'node:fs';
import path from 'node:path';
import { parseSkillMd, updateSkillMd } from '../../core/skills/frontmatter';
import { config, dataPaths } from '../config';
import { catalog, findCatalogSkill, sha256, skillHomeRoot } from './catalog';
import { tmDb } from './tmDb';

/**
 * Skill variants: full copies of a skill directory under ~/.kifu/skills,
 * edited in place. The real skill is never touched until an explicit apply.
 */

export interface Variant {
  id: string;
  skillKey: string;
  skillName: string;
  originalPath: string;
  baseHash: string;
  label: string;
  note?: string;
  createdAt: number;
  updatedAt: number;
  dir: string;
}

export interface VariantDetail extends Variant {
  raw: string;
  description?: string;
  body: string;
  baseRaw?: string;
  /** The real SKILL.md changed since the variant was created. */
  baseChanged: boolean;
}

interface VariantRow {
  id: string;
  skill_key: string;
  skill_name: string;
  original_path: string | null;
  base_hash: string;
  label: string | null;
  note: string | null;
  created_at: number;
  updated_at: number;
}

const safe = (s: string) => s.replace(/[^\w.-]+/g, '_');

export function variantDir(skillKey: string, id: string): string {
  return path.join(dataPaths.skills, safe(skillKey), 'variants', id);
}

function fromRow(r: VariantRow): Variant {
  return {
    id: r.id,
    skillKey: r.skill_key,
    skillName: r.skill_name,
    originalPath: r.original_path ?? '',
    baseHash: r.base_hash,
    label: r.label ?? r.id,
    note: r.note ?? undefined,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    dir: variantDir(r.skill_key, r.id),
  };
}

function newId(): string {
  return `v${Date.now().toString(36).slice(-5)}${Math.random().toString(36).slice(2, 5)}`;
}

export function listVariants(skillKey?: string): Variant[] {
  const db = tmDb();
  const rows = (skillKey
    ? db.prepare('select * from variants where skill_key = ? order by created_at').all(skillKey)
    : db.prepare('select * from variants order by created_at').all()) as unknown as VariantRow[];
  return rows.map(fromRow);
}

function real(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

/** Variants of skills installed in the workspace's agent home (the Codex home); others stay stored. */
export function labVariants(skillKey?: string): Variant[] {
  // variants record the skill's real directory; the home may be reached through a symlink (/var → /private/var)
  const roots = [skillHomeRoot(), config.agentsSkillsDir].flatMap((r) => [path.resolve(r), real(r)]).map((r) => r + path.sep);
  return listVariants(skillKey).filter((x) => !x.originalPath || roots.some((r) => (path.resolve(x.originalPath) + path.sep).startsWith(r)));
}

/** Directory name a variant is mounted under: its skill's name (never empty: that would cover the whole skills dir). */
export function mountName(v: Pick<Variant, 'skillName' | 'originalPath' | 'id'>): string {
  const fromSkill = v.skillName.split(':').pop()?.trim();
  return path.basename(v.originalPath || '') || fromSkill || `skill-${v.id}`;
}

export function getVariant(id: string): Variant | undefined {
  const row = tmDb().prepare('select * from variants where id = ?').get(id) as unknown as VariantRow | undefined;
  return row ? fromRow(row) : undefined;
}

export function variantDetail(v: Variant): VariantDetail {
  const raw = fs.readFileSync(path.join(v.dir, 'SKILL.md'), 'utf8');
  const parsed = parseSkillMd(raw);
  let baseRaw: string | undefined;
  try {
    // a brand-new skill (not installed) has no original
    baseRaw = v.originalPath ? fs.readFileSync(path.join(v.originalPath, 'SKILL.md'), 'utf8') : undefined;
  } catch {
    baseRaw = undefined;
  }
  return { ...v, raw, description: parsed.description, body: parsed.body, baseRaw, baseChanged: baseRaw !== undefined && sha256(baseRaw) !== v.baseHash };
}

export interface VariantEdit {
  raw?: string;
  description?: string;
  body?: string;
  label?: string;
  note?: string;
}

function applyEdit(dir: string, edit: VariantEdit): void {
  const file = path.join(dir, 'SKILL.md');
  if (edit.raw !== undefined) {
    fs.writeFileSync(file, edit.raw);
    return;
  }
  if (edit.description === undefined && edit.body === undefined) return;
  const current = fs.readFileSync(file, 'utf8');
  fs.writeFileSync(file, updateSkillMd(current, { description: edit.description, body: edit.body }));
}

export async function createVariant(skillKey: string, edit: VariantEdit & { fromVariant?: string }): Promise<Variant> {
  const skill = findCatalogSkill(skillKey);
  if (!skill) throw new Error(`找不到 skill ${skillKey}`);
  return copyVariant({ skillKey, skillName: skill.name, realDir: skill.realDir, hash: skill.hash }, edit);
}

async function copyVariant(skill: { skillKey: string; skillName: string; realDir: string; hash: string }, edit: VariantEdit & { fromVariant?: string }): Promise<Variant> {
  const skillKey = skill.skillKey;
  const id = newId();
  const dir = variantDir(skillKey, id);
  await fs.promises.mkdir(path.dirname(dir), { recursive: true, mode: 0o700 });
  const source = edit.fromVariant ? getVariant(edit.fromVariant)?.dir : skill.realDir;
  if (!source) throw new Error('来源变体不存在');
  const filter = (src: string) => !src.includes(`${path.sep}.git${path.sep}`) && !src.endsWith(`${path.sep}.git`);
  try {
    await fs.promises.cp(source, dir, { recursive: true, mode: fs.constants.COPYFILE_FICLONE, verbatimSymlinks: true, filter });
  } catch {
    await fs.promises.rm(dir, { recursive: true, force: true });
    await fs.promises.cp(source, dir, { recursive: true, verbatimSymlinks: true, filter });
  }
  applyEdit(dir, edit);
  const now = Date.now();
  const count = (tmDb().prepare('select count(*) as n from variants where skill_key = ?').get(skillKey) as { n: number }).n;
  const label = edit.label ?? `B${count + 1}`;
  tmDb()
    .prepare('insert into variants (id, skill_key, skill_name, original_path, base_hash, label, note, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, skillKey, skill.skillName, skill.realDir, skill.hash, label, edit.note ?? null, now, now);
  return getVariant(id)!;
}

/** Names a skill directory can have (the agents list skills by it). */
export const SKILL_NAME = /^[a-z0-9][a-z0-9-]{1,62}$/;

/** A variant of a skill that does not exist yet: mounted next to the others in replays, installed by "apply". */
export async function createNewSkillVariant(name: string, raw: string, o: { label?: string; note?: string } = {}): Promise<Variant> {
  if (!SKILL_NAME.test(name)) throw new Error('skill 名称只能用小写字母、数字和连字符（2–63 个字符）');
  if (catalog(true).some((s) => s.key === name || s.name === name)) throw new Error(`已经有叫 ${name} 的 skill`);
  const id = newId();
  const dir = variantDir(name, id);
  await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), raw);
  const now = Date.now();
  const count = (tmDb().prepare('select count(*) as n from variants where skill_key = ?').get(name) as { n: number }).n;
  tmDb()
    .prepare('insert into variants (id, skill_key, skill_name, original_path, base_hash, label, note, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, name, name, null, '', o.label ?? `新 ${count + 1}`, o.note ?? null, now, now);
  return getVariant(id)!;
}

export function updateVariant(id: string, edit: VariantEdit): Variant {
  const v = getVariant(id);
  if (!v) throw new Error('变体不存在');
  applyEdit(v.dir, edit);
  tmDb()
    .prepare('update variants set label = coalesce(?, label), note = coalesce(?, note), updated_at = ? where id = ?')
    .run(edit.label ?? null, edit.note ?? null, Date.now(), id);
  return getVariant(id)!;
}

export async function deleteVariant(id: string): Promise<void> {
  const v = getVariant(id);
  if (!v) return;
  await fs.promises.rm(v.dir, { recursive: true, force: true });
  tmDb().prepare('delete from variants where id = ?').run(id);
}

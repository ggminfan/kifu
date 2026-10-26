import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { parseSkillMd } from '../../core/skills/frontmatter';
import { config } from '../config';
import { claudeHomeDefault } from '../sources/claude';
import { codexHomeDefault } from '../sources/codex';
import { currentAgent, sources } from '../sources/registry';
import { skillUsage } from './indexer';

/**
 * Skill catalog of the workspace's agent install, mirroring its discovery order:
 * <home>/skills (r0) > ~/.agents/skills > <home>/skills/.system > plugin caches,
 * where <home> is CODEX_HOME (or Claude Code's config dir). Same-named skills
 * are shadowed by the earlier root, like the agents' own dedup.
 */

/** The agent home whose skills a workspace edits: the Codex home, or Claude Code's config dir. */
export function skillHomeRoot(): string {
  if (currentAgent() === 'codex') return sources().find((s) => s.agent === 'codex')?.home ?? codexHomeDefault() ?? path.join(config.homeDir, '.codex');
  // a Claude Code source is <config dir>/projects/<project>
  const project = sources().find((s) => s.agent === 'claude')?.home;
  return project ? path.dirname(path.dirname(project)) : (claudeHomeDefault() ?? path.join(config.homeDir, '.claude'));
}

export type SkillSource = 'user' | 'agents' | 'system' | 'plugin';

export interface CatalogSkill {
  /** Stable key: the listing name (`name` or `plugin:name`). */
  key: string;
  name: string;
  source: SkillSource;
  plugin?: string;
  marketplace?: string;
  /** Directory as discovered (may be a symlink). */
  dir: string;
  realDir: string;
  file: string;
  description?: string;
  descriptionChars: number;
  hash: string;
  mtimeMs: number;
  lines: number;
  /** Can we write back to it? Plugin and system skills are managed by the agent. */
  writable: boolean;
  shadowedBy?: string;
  sessionsUsed: number;
}

export function sha256(s: string | Buffer): string {
  return createHash('sha256').update(s).digest('hex');
}

function readdirSafe(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

function skillAt(dir: string, key: string, name: string, source: SkillSource, extra: Partial<CatalogSkill> = {}): CatalogSkill | undefined {
  const file = path.join(dir, 'SKILL.md');
  let raw: string;
  let st: fs.Stats;
  try {
    st = fs.statSync(file);
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
  const parsed = parseSkillMd(raw);
  let realDir = dir;
  try {
    realDir = fs.realpathSync(dir);
  } catch {
    // keep as is
  }
  return {
    key,
    name,
    source,
    dir,
    realDir,
    file: path.join(realDir, 'SKILL.md'),
    description: parsed.description,
    descriptionChars: parsed.description?.length ?? 0,
    hash: sha256(raw),
    mtimeMs: st.mtimeMs,
    lines: raw.split('\n').length,
    writable: source === 'user' || source === 'agents',
    sessionsUsed: 0,
    ...extra,
  };
}

/** The plugin version in use: the one marked in .active-version, else the installed one (the newest). */
function activeVersion(pluginDir: string): string | undefined {
  try {
    const v = fs.readFileSync(path.join(pluginDir, '.active-version'), 'utf8').trim();
    if (v && fs.existsSync(path.join(pluginDir, v))) return v;
  } catch {
    // no marker
  }
  const dirs = readdirSafe(pluginDir).filter((d) => !d.startsWith('.') && fs.existsSync(path.join(pluginDir, d, 'skills')));
  return dirs.sort((a, b) => fs.statSync(path.join(pluginDir, b)).mtimeMs - fs.statSync(path.join(pluginDir, a)).mtimeMs)[0];
}

let cached: { at: number; home: string; list: CatalogSkill[] } | undefined;

export function catalog(force = false): CatalogSkill[] {
  const home = skillHomeRoot();
  // keyed by home: the workspace's sources can change
  if (!force && cached && cached.home === home && Date.now() - cached.at < 5000) return cached.list;
  const out: CatalogSkill[] = [];
  const byKey = new Map<string, CatalogSkill>();
  const add = (s: CatalogSkill | undefined) => {
    if (!s) return;
    const prev = byKey.get(s.key);
    if (prev) {
      if (prev.realDir !== s.realDir) out.push({ ...s, shadowedBy: prev.dir });
      return;
    }
    byKey.set(s.key, s);
    out.push(s);
  };
  const userRoot = path.join(home, 'skills');
  for (const n of readdirSafe(userRoot)) {
    if (n.startsWith('.')) continue;
    const dir = path.join(userRoot, n);
    let real = dir;
    try {
      real = fs.realpathSync(dir);
    } catch {
      continue;
    }
    add(skillAt(dir, n, n, real.startsWith(config.agentsSkillsDir) ? 'agents' : 'user'));
  }
  // Claude Code reads neither ~/.agents/skills nor a .system dir
  const claude = currentAgent() === 'claude';
  for (const n of claude ? [] : readdirSafe(config.agentsSkillsDir)) {
    if (n.startsWith('.')) continue;
    add(skillAt(path.join(config.agentsSkillsDir, n), n, n, 'agents'));
  }
  const sysRoot = path.join(userRoot, '.system');
  for (const n of claude ? [] : readdirSafe(sysRoot)) {
    if (n.startsWith('.')) continue;
    add(skillAt(path.join(sysRoot, n), n, n, 'system'));
  }
  const cacheRoot = path.join(home, 'plugins', 'cache');
  for (const market of readdirSafe(cacheRoot)) {
    for (const plugin of readdirSafe(path.join(cacheRoot, market))) {
      const pdir = path.join(cacheRoot, market, plugin);
      const v = activeVersion(pdir);
      if (!v) continue;
      const sroot = path.join(pdir, v, 'skills');
      for (const n of readdirSafe(sroot)) {
        if (n.startsWith('.')) continue;
        add(skillAt(path.join(sroot, n), `${plugin}:${n}`, `${plugin}:${n}`, 'plugin', { plugin, marketplace: market }));
      }
    }
  }
  const usage = new Map(skillUsage().map((u) => [u.skill, u.sessions]));
  for (const s of out) s.sessionsUsed = usage.get(s.key) ?? 0;
  out.sort((a, b) => Number(Boolean(a.shadowedBy)) - Number(Boolean(b.shadowedBy)) || b.sessionsUsed - a.sessionsUsed || a.key.localeCompare(b.key));
  cached = { at: Date.now(), home, list: out };
  return out;
}

export function findCatalogSkill(key: string): CatalogSkill | undefined {
  return catalog().find((s) => s.key === key && !s.shadowedBy) ?? catalog(true).find((s) => s.key === key && !s.shadowedBy);
}

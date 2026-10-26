import fs from 'node:fs';
import path from 'node:path';
import type { DiskLookup, DiskSkill } from '../../core/analysis/skills';
import { parseSkillMd } from '../../core/skills/frontmatter';
import { config } from '../config';
import { claudeHomeDefault } from '../sources/claude';
import { codexHomeDefault } from '../sources/codex';
import { currentAgent, sourceById, sources } from '../sources/registry';
import { getSession, sourceIdOf } from './stateDb';

/** SKILL.md reads with an (mtime, size) cache. */

const cache = new Map<string, { key: string; data: DiskSkill }>();

export function skillFileOf(p: string): string {
  const expanded = p.startsWith('~/') ? path.join(config.homeDir, p.slice(2)) : p;
  return /SKILL\.md$/i.test(expanded) ? expanded : path.join(expanded, 'SKILL.md');
}

export function readDiskSkill(p: string | undefined): DiskSkill | undefined {
  if (!p) return undefined;
  const file = skillFileOf(p);
  let st: fs.Stats;
  try {
    st = fs.statSync(file);
  } catch {
    return undefined;
  }
  const key = `${st.size}:${st.mtimeMs}`;
  const hit = cache.get(file);
  if (hit?.key === key) return hit.data;
  const raw = fs.readFileSync(file, 'utf8');
  const parsed = parseSkillMd(raw);
  const data: DiskSkill = { path: file, description: parsed.description, body: parsed.body, lines: raw.split('\n').length };
  cache.set(file, { key, data });
  return data;
}

function activeVersionDir(pluginDir: string): string | undefined {
  try {
    const v = fs.readFileSync(path.join(pluginDir, '.active-version'), 'utf8').trim();
    if (v && fs.existsSync(path.join(pluginDir, v))) return path.join(pluginDir, v);
  } catch {
    // no marker
  }
  return undefined;
}

/** The newest version dir of a plugin without an .active-version marker (Claude Code). */
function newestVersionDir(pluginDir: string): string | undefined {
  try {
    const dirs = fs
      .readdirSync(pluginDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => path.join(pluginDir, d.name));
    return dirs.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
  } catch {
    return undefined;
  }
}

/** Where an agent installs skills: plain skill roots, and the plugin cache (<market>/<plugin>/<version>/skills). */
export interface SkillHome {
  roots: string[];
  pluginCache: string;
}

/** The skills of the home a session ran with (its CODEX_HOME, or Claude Code's config dir and project). */
export function sessionSkillHome(sessionId: string): SkillHome {
  const src = sourceById(sourceIdOf(sessionId) ?? '');
  if (currentAgent() === 'claude') {
    // a Claude Code source is <config dir>/projects/<project>
    const dir = src ? path.dirname(path.dirname(src.home)) : (claudeHomeDefault() ?? path.join(config.homeDir, '.claude'));
    const cwd = getSession(sessionId)?.cwd;
    return { roots: [path.join(dir, 'skills'), ...(cwd ? [path.join(cwd, '.claude', 'skills')] : [])], pluginCache: path.join(dir, 'plugins', 'cache') };
  }
  // a session whose source is gone: the workspace's Codex home
  const home = src?.home ?? sources().find((s) => s.agent === 'codex')?.home ?? codexHomeDefault() ?? path.join(config.homeDir, '.codex');
  return { roots: [path.join(home, 'skills'), config.agentsSkillsDir, path.join(home, 'skills', '.system')], pluginCache: path.join(home, 'plugins', 'cache') };
}

/** Best-effort path for a skill name (`name` or `plugin:name`) in a skill home. */
export function findSkillByName(name: string, home: SkillHome): string | undefined {
  const [plugin, skill] = name.includes(':') ? name.split(':', 2) : [undefined, name];
  if (!plugin) {
    for (const root of home.roots) {
      const f = path.join(root, skill, 'SKILL.md');
      if (fs.existsSync(f)) return f;
    }
    return undefined;
  }
  let markets: string[] = [];
  try {
    markets = fs.readdirSync(home.pluginCache);
  } catch {
    return undefined;
  }
  for (const m of markets) {
    const pluginDir = path.join(home.pluginCache, m, plugin);
    const dir = activeVersionDir(pluginDir) ?? newestVersionDir(pluginDir);
    if (!dir) continue;
    const f = path.join(dir, 'skills', skill, 'SKILL.md');
    if (fs.existsSync(f)) return f;
  }
  return undefined;
}

/** Skill files as a session saw them: the path it recorded, else the name in its own home. */
export function diskLookupFor(sessionId: string): DiskLookup {
  const home = sessionSkillHome(sessionId);
  return (p, name) => readDiskSkill(p) ?? readDiskSkill(findSkillByName(name, home));
}

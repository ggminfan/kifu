import fsc from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { AgentModel } from '../../shared/replay';
import { config } from '../config';
import { allocSameLengthDir, cloneEntry, homeSkillFiles, markOverlay, stripTomlKeys } from '../services/overlay';
import { CODEX_VOLATILE } from '../services/writeGuard';
import { freshExecArgv, modelArgs, registerAdapter, runQuick, type ReplayAdapter } from './adapter';

/**
 * Codex replays run with CODEX_HOME pointing at an isolated home:
 * - at a path as long as the real one (the skill list holds CODEX_HOME paths
 *   and is cut to a fixed budget, so a longer path shortens every description);
 * - config.toml cloned without `notify` (it runs a program when a turn ends)
 *   and, unless allowed, without the MCP servers; hooks are disabled;
 * - auth.json linked (a token refresh writes the user's own file), skills
 *   linked one by one so variants can replace single skills;
 * - fresh sessions and databases. After the run the transcripts move to the
 *   run dir and the home is deleted.
 */

const CLONE = ['AGENTS.md', 'rules', 'plugins', 'models_cache.json', 'version.json', 'installation_id'];

function codexEnv(home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.CODEX_HOME;
  env.CODEX_HOME = home;
  return env;
}

async function realpathOrUndefined(p: string): Promise<string | undefined> {
  return fs.realpath(p).catch(() => undefined);
}

async function readdirSafe(dir: string): Promise<fsc.Dirent[]> {
  return fs.readdir(dir, { withFileTypes: true }).catch(() => []);
}

export const codexAdapter: ReplayAdapter = {
  agent: 'codex',
  bin: () => config.codexBin,

  async version() {
    if (!config.codexBin) return undefined;
    const res = await runQuick(config.codexBin, ['--version']);
    return res.code === 0 ? res.stdout.trim() || undefined : undefined;
  },

  async models({ home }) {
    if (!config.codexBin) return [];
    const res = await runQuick(config.codexBin, ['debug', 'models'], codexEnv(home));
    if (res.code !== 0) return [];
    try {
      const j = JSON.parse(res.stdout) as {
        models?: Array<{ slug?: string; display_name?: string; description?: string; visibility?: string; default_reasoning_level?: string; supported_reasoning_levels?: Array<{ effort?: string } | string> }>;
      };
      return (j.models ?? []).flatMap((m): AgentModel[] =>
        m.slug && m.visibility !== 'hide'
          ? [
              {
                id: m.slug,
                label: m.display_name ?? m.slug,
                description: m.description,
                efforts: (m.supported_reasoning_levels ?? []).map((l) => (typeof l === 'string' ? l : (l.effort ?? ''))).filter(Boolean),
                defaultEffort: m.default_reasoning_level,
              },
            ]
          : [],
      );
    } catch {
      return [];
    }
  },

  async prepare(o) {
    const notes: string[] = [];
    const real = o.home;
    const { dir: home, parity } = await allocSameLengthDir(real.length, path.join(o.runDir, 'codex-home'));
    if (!parity) notes.push('无法分配与真实 CODEX_HOME 等长的路径，skill 列表的截断预算可能与真实环境略有不同');
    try {
      if (parity) await markOverlay(home);
      // analysts get the login and the model catalog, nothing that steers them
      for (const name of o.bare ? ['models_cache.json', 'version.json', 'installation_id'] : CLONE) {
        if (fsc.existsSync(path.join(real, name))) await cloneEntry(path.join(real, name), path.join(home, name));
      }
      if (fsc.existsSync(path.join(real, 'auth.json'))) await fs.symlink(path.join(real, 'auth.json'), path.join(home, 'auth.json'));

      // skills: link each one, mount variants as real directories, disable what they replace
      const disable = new Set<string>();
      const skills = path.join(home, 'skills');
      await fs.mkdir(skills, { recursive: true });
      const byReal = new Map<string, (typeof o.variants)[number]>();
      for (const v of o.variants) {
        const r = v.originalDir ? await realpathOrUndefined(v.originalDir) : undefined;
        if (r) byReal.set(r, v);
      }
      const pending = new Set(o.variants);
      // ~/.agents/skills are found through $HOME whatever CODEX_HOME is: switch them off
      if (o.bare) for (const f of await homeSkillFiles([config.agentsSkillsDir])) disable.add(f);
      for (const ent of o.bare ? [] : await readdirSafe(path.join(real, 'skills'))) {
        const src = path.join(real, 'skills', ent.name);
        const dst = path.join(skills, ent.name);
        if (ent.name.startsWith('.')) {
          await cloneEntry(src, dst);
          continue;
        }
        const r = await realpathOrUndefined(src);
        if (!r) continue;
        const v = byReal.get(r);
        if (v) {
          await cloneEntry(v.variantDir, dst);
          pending.delete(v);
          disable.add(path.join(r, 'SKILL.md'));
          notes.push(`变体 ${v.name} 挂载到 skills/${ent.name}`);
        } else {
          await fs.symlink(r, dst);
        }
      }
      for (const v of pending) {
        const name = v.name || path.basename(v.originalDir ?? v.variantDir);
        const dst = path.join(skills, name);
        await fs.rm(dst, { recursive: true, force: true });
        await cloneEntry(v.variantDir, dst);
        if (v.originalDir) disable.add(path.join((await realpathOrUndefined(v.originalDir)) ?? v.originalDir, 'SKILL.md'));
        notes.push(`变体 ${name} 挂载到 skills/${name}`);
      }

      let toml = await fs.readFile(path.join(real, 'config.toml'), 'utf8').catch(() => '');
      toml = stripTomlKeys(
        toml,
        o.bare ? ['notify', 'mcp_servers', 'plugins', 'skills', 'hooks'] : ['notify', ...(o.allowMcp ? [] : ['mcp_servers'])],
      );
      if (disable.size) {
        const blocks = [...disable].map((p) => `[[skills.config]]\npath = ${JSON.stringify(p)}\nenabled = false\n`);
        toml = `${toml.trimEnd()}\n\n# --- added by Kifu replay ---\n${blocks.join('\n')}`;
      }
      await fs.writeFile(path.join(home, 'config.toml'), toml, { mode: 0o600 });
      await fs.mkdir(path.join(home, 'sessions'), { recursive: true });
    } catch (e) {
      await fs.rm(home, { recursive: true, force: true });
      throw e;
    }

    const sessionsDir = path.join(home, 'sessions');
    const kept = path.join(o.runDir, 'sessions');
    return {
      sessionsDir,
      env: codexEnv(home),
      budgetParity: parity,
      pathMap: [[home, real]],
      notes,
      async cleanup() {
        await fs.rm(kept, { recursive: true, force: true });
        try {
          await fs.rename(sessionsDir, kept);
        } catch {
          await fs.cp(sessionsDir, kept, { recursive: true });
        }
        await fs.rm(home, { recursive: true, force: true });
        return (f) => (f.startsWith(`${sessionsDir}${path.sep}`) ? path.join(kept, path.relative(sessionsDir, f)) : f);
      },
      authLinked: async () => (await fs.lstat(path.join(home, 'auth.json')).catch(() => undefined))?.isSymbolicLink() ?? true,
    };
  },

  freshArgv: freshExecArgv,
  mention: (key) => `$${key}`,

  argv: (o) => [
    'exec', '-s', o.sandbox, '-C', o.cwd, 'resume', o.newId,
    '--json', '--skip-git-repo-check', '-c', 'approval_policy="never"', '--disable', 'hooks',
    ...modelArgs(o.model, o.effort),
    '-',
  ],

  guardRoots: ({ home }) => [
    { label: 'codex', dir: home, volatile: CODEX_VOLATILE },
    { label: 'agents-skills', dir: config.agentsSkillsDir },
  ],
};

registerAdapter(codexAdapter);

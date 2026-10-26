import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AgentKind } from '../shared/agents';

const home = os.homedir();

function which(bin: string): string | undefined {
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue;
    const p = path.join(dir, bin);
    try {
      // a broken install can leave a non-executable stub on PATH
      if (!fs.statSync(p).isFile()) continue;
      fs.accessSync(p, fs.constants.X_OK);
      return p;
    } catch {
      // keep looking
    }
  }
  return undefined;
}

const defaultTmHome = process.env.KIFU_HOME ?? path.join(home, '.kifu');

/**
 * Our own data dir and the agent CLIs we run. Values are read at call time
 * everywhere, so `configure()` (CLI flags) can adjust them before the server
 * starts. KIFU_* variables are the defaults.
 */
export const config = {
  host: '127.0.0.1',
  port: Number(process.env.KIFU_PORT ?? 7788),
  homeDir: home,
  tmHome: defaultTmHome,
  agentsSkillsDir: path.join(home, '.agents', 'skills'),
  /** Codex CLI for replays (Codex workspaces) and analysts. */
  codexBin: process.env.CODEX_BIN ?? which('codex'),
  /** Shown in the UI header, e.g. "本机" or "user@host". */
  label: process.env.KIFU_LABEL ?? '本机',
  /** Directory with the built web UI (optional). */
  webDir: undefined as string | undefined,
};

export const dataPaths = {
  db: '',
  cache: '',
  skills: '',
  runs: '',
  jobs: '',
  backups: '',
  cases: '',
};

function setDataPaths(tmHome: string): void {
  Object.assign(dataPaths, {
    db: path.join(tmHome, 'kifu.sqlite'),
    cache: path.join(tmHome, 'cache'),
    skills: path.join(tmHome, 'skills'),
    runs: path.join(tmHome, 'runs'),
    jobs: path.join(tmHome, 'jobs'),
    backups: path.join(tmHome, 'backups'),
    cases: path.join(tmHome, 'cases'),
  });
}
setDataPaths(config.tmHome);

function expandHome(p: string): string {
  return p === '~' ? home : p.startsWith('~/') ? path.join(home, p.slice(2)) : p;
}

export interface ConfigOverrides {
  /** codex or claude: each agent's workspaces keep their data apart. */
  agent?: AgentKind;
  dataDir?: string;
  webDir?: string;
  label?: string;
  host?: string;
  port?: number;
}

export function configure(o: ConfigOverrides): void {
  config.tmHome = o.dataDir ? path.resolve(expandHome(o.dataDir)) : o.agent ? path.join(defaultTmHome, 'agents', o.agent) : config.tmHome;
  setDataPaths(config.tmHome);
  if (o.webDir) config.webDir = path.resolve(o.webDir);
  if (o.label) config.label = o.label;
  if (o.host) config.host = o.host;
  if (o.port !== undefined) config.port = o.port;
}

export function ensureDataDirs(): void {
  fs.mkdirSync(config.tmHome, { recursive: true, mode: 0o700 });
  fs.chmodSync(config.tmHome, 0o700);
  for (const dir of Object.values(dataPaths)) {
    if (dir.endsWith('.sqlite')) continue;
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
}

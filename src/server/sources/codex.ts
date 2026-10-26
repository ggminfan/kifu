import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** The Codex home ($CODEX_HOME or ~/.codex): its thread index (state_5.sqlite) and sessions/. */
export function codexHomeDefault(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const dir = env.CODEX_HOME || path.join(os.homedir(), '.codex');
  return fs.existsSync(path.join(dir, 'state_5.sqlite')) || fs.existsSync(path.join(dir, 'sessions')) ? dir : undefined;
}

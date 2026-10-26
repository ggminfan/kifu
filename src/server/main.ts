import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve, ServeError } from './serve';

/**
 * Development entry (`pnpm dev` / `pnpm start`): fixed port, no token, serves
 * dist/web when it exists. The desktop shell and remotes use cli.ts instead.
 */
const webDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../dist/web');

// Codex sessions; KIFU_AGENT=claude shows Claude Code's instead (KIFU_ROOTS=a,b: scan these directories for the agent's homes)
const agent = process.env.KIFU_AGENT === 'claude' ? 'claude' : 'codex';
serve({
  port: Number(process.env.KIFU_PORT ?? 7788),
  noAuth: true,
  agent,
  roots: process.env.KIFU_ROOTS?.split(',').filter(Boolean),
  webDir: fs.existsSync(webDir) ? webDir : undefined,
}).catch((e) => {
  if (e instanceof ServeError) {
    console.error(`\n${e.message}\n`);
    process.exit(1);
  }
  throw e;
});

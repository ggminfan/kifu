import { Worker } from 'node:worker_threads';
import { IS_COMPILED } from '../build-info';
import { isBun } from './listen';

/**
 * Parse workers.
 * - Compiled binary: the worker is an extra entrypoint of `bun build --compile`,
 *   embedded at <bunfs root>/workers/parseWorker.js (paths are relative to the
 *   entrypoints' common directory, src/server), and import.meta.url is the
 *   bundle's own URL in that root. A bare relative path must not be used: Bun
 *   falls back to loading it from disk relative to the cwd, which only works
 *   when the cwd happens to be the repo.
 * - Bun from source: load the TypeScript entry directly.
 * - Node (pnpm dev): tsx bootstrap in boot.mjs.
 */
export function spawnParseWorker(): Worker {
  if (IS_COMPILED) return new Worker(new URL('./workers/parseWorker.ts', import.meta.url));
  if (isBun) return new Worker(new URL('../workers/parseWorker.ts', import.meta.url));
  const entry = new URL('../workers/parseWorker.ts', import.meta.url).href;
  return new Worker(new URL('../workers/boot.mjs', import.meta.url), { workerData: { entry } });
}

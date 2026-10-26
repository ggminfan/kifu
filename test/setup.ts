import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll } from 'vitest';

/**
 * Every test file runs with a throwaway HOME, and without the agents' home
 * variables: code that falls back to the user's own agent homes (~/.codex,
 * ~/.claude, ~/.agents/skills) or data dir (~/.kifu) finds an empty
 * directory instead of the real ones.
 */
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kifu-home-'));
process.env.HOME = home;
for (const key of ['CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'KIFU_HOME', 'KIFU_DESKTOP_STORE']) delete process.env[key];

afterAll(() => fs.rmSync(home, { recursive: true, force: true }));

import { spawn } from 'node:child_process';
import type { AgentKind } from '../../shared/agents';
import type { AgentModel } from '../../shared/replay';
import type { VariantMount } from '../services/overlay';
import type { GuardRoot } from '../services/writeGuard';

/**
 * What a replay needs from an agent CLI: an isolated home that looks like the
 * user's (same config, skills, login), where the copy of the session goes, and
 * how to resume it (`codex exec … resume <id> --json -`).
 */

export interface PrepareOptions {
  runDir: string;
  /** The real home the session came from (CODEX_HOME) and its data dir (the same). */
  home: string;
  dataRoot: string;
  variants: VariantMount[];
  allowMcp: boolean;
  /** Analysts: no skills, plugins, AGENTS.md or memories — only the login. */
  bare?: boolean;
}

export interface ReplayHome {
  /** Where rollouts live in the isolated home (the copy goes below it). */
  sessionsDir: string;
  env: NodeJS.ProcessEnv;
  /** Skill catalogs keep their budget only when the isolated home path is as long as the real one. */
  budgetParity: boolean;
  /** Isolated paths → the real ones they stand for (to compare requests with the original). */
  pathMap: Array<[string, string]>;
  notes: string[];
  /**
   * After the run: delete what holds config or credentials. Returns where a
   * file below `sessionsDir` ended up (Codex moves its transcripts out of /tmp).
   */
  cleanup(): Promise<(file: string) => string>;
  /** Is the login still a link to the user's own file (a token refresh wrote through it)? */
  authLinked(): Promise<boolean>;
}

export interface ResumeArgs {
  newId: string;
  cwd: string;
  sandbox: 'read-only' | 'workspace-write';
  model?: string;
  effort?: string;
}

export interface FreshArgs {
  cwd: string;
  sandbox: 'read-only' | 'workspace-write';
  model?: string;
  effort?: string;
  keepHooks?: boolean;
  /** Analysts: leave no session behind, write the last message here. */
  ephemeral?: boolean;
  outputFile?: string;
}

export interface ReplayAdapter {
  agent: AgentKind;
  bin(): string | undefined;
  version(): Promise<string | undefined>;
  models(o: { home: string; dataRoot: string }): Promise<AgentModel[]>;
  prepare(o: PrepareOptions): Promise<ReplayHome>;
  /** argv for resuming the copy; the prompt goes to stdin. */
  argv(o: ResumeArgs): string[];
  /** argv for a new session (Skill Lab trial runs, analysts); the prompt goes to stdin. */
  freshArgv(o: FreshArgs): string[];
  /** How a skill is mentioned in a prompt to force it (content tests). */
  mention(skillKey: string): string;
  /** The user's real directories that a replay must not change. */
  guardRoots(o: { home: string; dataRoot: string }): GuardRoot[];
}

/** `exec` for a new session. */
export function freshExecArgv(o: FreshArgs): string[] {
  return [
    'exec', '--json', '--skip-git-repo-check', '-c', 'approval_policy="never"', '-s', o.sandbox, '-C', o.cwd,
    ...(o.keepHooks ? [] : ['--disable', 'hooks']),
    ...(o.ephemeral ? ['--ephemeral'] : []),
    ...(o.outputFile ? ['-o', o.outputFile] : []),
    ...modelArgs(o.model, o.effort),
    '-',
  ];
}

/** The model-visible input of a new session rendered offline (`debug prompt-input`, no model call). */
export async function renderPromptInput(adapter: ReplayAdapter, home: ReplayHome, prompt: string, cwd: string): Promise<Array<{ type?: string; role?: string; content?: Array<{ type?: string; text?: string }> }>> {
  const bin = adapter.bin();
  if (!bin) throw new Error(`本机没有找到 ${adapter.agent} 命令行`);
  const res = await runQuick(bin, ['debug', 'prompt-input', prompt], home.env, 60_000, cwd);
  if (res.code !== 0) throw new Error(`${adapter.agent} debug prompt-input 失败（${res.code}）：${res.stderr.slice(-300)}`);
  return JSON.parse(res.stdout) as Array<{ type?: string; role?: string; content?: Array<{ type?: string; text?: string }> }>;
}

/** Run a CLI to completion (no stdin), bounded output and time; for version and model lists. */
export function runQuick(bin: string, args: string[], env: NodeJS.ProcessEnv = process.env, timeoutMs = 30_000, cwd?: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(bin, args, { env, cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      resolve({ code: null, stdout: '', stderr: (e as Error).message });
      return;
    }
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', (b: Buffer) => {
      if (stdout.length < 8_000_000) stdout += b.toString('utf8');
    });
    child.stderr.on('data', (b: Buffer) => {
      stderr = (stderr + b.toString('utf8')).slice(-4000);
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr: `${stderr}\n${e.message}` });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

/** `-m` and the reasoning effort. */
export function modelArgs(model?: string, effort?: string): string[] {
  return [...(model ? ['-m', model] : []), ...(effort ? ['-c', `model_reasoning_effort="${effort.replace(/[^\w-]/g, '')}"`] : [])];
}

const adapters = new Map<AgentKind, ReplayAdapter>();

export function registerAdapter(a: ReplayAdapter): void {
  adapters.set(a.agent, a);
}

export function adapterFor(agent: AgentKind): ReplayAdapter | undefined {
  return adapters.get(agent);
}

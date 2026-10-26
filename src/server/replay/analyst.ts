import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { skillHomeRoot } from '../services/catalog';
import { codexHomeDefault } from '../sources/codex';
import { currentAgent } from '../sources/registry';
import { adapterFor, type ReplayAdapter } from './adapter';
import './codex';

/** The real home a workspace's own runs start from: the Codex home. Claude Code has none (no runs). */
export function workspaceHomes(): { home: string; dataRoot: string } | undefined {
  const agent = currentAgent();
  if (agent === 'codex') {
    const home = skillHomeRoot();
    return { home, dataRoot: home };
  }
  return undefined;
}

/** The workspace's agent CLI, ready to run (or why not). */
export function workspaceAgent(): { adapter: ReplayAdapter; bin: string; homes: { home: string; dataRoot: string } } {
  const agent = currentAgent();
  const adapter = adapterFor(agent);
  const bin = adapter?.bin();
  const homes = workspaceHomes();
  if (!adapter || !homes) throw new Error(`${agent} 工作区不能运行 agent`);
  if (!bin) throw new Error(`本机没有找到 ${agent} 命令行`);
  return { adapter, bin, homes };
}

/** Who analyzes: the workspace's own agent; a Claude Code workspace borrows Codex when it is installed. */
function analystAgent(): { adapter: ReplayAdapter; bin: string; homes: { home: string; dataRoot: string } } {
  if (currentAgent() !== 'claude') return workspaceAgent();
  const codex = adapterFor('codex');
  const codexHome = codexHomeDefault();
  if (codex?.bin() && codexHome) return { adapter: codex, bin: codex.bin()!, homes: { home: codexHome, dataRoot: codexHome } };
  throw new Error('需要本机装有 codex 才能分析（用它的登录）');
}

export interface AnalystResult {
  text: string;
  usage?: { input_tokens?: number; output_tokens?: number };
}

function run(bin: string, args: string[], env: NodeJS.ProcessEnv, cwd: string, input: string, timeoutMs: number): Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.stdin.on('error', () => undefined);
    child.stdin.end(input);
    child.stdout.on('data', (b: Buffer) => {
      if (stdout.length < 16_000_000) stdout += b.toString('utf8');
    });
    child.stderr.on('data', (b: Buffer) => {
      stderr = (stderr + b.toString('utf8')).slice(-8000);
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });
  });
}

/**
 * One model call by the workspace's own agent CLI as an analyst: a bare home
 * (no skills, plugins, AGENTS.md, MCP or hooks — only the login), read-only,
 * ephemeral. The instructions and then the material go to stdin, so nothing
 * of the user's data shows up in the process list.
 */
export async function runAnalyst(o: { jobDir: string; instructions: string; input: string; timeoutMs?: number }): Promise<AnalystResult> {
  const { adapter, bin, homes } = analystAgent();
  fs.mkdirSync(o.jobDir, { recursive: true, mode: 0o700 });
  const runDir = path.join(o.jobDir, `analyst-${Date.now().toString(36)}`);
  const home = await adapter.prepare({ runDir, home: homes.home, dataRoot: homes.dataRoot, variants: [], allowMcp: false, bare: true });
  try {
    const out = path.join(o.jobDir, `answer-${Date.now().toString(36)}.txt`);
    const args = adapter.freshArgv({ cwd: o.jobDir, sandbox: 'read-only', ephemeral: true, outputFile: out });
    const res = await run(bin, args, home.env, o.jobDir, `${o.instructions}\n\n---\n\n${o.input}`, o.timeoutMs ?? 6 * 60_000);
    if (res.timedOut) throw new Error(`分析超时（${Math.round((o.timeoutMs ?? 6 * 60_000) / 60_000)} 分钟）`);
    const events = res.stdout.split('\n').flatMap((l) => {
      try {
        return [JSON.parse(l) as { type?: string; usage?: AnalystResult['usage']; item?: { type?: string; text?: string } }];
      } catch {
        return [];
      }
    });
    const usage = events.find((e) => e.type === 'turn.completed')?.usage;
    let text = fs.existsSync(out) ? fs.readFileSync(out, 'utf8') : '';
    if (!text) text = [...events].reverse().find((e) => e.item?.type === 'agent_message')?.item?.text ?? '';
    if (!text) throw new Error(`分析员没有输出（exit ${res.code}）：${res.stderr.slice(-300)}`);
    return { text, usage };
  } finally {
    await home.cleanup().catch(() => undefined);
    fs.rmSync(runDir, { recursive: true, force: true });
  }
}

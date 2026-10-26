import fs from 'node:fs';
import path from 'node:path';
import { summarizeTrace, type ExecSummary } from '../../core/compare/summary';
import { parseRollout } from '../../core/parse';
import { parseSkillMd } from '../../core/skills/frontmatter';
import { config, dataPaths } from '../config';
import { emit, prepareWorkspace, registerExecutor, saveRun, setStatus, spawnAgent, type LabRun, type Live } from '../services/runner';
import { registerRollout } from '../services/sessions';
import { getVariant, mountName } from '../services/variants';
import { diffManifests, snapshot as guardSnapshot, type ManifestDiff } from '../services/writeGuard';
import { currentAgent } from '../sources/registry';
import type { ReplayHome } from './adapter';
import { workspaceAgent } from './analyst';

/**
 * Skill trial runs (Skill Lab / the Skills page): a new session of the
 * workspace's agent (Codex) with the prompt on stdin, in an isolated
 * home where the variant replaces the skill — baseline A′ is the same without
 * the variant. Hooks and MCP servers are off unless asked for.
 */

/** Where an agent wrote the session with this id below `dir`. */
export async function findRollout(dir: string, threadId: string): Promise<string | undefined> {
  const files = (await fs.promises.readdir(dir, { recursive: true }).catch(() => [])) as string[];
  const f = files.find((x) => x.includes(threadId) && x.endsWith('.jsonl'));
  return f ? path.join(dir, f) : undefined;
}

async function executeLab(l: Live<LabRun>): Promise<void> {
  const r = l.record;
  const o = r.options;
  const runDir = path.join(dataPaths.runs, r.id);
  const notes: string[] = [];
  const t0 = Date.now();
  let home: ReplayHome | undefined;
  let budgetParity = false;
  let exitCode: number | null = null;
  let stderrTail: string | undefined;
  let guard: ManifestDiff | undefined;
  try {
    await fs.promises.mkdir(runDir, { recursive: true, mode: 0o700 });
    setStatus(l, 'running');
    const agent = currentAgent();
    const { adapter, bin, homes } = workspaceAgent();
    const variant = o.variantId ? getVariant(o.variantId) : undefined;
    if (o.variantId && !variant) throw new Error('变体不存在');
    home = await adapter.prepare({
      runDir,
      home: homes.home,
      dataRoot: homes.dataRoot,
      variants: variant ? [{ originalDir: variant.originalPath || undefined, variantDir: o.frozenVariantDir ?? variant.dir, name: mountName(variant) }] : [],
      allowMcp: Boolean(o.allowMcp),
    });
    budgetParity = home.budgetParity;
    notes.push(...home.notes);
    if (!o.allowMcp) notes.push('外部工具（MCP 服务器）已关闭');
    emit(l, 'log', { message: '隔离的 home 就绪' });
    const ws = await prepareWorkspace(o, runDir, notes);
    const roots = adapter.guardRoots(homes);
    const before = await guardSnapshot(roots);
    const prompt = o.testType === 'content' ? `${adapter.mention(o.skillKey)} ${o.prompt}` : o.prompt;
    const args = adapter.freshArgv({ cwd: ws.cwd, sandbox: ws.sandbox, model: o.model, keepHooks: o.keepHooks });
    emit(l, 'log', { message: `${agent} ${args.join(' ')}（输入从 stdin 传入）` });
    const res = await spawnAgent(l, { bin, args, env: home.env, cwd: ws.cwd, input: prompt });
    exitCode = res.code;
    stderrTail = res.stderr.slice(-2000) || undefined;
    guard = diffManifests(before, await guardSnapshot(roots));
    const authLinked = await home.authLinked();
    const written = r.threadId ? await findRollout(home.sessionsDir, r.threadId) : undefined;
    const move = await home.cleanup();
    home = undefined;
    if (written && r.threadId) {
      r.rollout = move(written);
      registerRollout(r.threadId, r.rollout);
    }
    let summary: ExecSummary | undefined;
    if (r.rollout) {
      const { trace } = await parseRollout(r.rollout, { homeDir: config.homeDir });
      const names = [o.skillKey];
      if (variant) {
        const parsed = parseSkillMd(fs.readFileSync(path.join(o.frozenVariantDir ?? variant.dir, 'SKILL.md'), 'utf8'));
        if (parsed.name) names.push(o.skillKey.includes(':') ? `${o.skillKey.split(':')[0]}:${parsed.name}` : parsed.name);
      }
      summary = summarizeTrace(trace, names);
    }
    r.result = { exitCode, wallMs: Date.now() - t0, summary, guard, authLinked, budgetParity, notes, stderrTail };
    if (!authLinked) notes.push(`运行中 auth.json 被替换（token 刷新）：真实登录可能需要重新执行 ${agent} login`);
    if (guard.added.length + guard.removed.length + guard.changed.length) notes.push('写保护检测到真实目录有变化，请检查');
    r.finishedAt = Date.now();
    setStatus(l, l.cancelled ? 'cancelled' : exitCode === 0 ? 'completed' : 'failed');
    if (exitCode !== 0 && !l.cancelled) r.error = `${agent} 退出码 ${exitCode}${stderrTail ? `：${stderrTail.slice(-300)}` : ''}`;
  } catch (e) {
    r.error = (e as Error).message;
    r.result ??= { exitCode, wallMs: Date.now() - t0, guard, authLinked: true, budgetParity, notes, stderrTail };
    r.finishedAt = Date.now();
    setStatus(l, l.cancelled ? 'cancelled' : 'failed');
  } finally {
    if (home) await home.cleanup().catch(() => undefined);
    saveRun(r);
    emit(l, 'done', r);
    l.child = undefined;
  }
}

registerExecutor('lab', executeLab);

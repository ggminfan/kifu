/**
 * A replay playground with made-up data and a fake agent (no model calls, no
 * user data): a Codex home with one three-turn session whose second turn goes
 * wrong — a command fails and the answer asks back instead of doing the work —
 * and a skill whose description lacks the word the request used.
 *
 * The fake agent loads that skill only when its description mentions "周报",
 * so a variant that adds the word turns the failing checks green.
 *
 *   pnpm demo:replay [--port 7791] [--dir <path>]
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../src/server/config';
import { serve } from '../src/server/serve';
import { item, RolloutBuilder } from '../test/fixtures/builder';

const args = process.argv.slice(2);
const opt = (name: string) => {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
};
const port = Number(opt('--port') ?? 7791);
const dir = path.resolve(opt('--dir') ?? fs.mkdtempSync(path.join(os.tmpdir(), 'kifu-demo-replay-')));
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fake = path.join(repo, 'test', 'fixtures', 'fake-agent.mjs');
fs.chmodSync(fake, 0o755);

const home = path.join(dir, 'codex');
const sessions = path.join(home, 'sessions', '2026', '09', '01');
const work = path.join(dir, 'work');
const id = '0199d0d0-0000-7000-8000-00000000c0de';
const skillDir = path.join(home, 'skills', 'report-writer');
const gitHelperDir = path.join(home, 'skills', 'git-helper');
fs.mkdirSync(sessions, { recursive: true });
fs.mkdirSync(skillDir, { recursive: true });
fs.mkdirSync(work, { recursive: true });
fs.writeFileSync(path.join(work, 'NOTES.md'), '# demo project\n');
fs.writeFileSync(path.join(home, 'config.toml'), 'model = "fake-model"\n\n[mcp_servers.docs]\ncommand = "docs-mcp"\n');
fs.writeFileSync(path.join(home, 'auth.json'), '{"demo":"not a real token"}');
fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '---\nname: report-writer\ndescription: Write weekly reports from git logs.\n---\n1. `git log --since=1.week`\n2. Group commits by area and summarize.\n');

const listing = [
  '<skills_instructions>',
  '## Skills',
  'A skill is a set of local instructions to follow that is stored in a `SKILL.md` file.',
  '### Available skills',
  `- report-writer: Write weekly reports from git logs. (file: ${path.join(skillDir, 'SKILL.md')})`,
  '</skills_instructions>',
].join('\n');

const b = new RolloutBuilder().meta({ id, cwd: work, base: 'You are a coding agent. Work in the user’s repository.' });
b.taskStarted('t1').append('t1', [item.dev('<permissions instructions>\nread-only\n</permissions instructions>', listing)]).turnContext('t1', 'fake-model');
b.append('t1', [item.user('看一下这个仓库里有什么')]);
b.append('t1', [item.call('shell', { command: ['bash', '-lc', 'ls'] }, 'call_1')]).tokens(1800, 30);
b.execEnd('call_1', 'ls').append('t1', [item.output('call_1', 'NOTES.md')]);
b.append('t1', [item.assistant('仓库里只有 NOTES.md。')]).tokens(1900, 12).taskComplete('t1', { last_agent_message: '仓库里只有 NOTES.md。' });

b.taskStarted('t2').turnContext('t2', 'fake-model').append('t2', [item.user('把这周的 git 提交整理成周报')]);
b.append('t2', [item.call('shell', { command: ['bash', '-lc', 'git log --oneline --since=week'] }, 'call_2')]).tokens(2100, 25);
b.execEnd('call_2', 'git log --oneline --since=week', 128).append('t2', [item.output('call_2', 'fatal: not a git repository')]);
b.append('t2', [item.call('shell', { command: ['bash', '-lc', 'git log --oneline --since=week'] }, 'call_3')]).tokens(2200, 25);
b.execEnd('call_3', 'git log --oneline --since=week', 128).append('t2', [item.output('call_3', 'fatal: not a git repository')]);
const question = '这个目录不是 git 仓库。你希望我从哪里读取提交记录？';
b.append('t2', [item.assistant(question)]).tokens(2300, 30).taskComplete('t2', { last_agent_message: question });

b.taskStarted('t3').turnContext('t3', 'fake-model').append('t3', [item.user('算了，先这样')]);
b.append('t3', [item.assistant('好的。')]).tokens(2400, 5).taskComplete('t3', { last_agent_message: '好的。' });
for (const l of b.lines) if (l.type === 'turn_context') l.payload.cwd = work;
fs.writeFileSync(path.join(sessions, `rollout-2026-09-01T10-00-00-${id}.jsonl`), `${b.lines.map((l) => JSON.stringify(l)).join('\n')}\n`);

// a long session to read through: fixing a flaky test over three turns, with long outputs, a skill,
// a command repeated in a loop, a context compaction and an idle gap (made up, like everything here)
{
  const lid = '0199d0d0-0000-7000-8000-00000000f1a7';
  const repo = '/work/demo-api';
  const fixer = path.join(home, 'skills', 'flaky-test-fixer');
  fs.mkdirSync(fixer, { recursive: true });
  const fixerMd = '---\nname: flaky-test-fixer\ndescription: 排查和修复偶发失败（flaky）的测试：先连续跑多次复现，再看计时器、并发和共享状态。\n---\n1. 用 `for i in $(seq 10)` 连续跑失败的用例，确认能复现。\n2. 找计时器（setTimeout / fake timers）、未等待的 Promise、测试之间共享的状态。\n3. 修完连续跑 5 次以上都通过才算修好。\n';
  fs.writeFileSync(path.join(fixer, 'SKILL.md'), fixerMd);
  const base = [
    'You are a coding agent working in the user’s repository.',
    '',
    '## How you work',
    '- Read the relevant code before changing it; keep changes small and focused.',
    '- Run the tests that cover your change, and say what you ran.',
    '- Ask only when the request is ambiguous and a wrong guess would be costly.',
    '',
    '## Tools',
    'Use the shell for searching (rg), reading files (sed -n, cat) and running tests. Use apply_patch to edit files.',
    '',
    '## Answers',
    'Lead with the outcome. Mention files with their paths. Use short lists.',
  ].join('\n').repeat(4);
  const agentsMd = [
    '# AGENTS.md instructions for /work/demo-api',
    '',
    '<INSTRUCTIONS>',
    '- 包管理用 pnpm，不要用 npm。',
    '- 测试：`pnpm vitest run <文件>`；全量 `pnpm test`。',
    '- 改了公共行为要在 CHANGELOG.md 的 Unreleased 下记一笔。',
    '- 不要改 test/fixtures 下的数据文件。',
    '</INSTRUCTIONS>',
  ].join('\n');
  const listing = [
    '<skills_instructions>',
    '## Skills',
    'A skill is a set of local instructions to follow that is stored in a `SKILL.md` file.',
    '### Available skills',
    `- flaky-test-fixer: 排查和修复偶发失败（flaky）的测试：先连续跑多次复现，再看计时器、并发和共享状态。 (file: ${path.join(fixer, 'SKILL.md')})`,
    `- report-writer: Write weekly reports from git logs. (file: ${path.join(skillDir, 'SKILL.md')})`,
    `- git-helper: Git log helper for commits, branches and history. (file: ${path.join(gitHelperDir, 'SKILL.md')})`,
    '</skills_instructions>',
  ].join('\n');
  const env = `<environment_context>\n  <cwd>${repo}</cwd>\n  <shell>zsh</shell>\n  <current_date>2026-09-01</current_date>\n</environment_context>`;
  const memory = '## Memory\n- 这个仓库用 pnpm，测试用 vitest。\n- 用户希望改动尽量小，改完在 CHANGELOG 里记一笔。';
  const perms = '<permissions instructions>\nFilesystem sandboxing: workspace-write. Network access is disabled. Approval policy: never.\n</permissions instructions>';
  const testFile = [
    "import { describe, expect, it, vi } from 'vitest';",
    "import { fetchWithRetry } from '../src/retry';",
    '',
    "describe('fetchWithRetry', () => {",
    ...Array.from({ length: 30 }, (_, i) => [
      `  it('case ${i + 1}: retries ${i % 4} times before giving up', async () => {`,
      `    const calls: number[] = [];`,
      `    const fn = vi.fn(async () => { calls.push(Date.now()); if (calls.length <= ${i % 4}) throw new Error('boom'); return 'ok'; });`,
      `    await expect(fetchWithRetry(fn, { retries: ${i % 4}, delayMs: 10 })).resolves.toBe('ok');`,
      `    expect(fn).toHaveBeenCalledTimes(${(i % 4) + 1});`,
      '  });',
    ]).flat(),
    '});',
  ].join('\n');
  const retrySrc = [
    'export interface RetryOptions { retries: number; delayMs: number }',
    '',
    'export async function fetchWithRetry<T>(fn: () => Promise<T>, o: RetryOptions): Promise<T> {',
    '  let lastError: unknown;',
    '  for (let attempt = 0; attempt <= o.retries; attempt++) {',
    '    try {',
    '      return await fn();',
    '    } catch (e) {',
    '      lastError = e;',
    '      setTimeout(() => {}, o.delayMs); // BUG: not awaited',
    '    }',
    '  }',
    '  throw lastError;',
    '}',
  ].join('\n');
  const failing = [
    ' RUN  v3.2.4 /work/demo-api',
    '',
    ' ❯ test/api.test.ts (30 tests | 1 failed) 412ms',
    "   × fetchWithRetry > case 7: retries 2 times before giving up 103ms",
    '     → expected "spy" to be called 3 times, but got 2 times',
    '',
    '⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯',
    '',
    ' FAIL  test/api.test.ts > fetchWithRetry > case 7: retries 2 times before giving up',
    'AssertionError: expected "spy" to be called 3 times, but got 2 times',
    ' ❯ test/api.test.ts:41:16',
    ...Array.from({ length: 40 }, (_, i) => `      ${i + 30}| ${i % 3 ? 'await' : 'expect'}(…)`),
    '',
    ' Test Files  1 failed (1)',
    '      Tests  1 failed | 29 passed (30)',
  ].join('\n');
  const passing = ' RUN  v3.2.4 /work/demo-api\n\n ✓ test/api.test.ts (30 tests) 388ms\n\n Test Files  1 passed (1)\n      Tests  30 passed (30)';
  const all = [
    ' RUN  v3.2.4 /work/demo-api',
    '',
    ...Array.from({ length: 180 }, (_, i) => ` ✓ test/module-${String(i).padStart(3, '0')}.test.ts (${(i % 9) + 3} tests) ${20 + (i % 70)}ms`),
    ' ❯ test/snapshots/report.test.ts (4 tests | 2 failed) 51ms',
    '   × report > renders the summary 12ms',
    '     → Snapshot `report > renders the summary 1` mismatched',
    '   × report > renders the retry count 9ms',
    '     → Snapshot `report > renders the retry count 1` mismatched',
    '',
    ' Test Files  1 failed | 180 passed (181)',
    '      Tests  2 failed | 1203 passed (1205)',
  ].join('\n');
  const patch = [
    '*** Begin Patch',
    '*** Update File: src/retry.ts',
    '@@',
    '     } catch (e) {',
    '       lastError = e;',
    '-      setTimeout(() => {}, o.delayMs); // BUG: not awaited',
    '+      if (attempt < o.retries) await new Promise((r) => setTimeout(r, o.delayMs));',
    '     }',
    '*** End Patch',
  ].join('\n');
  const t = new RolloutBuilder().meta({ id: lid, cwd: repo, base, cli: '0.154.0' });
  const sh = (cmd: string, id: string) => item.call('shell', { command: ['bash', '-lc', cmd] }, id);
  const ran = (id: string, cmd: string, out: string, exit = 0, ms = 900) =>
    t.wait(ms).execEnd(id, cmd, exit, { aggregated_output: out, duration: { secs: Math.floor(ms / 1000), nanos: (ms % 1000) * 1_000_000 } }).append(cur, [item.output(id, out)]);
  let cur = 't1';
  t.taskStarted('t1').append('t1', [item.dev(perms, listing, memory), item.user(env), item.user(agentsMd)]).turnContext('t1', 'demo-model');
  t.append('t1', [item.user('test/api.test.ts 里 fetchWithRetry 的用例偶尔失败，帮我查一下原因并修好')]);
  t.wait(5200).append('t1', [item.reasoning('先找到相关的测试和实现，再想办法复现。'), item.assistant('我先找一下和 retry 相关的测试和实现。', 'commentary'), sh('rg -n "retry" test src', 'l1')]).tokens(9800, 140);
  ran('l1', 'rg -n "retry" test src', Array.from({ length: 24 }, (_, i) => `test/api.test.ts:${5 + i * 6}:  it('case ${i + 1}: retries …`).join('\n') + '\nsrc/retry.ts:3:export async function fetchWithRetry', 0, 300);
  t.wait(3100).append('t1', [sh('sed -n 1,200p test/api.test.ts', 'l2')]).tokens(10400, 60, 'demo-model', 9600);
  ran('l2', 'sed -n 1,200p test/api.test.ts', testFile, 0, 120);
  t.wait(4800).append('t1', [item.assistant('先连续跑几次看能不能复现。', 'commentary'), sh('cat ' + path.join(fixer, 'SKILL.md'), 'l3')]).tokens(12600, 90, 'demo-model', 10200);
  ran('l3', 'cat ' + path.join(fixer, 'SKILL.md'), fixerMd, 0, 50);
  t.wait(3900).append('t1', [sh('for i in $(seq 10); do pnpm vitest run test/api.test.ts || break; done', 'l4')]).tokens(13400, 70, 'demo-model', 12400);
  ran('l4', 'for i in $(seq 10); do pnpm vitest run test/api.test.ts || break; done', failing, 1, 41000);
  t.wait(6100).append('t1', [item.reasoning('第 7 个用例在第三次调用之前就结束了：重试之间的等待没有 await，计时器不起作用。'), sh('sed -n 1,80p src/retry.ts', 'l5')]).tokens(14100, 160, 'demo-model', 13200);
  ran('l5', 'sed -n 1,80p src/retry.ts', retrySrc, 0, 80);
  t.wait(7400).append('t1', [item.assistant('问题在 src/retry.ts：重试之间的 setTimeout 没有被 await，所以根本没有等。改成 await 一个 Promise。', 'commentary'), item.call('apply_patch', { input: patch }, 'l6')]).tokens(15000, 230, 'demo-model', 13900);
  t.wait(200).append('t1', [item.output('l6', 'Success. Updated the following files:\nM src/retry.ts')]);
  t.wait(3300).append('t1', [sh('for i in $(seq 5); do pnpm vitest run test/api.test.ts || break; done', 'l7')]).tokens(15600, 60, 'demo-model', 14800);
  ran('l7', 'for i in $(seq 5); do pnpm vitest run test/api.test.ts || break; done', Array.from({ length: 5 }, () => passing).join('\n'), 0, 21000);
  const answer1 = [
    '已修好：`src/retry.ts` 里重试之间的等待没有 `await`，`setTimeout` 只是注册了一个计时器，循环立刻进入下一次尝试。',
    '',
    '**改动**',
    '- `src/retry.ts`：改成 `await new Promise((r) => setTimeout(r, o.delayMs))`，最后一次失败后不再等待。',
    '',
    '**验证**',
    '- `pnpm vitest run test/api.test.ts` 连续跑 5 次都通过（之前 10 次里会失败一次）。',
  ].join('\n');
  t.wait(5600).append('t1', [item.assistant(answer1)]).tokens(16200, 220, 'demo-model', 15400).taskComplete('t1', { last_agent_message: answer1 });

  // the user comes back six minutes later
  t.wait(6 * 60_000);
  cur = 't2';
  t.taskStarted('t2').turnContext('t2', 'demo-model').append('t2', [item.user('再跑一下全部测试，确认没有别的失败')]);
  t.wait(4100).append('t2', [sh('pnpm test', 'm1')]).tokens(16900, 40, 'demo-model', 16100);
  ran('m1', 'pnpm test', all, 1, 58000);
  for (const [k, id] of ['m2', 'm3', 'm4'].entries()) {
    t.wait(3600 + k * 400).append('t2', [sh('pnpm test -- test/snapshots/report.test.ts', id)]).tokens(24000 + k * 600, 50, 'demo-model', 23000 + k * 600);
    ran(id, 'pnpm test -- test/snapshots/report.test.ts', all.split('\n').slice(-9).join('\n'), 1, 2600);
  }
  // the context fills up: the agent compacts it into a summary and goes on
  t.wait(9000).tokens(25400, 900, 'demo-model', 24800);
  t.replace([
    item.dev(perms, listing, memory),
    item.user(env),
    item.user(agentsMd),
    item.user('The following is a structured summary of the conversation so far:\n1. 修好了 src/retry.ts 里没有 await 的重试等待（test/api.test.ts 连续 5 次通过）。\n2. 全量测试里 test/snapshots/report.test.ts 有 2 个快照不匹配，重试了 3 次结果一样。\n3. 下一步：确认快照变化是重试次数文案引起的，再更新快照。'),
    item.user('再跑一下全部测试，确认没有别的失败'),
  ]).event({ type: 'context_compacted' });
  t.wait(5200).append('t2', [item.reasoning('快照里多了重试次数的文案，是这次修复带来的预期变化，更新快照即可。'), sh('pnpm vitest run -u test/snapshots/report.test.ts', 'm5')]).tokens(11200, 120, 'demo-model', 0);
  ran('m5', 'pnpm vitest run -u test/snapshots/report.test.ts', ' ✓ test/snapshots/report.test.ts (4 tests) 49ms\n\n Snapshots  2 updated\n Test Files  1 passed (1)', 0, 3100);
  const answer2 = '全量测试现在都通过了。`test/snapshots/report.test.ts` 的 2 个快照失败是这次修复带来的预期变化（报告里多了重试次数），已经更新快照。';
  t.wait(4300).append('t2', [item.assistant(answer2)]).tokens(11800, 90, 'demo-model', 11000).taskComplete('t2', { last_agent_message: answer2 });

  cur = 't3';
  t.wait(40_000).taskStarted('t3').turnContext('t3', 'demo-model').append('t3', [item.user('把这次修改写进 CHANGELOG')]);
  t.wait(3800).append('t3', [sh('sed -n 1,30p CHANGELOG.md', 'n1')]).tokens(12400, 40, 'demo-model', 11600);
  ran('n1', 'sed -n 1,30p CHANGELOG.md', '# Changelog\n\n## Unreleased\n\n## 1.4.0\n- Add request timeouts.', 0, 60);
  t.wait(4600).append('t3', [item.call('apply_patch', { input: '*** Begin Patch\n*** Update File: CHANGELOG.md\n@@\n ## Unreleased\n+- fetchWithRetry now waits between retries (it did not, so retries ran back to back).\n*** End Patch' }, 'n2')]).tokens(13100, 110, 'demo-model', 12300);
  t.wait(150).append('t3', [item.output('n2', 'Success. Updated the following files:\nM CHANGELOG.md')]);
  t.wait(3000).append('t3', [item.assistant('已在 CHANGELOG.md 的 Unreleased 下加了一条。')]).tokens(13600, 30, 'demo-model', 13000).taskComplete('t3', { last_agent_message: '已在 CHANGELOG.md 的 Unreleased 下加了一条。' });
  for (const l of t.lines) if (l.type === 'turn_context') l.payload.cwd = repo;
  fs.writeFileSync(path.join(sessions, `rollout-2026-09-01T09-00-00-${lid}.jsonl`), `${t.lines.map((l) => JSON.stringify(l)).join('\n')}\n`);
}

// more one-turn sessions for evaluating report-writer: where it should load (one did, two did not),
// where it has nothing to do, and where a similar skill (git-helper) did its job
const gitHelper = gitHelperDir;
fs.mkdirSync(gitHelper, { recursive: true });
fs.writeFileSync(path.join(gitHelper, 'SKILL.md'), '---\nname: git-helper\ndescription: Git log helper for commits, branches and history.\n---\nUse `git log --graph`.\n');
const wide = [
  '<skills_instructions>',
  '## Skills',
  '### Available skills',
  `- report-writer: Write weekly reports from git logs. (file: ${path.join(skillDir, 'SKILL.md')})`,
  `- git-helper: Git log helper for commits, branches and history. (file: ${path.join(gitHelper, 'SKILL.md')})`,
  '</skills_instructions>',
].join('\n');
const oneTurn = (n: number, ask: string, read?: string) => {
  const sid = `0199d0d0-0000-7000-8000-0000000e000${n}`;
  const s = new RolloutBuilder().meta({ id: sid, cwd: work });
  s.taskStarted('t1').append('t1', [item.dev(wide)]).turnContext('t1', 'fake-model').append('t1', [item.user(ask)]);
  if (read) {
    const file = path.join(home, 'skills', read, 'SKILL.md');
    s.append('t1', [item.call('shell', { command: ['cat', file] }, 'c1')]).tokens(1500, 10);
    s.execEnd('c1', `cat ${file}`).append('t1', [item.output('c1', fs.readFileSync(file, 'utf8'))]);
  }
  s.append('t1', [item.assistant('好的，已完成。')]).tokens(1600, 8).taskComplete('t1', { last_agent_message: '好的，已完成。' });
  for (const l of s.lines) if (l.type === 'turn_context') l.payload.cwd = work;
  fs.writeFileSync(path.join(sessions, `rollout-2026-09-01T1${n}-00-00-${sid}.jsonl`), `${s.lines.map((l) => JSON.stringify(l)).join('\n')}\n`);
};
oneTurn(1, 'write the weekly report from the git logs of this week', 'report-writer');
oneTurn(2, 'please write weekly reports from my git logs', undefined);
oneTurn(3, 'turn the git logs into weekly reports for the team', undefined);
oneTurn(4, 'fix the typo in NOTES.md', undefined);
oneTurn(5, 'explain what this project does', undefined);
oneTurn(6, 'show the git branches and recent commits', 'git-helper');

// the fake agent's behaviour in replays: report-writer (or the distilled git-weekly-digest) loads for report requests once its description says 周报
Object.assign(process.env, { FAKE_STEPS: '3', FAKE_STEP_MS: '900', FAKE_FAIL_CMD: '1', FAKE_ASK: '1', FAKE_SKILL_WHEN: 'report-writer:周报,git-weekly-digest:周报', FAKE_SKILL_PROMPT: '周报|weekly|report' });

// the fake agent's answer as an analyst: a skill draft (the distill page; other analyst calls get it too)
const draft = path.join(dir, 'draft-answer.json');
fs.writeFileSync(
  draft,
  JSON.stringify({
    name: 'git-weekly-digest',
    description: '把 git 提交整理成周报（weekly report）：用户说 周报、weekly report、这周的提交 时使用。不用于发版说明和代码评审。',
    triggers: { positive: ['周报', 'weekly report', '这周的提交'], negative: ['发版说明'] },
    steps: ['git log --since=1.week --oneline 列出本周提交', '按模块（目录）分组，每组一两句话', '最后列出未完成的事项'],
    clarifications: [{ question: '周报写成中文还是英文？', answer: '中文' }],
    pitfalls: ['目录不是 git 仓库时先问仓库位置，不要反复重试 git log'],
    evidence: [
      { session: 'S1', turn: 1, quote: 'write the weekly report from the git logs of this week' },
      { session: 'S2', turn: 1, quote: 'please write weekly reports from my git logs' },
    ],
  }),
);
process.env.FAKE_ANSWER_FILE = draft;

// made-up skills only: not the user's ~/.agents/skills
config.agentsSkillsDir = path.join(dir, 'agents-skills');
fs.mkdirSync(config.agentsSkillsDir, { recursive: true });
// the fake agent stands in for codex
config.codexBin = fake;

console.log(`demo data in ${dir}`);
await serve({
  agent: 'codex',
  codexHome: home,
  dataDir: path.join(dir, 'data'),
  webDir: path.join(repo, 'dist', 'web'),
  port,
  noAuth: true,
  // the local workspace (replays run here)
  label: '本机',
});

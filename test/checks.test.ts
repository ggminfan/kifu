import { afterEach, describe, expect, it } from 'vitest';
import { configureLanguage } from '../src/shared/i18n';
afterEach(() => configureLanguage('system', 'en-US'));
import { attribution } from '../src/core/analysis/errors';
import { findProblems } from '../src/core/analysis/problems';
import { asksUser, evaluateChecks, suggestChecks, summarizeTurns } from '../src/core/eval/checks';
import { parseRollout } from '../src/core/parse';
import { checkText } from '../src/shared/replay';
import type { SkillReportResponse } from '../src/shared/api';
import { item, RolloutBuilder } from './fixtures/builder';

/** Two turns: the first loads a skill and fails a command three times in a row; the second asks back. */
async function session() {
  const b = new RolloutBuilder().meta({ id: 'checks-1' });
  b.taskStarted('t1').turnContext('t1').append('t1', [item.user('build the report')]);
  b.append('t1', [item.call('shell', { command: ['cat', '/home/u/.codex/skills/report/SKILL.md'] }, 'c0')]).tokens(100, 5);
  b.execEnd('c0', 'cat /home/u/.codex/skills/report/SKILL.md').append('t1', [item.output('c0', '# report')]);
  for (const i of [1, 2, 3]) {
    b.append('t1', [item.call('shell', { command: ['make', 'report'] }, `c${i}`)]).tokens(100 + i, 5);
    b.execEnd(`c${i}`, 'make report', 2).append('t1', [item.output(`c${i}`, 'make: *** error')]);
  }
  b.append('t1', [item.assistant('report is done')]).tokens(110, 5).taskComplete('t1', { last_agent_message: 'report is done' });
  b.taskStarted('t2').turnContext('t2').append('t2', [item.user('now publish it')]);
  b.append('t2', [item.assistant('Which channel do you want me to publish to?')]).tokens(120, 5).taskComplete('t2', { last_agent_message: 'Which channel do you want me to publish to?' });
  return (await parseRollout(b.write())).trace;
}

describe('checks', () => {
  it('summarizes a turn: steps, failures, loops, skills, tools', async () => {
    const t = await session();
    const s = summarizeTurns(t, 0, 1);
    expect(s).toMatchObject({ steps: 5, tools: 4, failedCommands: 3, toolErrors: 3, loops: 1, skillsLoaded: ['report'], status: 'completed', finalAnswer: 'report is done' });
    expect(summarizeTurns(t, 1, 2)).toMatchObject({ steps: 1, tools: 0, failedCommands: 0, loops: 0 });
  });

  it('judges each kind of check', async () => {
    const t = await session();
    const results = evaluateChecks(
      t,
      [
        { kind: 'skill_loaded', skill: 'plugin:report' },
        { kind: 'skill_not_loaded', skill: 'report' },
        { kind: 'tool_called', pattern: '/make\\s+rep/' },
        { kind: 'tool_not_called', pattern: 'rm -rf' },
        { kind: 'no_failed_commands' },
        { kind: 'no_loops' },
        { kind: 'max_steps', n: 4 },
        { kind: 'max_input_tokens', n: 10_000 },
        { kind: 'answer_contains', text: 'DONE' },
        { kind: 'answer_not_contains', text: 'error' },
        { kind: 'no_question' },
      ],
      { from: 0, to: 1 },
    );
    configureLanguage('zh-CN');
    expect(results.map((r) => [checkText(r.def), r.status])).toEqual([
      ['加载了 skill plugin:report', 'pass'],
      ['没有加载 skill report', 'fail'],
      ['调用了工具 /make\\s+rep/', 'pass'],
      ['没有调用工具 rm -rf', 'pass'],
      ['没有失败的命令', 'fail'],
      ['没有循环', 'fail'],
      ['步数不超过 4', 'fail'],
      ['输入 token 不超过 10000', 'pass'],
      ['回答包含「DONE」', 'pass'],
      ['回答不包含「error」', 'pass'],
      ['没有反问用户', 'pass'],
    ]);
    configureLanguage('en');
    expect(checkText(results[0].def)).toBe('Loaded skill plugin:report');
    expect(checkText(results[4].def)).toBe('No failed commands');
    expect(evaluateChecks(t, [{ kind: 'no_question' }], { from: 1, to: 2 })[0]).toMatchObject({ status: 'fail' });
  });

  it('a run stopped at its step limit is not judged on what needs the turn to end', async () => {
    const t = await session();
    const [steps, tokens, answer, loaded, failed] = evaluateChecks(
      t,
      [{ kind: 'max_steps', n: 10 }, { kind: 'max_input_tokens', n: 10 }, { kind: 'no_question' }, { kind: 'skill_loaded', skill: 'other' }, { kind: 'no_failed_commands' }],
      { from: 0, to: 1, stoppedAtMax: true },
    );
    expect([steps.status, tokens.status, answer.status, loaded.status, failed.status]).toEqual(['na', 'fail', 'na', 'na', 'fail']);
    // no failure seen yet in a turn that was cut short: not a pass
    const clean = evaluateChecks(t, [{ kind: 'no_failed_commands' }, { kind: 'no_tool_errors' }, { kind: 'no_loops' }], { from: 1, to: 2, stoppedAtMax: true });
    expect(clean.map((c) => c.status)).toEqual(['na', 'na', 'na']);
    expect(evaluateChecks(t, [{ kind: 'no_failed_commands' }], { from: 1, to: 2 })[0].status).toBe('pass');
  });

  it('suggests checks from what went right and wrong in turn K', async () => {
    const t = await session();
    const skills: SkillReportResponse = {
      rows: [
        { name: 'publisher', listed: true, truncated: true, invocations: [], flags: ['maybe_missed'], relevance: { turnIndex: 1, score: 3, matched: ['publish'], tailOnly: [] } },
      ],
    };
    expect(suggestChecks(t, 0, skills)).toEqual([{ kind: 'skill_loaded', skill: 'report' }, { kind: 'no_failed_commands' }, { kind: 'no_loops' }]);
    expect(suggestChecks(t, 1, skills)).toEqual([{ kind: 'skill_loaded', skill: 'publisher' }, { kind: 'no_question' }]);
  });

  it('tells a clarifying question from an answer', () => {
    expect(asksUser('Which file should I change?')).toBe(true);
    expect(asksUser('改好了。\n你希望我顺便更新文档吗')).toBe(true);
    expect(asksUser('改好了，测试全部通过。')).toBe(false);
    expect(asksUser('Fixed it — why did it fail? A missing import.')).toBe(false);
    expect(asksUser(undefined)).toBe(false);
  });
});

describe('problems', () => {
  it('lists failures, loops and skill signals in step order', async () => {
    const t = await session();
    const skills: SkillReportResponse = {
      rows: [{ name: 'publisher', listed: true, truncated: true, invocations: [], flags: ['trigger_truncated'], relevance: { turnIndex: 1, score: 3, matched: ['publish'], tailOnly: ['publish'] } }],
    };
    const p = findProblems(t, attribution(t), skills);
    expect(p.map((x) => [x.kind, x.turnIndex, x.callIndex])).toEqual([
      ['failed_tool', 0, 1],
      ['loop', 0, 1],
      ['failed_tool', 0, 2],
      ['failed_tool', 0, 3],
      ['trigger_truncated', 1, 5],
    ]);
    expect(p.find((x) => x.kind === 'trigger_truncated')).toMatchObject({ certainty: 'heuristic', skill: 'publisher' });
    expect(p.find((x) => x.kind === 'loop')?.detail).toBe('×3');
  });
});

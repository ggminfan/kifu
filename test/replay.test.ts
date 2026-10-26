import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseRollout } from '../src/core/parse';
import { turnCuts } from '../src/core/replay/cut';
import { blocksFromItems, classifyExtra, compareContexts } from '../src/core/replay/fidelity';
import { item, RolloutBuilder } from './fixtures/builder';

/** A two-turn session (user, tool call, answer; then a second user turn). */
function twoTurns(): { b: RolloutBuilder; file: string } {
  const b = new RolloutBuilder().meta({ id: 'replay-1' });
  b.taskStarted('t1').append('t1', [item.dev('context')]).turnContext('t1').append('t1', [item.user('list the files')]);
  b.append('t1', [item.reasoning('look'), item.call('shell', { command: ['ls'] }, 'call_1')]).tokens(100, 10);
  b.execEnd('call_1', 'ls').append('t1', [item.output('call_1', 'a.txt')]);
  b.append('t1', [item.assistant('a.txt')]).tokens(120, 5).taskComplete('t1');
  b.taskStarted('t2').turnContext('t2').append('t2', [item.user('now read it')]);
  b.append('t2', [item.assistant('done')]).tokens(140, 4).taskComplete('t2');
  return { b, file: b.write() };
}

describe('replay cut points', () => {
  it('records where each turn starts and ends', async () => {
    const { b, file } = twoTurns();
    const { trace } = await parseRollout(file);
    const started = b.lines.flatMap((l, i) => (l.type === 'event_msg' && l.payload.type === 'task_started' ? [i] : []));
    const completed = b.lines.flatMap((l, i) => (l.type === 'event_msg' && l.payload.type === 'task_complete' ? [i] : []));
    expect(trace.turns.map((t) => [t.startLine, t.endLine])).toEqual([
      [started[0], completed[0]],
      [started[1], completed[1]],
    ]);
  });

  it('cuts before a user turn, not before a turn another agent started', async () => {
    const { file } = twoTurns();
    const { trace, index } = await parseRollout(file);
    const cuts = turnCuts(trace, index);
    expect(cuts.map((c) => c.replayable)).toEqual([true, true]);
    expect(cuts[1].prefixBytes).toBe(index.offsets[cuts[1].startLine]);
    // nothing of turn 2 before its cut
    expect(fs.readFileSync(file).subarray(0, cuts[1].prefixBytes).includes('"turn_id":"t2"')).toBe(false);

    const sub = new RolloutBuilder().meta({ id: 'sub-1', source: { subagent: 'x' } });
    sub.event({ type: 'task_started', turn_id: 's1' }).turnContext('s1');
    sub.rec('inter_agent_communication_metadata', { trigger_turn: true });
    sub.append('s1', [{ type: 'agent_message', author: '/root', recipient: '/root/sub', content: [{ type: 'text', text: 'do it' }] }]);
    sub.append('s1', [item.assistant('ok')]).tokens(10, 1).taskComplete('s1');
    const parsed = await parseRollout(sub.write());
    const [c] = turnCuts(parsed.trace, parsed.index);
    expect(c.replayable).toBe(false);
    expect(c.reasons.join()).toMatch(/子 agent 会话/);
  });

  it('does not cut a subagent session whose parent writes its user messages (Codex guardian reviews)', async () => {
    const g = new RolloutBuilder().meta({ id: 'guardian-1', source: { subagent: { other: 'guardian' } } });
    g.taskStarted('g1').turnContext('g1').append('g1', [item.user('review this')]);
    g.append('g1', [item.assistant('ok')]).tokens(10, 1).taskComplete('g1');
    g.taskStarted('g2').turnContext('g2').append('g2', [item.user('and this')]);
    g.append('g2', [item.assistant('ok')]).tokens(12, 1).taskComplete('g2');
    const { trace, index } = await parseRollout(g.write());
    expect(trace.turns.map((t) => t.trigger)).toEqual(['user', 'user']);
    expect(turnCuts(trace, index).map((c) => c.replayable)).toEqual([false, false]);
  });

  it('a replay hides its copy of the original: only the new turns are its own', async () => {
    const { file } = twoTurns();
    const full = await parseRollout(file);
    const cut = turnCuts(full.trace, full.index)[1];
    const { trace } = await parseRollout(file, { prefixEnd: cut.startLine });
    expect(trace.forkPrefix).toEqual({ endLine: cut.startLine, kind: 'replay' });
    expect(trace.turns.map((t) => t.id)).toEqual(['t2']);
    expect(trace.calls).toHaveLength(1);
    // the copied history is still the replayed call's context
    expect(trace.items.filter((i) => i.cat === 'user').length).toBe(2);
  });
});

describe('replay fidelity', () => {
  const long = (tag: string) => `${tag} ${'detail '.repeat(12)}`;

  it('matches the history line by line across different splits, paths and truncation', () => {
    const original = blocksFromItems(
      [
        { kind: 'message', role: 'developer', cat: 'context', text: '<permissions instructions>\nread only\n</permissions instructions>' },
        { kind: 'message', role: 'user', cat: 'user', text: `look at /real/home/a.txt\n${long('first')}` },
        { kind: 'function_call', cat: 'tool_call', text: '{"cmd":"cat a.txt"}' },
        { kind: 'function_call_output', cat: 'tool_output', text: long('output line') },
        { kind: 'reasoning', cat: 'reasoning', text: 'thinking' },
      ],
      'You are an agent.\nBe brief.',
    );
    const replay = blocksFromItems(
      [
        { kind: 'message', role: 'developer', cat: 'context', text: '<permissions instructions>\nread only\n</permissions instructions>' },
        { kind: 'message', role: 'user', cat: 'user', text: 'look at /tmp/overlay/a.txt' },
        { kind: 'message', role: 'user', cat: 'user', text: long('first') },
        { kind: 'function_call', cat: 'tool_call', text: '{"cmd":"cat a.txt"}' },
        { kind: 'function_call_output', cat: 'tool_output', text: long('output line').slice(0, 60) },
        { kind: 'message', role: 'developer', cat: 'developer', text: '<model_switch>\nThe user switched models.\n</model_switch>' },
      ],
      'You are an agent.\nBe brief.',
    );
    const r = compareContexts(original, replay, { pathMap: [['/tmp/overlay', '/real/home']] });
    expect(r.base.coverage).toBe(1);
    expect(r.history.coverage).toBe(1);
    expect(r.truncatedLines).toBe(1);
    expect(r.extras).toEqual([expect.objectContaining({ kind: 'model', role: 'system', scope: 'history', source: 'message/developer', position: 1, lines: 3 })]);
    expect(r.missing).toEqual([]);
  });

  it('names what an agent adds on resume', () => {
    expect(classifyExtra('<model_switch>\n…')).toBe('model');
    expect(classifyExtra('<collaboration_mode># Collaboration Mode: Default')).toBe('mode');
    expect(classifyExtra('<environment_context>\n<cwd>/x</cwd>')).toBe('environment');
    expect(classifyExtra('<permissions instructions>')).toBe('permissions');
    expect(classifyExtra('<skills_instructions>\n## Skills')).toBe('skills');
    expect(classifyExtra('# AGENTS.md instructions for /x')).toBe('agents_md');
    expect(classifyExtra('something else')).toBe('other');
  });
});

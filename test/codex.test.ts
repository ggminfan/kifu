import { describe, expect, it } from 'vitest';
import { codexForkPrefix, parseRollout } from '../src/core/parse';
import { CodexRolloutBuilder, codexItem, item } from './fixtures/builder';

async function parse(b: CodexRolloutBuilder) {
  return (await parseRollout(b.write(), { homeDir: '/home/u' })).trace;
}

const cats = (t: Awaited<ReturnType<typeof parse>>, call: number) =>
  t.epochs[t.calls[call].view.epoch].slice(0, t.calls[call].view.len).map((i) => t.items[i].cat);

describe('Codex rollouts', () => {
  it('builds calls from response items, with usage from token_usage_record', async () => {
    const b = new CodexRolloutBuilder()
      .meta({ id: 'cx-1' })
      .taskStarted('t1')
      .item('t1', item.dev('<permissions instructions>\nsandbox'), ['permissions.instructions'])
      .item('t1', item.user('# AGENTS.md instructions for /work/demo', '<environment_context>\n<cwd>/work/demo</cwd>'), ['agents_md.instructions', 'environments.environment_context'])
      .turnContext('t1')
      .item('t1', item.user('please list files'), ['user.text'])
      .itemCompleted({ type: 'UserMessage', id: 'u1', content: [{ type: 'text', text: 'please list files' }] })
      .item('t1', item.reasoning('think'))
      .item('t1', item.assistant('Looking.', 'commentary'))
      .item('t1', codexItem.custom('exec', 'await tools.exec_command({cmd:"ls"})', 'call_A'))
      .usage('t1', 1000, 50)
      .command('exec-1', 'ls')
      .item('t1', codexItem.customOutput('call_A', 'Script completed\nOutput:\na.txt'))
      .tokenCount()
      .item('t1', item.assistant('There is a.txt'))
      .usage('t1', 1100, 20)
      .tokenCount()
      .taskComplete('t1');
    const t = await parse(b);

    expect(t.meta).toMatchObject({ threadId: 'cx-1', model: 'gpt-demo', contextWindow: 258400, cliVersion: '0.154.0' });
    expect(t.turns).toHaveLength(1);
    expect(t.turns[0]).toMatchObject({ trigger: 'user', status: 'completed' });
    expect(t.turns[0].input?.preview).toBe('please list files');
    expect(t.calls.map((c) => c.kind)).toEqual(['response', 'response']);
    expect(t.calls.map((c) => c.usage?.total)).toEqual([1050, 1120]);
    expect(t.calls[0].usage?.cacheWrite).toBe(7);
    expect(t.calls[0]).toMatchObject({ model: 'gpt-demo', phase: 'commentary' });
    expect(t.calls[0].reasoning?.preview).toBe('think');
    expect(t.calls[0].text?.preview).toBe('Looking.');
    expect(t.calls[1].text?.preview).toBe('There is a.txt');
    // context added by the harness before the first response; the user's text is not "injected"
    expect(t.calls[0].injected.map((i) => t.items[i].cat)).toEqual(['permissions', 'agents_md', 'environment']);
    expect(t.calls[1].injected).toEqual([]);

    const tool = t.tools.call_A;
    expect(tool).toMatchObject({ kind: 'code_exec', status: 'done', isError: false, callIndex: 0 });
    expect(tool.args).toMatchObject({ preview: 'await tools.exec_command({cmd:"ls"})' });
    expect(tool.inner).toHaveLength(1);
    expect(tool.inner[0]).toMatchObject({ link: 'position', innerId: 'exec-1', title: 'ls', exitCode: 0, durationMs: 2000 });
    expect(tool.inner[0].output?.preview).toBe('ok');

    expect(cats(t, 1)).toEqual(['permissions', 'agents_md', 'environment', 'user', 'reasoning', 'assistant', 'tool_call', 'tool_output']);
    expect(t.totals.usage.total).toBe(2170);
    expect(t.diagnostics.filter((d) => d.kind.startsWith('unknown'))).toEqual([]);
  });

  it('older versions: token_count closes the response, repeats are ignored', async () => {
    const b = new CodexRolloutBuilder()
      .meta({ id: 'cx-2', cli: '0.130.0' })
      .taskStarted('t1')
      .turnContext('t1')
      .item('t1', item.user('run it'))
      .tokenCount()
      .item('t1', item.reasoning('plan'))
      .item('t1', item.call('exec_command', { cmd: 'make' }, 'call_B'))
      .tokenCount({ input: 100, output: 10 })
      .command('call_B', 'make', 2)
      .item('t1', item.output('call_B', 'make: *** failed'))
      .tokenCount()
      .item('t1', item.assistant('It failed.'))
      .tokenCount({ input: 120, output: 5 })
      .taskComplete('t1');
    const t = await parse(b);

    expect(t.calls.map((c) => [c.kind, c.usage?.total])).toEqual([
      ['response', 110],
      ['response', 125],
    ]);
    expect(t.tools.call_B).toMatchObject({ kind: 'shell', isError: true, errorReason: 'exit 2', durationMs: 2000 });
    expect(t.tools.call_B.inner[0]).toMatchObject({ link: 'self', exitCode: 2 });
  });

  it('links MCP, patch and hosted web search details', async () => {
    const b = new CodexRolloutBuilder()
      .meta({ id: 'cx-3' })
      .taskStarted('t1')
      .item('t1', item.user('go'), ['user.text'])
      .item('t1', codexItem.custom('exec', 'await tools.mcp__demo__q({})', 'call_E'))
      .usage('t1', 10, 1)
      .itemCompleted({ type: 'McpToolCall', id: 'exec-9', server: 'demo', tool: 'q', status: 'failed', arguments: {}, duration: { secs: 0, nanos: 5e8 }, result: { content: [{ type: 'text', text: 'nope' }], isError: true } })
      .item('t1', codexItem.customOutput('call_E', 'Script failed'))
      .item('t1', codexItem.custom('apply_patch', '*** Begin Patch', 'call_P'))
      .usage('t1', 12, 1)
      .itemCompleted({ type: 'FileChange', id: 'call_P', status: 'completed', changes: { '/work/demo/a.txt': { type: 'update', unified_diff: '@@ -1 +1 @@' } } })
      .item('t1', codexItem.customOutput('call_P', 'Success'))
      .itemCompleted({ type: 'WebSearch', id: 'ws_old', query: 'demo docs', action: { type: 'search', query: 'demo docs' } })
      .item('t1', item.reasoning('search'))
      .item('t1', codexItem.webSearch('demo docs'))
      .item('t1', item.assistant('Found it.'))
      .usage('t1', 14, 2)
      .taskComplete('t1');
    const t = await parse(b);

    expect(t.calls).toHaveLength(3);
    const exec = t.tools.call_E;
    expect(exec.inner[0]).toMatchObject({ kind: 'mcp', title: 'demo.q', isError: true, link: 'position', durationMs: 500 });
    expect(exec.inner[0].output?.preview).toBe('nope');
    expect(t.tools.call_P).toMatchObject({ kind: 'patch', isError: false });
    expect(t.tools.call_P.inner[0]).toMatchObject({ kind: 'patch', title: 'patch /work/demo/a.txt', link: 'self' });

    const search = Object.values(t.tools).find((x) => x.kind === 'web_search');
    expect(search).toMatchObject({ name: 'web_search', status: 'done', callIndex: 2 });
    expect(search?.inner[0]).toMatchObject({ kind: 'web_search', title: 'search demo docs', link: 'position' });
    expect(t.calls[2].tools).toEqual([search?.id]);
    expect(t.orphanEvents).toEqual([]);
  });

  it('compaction: the usage before `compacted` is the compaction call, history restarts from replacement_history', async () => {
    const b = new CodexRolloutBuilder()
      .meta({ id: 'cx-4' })
      .taskStarted('t1')
      .item('t1', item.user('long task'), ['user.text'])
      .item('t1', item.assistant('working'))
      .usage('t1', 50, 5)
      .usage('t1', 900, 100)
      .compacted([
        item.user('long task'),
        item.user('Another language model started to solve this problem and produced a summary.'),
        codexItem.compaction(4000),
      ])
      .item('t1', item.assistant('continuing'))
      .usage('t1', 60, 4)
      .taskComplete('t1');
    const t = await parse(b);

    expect(t.calls.map((c) => [c.kind, c.usage?.total])).toEqual([
      ['response', 55],
      ['compaction', 1000],
      ['response', 64],
    ]);
    expect(t.epochs).toHaveLength(2);
    expect(t.calls[2].view.epoch).toBe(1);
    expect(cats(t, 2)).toEqual(['user', 'compaction_summary', 'compaction_summary']);
    // the encrypted summary is weighed by its size
    expect(t.items[t.epochs[1][2]].wchars).toBe(750);
    expect(t.turns[0].marks.map((m) => m.kind)).toEqual(['compaction']);
    // replayed history does not change the turn's input
    expect(t.turns[0].input?.preview).toBe('long task');
  });

  it('agent messages start turns, collaboration tools link subagents', async () => {
    const b = new CodexRolloutBuilder()
      .meta({ id: 'cx-5' })
      .taskStarted('t1')
      .interAgent(true)
      .item('t1', codexItem.agentMessage('review the parser'))
      .item('t1', item.call('spawn_agent', { task_name: 'helper', message: 'check tests', fork_turns: 'none' }, 'call_S', 'collaboration'))
      .usage('t1', 30, 3)
      .itemCompleted({ type: 'SubAgentActivity', id: 'call_S', kind: 'started', agent_thread_id: 'child-1', agent_path: '/root/helper' })
      .itemCompleted({ type: 'SubAgentActivity', id: 'suba_unrelated', kind: 'completed', agent_thread_id: 'other', agent_path: '/root/x' })
      .item('t1', item.output('call_S', 'spawned'))
      .item('t1', item.call('send_message', { target: '/root/helper', message: 'hi' }, 'call_M', 'collaboration'))
      .usage('t1', 31, 2)
      .item('t1', item.output('call_M', 'sent'))
      .taskComplete('t1');
    const t = await parse(b);

    expect(t.turns[0]).toMatchObject({ trigger: 'inter_agent' });
    expect(t.turns[0].input?.preview).toBe('review the parser');
    expect(t.tools.call_S.kind).toBe('collab');
    expect(t.tools.call_M.kind).toBe('collab');
    expect(t.subagents).toHaveLength(1);
    expect(t.subagents[0]).toMatchObject({ spawnCallId: 'call_S', taskName: 'helper', childThreadId: 'child-1', agentPath: '/root/helper' });
    expect(t.items.filter((i) => i.cat === 'inter_agent')).toHaveLength(1);
    expect(t.diagnostics.filter((d) => d.kind === 'orphan_event')).toEqual([]);
  });

  it('turns started by a harness message, and internal context never counts as user input', async () => {
    const b = new CodexRolloutBuilder()
      .meta({ id: 'cx-6' })
      .taskStarted('t1')
      .item('t1', item.user('<goal_context>keep going</goal_context>'), ['goal.internal_context'])
      .item('t1', item.user('fix the build'), ['user.text'])
      .item('t1', item.assistant('ok'))
      .usage('t1', 5, 1)
      .taskComplete('t1')
      .taskStarted('t2')
      .turnContext('t2')
      .item('t2', item.dev('<subagent_notification>helper finished</subagent_notification>'))
      .item('t2', item.assistant('helper is done'))
      .usage('t2', 6, 1)
      .taskComplete('t2');
    const t = await parse(b);

    expect(t.turns[0]).toMatchObject({ trigger: 'user' });
    expect(t.turns[0].input?.preview).toBe('fix the build');
    expect(t.items.find((i) => i.preview.startsWith('<goal_context>'))?.cat).toBe('system_reminder');
    expect(t.turns[1]).toMatchObject({ trigger: 'system' });
    expect(t.turns[1].input?.preview).toContain('subagent_notification');
  });

  it('forked subagents with a copied parent session_meta: own history starts at subagent_history_start_ordinal', async () => {
    const b = new CodexRolloutBuilder().meta({ id: 'child', source: { subagent: { thread_spawn: { parent_thread_id: 'parent', depth: 1 } } }, forkedFrom: 'parent', historyStart: 8 });
    b.meta({ id: 'parent' })
      .taskStarted('p1')
      .item('p1', item.user('parent request'), ['user.text'])
      .item('p1', item.assistant('parent answer'))
      .usage('p1', 500, 50)
      .tokenCount()
      .taskComplete('p1');
    expect(b.lines).toHaveLength(8);
    b.taskStarted('c1')
      .interAgent(true)
      .item('c1', codexItem.agentMessage('do the subtask', '/root', '/root/child'))
      .item('c1', item.assistant('subtask done'))
      .usage('c1', 40, 4)
      .taskComplete('c1');
    const t = await parse(b);

    expect(t.forkPrefix).toEqual({ endLine: 8, kind: 'full' });
    expect(t.meta.spawn?.parentThreadId).toBe('parent');
    expect(t.turns).toHaveLength(1);
    expect(t.calls.map((c) => c.usage?.total)).toEqual([44]);
    // the subagent saw the parent's history
    expect(cats(t, 0)).toEqual(['user', 'assistant', 'inter_agent']);
  });

  it('0.144-style forks: the filtered copy of the parent turn is not counted', async () => {
    const b = new CodexRolloutBuilder()
      .meta({ id: 'child', cli: '0.144.1', forkedFrom: 'parent', historyStart: 16 })
      .taskStarted('p1')
      .item('p1', item.dev('<permissions instructions>'))
      .turnContext('p1')
      .itemCompleted({ type: 'AgentMessage', id: 'm1', content: [{ type: 'Text', text: 'parent progress' }], phase: 'commentary' })
      .tokenCount({ input: 800, output: 80 })
      .item('p1', item.dev('<status/>'))
      .tokenCount({ input: 900, output: 90 })
      .taskStarted('c1')
      .turnContext('c1')
      .interAgent(true)
      .item('c1', codexItem.agentMessage('subtask'))
      .item('c1', item.reasoning('on it'))
      .item('c1', item.assistant('done'))
      .tokenCount({ input: 50, output: 5 })
      .taskComplete('c1');
    const t = await parse(b);

    expect(b.lines).toHaveLength(16);
    expect(t.forkPrefix?.endLine).toBe(8);
    expect(t.turns).toHaveLength(1);
    expect(t.calls.map((c) => [c.kind, c.usage?.total])).toEqual([['response', 55]]);
  });

  it('codexForkPrefix only trusts ordinals that point inside the file', () => {
    expect(codexForkPrefix(8, 2, Array(20).fill('x'), true)).toBe(8);
    expect(codexForkPrefix(20, 2, Array(20).fill('x'), true)).toBeUndefined();
    expect(codexForkPrefix(5, 1, ['session_meta', 'event_msg:task_started', 'inter_agent_communication_metadata'], false)).toBeUndefined();
    // a copy that contains real model work is not a filtered copy
    const kinds = ['session_meta', 'event_msg:task_started', 'response_item:reasoning', 'event_msg:task_started', 'inter_agent_communication_metadata'];
    expect(codexForkPrefix(undefined, 1, kinds, true)).toBeUndefined();
    kinds[2] = 'response_item:message';
    expect(codexForkPrefix(undefined, 1, kinds, true)).toBe(3);
  });
});

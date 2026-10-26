import { describe, expect, it } from 'vitest';
import { parseRollout } from '../src/core/parse';
import { extractBlob, parseLine, stripBlobs } from '../src/core/reader/lines';
import { detectSkillRead, parseListing, skillNameFromPath } from '../src/core/skills/detect';
import { CODEX_LISTING, RolloutBuilder, item, nested } from './fixtures/builder';

async function parse(b: RolloutBuilder) {
  return (await parseRollout(b.write(), { homeDir: '/home/u' })).trace;
}

describe('basic turn reconstruction', () => {
  it('splits LLM calls, links nested exec events and attaches outputs', async () => {
    const b = new RolloutBuilder()
      .meta({ id: 'th-1' })
      .taskStarted('t1')
      .append('t1', [item.dev('<permissions instructions>\nsandbox'), item.dev(CODEX_LISTING), item.user('please list files')])
      .turnContext('t1')
      .event({ type: 'user_message', message: 'please list files' })
      .append('t1', [item.reasoning('think'), item.assistant('Looking.', 'commentary'), item.exec('await tools.exec_command({cmd:"ls"})', 'call_A')])
      .execEnd(nested('call_A'), 'ls')
      .append('t1', [item.output('call_A', 'Script completed\nWall time 0.1s\nOutput:\n', 'a.txt')])
      .tokens(1000, 50)
      .append('t1', [item.assistant('There is a.txt')])
      .tokens(1100, 20)
      .taskComplete('t1');
    const t = await parse(b);

    expect(t.meta).toMatchObject({ threadId: 'th-1', model: 'demo-model', source: 'cli' });
    expect(t.turns).toHaveLength(1);
    expect(t.turns[0]).toMatchObject({ trigger: 'user', status: 'completed', durationMs: 5000, ttftMs: 800 });
    expect(t.calls.map((c) => c.kind)).toEqual(['response', 'response']);
    expect(t.calls.map((c) => c.usage?.total)).toEqual([1050, 1120]);
    expect(t.calls[0].reasoning?.preview).toBe('think');
    expect(t.calls[1].text?.preview).toBe('There is a.txt');

    const tool = t.tools.call_A;
    expect(tool).toMatchObject({ kind: 'code_exec', status: 'done', isError: false, callIndex: 0 });
    expect(tool.args.preview).toBe('await tools.exec_command({cmd:"ls"})');
    expect(tool.inner).toHaveLength(1);
    expect(tool.inner[0]).toMatchObject({ link: 'nested', innerId: 'exec-1111', title: 'ls', exitCode: 0, durationMs: 1500 });

    // The second call sees everything before it, including the tool output.
    const view = t.epochs[t.calls[1].view.epoch].slice(0, t.calls[1].view.len).map((i) => t.items[i]);
    expect(view.map((i) => i.cat)).toEqual(['permissions', 'skills_listing', 'user', 'reasoning', 'assistant', 'tool_call', 'tool_output']);
    expect(t.totals.usage.total).toBe(2170);
  });

  it('ignores duplicate token_counts and counts usage once per change', async () => {
    const b = new RolloutBuilder()
      .meta({ id: 'th-2' })
      .taskStarted('t1')
      .tokensRepeat()
      .append('t1', [item.user('hi')])
      .append('t1', [item.assistant('hello')])
      .tokens(10, 5)
      .tokensRepeat()
      .taskComplete('t1');
    const t = await parse(b);
    expect(t.calls).toHaveLength(1);
    expect(t.calls[0].usage?.total).toBe(15);
  });
});

describe('code-mode exec linking', () => {
  it('attributes legacy bare exec ids by position and merges double exec ends', async () => {
    const b = new RolloutBuilder()
      .meta({ id: 'th-3', cli: '0.201.5' })
      .taskStarted('t1')
      .append('t1', [item.user('run')])
      .append('t1', [item.exec('a', 'call_X')])
      .execEnd('exec-legacy', 'sleep 9', 0, { status: 'backgrounded', aggregated_output: '' })
      .append('t1', [item.output('call_X', 'Script running with cell ID 7')])
      .tokens(10, 1)
      .append('t1', [item.call('wait', { cell_id: 7, yield_time_ms: 1000 }, 'call_W')])
      .execEnd('exec-legacy', 'sleep 9', 1)
      .append('t1', [item.output('call_W', 'Script failed\nWall time 9s\nOutput:\n')])
      .tokens(12, 1)
      .taskComplete('t1');
    const t = await parse(b);
    const exec = t.tools.call_X;
    expect(exec.cellId).toBe('7');
    expect(exec.inner).toHaveLength(1);
    expect(exec.inner[0]).toMatchObject({ link: 'position', status: 'failed', exitCode: 1, output: { preview: 'boom' } });
    expect(t.tools.call_W.waitsFor).toBe('call_X');
    expect(t.tools.call_W.isError).toBe(true);
    expect(exec.isError).toBe(true);
    expect(exec.status).toBe('done');
  });
});

describe('compaction and rollback', () => {
  it('turns a usage-only call before replace into a compaction and opens a new epoch', async () => {
    const b = new RolloutBuilder()
      .meta({ id: 'th-4' })
      .taskStarted('t1')
      .append('t1', [item.user('long task')])
      .append('t1', [item.assistant('step', 'commentary')])
      .tokens(100, 10)
      .tokens(50, 20) // summary call, no output commit
      .replace([item.dev('<permissions instructions>'), item.user('The following is a structured summary')])
      .event({ type: 'context_compacted' })
      .append('t1', [item.assistant('continue')])
      .tokens(30, 5)
      .taskComplete('t1');
    const t = await parse(b);
    expect(t.calls.map((c) => c.kind)).toEqual(['response', 'compaction', 'response']);
    expect(t.epochs).toHaveLength(2);
    expect(t.calls[2].view.epoch).toBe(1);
    expect(t.items[t.epochs[1][1]].cat).toBe('compaction_summary');
    expect(t.turns[0].marks.filter((m) => m.kind === 'compaction')).toHaveLength(1);
  });

  it('marks a rollback and an aborted turn', async () => {
    const b = new RolloutBuilder().meta({ id: 'th-5' }).taskStarted('t1').append('t1', [item.user('first')]);
    b.append('t1', [item.assistant('ok')]).tokens(10, 1).taskComplete('t1');
    b.taskStarted('t2').append('t2', [item.user('second')]);
    b.event({ type: 'turn_aborted', reason: 'interrupted' })
      .event({ type: 'thread_rolled_back', num_turns: 1 })
      .taskStarted('t3')
      .append('t3', [item.user('third')])
      .append('t3', [item.assistant('done')])
      .tokens(12, 1)
      .taskComplete('t3');
    const t = await parse(b);
    expect(t.turns.find((x) => x.id === 't2')?.status).toBe('aborted');
    expect(t.turns.flatMap((x) => x.marks.map((m) => [x.id, m.kind, m.detail]))).toEqual([
      ['t2', 'abort', 'interrupted'],
      ['t2', 'rollback', '回滚 1 轮'],
    ]);
  });
});

const PLUGIN_LISTING = [
  '<skills_instructions>',
  '## Skills',
  '### Available skills',
  '- alpha: Do alpha things when the user asks for alpha reports. (file: /home/u/.codex/skills/alpha/SKILL.md)',
  '- demo-plugin:beta: Beta helper. (file: /home/u/.codex/plugins/cache/mk/demo-plugin/1.0.0/skills/beta/SKILL.md)',
  '</skills_instructions>',
].join('\n');

describe('skills', () => {
  it('resolves skill root aliases in the codex catalog', () => {
    const l = parseListing(
      [
        '<skills_instructions>',
        '## Skills',
        'Skill roots:',
        '- `r0` = `/home/u/.codex/skills`',
        '- `r1` = `/home/u/.codex/plugins/cache/mk/demo-plugin/1.0.0/skills`',
        '### Available skills',
        '- alpha: Do alpha things when the user asks for alpha reports and (file: r0/alpha/SKILL.md)',
        '- demo-plugin:beta: Beta helper. (file: r1/beta/SKILL.md)',
        '</skills_instructions>',
      ].join('\n'),
    )!;
    expect(l.format).toBe('codex');
    expect(l.roots).toEqual({ r0: '/home/u/.codex/skills', r1: '/home/u/.codex/plugins/cache/mk/demo-plugin/1.0.0/skills' });
    expect(l.entries).toEqual([
      { name: 'alpha', description: 'Do alpha things when the user asks for alpha reports and', file: 'r0/alpha/SKILL.md', path: '/home/u/.codex/skills/alpha/SKILL.md' },
      { name: 'demo-plugin:beta', description: 'Beta helper.', file: 'r1/beta/SKILL.md', path: '/home/u/.codex/plugins/cache/mk/demo-plugin/1.0.0/skills/beta/SKILL.md' },
    ]);
  });

  it('parses the codex catalog with absolute paths and parentheses in descriptions', () => {
    const l = parseListing(CODEX_LISTING)!;
    expect(l.format).toBe('codex');
    expect(l.entries.map((e) => e.name)).toEqual(['alpha', 'gamma']);
    expect(l.entries[0].description).toBe('Do alpha things (examples: reports) when asked.');
    expect(l.entries[1].path).toBe('/home/u/.agents/skills/gamma/SKILL.md');
  });

  it('detects Skill tool, $mention (deduplicated) and implicit reads', async () => {
    const b = new RolloutBuilder()
      .meta({ id: 'th-6' })
      .taskStarted('t1')
      .append('t1', [item.dev(PLUGIN_LISTING), item.user('use $alpha please')])
      .event({ type: 'item_completed', item: { type: 'UserMessage', content: [{ type: 'skill', name: 'alpha', path: '/home/u/.codex/skills/alpha/SKILL.md' }] } })
      .append('t1', [item.user('<skill>\n<name>alpha</name>\n<path>/home/u/.codex/skills/alpha/SKILL.md</path>\n# Alpha\nsteps')])
      .append('t1', [item.call('Skill', { skill: 'demo-plugin:beta' }, 'call_S')])
      .append('t1', [item.output('call_S', '<command-name>/demo-plugin:beta</command-name><skill><name>demo-plugin:beta</name><path>/p/beta/SKILL.md</path>\nbody')])
      .tokens(10, 1)
      .append('t1', [item.exec('x', 'call_R')])
      .execEnd(nested('call_R'), "sed -n '1,40p' /home/u/.codex/plugins/cache/mk/demo-plugin/1.0.0/skills/beta/SKILL.md")
      .append('t1', [item.output('call_R', 'Script completed')])
      .tokens(11, 1)
      .taskComplete('t1');
    const t = await parse(b);
    const inv = t.invocations.map((v) => [v.mode, v.skill, v.seenLines ?? null]);
    expect(inv).toEqual([
      ['mention', 'alpha', null],
      ['tool', 'demo-plugin:beta', null],
      ['implicit_read', 'demo-plugin:beta', [1, 40]],
    ]);
    expect(t.invocations[0].contentItem).toBeDefined();
    expect(t.invocations[1].path).toBe('/p/beta/SKILL.md');
    expect(t.tools.call_R.skill).toBe('demo-plugin:beta');
    expect(t.listings).toHaveLength(1);
  });

  it('recognizes reads through command rewrites but not writes', () => {
    expect(detectSkillRead('rtk read /a/b/SKILL.md && git log')?.path).toBe('/a/b/SKILL.md');
    expect(detectSkillRead('head -n 20 ~/.agents/skills/x/SKILL.md')).toEqual({ path: '~/.agents/skills/x/SKILL.md', lines: [1, 20] });
    expect(detectSkillRead('echo hi > /a/b/SKILL.md')).toBeNull();
    expect(detectSkillRead("sed -i 's/a/b/' /a/b/SKILL.md")).toBeNull();
    expect(detectSkillRead('ls /tmp')).toBeNull();
  });

  it('names plugin skills plugin:skill', () => {
    expect(skillNameFromPath('/h/.codex/plugins/cache/mk/docs-cli/0.1.2/skills/docs-cli/SKILL.md')).toBe('docs-cli:docs-cli');
    expect(skillNameFromPath('/h/.codex/skills/alpha/SKILL.md')).toBe('alpha');
  });
});

describe('robustness', () => {
  it('strips and recovers large base64 payloads', () => {
    const b64 = `iVBOR${'A'.repeat(300_000)}`;
    const line = JSON.stringify({ type: 'event_msg', payload: { type: 'mcp_tool_call_end', result: { Ok: { content: [{ type: 'image', data: b64 }] } } } });
    const { text, blobs } = stripBlobs(line, 9);
    expect(blobs).toEqual(['blob:9:0']);
    expect(text.length).toBeLessThan(500);
    expect(parseLine(line, 9).rec.payload).toMatchObject({ result: { Ok: { content: [{ data: 'blob:9:0' }] } } });
    expect(extractBlob(line, 0)).toMatchObject({ mime: 'image/png' });
    expect(extractBlob(line, 0)?.base64.length).toBe(b64.length);
  });

  it('records unknown record and event types as diagnostics instead of failing', async () => {
    const b = new RolloutBuilder()
      .meta({ id: 'th-7' })
      .rec('brand_new_record', { x: 1 })
      .taskStarted('t1')
      .event({ type: 'brand_new_event' })
      .append('t1', [item.user('hi')])
      .append('t1', [item.assistant('yo')])
      .tokens(1, 1)
      .taskComplete('t1');
    const t = await parse(b);
    expect(t.diagnostics.map((d) => `${d.kind}:${d.detail}`).sort()).toEqual(['unknown_event:brand_new_event', 'unknown_record:brand_new_record']);
    expect(t.calls).toHaveLength(1);
  });
});

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { claudeUsage } from '../src/core/claude/parse';
import { parseSession, sniffFormat } from '../src/core/parse';
import { loadClaudeProject } from '../src/server/sources/claude';
import { ClaudeTranscriptBuilder, block } from './fixtures/claude';

async function parse(file: string) {
  return (await parseSession(file, { homeDir: '/home/u' })).trace;
}

type Trace = Awaited<ReturnType<typeof parse>>;
const viewCats = (t: Trace, call: number) => t.epochs[t.calls[call].view.epoch].slice(0, t.calls[call].view.len).map((i) => t.items[i].cat);

const LISTING = '<system-reminder>\nThe following skills are available for use with the Skill tool:\n\n- alpha: Do alpha things when asked for alpha reports\n- beta: Beta helper\n</system-reminder>';

describe('Claude Code transcripts', () => {
  it('detects the format from the record envelope only', () => {
    expect(sniffFormat('{"timestamp":"2026-01-01T00:00:00Z","type":"session_meta","payload":{"id":"x"}}')).toBe('rollout');
    expect(sniffFormat('{"timestamp":"2026-01-01T00:00:00Z","ordinal":0,"type":"session_meta","payload":{}}')).toBe('rollout');
    expect(sniffFormat('{"parentUuid":null,"isSidechain":false,"message":{"content":"send the \\"payload\\": now"}}')).toBe('claude');
    expect(sniffFormat('{"type":"queue-operation","operation":"enqueue"}')).toBe('claude');
  });

  it('merges a response written block by block into one call, with the last block’s usage', async () => {
    const b = new ClaudeTranscriptBuilder()
      .plain('custom-title', { customTitle: 'demo', sessionId: 'cc-session-0001' })
      .prompt('list files')
      .assistant('msg_1', [block.thinking('plan'), block.text('Looking.'), block.tool('tu_1', 'Bash', { command: 'ls' })], { input: 10, cacheWrite: 100, cacheRead: 1000, output: 5 }, 'tool_use', { finalOutput: 20 })
      .toolResult('tu_1', 'a.txt', { result: { stdout: 'a.txt', stderr: '' } })
      .assistant('msg_2', [block.text('There is a.txt')], { input: 3, cacheRead: 1200, output: 8 }, 'end_turn')
      .system('turn_duration', { durationMs: 5000, messageCount: 4 });
    const t = await parse(b.write());

    expect(t.meta).toMatchObject({ threadId: 'cc-session-0001', model: 'claude-demo', cwd: '/work/demo', cliVersion: '2.1.286', modelProvider: 'anthropic' });
    expect(t.calls).toHaveLength(2);
    expect(t.calls[0].usage).toEqual({ input: 1110, cached: 1000, cacheWrite: 100, output: 20, reasoning: 0, total: 1130 });
    expect(t.calls[0]).toMatchObject({ kind: 'response', model: 'claude-demo' });
    expect(t.calls[0].reasoning?.preview).toBe('plan');
    expect(t.calls[0].text?.preview).toBe('Looking.');
    expect(t.calls[0].outputItems).toHaveLength(3);
    expect(t.tools.tu_1).toMatchObject({ kind: 'shell', status: 'done', isError: false, callIndex: 0, durationMs: 1000 });
    expect(t.tools.tu_1.output?.preview).toBe('a.txt');
    expect(t.tools.tu_1.args.ref).toBeUndefined();
    expect(t.turns).toHaveLength(1);
    expect(t.turns[0]).toMatchObject({ trigger: 'user', status: 'completed', durationMs: 5000 });
    expect(t.turns[0].input?.preview).toBe('list files');
    expect(t.turns[0].lastAgentMessage?.preview).toBe('There is a.txt');
    expect(viewCats(t, 1)).toEqual(['user', 'reasoning', 'assistant', 'tool_call', 'tool_output']);
    expect(t.totals.usage.total).toBe(1130 + 1211);
    expect(t.diagnostics).toEqual([]);
  });

  it('pairs interleaved blocks and tool results, records errors and injected context', async () => {
    const b = new ClaudeTranscriptBuilder()
      .prompt('check it')
      .attachment({ type: 'skill_listing', content: 'x', names: ['alpha', 'beta'], skillCount: 2 }, LISTING)
      .attachment({ type: 'hook_success', content: 'hook ran', hookEvent: 'PostToolUse' }) // not shown to the model
      .assistant('msg_1', [block.tool('tu_a', 'Read', { file_path: '/w/missing.txt' })], { input: 50, output: 4 }, null)
      .toolResult('tu_a', 'File does not exist.', { isError: true })
      .assistant('msg_1', [block.tool('tu_b', 'Bash', { command: 'cat /home/u/.claude/skills/alpha/SKILL.md' })], { input: 50, output: 9 }, 'tool_use')
      .toolResult('tu_b', '# Alpha')
      .assistant('msg_2', [block.text('Done.')], { input: 80, output: 2 }, 'end_turn');
    const t = await parse(b.write());

    expect(t.calls).toHaveLength(2);
    expect(t.calls[0].tools).toEqual(['tu_a', 'tu_b']);
    expect(t.calls[0].usage?.output).toBe(9);
    expect(t.tools.tu_a).toMatchObject({ kind: 'file', isError: true, errorReason: 'File does not exist.' });
    expect(t.calls[0].injected.map((i) => t.items[i].cat)).toEqual(['skills_listing']);
    expect(t.listings).toHaveLength(1);
    expect(t.listings[0].entries.map((e) => e.name)).toEqual(['alpha', 'beta']);
    // a shell read of a SKILL.md loads that skill implicitly
    expect(t.invocations).toMatchObject([{ skill: 'alpha', mode: 'implicit_read', toolCallId: 'tu_b' }]);
    expect(t.items.some((i) => i.preview.includes('hook ran'))).toBe(false);
  });

  it('links Skill calls and /skill commands to the instructions the harness injected', async () => {
    const b = new ClaudeTranscriptBuilder()
      .prompt('do alpha')
      .assistant('msg_1', [block.tool('tu_s', 'Skill', { skill: 'alpha' })], { input: 20, output: 3 }, 'tool_use')
      .toolResult('tu_s', 'Launching skill: alpha', { result: { commandName: 'alpha', success: true } });
    b.meta('Base directory for this skill: /home/u/.claude/skills/alpha\n\n# Alpha\nSteps…', { sourceToolUseID: 'tu_s' })
      .assistant('msg_2', [block.text('Alpha done.')], { input: 30, output: 3 }, 'end_turn')
      .prompt('<command-message>beta</command-message>\n<command-name>/beta</command-name>\n<command-args>now</command-args>')
      .meta('Base directory for this skill: /home/u/.claude/skills/beta\n\n# Beta')
      .assistant('msg_3', [block.text('Beta done.')], { input: 40, output: 3 }, 'end_turn');
    const t = await parse(b.write());

    const tool = t.invocations.find((v) => v.mode === 'tool');
    expect(tool).toMatchObject({ skill: 'alpha', toolCallId: 'tu_s', path: '/home/u/.claude/skills/alpha/SKILL.md' });
    expect(t.items[tool!.contentItem!].cat).toBe('skill_content');
    const mention = t.invocations.find((v) => v.mode === 'mention');
    expect(mention).toMatchObject({ skill: 'beta', path: '/home/u/.claude/skills/beta/SKILL.md', callIndex: 2 });
    expect(t.items[mention!.contentItem!].cat).toBe('skill_content');
    expect(t.turns.map((x) => x.input?.preview)).toEqual(['do alpha', '/beta now']);
  });

  it('compaction starts a new context with the summary and the preserved messages', async () => {
    const b = new ClaudeTranscriptBuilder().prompt('first task').assistant('msg_1', [block.text('ok')], { input: 900, output: 10 }, 'end_turn').prompt('second task');
    const keep = b.lastUuid;
    b.system('compact_boundary', { content: 'Conversation compacted', compactMetadata: { trigger: 'auto', preTokens: 1000, postTokens: 200, preservedMessages: { uuids: [keep] } } })
      .rec('user', { isCompactSummary: true, message: { role: 'user', content: 'This session is being continued from a previous conversation. Summary: …' } })
      .assistant('msg_2', [block.text('continuing')], { input: 300, output: 5 }, 'end_turn');
    const t = await parse(b.write());

    expect(t.epochs).toHaveLength(2);
    expect(t.calls[1].view.epoch).toBe(1);
    expect(viewCats(t, 1)).toEqual(['user', 'compaction_summary']);
    expect(t.items[t.epochs[1][0]].preview).toBe('second task');
    const marks = t.turns.flatMap((x) => x.marks);
    expect(marks).toMatchObject([{ kind: 'compaction', detail: '自动压缩 1000 → 200 tokens' }]);
  });

  it('links Agent calls to subagent transcripts; a subagent session is agent-triggered', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kifu-claude-sub-'));
    const main = new ClaudeTranscriptBuilder('cc-main')
      .prompt('review the change')
      .assistant('msg_1', [block.tool('tu_ag', 'Agent', { description: 'Review', prompt: 'review the diff', subagent_type: 'reviewer' })], { input: 40, output: 6 }, 'tool_use')
      .toolResult('tu_ag', [{ type: 'text', text: 'looks good' }], { result: { agentId: 'abc123', status: 'completed', totalTokens: 900 } })
      .assistant('msg_2', [block.text('Reviewed.')], { input: 60, output: 2 }, 'end_turn');
    const child = new ClaudeTranscriptBuilder('cc-main', 'abc123')
      .prompt('review the diff')
      .assistant('msg_c1', [block.text('looks good')], { input: 30, output: 3 }, 'end_turn');
    const mainFile = main.write(dir);
    const childFile = child.write(dir, { agentType: 'reviewer', description: 'Review', toolUseId: 'tu_ag', spawnDepth: 1 });

    const t = await parse(mainFile);
    expect(t.tools.tu_ag).toMatchObject({ kind: 'collab', childThreadId: 'agent-abc123' });
    expect(t.subagents).toMatchObject([{ spawnCallId: 'tu_ag', taskName: 'Review', role: 'reviewer', childThreadId: 'agent-abc123' }]);
    expect(t.subagents[0].prompt?.preview).toBe('review the diff');

    const c = await parse(childFile);
    expect(c.meta).toMatchObject({ threadId: 'agent-abc123', source: 'subagent', spawn: { parentThreadId: 'cc-main', role: 'reviewer', depth: 1 } });
    expect(c.turns[0]).toMatchObject({ trigger: 'inter_agent', status: 'completed' });

    // the session list shows the subagent under its parent, with tokens counted once per response
    const snap = loadClaudeProject(dir);
    expect(snap.children.get('cc-main')).toEqual(['agent-abc123']);
    expect(snap.byId.get('agent-abc123')).toMatchObject({ parentId: 'cc-main', isSubagent: true, agentRole: 'reviewer', tokensUsed: 33 });
    expect(snap.byId.get('cc-main')?.tokensUsed).toBe(46 + 62);
  });

  it('handles local commands, interrupts, API errors and background notifications', async () => {
    const b = new ClaudeTranscriptBuilder()
      .prompt('<command-name>/model</command-name>\n<command-message>model</command-message>')
      .prompt('<local-command-stdout>Set model to demo</local-command-stdout>')
      .prompt('go')
      .assistant('msg_1', [block.tool('tu_x', 'Bash', { command: 'sleep 100' })], { input: 10, output: 2 }, 'tool_use')
      .toolResult('tu_x', '[Request interrupted by user for tool use]', { isError: true })
      .prompt([{ type: 'text', text: '[Request interrupted by user for tool use]' }])
      .prompt('again')
      .rec('assistant', { isApiErrorMessage: true, message: { id: 'err', model: '<synthetic>', role: 'assistant', content: [{ type: 'text', text: 'API Error: 500 overloaded' }] } })
      .prompt('<task-notification>\n<task-id>bg1</task-id>\n<status>completed</status>\n</task-notification>')
      .assistant('msg_2', [block.text('The background job finished.')], { input: 20, output: 4 }, 'end_turn');
    const t = await parse(b.write());

    expect(t.turns.map((x) => [x.trigger, x.input?.preview.split('\n')[0], x.status])).toEqual([
      ['user', 'go', 'aborted'],
      ['user', 'again', 'failed'],
      ['system', '<task-notification>', 'completed'],
    ]);
    expect(t.turns[1].marks).toMatchObject([{ kind: 'error', detail: 'API Error: 500 overloaded' }]);
    expect(t.calls).toHaveLength(2);
  });

  it('converts usage to whole-prompt input tokens', () => {
    expect(claudeUsage({ input_tokens: 5, cache_creation_input_tokens: 10, cache_read_input_tokens: 100, output_tokens: 7 })).toEqual({
      input: 115,
      cached: 100,
      cacheWrite: 10,
      output: 7,
      reasoning: 0,
      total: 122,
    });
  });
});

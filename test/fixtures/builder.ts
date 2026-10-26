import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Tiny DSL that writes synthetic Codex rollouts for tests: `append` writes a
 * batch of history items (input items, then a response's output items) as
 * response_item records, `tokens` the response's usage. Shapes follow the
 * real format (see src/core/build/reducer.ts) but every value is made up —
 * never copy user data into fixtures.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
type J = Record<string, any>;

let seq = 0;
const uid = (p: string) => `${p}-${(++seq).toString(36).padStart(6, '0')}`;

export const item = {
  dev: (...texts: string[]): J => ({ type: 'message', role: 'developer', content: texts.map((text) => ({ type: 'input_text', text })) }),
  user: (...texts: string[]): J => ({ type: 'message', role: 'user', content: texts.map((text) => ({ type: 'input_text', text })) }),
  assistant: (text: string, phase = 'final_answer'): J => ({
    type: 'message',
    role: 'assistant',
    id: 'msg_0',
    phase,
    content: [{ type: 'output_text', text }],
  }),
  reasoning: (text: string): J => ({ type: 'reasoning', id: 'rs_0', summary: [], content: [{ type: 'reasoning_text', text }] }),
  call: (name: string, args: unknown, callId: string, namespace?: string): J => ({
    type: 'function_call',
    name,
    arguments: typeof args === 'string' ? args : JSON.stringify(args),
    call_id: callId,
    ...(namespace ? { namespace } : {}),
  }),
  exec: (js: string, callId: string): J => item.call('exec', { input: js }, callId),
  output: (callId: string, ...texts: string[]): J => ({
    type: 'function_call_output',
    call_id: callId,
    output: texts.map((text) => ({ type: 'input_text', text })),
  }),
};

export class RolloutBuilder {
  readonly lines: J[] = [];
  private t = Date.parse('2026-09-01T00:00:00.000Z');
  private total = 0;

  private ts(): string {
    this.t += 1000;
    return new Date(this.t).toISOString();
  }

  rec(type: string, payload: J): this {
    this.lines.push({ timestamp: this.ts(), type, payload });
    return this;
  }

  /** Let time pass before the next record (a model call, a slow command, an idle user). */
  wait(ms: number): this {
    this.t += ms;
    return this;
  }

  meta(p: { id: string; cwd?: string; cli?: string; source?: unknown; base?: string; forkedFrom?: string; extra?: J }): this {
    return this.rec('session_meta', {
      session_id: p.id,
      id: p.id,
      timestamp: new Date(this.t).toISOString(),
      cwd: p.cwd ?? '/work/demo',
      originator: 'codex_cli_rs',
      cli_version: p.cli ?? '0.154.0',
      source: p.source ?? 'cli',
      model_provider: 'openai',
      base_instructions: { text: p.base ?? 'You are a coding agent.' },
      ...(p.forkedFrom ? { forked_from_id: p.forkedFrom } : {}),
      ...p.extra,
    });
  }

  taskStarted(turnId: string): this {
    return this.event({ type: 'task_started', turn_id: turnId, started_at: this.t / 1000, model_context_window: 200000 });
  }

  turnContext(turnId: string, model = 'demo-model'): this {
    return this.rec('turn_context', { turn_id: turnId, cwd: '/work/demo', model });
  }

  taskComplete(turnId: string, extra: J = {}): this {
    return this.event({ type: 'task_complete', turn_id: turnId, duration_ms: 5000, time_to_first_token_ms: 800, last_agent_message: 'done', ...extra });
  }

  /** History items of turn `turnId`, one response_item record each. */
  append(turnId: string, items: J[]): this {
    for (const it of items) this.rec('response_item', { ...it, internal_chat_message_metadata_passthrough: { turn_id: turnId } });
    return this;
  }

  /** A compaction: the history continues from `items`. */
  replace(items: J[]): this {
    return this.rec('compacted', { message: '', replacement_history: items });
  }

  /** token_count with the usage of the response just written. */
  tokens(input: number, output: number, model = 'demo-model', cached = 0): this {
    const total = input + output;
    this.total += total;
    const last = { input_tokens: input, cached_input_tokens: cached, output_tokens: output, reasoning_output_tokens: 0, total_tokens: total };
    return this.event({
      type: 'token_count',
      info: { total_token_usage: { ...last, total_tokens: this.total }, last_token_usage: last, model_context_window: 200000 },
      rate_limits: null,
      context: { model },
    });
  }

  /** Re-emit the current total (duplicate / refresh token_count). */
  tokensRepeat(): this {
    const last = { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0, total_tokens: 0 };
    return this.event({ type: 'token_count', info: { total_token_usage: { ...last, total_tokens: this.total }, last_token_usage: last }, rate_limits: null });
  }

  event(payload: J): this {
    return this.rec('event_msg', payload);
  }

  execEnd(callId: string, cmd: string, exitCode = 0, extra: J = {}): this {
    return this.event({
      type: 'exec_command_end',
      call_id: callId,
      process_id: '1',
      turn_id: 't',
      command: ['/bin/zsh', '-lc', cmd],
      cwd: '/work/demo',
      parsed_cmd: [{ type: 'unknown', cmd }],
      stdout: '',
      stderr: '',
      aggregated_output: exitCode === 0 ? 'ok' : 'boom',
      exit_code: exitCode,
      duration: { secs: 1, nanos: 500_000_000 },
      status: exitCode === 0 ? 'completed' : 'failed',
      ...extra,
    });
  }

  write(dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kifu-fixture-'))): string {
    const file = path.join(dir, `rollout-2026-09-01T00-00-00-${uid('thread')}.jsonl`);
    fs.writeFileSync(file, `${this.lines.map((l) => JSON.stringify(l)).join('\n')}\n`);
    return file;
  }
}

export function nested(outer: string, inner = 'exec-1111'): string {
  return `code-mode-nested:${outer.length}:${outer}:${inner}`;
}

export const CODEX_LISTING = [
  '<skills_instructions>',
  '## Skills',
  'A skill is a set of local instructions to follow that is stored in a `SKILL.md` file.',
  '### Available skills',
  '- alpha: Do alpha things (examples: reports) when asked. (file: /home/u/.codex/skills/alpha/SKILL.md)',
  '- gamma: Gamma tool. (file: /home/u/.agents/skills/gamma/SKILL.md)',
  '</skills_instructions>',
].join('\n');

export const codexItem = {
  custom: (name: string, input: string, callId: string): J => ({ type: 'custom_tool_call', status: 'completed', call_id: callId, name, input }),
  customOutput: (callId: string, text: string): J => ({ type: 'custom_tool_call_output', call_id: callId, output: text }),
  agentMessage: (text: string, author = '/root', recipient = '/root/worker'): J => ({ type: 'agent_message', author, recipient, content: [{ type: 'text', text }] }),
  webSearch: (query: string, id?: string): J => ({ type: 'web_search_call', status: 'completed', action: { type: 'search', query }, ...(id ? { id } : {}) }),
  compaction: (size: number): J => ({ type: 'compaction', id: 'cmp_1', encrypted_content: 'Q'.repeat(size) }),
};

/**
 * Synthetic Codex rollouts: one response_item record per history item (with
 * the turn in its passthrough metadata), a token_usage_record per response
 * in newer versions, tool details as item_completed events. Made-up values.
 */
export class CodexRolloutBuilder {
  readonly lines: J[] = [];
  private t = Date.parse('2026-09-02T00:00:00.000Z');
  private total = 0;

  private ts(): string {
    this.t += 1000;
    return new Date(this.t).toISOString();
  }

  rec(type: string, payload: J): this {
    this.lines.push({ timestamp: this.ts(), ordinal: this.lines.length, type, payload });
    return this;
  }

  meta(p: { id: string; cli?: string; source?: unknown; forkedFrom?: string; historyStart?: number }): this {
    return this.rec('session_meta', {
      session_id: p.id,
      id: p.id,
      timestamp: new Date(this.t).toISOString(),
      cwd: '/work/demo',
      originator: 'codex_cli_rs',
      cli_version: p.cli ?? '0.154.0',
      source: p.source ?? 'cli',
      model_provider: 'openai',
      base_instructions: { text: 'You are a coding agent.' },
      context_window: 258400,
      history_mode: 'paginated',
      ...(p.forkedFrom ? { forked_from_id: p.forkedFrom } : {}),
      ...(p.historyStart !== undefined ? { subagent_history_start_ordinal: p.historyStart } : {}),
    });
  }

  taskStarted(turnId: string): this {
    return this.event({ type: 'task_started', turn_id: turnId, started_at: this.t / 1000 });
  }

  turnContext(turnId: string, model = 'gpt-demo'): this {
    return this.rec('turn_context', { turn_id: turnId, cwd: '/work/demo', model, effort: 'medium' });
  }

  taskComplete(turnId: string): this {
    return this.event({ type: 'task_complete', turn_id: turnId, last_agent_message: 'done', duration_ms: 3000 });
  }

  /** A history item of turn `turnId`; `kinds` = content_item_kinds of a context message. */
  item(turnId: string, it: J, kinds?: string[]): this {
    return this.rec('response_item', { ...it, internal_chat_message_metadata_passthrough: { turn_id: turnId, ...(kinds ? { content_item_kinds: kinds } : {}) } });
  }

  /** token_usage_record: the usage of the response just written. */
  usage(turnId: string, input: number, output: number): this {
    const total = input + output;
    this.total += total;
    return this.rec('token_usage_record', {
      session_id: 's',
      thread_id: 's',
      turn_id: turnId,
      root_turn_id: turnId,
      response_id: `resp_${this.lines.length}`,
      usage: { input_tokens: input, cached_input_tokens: 0, cache_write_input_tokens: 7, output_tokens: output, reasoning_output_tokens: 0, total_tokens: total },
    });
  }

  /** token_count; with `last` it reports a new response (older versions), without it repeats the total. */
  tokenCount(last?: { input: number; output: number }): this {
    let lastUsage = { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0, total_tokens: 0 };
    if (last) {
      const total = last.input + last.output;
      this.total += total;
      lastUsage = { input_tokens: last.input, cached_input_tokens: 0, output_tokens: last.output, reasoning_output_tokens: 0, total_tokens: total };
    }
    return this.event({ type: 'token_count', info: { total_token_usage: { ...lastUsage, total_tokens: this.total }, last_token_usage: lastUsage, model_context_window: 258400 }, rate_limits: null });
  }

  itemCompleted(item: J): this {
    return this.event({ type: 'item_completed', thread_id: 's', turn_id: 't', item });
  }

  command(id: string, cmd: string, exitCode = 0): this {
    return this.itemCompleted({
      type: 'CommandExecution',
      id,
      command: ['/bin/zsh', '-lc', cmd],
      cwd: '/work/demo',
      process_id: '1',
      source: 'unified_exec_startup',
      parsed_cmd: [{ type: 'unknown', cmd }],
      aggregated_output: exitCode === 0 ? 'ok' : 'boom',
      exit_code: exitCode,
      duration: { secs: 2, nanos: 0 },
      status: exitCode === 0 ? 'completed' : 'failed',
    });
  }

  interAgent(trigger: boolean): this {
    return this.rec('inter_agent_communication_metadata', { trigger_turn: trigger });
  }

  compacted(history: J[]): this {
    return this.rec('compacted', { message: '', replacement_history: history });
  }

  event(payload: J): this {
    return this.rec('event_msg', payload);
  }

  write(dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kifu-codex-fixture-'))): string {
    const file = path.join(dir, `rollout-2026-09-02T00-00-00-${uid('thread')}.jsonl`);
    fs.writeFileSync(file, `${this.lines.map((l) => JSON.stringify(l)).join('\n')}\n`);
    return file;
  }
}

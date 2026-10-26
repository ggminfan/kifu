import fs from 'node:fs';
import path from 'node:path';
import type { FileInfo, LlmCall, SegmentCat, SessionTrace, TextRef, Turn, Txt, Usage } from '../../shared/types';
import { classifyPart } from '../build/classify';
import { NOT_INJECTED, TraceBuilder, type BuilderOptions } from '../build/reducer';
import type { ParseOptions, ParseResult } from '../parse';
import { parseLine, streamLines } from '../reader/lines';
import { detectSkillRead } from '../skills/detect';
import { LIMITS, contentText, mkTxt, oneLine } from '../text';

/* eslint-disable @typescript-eslint/no-explicit-any */
type J = Record<string, any>;

/**
 * Claude Code transcripts (~/.claude/projects/<project>/<session>.jsonl) as a
 * SessionTrace:
 * - one API response is written as one assistant record per content block
 *   (same message.id, possibly interleaved with tool results); it becomes one
 *   call, whose usage is the last block's;
 * - user records carry prompts, injected meta messages and tool results;
 *   attachments with `rendered` text are context the harness injected;
 * - a compact_boundary starts a new context (summary + preserved messages);
 * - subagents live in <session>/subagents/agent-<id>.jsonl, their
 *   .meta.json naming the Agent tool call that started them.
 */

/** Claude's input_tokens excludes cache reads and writes; ours is the whole prompt. */
export function claudeUsage(u: J | undefined): Usage | undefined {
  if (!u || typeof u !== 'object') return undefined;
  const cached = Number(u.cache_read_input_tokens ?? 0);
  const cacheWrite = Number(u.cache_creation_input_tokens ?? 0);
  const input = Number(u.input_tokens ?? 0) + cached + cacheWrite;
  const output = Number(u.output_tokens ?? 0);
  return { input, cached, cacheWrite, output, reasoning: 0, total: input + output };
}

/** Context categories of attachments (anything else the harness adds counts as a system reminder). */
const ATTACHMENT_CAT: Record<string, SegmentCat> = {
  skill_listing: 'skills_listing',
  invoked_skills: 'skill_content',
  instructions: 'agents_md',
  environment: 'environment',
  session_context: 'environment',
  date: 'environment',
  date_change: 'environment',
  model: 'environment',
  directory: 'environment',
  remote_session_change: 'environment',
  mcp_instructions_delta: 'plugins',
  deferred_tools_delta: 'plugins',
  agent_listing_delta: 'developer',
  queued_command: 'user',
};

/** Before 2.1.266 attachments had no `rendered` text: the field holding what the model saw. */
const LEGACY_TEXT: Record<string, string> = {
  skill_listing: 'content',
  total_tokens_reminder: 'text',
  queued_command: 'prompt',
  edited_text_file: 'snippet',
  hook_additional_context: 'content',
  task_reminder: 'content',
};

/** Records that carry nothing for the trace (titles are read by the session list). */
const QUIET_RECORDS = new Set([
  'custom-title',
  'ai-title',
  'agent-name',
  'last-prompt',
  'summary',
  'mode',
  'permission-mode',
  'queue-operation',
  'file-history-snapshot',
  'file-history-delta',
  'bridge-session',
  'atis-latch',
  'cost-state',
  'progress',
  'artifact-autoreact-ledger',
  'artifact-comment-monitor',
  'frame-link',
]);

const SKILL_BASE = /^Base directory for this skill:\s*(\S[^\n]*)/;

function readJson(p: string): J | undefined {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8')) as J;
  } catch {
    return undefined;
  }
}

/** `<command-name>/x</command-name><command-args>a</command-args>` → `/x a`. */
function commandLine(text: string): string | undefined {
  const name = /<command-name>([^<]*)<\/command-name>/.exec(text)?.[1]?.trim();
  if (!name) return undefined;
  const args = /<command-args>([^<]*)<\/command-args>/.exec(text)?.[1]?.trim();
  return args ? `${name} ${args}` : name;
}

interface AgentMeta {
  agentType?: string;
  description?: string;
  spawnDepth?: number;
}

export class ClaudeTraceBuilder extends TraceBuilder {
  /** API response (message.id) → call. */
  private callByMsg = new Map<string, LlmCall>();
  private callText = new Map<LlmCall, { reasoning: string[]; texts: string[]; rRef?: TextRef; tRef?: TextRef }>();
  /** Record uuid → the history items it created (to carry preserved messages over a compaction). */
  private itemsOf = new Map<string, number[]>();
  /** Agent tool call id → the subagent transcript it started (agent-<id>). */
  private childByToolUse = new Map<string, string>();
  private agentMeta?: AgentMeta;
  /** Turns that only ran a local slash command (no model call): dropped at the end. */
  private localOnly = new Set<string>();
  private prompts = 0;

  constructor(
    opts: BuilderOptions,
    private readonly file: string,
  ) {
    super(opts);
    const base = file.replace(/\.jsonl$/, '');
    if (path.basename(path.dirname(file)) === 'subagents') {
      this.agentMeta = readJson(`${base}.meta.json`) as AgentMeta | undefined;
      return;
    }
    const dir = path.join(base, 'subagents');
    let names: string[] = [];
    try {
      names = fs.readdirSync(dir);
    } catch {
      // no subagents
    }
    for (const f of names) {
      if (!f.endsWith('.meta.json')) continue;
      const m = readJson(path.join(dir, f));
      if (typeof m?.toolUseId === 'string') this.childByToolUse.set(m.toolUseId, f.replace(/\.meta\.json$/, ''));
    }
  }

  override push(line: number, rec: J): void {
    const ts = typeof rec.timestamp === 'string' ? rec.timestamp : undefined;
    this.curTs = ts;
    this.onMeta(rec, ts);
    switch (rec.type) {
      case 'user':
        this.onUser(rec, line, ts);
        break;
      case 'assistant':
        this.onAssistant(rec, line, ts);
        break;
      case 'attachment':
        this.onAttachment(rec, line);
        break;
      case 'system':
        this.onSystem(rec, line, ts);
        break;
      case 'fork-context-ref': {
        // a forked subagent continues from its parent's context (not in this file); its task is the Agent call's
        this.sinceCall.push(this.newItem(line, 'other', 'other', `[继承父会话的前 ${rec.contextLength ?? '?'} 条消息]`, { line, ptr: '/contextLength' }));
        const task = this.agentMeta?.description;
        const t = this.startTurn(undefined, line, ts);
        t.trigger = 'inter_agent';
        if (task) t.input = { preview: task, chars: task.length };
        this.prompts++;
        break;
      }
      default:
        if (!QUIET_RECORDS.has(String(rec.type))) this.diag('unknown_record', String(rec.type), line);
    }
    if (ts) this.prevTs = ts;
  }

  private onMeta(rec: J, ts?: string): void {
    if (typeof rec.sessionId !== 'string') return;
    if (!this.sawMeta) {
      this.sawMeta = true;
      this.meta = { threadId: rec.sessionId, modelProvider: 'anthropic' };
    }
    if (typeof rec.agentId === 'string' && !this.meta.spawn) {
      // subagent transcripts carry the parent's sessionId; their own id is the file name agent-<id>
      this.meta.threadId = `agent-${rec.agentId}`;
      this.meta.source = 'subagent';
      this.meta.spawn = {
        parentThreadId: rec.sessionId,
        depth: this.agentMeta?.spawnDepth,
        nickname: this.agentMeta?.description,
        role: this.agentMeta?.agentType,
      };
    }
    if (typeof rec.uuid !== 'string') return; // titles, queue operations … carry no session details
    this.meta.cwd ??= rec.cwd;
    this.meta.cliVersion ??= rec.version;
    this.meta.originator ??= rec.entrypoint;
    this.meta.source ??= rec.entrypoint;
    this.meta.startedAt ??= ts;
  }

  // ---------------------------------------------------------------- user records

  private onUser(rec: J, line: number, ts?: string): void {
    const content = rec.message?.content;
    const created: number[] = [];
    if (typeof content === 'string') {
      created.push(...this.userText(rec, content, line, '/message/content', ts));
    } else if (Array.isArray(content)) {
      content.forEach((b: J, j: number) => {
        const ptr = `/message/content/${j}`;
        if (b?.type === 'tool_result') created.push(this.toolResult(rec, b, line, ptr));
        else if (b?.type === 'text') created.push(...this.userText(rec, String(b.text ?? ''), line, `${ptr}/text`, ts));
        else if (b?.type === 'image' || b?.type === 'document') {
          created.push(this.newItem(line, 'message', rec.isMeta ? 'other' : 'user', `[${b.type}]`, { line, ptr }, { role: 'user' }));
        }
      });
    }
    this.sinceCall.push(...created);
    if (typeof rec.uuid === 'string') this.itemsOf.set(rec.uuid, created);
  }

  private userText(rec: J, text: string, line: number, ptr: string, ts?: string): number[] {
    if (!text) return [];
    const t = text.trimStart();
    const ref: TextRef = { line, ptr };
    let cat: SegmentCat;
    let trigger: Turn['trigger'] | undefined;
    let input: Txt | undefined;
    if (rec.isCompactSummary) cat = 'compaction_summary';
    else if (rec.isMeta) {
      const c = classifyPart('user', text);
      cat = SKILL_BASE.test(t) ? 'skill_content' : c === 'user' ? 'system_reminder' : c;
    } else if (t.startsWith('[Request interrupted by user')) {
      cat = 'other';
      if (this.turn) {
        this.mark('abort', line, ts, '用户中断');
        this.turn.status = 'aborted';
      }
    } else if (t.startsWith('<task-notification>')) {
      cat = 'system_reminder';
      trigger = 'system';
    } else if (t.startsWith('<command-name>') || t.startsWith('<command-message>')) {
      cat = 'user';
      trigger = 'user';
      const cmd = commandLine(t);
      if (cmd) input = { preview: cmd.slice(0, LIMITS.input), chars: text.length, ref };
    } else if (/^<local-command-(stdout|stderr|caveat)>/.test(t)) {
      cat = 'other';
      // a local slash command (/model, /context …): its turn never reaches the model
      if (this.turn && !this.turn.calls.length && this.turn.input?.preview.startsWith('/')) this.localOnly.add(this.turn.id);
    } else if (/^<bash-(input|stdout|stderr)>/.test(t)) {
      cat = 'user';
    } else {
      cat = classifyPart('user', text);
      if (cat === 'user') trigger = this.meta.spawn && this.prompts === 0 ? 'inter_agent' : 'user';
    }

    if (trigger) {
      this.prompts++;
      const turn = this.startTurn(typeof rec.promptId === 'string' ? rec.promptId : undefined, line, ts);
      if (!turn.input) {
        turn.trigger = trigger;
        turn.input = input ?? mkTxt(text, LIMITS.input, ref);
      }
    }
    const idx = this.newItem(line, 'message', cat, text, ref, { role: 'user' });
    this.inspectMessage(text, cat, idx, line, false);
    if (cat === 'skill_content') this.skillContent(rec, t, idx, line);
    return [idx];
  }

  /** Skill instructions the harness injected: after a Skill tool call, or for a /skill command. */
  private skillContent(rec: J, text: string, idx: number, line: number): void {
    const dir = SKILL_BASE.exec(text)?.[1]?.trim();
    if (!dir) return;
    const skillPath = `${dir.replace(/\/$/, '')}/SKILL.md`;
    const name = path.basename(dir);
    const inv = typeof rec.sourceToolUseID === 'string' ? this.invocations.find((v) => v.toolCallId === rec.sourceToolUseID) : undefined;
    if (inv) {
      inv.contentItem ??= idx;
      inv.path ??= skillPath;
      return;
    }
    this.addMention(name, skillPath, line, idx);
  }

  private toolResult(rec: J, b: J, line: number, ptr: string): number {
    const id = String(b.tool_use_id ?? '');
    const text = typeof b.content === 'string' ? b.content : contentText(b.content);
    const ref: TextRef = { line, ptr: `${ptr}/content` };
    const idx = this.newItem(line, 'function_call_output', 'tool_output', text, ref, { callId: id });
    const tool = this.tools.get(id);
    if (!tool) {
      this.diag('unmatched_output', 'tool_result', line);
      return idx;
    }
    tool.output = mkTxt(text, LIMITS.output, ref);
    tool.outputLine = line;
    tool.outputTs = this.curTs;
    tool.status = 'done';
    if (tool.ts && this.curTs) {
      const d = Date.parse(this.curTs) - Date.parse(tool.ts);
      if (d >= 0) tool.durationMs ??= d;
    }
    if (b.is_error === true) {
      tool.isError = true;
      tool.errorReason = oneLine(text, 200);
    }
    const res = rec.toolUseResult;
    if (res && typeof res === 'object' && !Array.isArray(res) && typeof res.agentId === 'string') {
      const child = `agent-${res.agentId}`;
      tool.childThreadId ??= child;
      const sub = this.subByCall.get(id);
      if (sub) {
        sub.childThreadId ??= child;
        sub.status ??= typeof res.status === 'string' ? res.status : undefined;
      }
    }
    // (a Skill call's instructions arrive in the meta message that follows: see skillContent)
    return idx;
  }

  // ---------------------------------------------------------------- assistant records

  private onAssistant(rec: J, line: number, ts?: string): void {
    const m: J = rec.message ?? {};
    if (rec.isApiErrorMessage) {
      if (!this.turn) this.startTurn(undefined, line, ts);
      this.mark('error', line, ts, oneLine(contentText(m.content) || 'API error', 400));
      this.turn!.status = 'failed';
      return;
    }
    if (m.model === '<synthetic>') return; // placeholders the harness wrote, not a model response

    const key = String(m.id ?? rec.requestId ?? rec.uuid ?? `line${line}`);
    const call = this.callByMsg.get(key) ?? this.newCall(key, m, line, ts);
    const usage = claudeUsage(m.usage);
    if (usage) call.usage = usage; // later blocks of a response carry the more complete usage

    const created: number[] = [];
    const blocks: J[] = Array.isArray(m.content) ? m.content : [];
    blocks.forEach((b, j) => {
      const ptr = `/message/content/${j}`;
      switch (b?.type) {
        case 'thinking': {
          const text = String(b.thinking ?? '');
          created.push(this.newItem(line, 'reasoning', 'reasoning', text, { line, ptr: `${ptr}/thinking` }));
          this.appendText(call, 'reasoning', text, { line, ptr: `${ptr}/thinking` });
          break;
        }
        case 'redacted_thinking':
          created.push(this.newItem(line, 'reasoning', 'reasoning', '[redacted thinking]', { line, ptr }));
          break;
        case 'text': {
          const text = String(b.text ?? '');
          created.push(this.newItem(line, 'message', 'assistant', text, { line, ptr: `${ptr}/text` }, { role: 'assistant' }));
          this.appendText(call, 'text', text, { line, ptr: `${ptr}/text` });
          break;
        }
        case 'tool_use':
        case 'server_tool_use': {
          const input = b.input ?? {};
          created.push(this.newItem(line, 'custom_tool_call', 'tool_call', JSON.stringify(input), { line, ptr: `${ptr}/input` }, { name: b.name, callId: b.id }));
          this.addToolCall({ type: 'custom_tool_call', name: b.name, input, call_id: b.id }, call, line, j, ts, ptr);
          this.afterToolUse(String(b.id), b.name, input);
          break;
        }
        default:
          created.push(this.newItem(line, 'other', 'other', JSON.stringify(b ?? null).slice(0, 4000), { line, ptr }));
      }
    });
    call.outputItems.push(...created);
    if (typeof rec.uuid === 'string') this.itemsOf.set(rec.uuid, created);

    if (m.stop_reason === 'end_turn' && this.turn && call.turnId === this.turn.id) {
      const t = this.turn;
      t.endedAt = ts;
      if (t.startedAt && ts) t.durationMs = Date.parse(ts) - Date.parse(t.startedAt);
      t.lastAgentMessage = call.text;
      if (t.status === 'open') t.status = 'completed';
    }
  }

  private newCall(key: string, m: J, line: number, ts?: string): LlmCall {
    const turn = this.turn ?? this.startTurn(undefined, line, ts);
    const model = typeof m.model === 'string' ? m.model : undefined;
    const call: LlmCall = {
      index: this.calls.length,
      turnId: turn.id,
      kind: 'response',
      line,
      ts,
      startTs: this.prevTs,
      model,
      view: { epoch: this.cur, len: this.epochs[this.cur].length },
      injected: this.sinceCall.filter((idx) => !NOT_INJECTED.has(this.items[idx].cat)),
      outputItems: [],
      tools: [],
      fidelity: 'reconstructed',
    };
    this.sinceCall = [];
    this.calls.push(call);
    turn.calls.push(call.index);
    turn.model ??= model;
    turn.cwd ??= this.meta.cwd;
    this.meta.model ??= model;
    this.callByMsg.set(key, call);
    return call;
  }

  private appendText(call: LlmCall, kind: 'reasoning' | 'text', text: string, ref: TextRef): void {
    if (!text) return;
    let acc = this.callText.get(call);
    if (!acc) {
      acc = { reasoning: [], texts: [] };
      this.callText.set(call, acc);
    }
    if (kind === 'reasoning') {
      acc.reasoning.push(text);
      acc.rRef ??= ref;
      call.reasoning = mkTxt(acc.reasoning.join('\n\n'), LIMITS.output, acc.rRef);
    } else {
      acc.texts.push(text);
      acc.tRef ??= ref;
      call.text = mkTxt(acc.texts.join('\n\n'), LIMITS.input, acc.tRef);
    }
  }

  private afterToolUse(id: string, name: unknown, input: J): void {
    const tool = this.tools.get(id);
    if (!tool) return;
    if (name === 'Bash' && typeof input.command === 'string') {
      const r = detectSkillRead(input.command);
      if (r) this.addImplicitRead(r, tool);
    }
    const child = this.childByToolUse.get(id);
    if (child) {
      tool.childThreadId = child;
      const sub = this.subByCall.get(id);
      if (sub) sub.childThreadId = child;
    }
  }

  // ---------------------------------------------------------------- attachments, system records

  private onAttachment(rec: J, line: number): void {
    const a: J = rec.attachment ?? {};
    const type = String(a.type ?? 'unknown');
    if (type === 'prompt_snapshot') {
      if (!this.meta.baseInstructions && Array.isArray(a.systemPrompt)) {
        this.meta.baseInstructions = mkTxt(a.systemPrompt.join('\n\n'), LIMITS.meta, { line, ptr: '/attachment/systemPrompt' });
      }
      return;
    }
    let text: string | undefined;
    let ptr = '/rendered';
    if (Array.isArray(rec.rendered)) {
      text = rec.rendered.map((r: J) => (typeof r?.content === 'string' ? r.content : contentText(r?.content))).join('\n');
    } else {
      const field = LEGACY_TEXT[type];
      if (field && typeof a[field] === 'string') {
        text = a[field];
        ptr = `/attachment/${field}`;
      }
    }
    if (!text) return;
    const listed = classifyPart('user', text) === 'skills_listing';
    const cat = ATTACHMENT_CAT[type] ?? (listed ? 'skills_listing' : 'system_reminder');
    const idx = this.newItem(line, 'message', cat, text, { line, ptr }, { role: rec.renderedRole === 'system' ? 'system' : 'user', name: type });
    this.inspectMessage(text, cat, idx, line, false);
    this.sinceCall.push(idx);
    if (typeof rec.uuid === 'string') this.itemsOf.set(rec.uuid, [idx]);
  }

  private onSystem(rec: J, line: number, ts?: string): void {
    switch (rec.subtype) {
      case 'compact_boundary': {
        // the context restarts from the summary plus the messages compaction preserved
        const m: J = rec.compactMetadata ?? {};
        const preserved: unknown[] = Array.isArray(m.preservedMessages?.uuids) ? m.preservedMessages.uuids : [];
        const keep = preserved.flatMap((u) => this.itemsOf.get(String(u)) ?? []).sort((a, b) => a - b);
        this.epochs.push(keep);
        this.cur = this.epochs.length - 1;
        this.sinceCall = [];
        const detail = typeof m.preTokens === 'number' ? `${m.trigger === 'manual' ? '手动' : '自动'}压缩 ${m.preTokens} → ${m.postTokens ?? '?'} tokens` : undefined;
        this.mark('compaction', line, ts, detail);
        return;
      }
      case 'turn_duration': {
        const t = this.turn;
        if (!t) return;
        if (typeof rec.durationMs === 'number') t.durationMs = rec.durationMs;
        t.endedAt ??= ts;
        if (t.status === 'open') t.status = 'completed';
        return;
      }
      case 'api_error': {
        const e: J = rec.error ?? {};
        const msg = String(e.message ?? e.error?.message ?? rec.content ?? 'API error');
        this.mark('error', line, ts, oneLine(rec.retryAttempt ? `${msg}（重试 ${rec.retryAttempt}/${rec.maxRetries ?? '?'}）` : msg, 400));
        return;
      }
      default:
    }
  }

  override finish(file: FileInfo): SessionTrace {
    if (!this.meta.threadId) this.meta.threadId = path.basename(this.file, '.jsonl');
    if (this.localOnly.size) {
      this.turns = this.turns.filter((t) => !this.localOnly.has(t.id) || t.calls.length > 0 || t.marks.length > 0);
      this.turns.forEach((t, i) => (t.index = i));
    }
    // stop_reason is often missing from streamed records: a turn whose last response called no tools is done
    for (const t of this.turns) {
      if (t.status !== 'open' || !t.calls.length) continue;
      const last = this.calls[t.calls[t.calls.length - 1]];
      if (last.tools.length) continue;
      t.status = 'completed';
      t.endedAt ??= last.ts;
      if (t.durationMs === undefined && t.startedAt && t.endedAt) t.durationMs = Date.parse(t.endedAt) - Date.parse(t.startedAt);
      t.lastAgentMessage ??= last.text;
    }
    return super.finish(file);
  }
}

function kindOf(rec: J): string {
  const t = String(rec.type ?? 'unknown');
  if (t === 'attachment') return `attachment:${rec.attachment?.type ?? '?'}`;
  if (t === 'system') return `system:${rec.subtype ?? '?'}`;
  return t;
}

export async function parseClaudeSession(file: string, opts: ParseOptions = {}): Promise<ParseResult> {
  const st = await fs.promises.stat(file);
  const offsets: number[] = [];
  const lengths: number[] = [];
  const kinds: string[] = [];
  const builder = new ClaudeTraceBuilder({ homeDir: opts.homeDir }, file);
  let bytes = 0;
  let lastReport = 0;
  for await (const { line, offset, data } of streamLines(file)) {
    while (kinds.length < line) {
      offsets.push(offset);
      lengths.push(0);
      kinds.push('');
    }
    offsets.push(offset);
    lengths.push(data.length);
    bytes += data.length + 1;
    if (opts.onProgress && bytes - lastReport > 32 * 1024 * 1024) {
      lastReport = bytes;
      opts.onProgress(bytes, st.size);
    }
    let rec: J;
    try {
      rec = parseLine(data, line).rec as J;
    } catch (e) {
      kinds.push('unknown');
      builder.diag('parse_error', (e as Error).message.slice(0, 120), line);
      continue;
    }
    kinds.push(kindOf(rec));
    builder.push(line, rec);
  }
  const trace = builder.finish({ path: file, size: st.size, mtimeMs: st.mtimeMs, lines: kinds.length });
  return { trace, index: { offsets, lengths, kinds } };
}

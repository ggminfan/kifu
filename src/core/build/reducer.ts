import {
  PARSER_VERSION,
  addUsage,
  emptyUsage,
  type Diagnostic,
  type FileInfo,
  type HistItem,
  type HistItemKind,
  type InnerEvent,
  type LlmCall,
  type SegmentCat,
  type SessionMeta,
  type SessionTrace,
  type SkillInvocation,
  type SkillListing,
  type SubagentLink,
  type TextRef,
  type ToolCall,
  type Turn,
  type TurnMark,
  type Usage,
} from '../../shared/types';
import {
  detectSkillRead,
  detectSkillResource,
  parseListing,
  parseSkillBlock,
  skillNameFromPath,
  type SkillRead,
} from '../skills/detect';
import { LIMITS, contentText, mkTxt, oneLine, partText, tryJson, weightedChars } from '../text';
import { classifyCodexPart, isOutputItem, toolKind } from './classify';
import { QUIET_EVENTS, TOOL_EVENTS, codexItemEvent, commandString, eventCallId, toInnerEvent, type EventCore } from './events';

/* eslint-disable @typescript-eslint/no-explicit-any */
type J = Record<string, any>;

export interface BuilderOptions {
  /** Lines before this index are copied from another session (forked subagents, replays): context only. */
  forkPrefixEnd?: number;
  forkKind?: 'full' | 'partial' | 'replay';
  /** Used to expand `~/` in skill paths. */
  homeDir?: string;
}

function toUsage(u: J): Usage {
  return {
    input: Number(u.input_tokens ?? 0),
    cached: Number(u.cached_input_tokens ?? 0),
    cacheWrite: Number(u.cache_creation_input_tokens ?? u.cache_write_input_tokens ?? 0),
    output: Number(u.output_tokens ?? 0),
    reasoning: Number(u.reasoning_output_tokens ?? 0),
    total: Number(u.total_tokens ?? 0),
  };
}

/** Categories that are not harness-injected context. */
export const NOT_INJECTED = new Set<SegmentCat>(['user', 'assistant', 'reasoning', 'tool_call', 'tool_output', 'inter_agent', 'compaction_summary']);

function itemText(it: J): string {
  switch (it.type) {
    case 'reasoning': {
      const c = contentText(it.content);
      if (c) return c;
      return Array.isArray(it.summary) ? it.summary.map(partText).join('\n') : '';
    }
    case 'function_call':
      return typeof it.arguments === 'string' ? it.arguments : JSON.stringify(it.arguments ?? '');
    case 'custom_tool_call':
      return typeof it.input === 'string' ? it.input : JSON.stringify(it.input ?? '');
    case 'function_call_output':
    case 'custom_tool_call_output': {
      const o = it.output;
      if (o && typeof o === 'object' && !Array.isArray(o) && 'content' in o) return contentText(o.content);
      return contentText(o);
    }
    default:
      return contentText(it.content);
  }
}

/**
 * Streaming reducer over Codex rollout records. Feed records in file order
 * with `push(line, record)`, then call `finish()`.
 */
export class TraceBuilder {
  protected meta: SessionMeta = { threadId: '' };
  protected sawMeta = false;
  protected items: HistItem[] = [];
  protected epochs: number[][] = [[]];
  protected cur = 0;
  protected turns: Turn[] = [];
  protected turnById = new Map<string, Turn>();
  protected turn?: Turn;
  protected calls: LlmCall[] = [];
  protected pending?: LlmCall;
  protected lastOrphan?: LlmCall;
  protected lastTotal = -1;
  protected tools = new Map<string, ToolCall>();
  protected execStack: string[] = [];
  protected cells = new Map<string, string>();
  protected listings: SkillListing[] = [];
  protected invocations: SkillInvocation[] = [];
  protected mentionKeys = new Set<string>();
  protected skillPaths = new Map<string, string>();
  protected subagents: SubagentLink[] = [];
  protected subByCall = new Map<string, SubagentLink>();
  protected orphans: InnerEvent[] = [];
  protected diags = new Map<string, Diagnostic>();
  protected prevTs?: string;
  protected curTs?: string;
  protected lastWasCountChange = false;
  // The response whose output items are still arriving, and its texts.
  protected open?: LlmCall;
  protected openText = { reasoning: [] as string[], texts: [] as string[], rRef: undefined as TextRef | undefined, tRef: undefined as TextRef | undefined };
  /** Input items added since the last call. */
  protected sinceCall: number[] = [];
  /** token_usage_record seen, so token_count no longer carries per-response usage. */
  protected usageRecords = false;
  /** The next agent_message starts a turn (inter_agent_communication_metadata.trigger_turn). */
  protected agentTrigger = false;
  /** A web search reported before its web_search_call item. */
  protected pendingSearch?: EventCore & { id: string };

  constructor(private readonly opts: BuilderOptions = {}) {}

  push(line: number, rec: J): void {
    const ts = typeof rec.timestamp === 'string' ? rec.timestamp : undefined;
    const p: J = rec.payload && typeof rec.payload === 'object' ? rec.payload : {};
    const inPrefix = this.opts.forkPrefixEnd !== undefined && line < this.opts.forkPrefixEnd;
    this.curTs = ts;
    const wasCountChange = this.lastWasCountChange;
    this.lastWasCountChange = false;
    switch (rec.type) {
      case 'session_meta':
        this.onSessionMeta(p, line, ts);
        break;
      case 'turn_context':
        if (!inPrefix) this.onTurnContext(p);
        break;
      case 'world_state':
        break;
      case 'event_msg':
        this.onEvent(p, line, ts, inPrefix);
        break;
      case 'response_item':
        this.onResponseItem(p, line, ts, inPrefix);
        break;
      case 'compacted':
        this.onCompacted(p, line, ts, inPrefix, wasCountChange);
        break;
      case 'token_usage_record':
        this.onUsageRecord(p, line, ts, inPrefix);
        break;
      case 'inter_agent_communication_metadata':
        this.agentTrigger = Boolean(p.trigger_turn);
        break;
      default:
        this.diag('unknown_record', String(rec.type), line);
    }
    if (ts) this.prevTs = ts;
  }

  diag(kind: Diagnostic['kind'], detail: string, line: number): void {
    const key = `${kind}:${detail}`;
    const d = this.diags.get(key);
    if (d) d.count++;
    else this.diags.set(key, { kind, detail, count: 1, firstLine: line });
  }

  // ---------------------------------------------------------------- meta

  protected onSessionMeta(p: J, line: number, ts?: string): void {
    if (!this.sawMeta) {
      this.sawMeta = true;
      const src = p.source;
      const spawn = src && typeof src === 'object' ? src.subagent?.thread_spawn : undefined;
      this.meta = {
        threadId: String(p.id ?? ''),
        cwd: p.cwd,
        cliVersion: p.cli_version,
        originator: p.originator,
        source: typeof src === 'string' ? src : src && typeof src === 'object' && 'subagent' in src ? 'subagent' : undefined,
        modelProvider: p.model_provider,
        startedAt: p.timestamp ?? ts,
        baseInstructions: mkTxt(p.base_instructions?.text, LIMITS.meta, { line, ptr: '/payload/base_instructions/text' }),
        forkedFromId: p.forked_from_id ?? undefined,
        contextWindow: typeof p.context_window === 'number' ? p.context_window : undefined,
      };
      if (spawn) {
        this.meta.spawn = {
          parentThreadId: String(spawn.parent_thread_id ?? ''),
          depth: spawn.depth,
          agentPath: spawn.agent_path ?? p.agent_path,
          nickname: spawn.agent_nickname ?? p.agent_nickname,
          role: spawn.agent_role ?? p.agent_role,
        };
      }
    }
  }

  protected onTurnContext(p: J): void {
    this.meta.model ??= p.model;
    this.meta.cwd ??= p.cwd;
    if (this.turn) {
      this.turn.model ??= p.model;
      this.turn.cwd ??= p.cwd;
    }
  }

  // ---------------------------------------------------------------- turns

  protected startTurn(id: unknown, line: number, ts?: string): Turn {
    const turnId = typeof id === 'string' && id ? id : `implicit-${line}`;
    let t = this.turnById.get(turnId);
    if (!t) {
      t = { id: turnId, index: this.turns.length, startLine: line, startedAt: ts, trigger: 'unknown', calls: [], marks: [], status: 'open' };
      this.turns.push(t);
      this.turnById.set(turnId, t);
    }
    this.turn = t;
    this.execStack = [];
    this.open = undefined;
    this.dropPendingSearch();
    return t;
  }

  protected turnFor(turnId: unknown, line: number, ts?: string): Turn {
    if (typeof turnId === 'string' && this.turnById.has(turnId)) return this.turnById.get(turnId)!;
    return this.turn ?? this.startTurn(turnId, line, ts);
  }

  protected mark(kind: TurnMark['kind'], line: number, ts?: string, detail?: string): void {
    const t = this.turn ?? this.startTurn(undefined, line, ts);
    const last = t.marks[t.marks.length - 1];
    if (kind === 'compaction' && last?.kind === 'compaction' && line - last.line < 8) return;
    t.marks.push({ kind, line, ts, detail });
  }

  protected endTurn(p: J, line: number, ts?: string): void {
    this.open = undefined;
    const t = (typeof p.turn_id === 'string' && this.turnById.get(p.turn_id)) || this.turn;
    if (!t) return;
    t.endLine = line;
    t.endedAt = ts;
    t.durationMs =
      typeof p.duration_ms === 'number'
        ? p.duration_ms
        : t.startedAt && ts
          ? Date.parse(ts) - Date.parse(t.startedAt)
          : undefined;
    if (typeof p.time_to_first_token_ms === 'number') t.ttftMs = p.time_to_first_token_ms;
    t.lastAgentMessage = mkTxt(p.last_agent_message, LIMITS.output, { line, ptr: '/payload/last_agent_message' });
    if (p.error) {
      t.status = 'failed';
      const msg = typeof p.error === 'string' ? p.error : (p.error.message ?? JSON.stringify(p.error));
      t.marks.push({ kind: 'error', line, ts, detail: oneLine(String(msg), 400) });
    } else if (t.status === 'open') {
      t.status = 'completed';
    }
  }

  // ---------------------------------------------------------------- history

  protected newItem(
    line: number,
    kind: HistItemKind,
    cat: SegmentCat,
    text: string,
    ref: TextRef,
    extra: Partial<Pick<HistItem, 'role' | 'name' | 'callId'>> = {},
  ): number {
    const idx = this.items.length;
    this.items.push({
      idx,
      line,
      kind,
      cat,
      chars: text.length,
      wchars: Math.round(weightedChars(text)),
      preview: text.length > LIMITS.item ? text.slice(0, LIMITS.item) : text,
      ref,
      ...extra,
    });
    this.epochs[this.cur].push(idx);
    return idx;
  }

  /** Add one history item (messages split per content part). Returns the created item indices. */
  protected addItem(it: J, line: number, i: number, inPrefix: boolean, ptrBase = `/payload/items/${i}`): number[] {
    switch (it.type) {
      case 'message': {
        const parts: unknown[] = Array.isArray(it.content) ? it.content : [{ type: 'input_text', text: contentText(it.content) }];
        const kinds: unknown[] | undefined = it.internal_chat_message_metadata_passthrough?.content_item_kinds;
        const out: number[] = [];
        parts.forEach((part, j) => {
          const text = partText(part);
          if (!text) return;
          const cat = classifyCodexPart(kinds?.[j], it.role, text);
          const idx = this.newItem(line, 'message', cat, text, { line, ptr: `${ptrBase}/content/${j}/text` }, { role: it.role });
          out.push(idx);
          this.inspectMessage(text, cat, idx, line, inPrefix);
          // a turn without a user_message event: take the first user text of the turn.
          if (cat === 'user' && !inPrefix && this.turn && !this.turn.input) {
            this.turn.input = mkTxt(text, LIMITS.input, { line, ptr: `${ptrBase}/content/${j}/text` });
            this.turn.trigger = 'user';
          }
        });
        return out;
      }
      case 'reasoning':
        return [
          this.newItem(line, 'reasoning', 'reasoning', itemText(it), { line, ptr: `${ptrBase}/${contentText(it.content) ? 'content' : 'summary'}` }),
        ];
      case 'function_call':
        return [
          this.newItem(line, 'function_call', 'tool_call', itemText(it), { line, ptr: `${ptrBase}/arguments` }, { name: it.name, callId: it.call_id }),
        ];
      case 'custom_tool_call':
        return [
          this.newItem(line, 'custom_tool_call', 'tool_call', itemText(it), { line, ptr: `${ptrBase}/input` }, { name: it.name, callId: it.call_id }),
        ];
      case 'function_call_output':
      case 'custom_tool_call_output': {
        const text = itemText(it);
        const idx = this.newItem(line, it.type, 'tool_output', text, { line, ptr: `${ptrBase}/output` }, { callId: it.call_id });
        if (!inPrefix) this.attachOutput(it, text, idx, line);
        return [idx];
      }
      case 'web_search_call':
        return [this.newItem(line, 'other', 'tool_call', JSON.stringify(it.action ?? {}), { line, ptr: `${ptrBase}/action` }, { name: 'web_search' })];
      case 'agent_message':
        return [
          this.newItem(line, 'inter_agent', 'inter_agent', `message ${it.author ?? '?'} → ${it.recipient ?? '?'}\n${contentText(it.content)}`, {
            line,
            ptr: `${ptrBase}/content`,
          }, { role: it.author }),
        ];
      case 'compaction': {
        // Codex remote compaction: the summary is encrypted; weigh it by its size.
        const idx = this.newItem(line, 'other', 'compaction_summary', '[压缩摘要（已加密）]', { line, ptr: ptrBase });
        const enc = typeof it.encrypted_content === 'string' ? it.encrypted_content.length : 0;
        if (enc) this.items[idx].wchars = Math.round((enc * 0.75) / 4);
        return [idx];
      }
      default: {
        const text = itemText(it) || JSON.stringify(it).slice(0, 4000);
        return [this.newItem(line, 'other', 'other', text, { line, ptr: ptrBase })];
      }
    }
  }

  protected inspectMessage(text: string, cat: SegmentCat, idx: number, line: number, inPrefix: boolean): void {
    if (cat === 'skills_listing' || (cat !== 'user' && text.includes('## Host skills update'))) {
      const parsed = parseListing(text);
      if (parsed) {
        this.listings.push({ line, itemIdx: idx, ...parsed });
        for (const e of parsed.entries) if (e.path) this.skillPaths.set(this.expand(e.path), e.name);
      }
    }
    if (cat === 'skill_content' && !inPrefix) {
      const block = parseSkillBlock(text);
      if (block) this.addMention(block.name ?? skillNameFromPath(block.path ?? ''), block.path, line, idx);
    }
  }

  protected expand(p: string): string {
    const home = this.opts.homeDir ?? process.env.HOME ?? '';
    return p.startsWith('~/') && home ? `${home}${p.slice(1)}` : p;
  }

  protected addMention(skill: string, path: string | undefined, line: number, contentItem?: number): void {
    const key = `${this.turn?.id ?? ''}:${skill}`;
    if (this.mentionKeys.has(key)) {
      const prev = this.invocations.find((v) => v.mode === 'mention' && `${this.turn?.id ?? ''}:${v.skill}` === key);
      if (prev && contentItem !== undefined) prev.contentItem ??= contentItem;
      return;
    }
    this.mentionKeys.add(key);
    this.invocations.push({ skill, path, mode: 'mention', callIndex: this.calls.length, line, contentItem });
  }

  // ---------------------------------------------------------------- tools

  protected addToolCall(it: J, call: LlmCall, line: number, i: number, ts?: string, ptrBase = `/payload/items/${i}`): void {
    const name = String(it.name ?? 'unknown');
    const namespace: string | undefined = typeof it.namespace === 'string' ? it.namespace : undefined;
    const id = String(it.call_id ?? it.id ?? `line${line}:${i}`);
    const kind = toolKind(name, namespace);
    const custom = it.type === 'custom_tool_call';
    const raw = custom ? it.input : it.arguments;
    const argsStr = typeof raw === 'string' ? raw : JSON.stringify(raw ?? '');
    const parsed = (raw && typeof raw === 'object' ? raw : argsStr.length < 256 * 1024 ? tryJson(argsStr) : undefined) as J | undefined;
    let display = argsStr;
    let ref: TextRef = { line, ptr: `${ptrBase}/${custom ? 'input' : 'arguments'}` };
    // a field of the arguments: inside their JSON string, or a plain pointer when they are an object (Claude Code)
    const argsRef = ref;
    const field = (f: string): TextRef => (typeof raw === 'string' ? { ...argsRef, json: f } : { line, ptr: `${argsRef.ptr}${f}` });
    if (kind === 'code_exec' && typeof parsed?.input === 'string') {
      display = parsed.input;
      ref = field('/input');
    }
    const tool: ToolCall = {
      id,
      callIndex: call.index,
      name,
      namespace,
      kind,
      args: mkTxt(display, LIMITS.args, ref)!,
      argsJson: argsStr.length < 4096 && parsed && typeof parsed === 'object' ? parsed : undefined,
      status: 'pending',
      isError: false,
      inner: [],
      ts,
    };

    if (kind === 'wait' && parsed?.cell_id !== undefined) tool.waitsFor = this.cells.get(String(parsed.cell_id));

    if (kind === 'skill') {
      const s = parsed?.skill ?? parsed?.name ?? parsed?.command;
      if (typeof s === 'string' && s) {
        tool.skill = s.replace(/^\//, '');
        this.invocations.push({ skill: tool.skill, mode: 'tool', callIndex: call.index, toolCallId: id, line });
      }
    }
    if ((name === 'Read' || name === 'read_file') && typeof parsed?.file_path === 'string' && /SKILL\.md$/i.test(parsed.file_path)) {
      const offset = Number(parsed.offset ?? 1);
      const lines: [number, number] | undefined = parsed.limit ? [offset, offset + Number(parsed.limit) - 1] : undefined;
      this.addImplicitRead({ path: parsed.file_path, lines }, tool);
    }
    if (kind === 'code_exec') {
      for (const s of detectSkillResource(display)) {
        this.invocations.push({ skill: s, mode: 'resource', callIndex: call.index, toolCallId: id, line });
        tool.skill ??= s;
      }
    }
    if (kind === 'collab' && /spawn_agent$|^Agent$|^Task$/.test(name)) {
      const link: SubagentLink = {
        spawnCallId: id,
        taskName: parsed?.task_name ?? parsed?.description,
        role: parsed?.agent_type ?? parsed?.subagent_type,
        forkTurns: parsed?.fork_turns !== undefined ? String(parsed.fork_turns) : undefined,
        model: parsed?.model,
        prompt: mkTxt(parsed?.message ?? parsed?.prompt, LIMITS.item, field(parsed?.message ? '/message' : '/prompt')),
        line,
        callIndex: call.index,
      };
      this.subagents.push(link);
      this.subByCall.set(id, link);
    }

    this.tools.set(id, tool);
    call.tools.push(id);
    if (kind === 'code_exec') this.execStack.push(id);
  }

  protected attachOutput(it: J, text: string, idx: number, line: number): void {
    const id = String(it.call_id ?? '');
    const tool = this.tools.get(id);
    if (!tool) {
      this.diag('unmatched_output', String(it.type), line);
      return;
    }
    tool.output = mkTxt(text, LIMITS.output, this.items[idx].ref);
    tool.outputLine = line;
    tool.outputTs = this.curTs;
    tool.status = 'done';
    if (tool.durationMs === undefined && tool.ts && this.curTs) {
      const d = Date.parse(this.curTs) - Date.parse(tool.ts);
      if (d >= 0) tool.durationMs = d;
    }
    const head = text.slice(0, 240);
    if (tool.kind === 'code_exec') {
      const cell = /Script running with cell ID (\S+)/.exec(head);
      if (cell) {
        tool.status = 'running';
        tool.cellId = cell[1];
        this.cells.set(cell[1], tool.id);
      } else if (/^Script failed/.test(head)) {
        tool.isError = true;
        tool.errorReason = oneLine(text, 200);
      }
    } else if (tool.kind === 'wait') {
      const exec = tool.waitsFor ? this.tools.get(tool.waitsFor) : undefined;
      if (/^Script failed/.test(head)) {
        tool.isError = true;
        tool.errorReason = oneLine(text, 200);
        if (exec) {
          exec.isError = true;
          exec.errorReason ??= tool.errorReason;
        }
      }
      if (exec && !/Script running/.test(head)) exec.status = 'done';
    } else if (/^(<tool_use_error>|Error:|error:|ERROR:|Failed to |Exception)/.test(text.trimStart().slice(0, 60))) {
      tool.isError = true;
      tool.errorReason = oneLine(text, 200);
    }
    if (tool.kind === 'skill') {
      const inv = this.invocations.find((v) => v.toolCallId === tool.id);
      if (inv) {
        inv.contentItem = idx;
        inv.path ??= parseSkillBlock(text)?.path;
      }
    }
  }

  protected findOpenExec(): string | undefined {
    for (let i = this.execStack.length - 1; i >= 0; i--) {
      const t = this.tools.get(this.execStack[i]);
      if (t && t.status !== 'done') return t.id;
    }
    return this.execStack[this.execStack.length - 1];
  }

  protected addImplicitRead(r: SkillRead, tool: ToolCall): void {
    const path = this.expand(r.path);
    const skill = this.skillPaths.get(path) ?? skillNameFromPath(path);
    if (this.invocations.some((v) => v.toolCallId === tool.id && v.path === path && v.mode === 'implicit_read')) return;
    this.invocations.push({ skill, path, mode: 'implicit_read', callIndex: tool.callIndex, toolCallId: tool.id, line: tool.outputLine ?? 0, seenLines: r.lines });
    tool.skill ??= skill;
  }

  // ---------------------------------------------------------------- events

  protected onEvent(p: J, line: number, ts: string | undefined, inPrefix: boolean): void {
    const et = String(p.type);
    switch (et) {
      case 'task_started':
        if (!inPrefix) this.startTurn(p.turn_id, line, ts);
        if (typeof p.model_context_window === 'number') this.meta.contextWindow ??= p.model_context_window;
        return;
      case 'task_complete':
        if (!inPrefix) this.endTurn(p, line, ts);
        return;
      case 'turn_aborted':
        this.open = undefined;
        if (!inPrefix) {
          this.mark('abort', line, ts, p.reason);
          if (this.turn) {
            this.turn.status = 'aborted';
            this.turn.endLine = line;
          }
        }
        return;
      case 'token_count':
        this.onTokenCount(p, line, ts, inPrefix);
        return;
      case 'user_message':
        if (!inPrefix && this.turn && !this.turn.input) {
          this.turn.input = mkTxt(p.message, LIMITS.input, { line, ptr: '/payload/message' });
          this.turn.trigger = 'user';
        }
        return;
      case 'item_completed':
        if (!inPrefix) this.onItemCompleted(p, line, ts);
        return;
      case 'context_compacted':
        if (!inPrefix) this.mark('compaction', line, ts);
        return;
      case 'thread_rolled_back':
        if (!inPrefix) this.mark('rollback', line, ts, `回滚 ${p.num_turns ?? 1} 轮`);
        return;
      case 'error':
        if (!inPrefix) this.mark('error', line, ts, oneLine(String(p.message ?? ''), 400));
        return;
      default:
        break;
    }
    if (QUIET_EVENTS.has(et)) return;
    const cid = eventCallId(p);
    if (!TOOL_EVENTS.has(et) || !cid) {
      if (!TOOL_EVENTS.has(et)) this.diag('unknown_event', et, line);
      return;
    }
    if (inPrefix) return;
    this.linkEvent(et, p, cid, line, ts);
  }

  protected onTokenCount(p: J, line: number, ts: string | undefined, inPrefix: boolean): void {
    const info = p.info;
    if (!info) return;
    if (typeof info.model_context_window === 'number') this.meta.contextWindow ??= info.model_context_window;
    const total = info.total_token_usage?.total_tokens;
    if (typeof total !== 'number' || total === this.lastTotal) return;
    this.lastTotal = total;
    // Newer Codex versions write each response's usage in a token_usage_record instead.
    if (this.usageRecords) return;
    const last = info.last_token_usage;
    if (inPrefix || !last || !(Number(last.total_tokens) > 0)) return;
    const usage = toUsage(last);
    const model: string | undefined = p.context?.model;
    if (this.pending && !this.pending.usage) {
      this.pending.usage = usage;
      this.pending.model ??= model;
      this.pending = undefined;
      this.open = undefined;
      return;
    }
    // Usage without a committed response: a compaction summary call or a response lost to an abort.
    this.addOrphan(usage, model, line, ts);
  }

  protected addOrphan(usage: Usage, model: string | undefined, line: number, ts: string | undefined, turnId?: unknown): LlmCall {
    const turn = (typeof turnId === 'string' && this.turnById.get(turnId)) || this.turn || this.startTurn(undefined, line, ts);
    const call: LlmCall = {
      index: this.calls.length,
      turnId: turn.id,
      kind: 'orphan',
      line,
      ts,
      startTs: this.prevTs,
      model,
      usage,
      view: { epoch: this.cur, len: this.epochs[this.cur].length },
      injected: [],
      outputItems: [],
      tools: [],
      fidelity: 'reconstructed',
    };
    this.calls.push(call);
    turn.calls.push(call.index);
    this.lastOrphan = call;
    this.lastWasCountChange = true;
    return call;
  }

  protected onItemCompleted(p: J, line: number, ts?: string): void {
    const item = p.item;
    const content = item?.content;
    if (Array.isArray(content)) {
      for (const c of content) {
        if (c?.type === 'skill' && typeof c.name === 'string') this.addMention(c.name, c.path, line);
      }
    }
    if (!item || typeof item !== 'object') return;
    const ev = codexItemEvent(item, line, ts);
    if (!ev) return;
    if (ev.et === 'web_search_end' && !this.tools.has(ev.id) && !ev.id.startsWith('exec-')) {
      // older Codex versions report a hosted search before its web_search_call item
      this.dropPendingSearch();
      this.pendingSearch = { ...ev.core, id: ev.id };
      return;
    }
    // activity of an agent that none of our tool calls started or addressed
    if (ev.et === 'sub_agent_activity' && !this.tools.has(ev.id)) return;
    this.linkEvent(ev.et, ev.p, ev.id, line, ts, ev.core);
  }

  protected dropPendingSearch(): void {
    if (!this.pendingSearch) return;
    const { id, ...core } = this.pendingSearch;
    this.orphans.push({ ...core, callId: id, link: 'position' });
    this.pendingSearch = undefined;
  }

  protected linkEvent(et: string, p: J, cid: string, line: number, ts?: string, core: EventCore = toInnerEvent(p, line, ts, [])): void {
    let tool = this.tools.get(cid);
    let link: InnerEvent['link'] = 'self';
    let innerId: string | undefined;
    if (!tool && cid.startsWith('code-mode-nested:')) {
      const m = /^code-mode-nested:(\d+):/.exec(cid);
      if (m) {
        const n = Number(m[1]);
        const start = m[0].length;
        const outer = cid.slice(start, start + n);
        innerId = cid.slice(start + n + 1) || undefined;
        tool = this.tools.get(outer);
        link = 'nested';
      }
    }
    if (!tool && /^exec-/.test(cid)) {
      const open = this.findOpenExec();
      if (open) {
        tool = this.tools.get(open);
        link = 'position';
        innerId = cid;
      }
    }
    if (!tool) {
      this.orphans.push({ ...core, callId: cid, link: 'position' });
      this.diag('orphan_event', et, line);
      return;
    }
    const ev: InnerEvent = { ...core, callId: cid, innerId, link };
    const dup = et === 'exec_command_end' ? tool.inner.findIndex((e) => e.type === et && e.callId === cid) : -1;
    if (dup !== -1) {
      const prev = tool.inner[dup];
      tool.inner[dup] = { ...prev, ...ev, output: ev.output?.chars ? ev.output : prev.output };
    } else {
      tool.inner.push(ev);
    }
    if (link === 'self') {
      if (ev.isError) {
        tool.isError = true;
        tool.errorReason ??= ev.exitCode !== undefined ? `exit ${ev.exitCode}` : ev.status;
      }
      tool.durationMs ??= ev.durationMs;
    }

    if (et === 'exec_command_end') {
      const r = detectSkillRead(commandString(p.command), core.parsedCmd);
      if (r) this.addImplicitRead(r, tool);
    } else if (et === 'collab_agent_spawn_end') {
      const sub = this.subByCall.get(tool.id) ?? { spawnCallId: tool.id, line, callIndex: tool.callIndex };
      if (!this.subByCall.has(tool.id)) {
        this.subagents.push(sub);
        this.subByCall.set(tool.id, sub);
      }
      sub.childThreadId = p.new_thread_id ?? sub.childThreadId;
      sub.nickname = p.new_agent_nickname ?? sub.nickname;
      sub.role = p.new_agent_role ?? sub.role;
      sub.model = p.model ?? sub.model;
      sub.status = typeof p.status === 'string' ? p.status : sub.status;
      sub.prompt ??= mkTxt(p.prompt, LIMITS.item, { line, ptr: '/payload/prompt' });
      if (p.new_thread_id) tool.childThreadId = p.new_thread_id;
    } else if (et === 'collab_agent_interaction_end' || et === 'collab_close_end') {
      tool.childThreadId ??= p.receiver_thread_id ?? undefined;
    } else if (et === 'sub_agent_activity') {
      tool.childThreadId ??= p.agent_thread_id ?? undefined;
      const sub = this.subByCall.get(tool.id);
      if (sub) {
        sub.agentPath ??= p.agent_path;
        sub.childThreadId ??= p.agent_thread_id ?? undefined;
      }
    }
  }

  // ---------------------------------------------------------------- responses

  /**
   * Codex writes each history item as its own response_item record: a
   * response's output items (reasoning, assistant text, tool calls), then its
   * usage (token_usage_record in newer versions, token_count in older ones),
   * then tool outputs and other input items. One call = the run of output
   * items up to its usage or the next input item.
   */
  protected onResponseItem(p: J, line: number, ts: string | undefined, inPrefix: boolean): void {
    const trigger = p.type === 'agent_message' && this.agentTrigger;
    if (p.type === 'agent_message') this.agentTrigger = false;
    if (inPrefix) {
      this.addItem(p, line, 0, true, '/payload');
      return;
    }
    if (!isOutputItem(p)) {
      this.open = undefined;
      this.sinceCall.push(...this.addItem(p, line, 0, false, '/payload'));
      if (trigger) {
        const t = this.turn ?? this.startTurn(undefined, line, ts);
        if (!t.input) {
          t.trigger = 'inter_agent';
          t.input = mkTxt(contentText(p.content), LIMITS.input, { line, ptr: '/payload/content' });
        }
      }
      return;
    }

    const call = this.open ?? this.openCall(p, line, ts);
    const created = this.addItem(p, line, 0, false, '/payload');
    call.outputItems.push(...created);
    const o = this.openText;
    if (p.type === 'reasoning') {
      const text = itemText(p);
      if (text) {
        o.reasoning.push(text);
        o.rRef ??= this.items[created[0]]?.ref;
        call.reasoning = mkTxt(o.reasoning.join('\n\n'), LIMITS.output, o.rRef);
      }
    } else if (p.type === 'message') {
      const text = contentText(p.content);
      if (text) {
        o.texts.push(text);
        o.tRef ??= { line, ptr: '/payload/content' };
        call.text = mkTxt(o.texts.join('\n\n'), LIMITS.input, o.tRef);
      }
      if (p.phase) call.phase = p.phase;
    } else if (p.type === 'function_call' || p.type === 'custom_tool_call') {
      this.addToolCall(p, call, line, 0, ts, '/payload');
    } else if (p.type === 'web_search_call') {
      this.addSearchCall(p, call, line, ts);
    }
  }

  protected openCall(p: J, line: number, ts?: string): LlmCall {
    const turn = this.turnFor(p.internal_chat_message_metadata_passthrough?.turn_id, line, ts);
    if (this.pending && !this.pending.usage) this.diag('missing_usage', 'response without usage', this.pending.line);
    const call: LlmCall = {
      index: this.calls.length,
      turnId: turn.id,
      kind: 'response',
      line,
      ts,
      startTs: this.prevTs,
      model: turn.model ?? this.meta.model,
      view: { epoch: this.cur, len: this.epochs[this.cur].length },
      // context the harness added since the previous response (environment, reminders …)
      injected: this.sinceCall.filter((idx) => !NOT_INJECTED.has(this.items[idx].cat)),
      outputItems: [],
      tools: [],
      fidelity: 'reconstructed',
    };
    if (!turn.input && !turn.calls.length) this.systemTrigger(turn);
    this.sinceCall = [];
    this.calls.push(call);
    turn.calls.push(call.index);
    this.pending = call;
    this.open = call;
    this.openText = { reasoning: [], texts: [], rRef: undefined, tRef: undefined };
    return call;
  }

  /** A turn without user or agent input that a harness message started (the last input before the first response). */
  protected systemTrigger(turn: Turn): void {
    const last = this.sinceCall[this.sinceCall.length - 1];
    const it = last === undefined ? undefined : this.items[last];
    if (it?.kind !== 'message' || (it.cat !== 'developer' && it.cat !== 'system_reminder')) return;
    turn.trigger = 'system';
    turn.input = { preview: it.preview, chars: it.chars, ref: it.chars > it.preview.length ? it.ref : undefined };
  }

  /** A hosted web search the model ran inside its response. */
  protected addSearchCall(p: J, call: LlmCall, line: number, ts?: string): void {
    const id = typeof p.id === 'string' && p.id ? p.id : `ws:${line}`;
    const action = (p.action ?? {}) as J;
    const argsStr = JSON.stringify(action);
    const tool: ToolCall = {
      id,
      callIndex: call.index,
      name: 'web_search',
      kind: 'web_search',
      args: mkTxt(argsStr, LIMITS.args, { line, ptr: '/payload/action' })!,
      argsJson: argsStr.length < 4096 ? action : undefined,
      status: 'done',
      isError: p.status === 'failed',
      inner: [],
      ts,
    };
    if (this.pendingSearch) {
      const { id: evId, ...core } = this.pendingSearch;
      this.pendingSearch = undefined;
      tool.inner.push({ ...core, callId: evId, link: evId === id ? 'self' : 'position' });
    }
    this.tools.set(id, tool);
    call.tools.push(id);
  }

  /** The usage of one response (newer Codex versions), written right after its output items. */
  protected onUsageRecord(p: J, line: number, ts: string | undefined, inPrefix: boolean): void {
    this.usageRecords = true;
    if (inPrefix || !p.usage || typeof p.usage !== 'object') return;
    const usage = toUsage(p.usage);
    const model = this.turn?.model ?? this.meta.model;
    const call = this.open ?? (this.pending && !this.pending.usage ? this.pending : undefined);
    this.open = undefined;
    if (call) {
      call.usage = usage;
      call.model ??= model;
      this.pending = undefined;
      return;
    }
    // usage with no response items before it: the compaction request (a `compacted` record follows)
    this.addOrphan(usage, model, line, ts, p.turn_id);
  }

  /** Compaction: the history continues from `replacement_history`. */
  protected onCompacted(p: J, line: number, ts: string | undefined, inPrefix: boolean, wasCountChange: boolean): void {
    const items: J[] = Array.isArray(p.replacement_history) ? p.replacement_history : [];
    if (items.length) {
      this.open = undefined;
      this.epochs.push([]);
      this.cur = this.epochs.length - 1;
      items.forEach((it, i) => this.addItem(it, line, i, true, `/payload/replacement_history/${i}`));
      this.sinceCall = [];
    }
    if (!inPrefix) {
      if (wasCountChange && this.lastOrphan) this.lastOrphan.kind = 'compaction';
      this.mark('compaction', line, ts);
    }
  }

  // ---------------------------------------------------------------- finish

  finish(file: FileInfo): SessionTrace {
    this.dropPendingSearch();
    const tools = Object.fromEntries(this.tools);
    let usage = emptyUsage();
    for (const c of this.calls) if (c.usage) usage = addUsage(usage, c.usage);
    for (const l of this.listings) l.firstCall = this.calls.find((c) => c.line >= l.line)?.index;
    const totals = {
      turns: this.turns.length,
      calls: this.calls.length,
      tools: this.tools.size,
      toolErrors: [...this.tools.values()].filter((t) => t.isError).length,
      usage,
      durationMs: this.turns.reduce((s, t) => s + (t.durationMs ?? 0), 0),
      subagents: this.subagents.length,
      skillInvocations: this.invocations.length,
    };
    return {
      parserVersion: PARSER_VERSION,
      file,
      meta: this.meta,
      forkPrefix:
        this.opts.forkPrefixEnd !== undefined ? { endLine: this.opts.forkPrefixEnd, kind: this.opts.forkKind ?? 'partial' } : undefined,
      turns: this.turns,
      calls: this.calls,
      tools,
      items: this.items,
      epochs: this.epochs,
      listings: this.listings,
      invocations: this.invocations,
      subagents: this.subagents,
      orphanEvents: this.orphans,
      diagnostics: [...this.diags.values()],
      totals,
    };
  }
}

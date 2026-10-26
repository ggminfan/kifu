/**
 * Domain model shared by the parser (src/core), the server and the web UI.
 * Everything here must stay JSON-serializable.
 */

export const PARSER_VERSION = 8;

/** Location of a value inside a rollout: line number + JSON pointer into the (blob-stripped) record. */
export interface TextRef {
  line: number;
  ptr: string;
  /** When the value at `ptr` is a JSON string: pointer applied after parsing it (e.g. exec args → /input). */
  json?: string;
}

/** A possibly long text: short preview inline, full value fetched lazily through `ref`. */
export interface Txt {
  preview: string;
  chars: number;
  ref?: TextRef;
}

export interface Usage {
  input: number;
  cached: number;
  cacheWrite: number;
  output: number;
  reasoning: number;
  total: number;
}

export interface SpawnInfo {
  parentThreadId: string;
  depth?: number;
  agentPath?: string;
  nickname?: string;
  role?: string;
}

export interface SessionMeta {
  threadId: string;
  cwd?: string;
  cliVersion?: string;
  originator?: string;
  /** 'cli' | 'exec' | 'subagent' | … */
  source?: string;
  model?: string;
  modelProvider?: string;
  contextWindow?: number;
  startedAt?: string;
  baseInstructions?: Txt;
  spawn?: SpawnInfo;
  forkedFromId?: string;
}

/** Source category of a piece of model input, used for context composition. */
export type SegmentCat =
  | 'system'
  | 'permissions'
  | 'developer'
  | 'agents_md'
  | 'environment'
  | 'skills_listing'
  | 'skill_content'
  | 'memory'
  | 'plugins'
  | 'system_reminder'
  | 'user'
  | 'assistant'
  | 'reasoning'
  | 'tool_call'
  | 'tool_output'
  | 'inter_agent'
  | 'compaction_summary'
  | 'other';

export type HistItemKind =
  | 'message'
  | 'reasoning'
  | 'function_call'
  | 'function_call_output'
  | 'custom_tool_call'
  | 'custom_tool_call_output'
  | 'inter_agent'
  | 'marker'
  | 'other';

/** One model-visible history entry (messages are split per content part). */
export interface HistItem {
  idx: number;
  line: number;
  kind: HistItemKind;
  role?: string;
  name?: string;
  callId?: string;
  cat: SegmentCat;
  chars: number;
  /** Token-weighted chars: CJK count 1, other chars 0.25 (≈ tokens before calibration). */
  wchars: number;
  preview: string;
  ref: TextRef;
}

export interface ViewRef {
  epoch: number;
  len: number;
}

export type ToolKind =
  | 'code_exec'
  | 'shell'
  | 'file'
  | 'patch'
  | 'mcp'
  | 'skill'
  | 'collab'
  | 'web_search'
  | 'wait'
  | 'plan'
  | 'function'
  | 'custom';

export interface ParsedCmd {
  type: string;
  cmd?: string;
  name?: string;
  path?: string;
}

/** An event emitted while a tool ran (inner commands of code-mode exec, MCP results, patches …). */
export interface InnerEvent {
  kind: 'exec' | 'mcp' | 'patch' | 'web_search' | 'terminal' | 'collab' | 'other';
  type: string;
  callId: string;
  innerId?: string;
  line: number;
  ts?: string;
  link: 'self' | 'nested' | 'position';
  title: string;
  status?: string;
  exitCode?: number;
  durationMs?: number;
  isError?: boolean;
  output?: Txt;
  paths?: string[];
  parsedCmd?: ParsedCmd[];
  blobs?: string[];
  threadId?: string;
}

export interface ToolCall {
  id: string;
  callIndex: number;
  name: string;
  namespace?: string;
  kind: ToolKind;
  args: Txt;
  /** Parsed arguments when small enough. */
  argsJson?: unknown;
  output?: Txt;
  outputLine?: number;
  outputTs?: string;
  status: 'pending' | 'running' | 'done';
  isError: boolean;
  errorReason?: string;
  cellId?: string;
  /** For `wait`: the code-mode exec call whose cell it collects. */
  waitsFor?: string;
  inner: InnerEvent[];
  childThreadId?: string;
  /** Skill loaded by this call, if any. */
  skill?: string;
  ts?: string;
  durationMs?: number;
}

export interface LlmCall {
  index: number;
  turnId?: string;
  kind: 'response' | 'compaction' | 'orphan';
  /** Line of the output commit (or of the token_count for orphans). */
  line: number;
  ts?: string;
  /** Timestamp of the record preceding the call (≈ request start). */
  startTs?: string;
  model?: string;
  usage?: Usage;
  /** Input = items[epochs[view.epoch].slice(0, view.len)] (+ base instructions). */
  view: ViewRef;
  /** Input items committed together with the response (system reminders …). */
  injected: number[];
  outputItems: number[];
  reasoning?: Txt;
  text?: Txt;
  phase?: string;
  tools: string[];
  fidelity: 'reconstructed' | 'exact';
}

export interface TurnMark {
  kind: 'compaction' | 'abort' | 'error' | 'rollback';
  line: number;
  ts?: string;
  detail?: string;
}

export interface Turn {
  id: string;
  index: number;
  /** Line of the record that started the turn (Codex: its task_started; Claude Code: the prompt). */
  startLine?: number;
  /** Line of the record that ended it (task_complete, turn_aborted). */
  endLine?: number;
  startedAt?: string;
  endedAt?: string;
  durationMs?: number;
  ttftMs?: number;
  /** What started the turn: the user, another agent's message, or a harness message (Codex notifications, goal continuation). */
  trigger: 'user' | 'inter_agent' | 'system' | 'unknown';
  input?: Txt;
  calls: number[];
  marks: TurnMark[];
  lastAgentMessage?: Txt;
  model?: string;
  cwd?: string;
  status: 'completed' | 'aborted' | 'failed' | 'open';
}

export interface SkillEntry {
  name: string;
  description: string;
  /** File as written in the listing (alias like r0/x/SKILL.md or absolute). */
  file?: string;
  /** Absolute path after alias resolution. */
  path?: string;
}

export interface SkillListing {
  line: number;
  itemIdx: number;
  format: 'codex' | 'claudecode' | 'host_update' | 'unknown';
  roots: Record<string, string>;
  entries: SkillEntry[];
  /** Index of the first LLM call that had this listing in its input. */
  firstCall?: number;
  /** Content hash so repeated listings (after compaction) can be deduplicated. */
  hash: string;
}

export type SkillInvocationMode = 'tool' | 'mention' | 'implicit_read' | 'resource';

export interface SkillInvocation {
  skill: string;
  path?: string;
  mode: SkillInvocationMode;
  callIndex: number;
  toolCallId?: string;
  line: number;
  /** Line range actually read (sed -n a,bp / head -n N). */
  seenLines?: [number, number];
  /** History item holding the skill content the model saw, when known. */
  contentItem?: number;
}

export interface SubagentLink {
  childThreadId?: string;
  spawnCallId: string;
  nickname?: string;
  role?: string;
  agentPath?: string;
  taskName?: string;
  forkTurns?: string;
  model?: string;
  prompt?: Txt;
  status?: string;
  line: number;
  callIndex?: number;
}

export interface Diagnostic {
  kind: 'unknown_record' | 'unknown_event' | 'parse_error' | 'orphan_event' | 'unmatched_output' | 'missing_usage';
  detail: string;
  count: number;
  firstLine: number;
}

export interface SessionTotals {
  turns: number;
  calls: number;
  tools: number;
  toolErrors: number;
  usage: Usage;
  durationMs: number;
  subagents: number;
  skillInvocations: number;
}

export interface FileInfo {
  path: string;
  size: number;
  mtimeMs: number;
  lines: number;
}

/** Full parse result (kept server-side / cached). */
export interface SessionTrace {
  parserVersion: number;
  file: FileInfo;
  meta: SessionMeta;
  /**
   * Lines before endLine are copied from another session and not this session's own work:
   * a forked subagent's copy of its parent (full / partial), or a replay's copy of the
   * original session up to the replayed turn (replay).
   */
  forkPrefix?: { endLine: number; kind: 'full' | 'partial' | 'replay' };
  turns: Turn[];
  calls: LlmCall[];
  tools: Record<string, ToolCall>;
  items: HistItem[];
  epochs: number[][];
  listings: SkillListing[];
  invocations: SkillInvocation[];
  subagents: SubagentLink[];
  orphanEvents: InnerEvent[];
  diagnostics: Diagnostic[];
  totals: SessionTotals;
}

/** What the trace view needs: everything except the (large) history item table. */
/** An inner event as the step list shows it (its output, paths and images come with the tool's details). */
export type InnerBrief = Pick<InnerEvent, 'kind' | 'type' | 'line' | 'ts' | 'link' | 'title' | 'status' | 'exitCode' | 'durationMs' | 'isError'>;

/**
 * A tool call as the step list and the timeline show it. Arguments and output
 * are what makes a session's trace big (tens of MB for long sessions): they
 * come per tool, when one is opened (GET /sessions/:id/tools/:toolId).
 */
export interface ToolBrief extends Pick<ToolCall, 'id' | 'callIndex' | 'name' | 'namespace' | 'kind' | 'status' | 'isError' | 'errorReason' | 'cellId' | 'waitsFor' | 'childThreadId' | 'skill' | 'ts' | 'outputTs' | 'durationMs' | 'outputLine'> {
  /** One line: the command, the file, the query … */
  summary: string;
  argsChars: number;
  outputChars?: number;
  inner: InnerBrief[];
}

/** A session as its page loads it: no history items (per step, from the context API), tool calls as briefs. */
export type TraceView = Omit<SessionTrace, 'items' | 'epochs' | 'tools' | 'listings' | 'invocations' | 'orphanEvents'> & {
  itemCount: number;
  epochCount: number;
  tools: Record<string, ToolBrief>;
};

export function emptyUsage(): Usage {
  return { input: 0, cached: 0, cacheWrite: 0, output: 0, reasoning: 0, total: 0 };
}

export function addUsage(a: Usage, b: Usage): Usage {
  return {
    input: a.input + b.input,
    cached: a.cached + b.cached,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    output: a.output + b.output,
    reasoning: a.reasoning + b.reasoning,
    total: a.total + b.total,
  };
}

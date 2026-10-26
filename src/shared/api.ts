/** Response shapes of the REST API (shared by server and web). */
import type { AgentKind, SourceKind } from './agents';
import type { SegmentCat, TraceView } from './types';

export interface SessionSummary {
  id: string;
  /** Where the session lives (a Codex home, a Claude Code project). */
  sourceId?: string;
  sourceLabel?: string;
  title?: string;
  firstUserMessage?: string;
  cwd?: string;
  model?: string;
  tokensUsed: number;
  createdAt: number;
  updatedAt: number;
  source?: string;
  threadSource?: string;
  agentRole?: string;
  agentNickname?: string;
  agentPath?: string;
  parentId?: string;
  childCount: number;
  rolloutExists: boolean;
  archived: boolean;
  gitBranch?: string;
  cliVersion?: string;
  isSubagent: boolean;
  /** Filled in by the background indexer once the rollout has been analyzed. */
  summary?: SessionIndexSummary;
}

export interface SessionIndexSummary {
  calls: number;
  tools: number;
  toolErrors: number;
  turns: number;
  skills: string[];
  durationMs: number;
}

export interface SessionListResponse {
  sessions: SessionSummary[];
  total: number;
  /** Of the sessions matching the filters, those whose record file is gone (`missing=exclude` leaves them out, `missing=only` lists them). */
  missing?: number;
  /** All sources of this workspace (for the 来源 filter), with their session counts. */
  sources?: SourceInfo[];
}

export interface SourceInfo {
  id: string;
  agent: AgentKind;
  kind: SourceKind;
  label: string;
  home: string;
  /** Top-level sessions that can be read. */
  sessions: number;
  /** Top-level sessions whose record file is gone. */
  missing?: number;
  lastActivity?: number;
  ok: boolean;
  error?: string;
}

export interface SessionTreeNode {
  session: SessionSummary;
  children: SessionTreeNode[];
}

export interface HealthResponse {
  agent: AgentKind;
  /** Number of sources (Codex homes, Claude Code projects …). */
  sources: number;
  tmHome: string;
  /** Top-level sessions whose records can be read. */
  threads: number;
  /** Top-level sessions still in the agent's index whose record file is gone (deleted or moved): listed apart, collapsed. */
  unreadable?: number;
  stateDbOk: boolean;
  /** "本机" or "user@host" — set by the desktop shell. */
  label: string;
  /** Runs, evaluations or analyses still going (the server must not be stopped). */
  busy: boolean;
  protocol: number;
  version: string;
  buildId: string;
  instanceId: string;
}

export type TraceResponse = TraceView & {
  title?: string;
  /** The agent that wrote the session (this server's agent). */
  agent?: AgentKind;
  /** Where the session lives, when the workspace merges several sources. */
  sourceId?: string;
  sourceLabel?: string;
};

export interface ContextItem {
  idx: number;
  kind: string;
  role?: string;
  name?: string;
  callId?: string;
  cat: SegmentCat;
  chars: number;
  estTokens: number;
  preview: string;
  ref: { line: number; ptr: string; json?: string };
  injected?: boolean;
  /** Not present in the previous call's input. */
  isNew?: boolean;
  /** The turn whose records added it (absent: before the first turn — the session's opening context). */
  turn?: number;
  /** The step whose response produced it (the model's own messages and tool calls). */
  from?: number;
  /** The tool call it belongs to (a tool call, or its output). */
  tool?: string;
}

export interface CompositionRow {
  cat: SegmentCat | 'tools_overhead';
  chars: number;
  estTokens: number;
  items: number;
}

export interface CallContextResponse {
  callIndex: number;
  fidelity: 'reconstructed' | 'exact';
  inputTokens?: number;
  cachedTokens?: number;
  /** tokens ≈ ratio × weighted chars, fitted per session. */
  ratio: number;
  composition: CompositionRow[];
  system?: { preview: string; chars: number; estTokens: number; ref?: { line: number; ptr: string } };
  items: ContextItem[];
  newCount: number;
  /** The step before (the comparison for "new" and "removed"). */
  prevCall?: number;
  /** Tokens (estimated) of the items new since that step. */
  newTokens?: number;
  /** Items that step had and this one does not: compacted away, rolled back. */
  removed?: ContextItem[];
  removedTokens?: number;
  /** The model's context window, when the session says. */
  contextWindow?: number;
}

/**
 * Every step's input by category (estimated tokens, like a step's composition;
 * `tools_overhead` is what the reported input has beyond them): how the context
 * filled up, and what each compaction took out.
 */
export interface ContextSeriesResponse {
  /** The categories, in the order of each point's values. */
  cats: Array<CompositionRow['cat']>;
  points: Array<{ call: number; input?: number; cached?: number; v: number[] }>;
  contextWindow?: number;
}

/** Where a word appears in a step's input, its full texts included (not only the previews). */
export interface ContextSearchResponse {
  hits: Array<{ idx: number; count: number; snippet: string }>;
  /** Items whose full text was not read (the search stopped at its budget). */
  skipped: number;
}

export type SkillFlag = 'loaded' | 'maybe_missed' | 'trigger_truncated' | 'partial_read' | 'not_followed' | 'desc_changed' | 'not_listed';

export interface SkillInvocationRef {
  mode: 'tool' | 'mention' | 'implicit_read' | 'resource';
  callIndex: number;
  turnIndex?: number;
  toolCallId?: string;
  seenLines?: [number, number];
}

export interface SkillReportRow {
  name: string;
  path?: string;
  listed: boolean;
  visibleDescription?: string;
  /** Current frontmatter description on disk. */
  fullDescription?: string;
  truncated: boolean | null;
  hiddenTail?: string;
  fileLines?: number;
  invocations: SkillInvocationRef[];
  /** Best lexical match between a user turn and this skill's description. */
  relevance?: { turnIndex: number; score: number; matched: string[]; tailOnly: string[] };
  follow?: { checked: number; matched: number; samples: Array<{ toolCallId: string; tokens: string[] }> };
  flags: SkillFlag[];
}

export interface SkillReportResponse {
  listing?: {
    format: string;
    entries: number;
    distinct: number;
    truncatedCount: number;
    /** Common cut length of truncated descriptions (chars). */
    cap?: number;
    firstCall?: number;
  };
  rows: SkillReportRow[];
}

export interface FailedTool {
  toolId: string;
  callIndex: number;
  name: string;
  kind: string;
  reason?: string;
  inner?: { title: string; exitCode?: number };
}

export interface LoopFinding {
  signature: string;
  count: number;
  callIndices: number[];
  toolIds: string[];
}

export interface AttributionResponse {
  failedTools: FailedTool[];
  failedCommands: Array<{ toolId: string; callIndex: number; title: string; exitCode?: number }>;
  loops: LoopFinding[];
  aborts: Array<{ turnIndex: number; reason?: string }>;
  requestErrors: Array<{ turnIndex: number; detail?: string }>;
  firstError?: { callIndex: number; toolId: string };
}

export interface EvidenceHit {
  source: 'skill_content' | 'skills_listing' | 'user' | 'tool_output' | 'agents_md' | 'memory' | 'assistant' | 'skill_file' | 'other';
  label: string;
  itemIdx?: number;
  skill?: string;
  lineStart: number;
  lineEnd: number;
  snippet: string;
  score: number;
  matched: string[];
}

export interface EvidenceResponse {
  toolId: string;
  query: string[];
  hits: EvidenceHit[];
  scannedChars: number;
}

export interface TextResponse {
  text: string;
  truncated: boolean;
  chars: number;
}

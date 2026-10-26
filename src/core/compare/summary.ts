import type { SessionTrace, ToolCall, Usage } from '../../shared/types';
import { addUsage, emptyUsage } from '../../shared/types';

/** Comparable summary of one execution (a Skill Lab run, or the first turn of an original session). */
export interface ExecSummary {
  threadId: string;
  turns: number;
  calls: number;
  tools: number;
  toolErrors: number;
  failedCommands: number;
  usage: Usage;
  durationMs: number;
  ttftMs?: number;
  skillLoaded: boolean;
  skillModes: string[];
  firstSkillCall?: number;
  skillLines: Array<[number, number]>;
  otherSkills: string[];
  finalAnswer?: string;
  toolSeq: string[];
}

/** `mapText` rewrites the call's text before it is cut short (a replay's isolated paths → the real ones). */
/** The command a shell call runs: `bash -lc <script>` gives the script; other arrays their words. */
function shellCommand(v: unknown): string {
  if (Array.isArray(v)) {
    const words = v.map(String);
    const c = words.findIndex((w) => /^-l?c$/.test(w));
    return c >= 0 && c + 1 < words.length && /(^|\/)(ba|z|da)?sh$/.test(words[0] ?? '') ? words.slice(c + 1).join(' ') : words.join(' ');
  }
  return typeof v === 'string' ? v : '';
}

/** A tool call in a sequence to align: `kind:name:first words of the command / file name / skill`. */
export function seqToken(t: ToolCall, mapText: (s: string) => string = (s) => s): string {
  const a = (t.argsJson ?? {}) as Record<string, unknown>;
  let key = '';
  if (t.kind === 'code_exec') {
    const cmd = t.inner.find((e) => e.kind === 'exec')?.title ?? t.inner[0]?.title ?? '';
    key = cmd.split(/\s+/).slice(0, 2).join(' ');
  } else if (t.kind === 'file' || t.kind === 'patch') {
    const p = String(a.file_path ?? a.path ?? '');
    key = p.split('/').pop() ?? '';
  } else if (t.kind === 'shell') {
    key = shellCommand(a.cmd ?? a.command).trim().split(/\s+/).slice(0, 2).join(' ');
  } else if (t.kind === 'skill') {
    key = t.skill ?? '';
  }
  key = mapText(key);
  return `${t.kind}:${t.name}${key ? `:${key.slice(0, 40)}` : ''}`;
}

/**
 * The same token from older runs: shell commands given as an array were
 * joined with commas ("bash,-lc,rg -n"). Sequences are compared normalized,
 * so replays stored before still line up.
 */
export function normalizeSeqToken(token: string): string {
  return token.replace(/^(shell:[^:]+:)(?:\/?[\w/]*?(?:ba|z|da)?sh),-l?c,(\S+)(?: (\S+))?.*$/, (_, head: string, w1: string, w2?: string) => `${head}${w2 ? `${w1} ${w2}` : w1}`);
}

/** A token as a person reads it: the tool and what it ran (the kind when it says more than the name). */
export function seqLabel(token: string): string {
  const [kind, name, ...rest] = normalizeSeqToken(token).split(':');
  const key = rest.join(':');
  const head = name === undefined ? kind : kind === name || kind === 'function' ? name : `${name}（${kind}）`;
  return key ? `${head} · ${key}` : head;
}

export function summarizeTrace(trace: SessionTrace, skillNames: string[], opts: { firstTurnOnly?: boolean } = {}): ExecSummary {
  const turns = opts.firstTurnOnly ? trace.turns.slice(0, 1) : trace.turns;
  const callIdx = new Set(turns.flatMap((t) => t.calls));
  const calls = trace.calls.filter((c) => callIdx.has(c.index));
  const tools = calls.flatMap((c) => c.tools.map((id) => trace.tools[id]).filter((t): t is ToolCall => Boolean(t)));
  let usage = emptyUsage();
  for (const c of calls) if (c.usage) usage = addUsage(usage, c.usage);
  const names = new Set(skillNames);
  const invs = trace.invocations.filter((v) => callIdx.has(v.callIndex));
  const mine = invs.filter((v) => names.has(v.skill));
  const lastTurn = turns[turns.length - 1];
  const lastText = [...calls].reverse().find((c) => c.text)?.text?.preview;
  return {
    threadId: trace.meta.threadId,
    turns: turns.length,
    calls: calls.length,
    tools: tools.length,
    toolErrors: tools.filter((t) => t.isError).length,
    failedCommands: tools.reduce((s, t) => s + t.inner.filter((e) => e.isError && e.kind === 'exec').length, 0),
    usage,
    durationMs: turns.reduce((s, t) => s + (t.durationMs ?? 0), 0),
    ttftMs: turns[0]?.ttftMs,
    skillLoaded: mine.length > 0,
    skillModes: [...new Set(mine.map((v) => v.mode))],
    firstSkillCall: mine[0]?.callIndex,
    skillLines: mine.flatMap((v) => (v.seenLines ? [v.seenLines] : [])),
    otherSkills: [...new Set(invs.filter((v) => !names.has(v.skill)).map((v) => v.skill))],
    finalAnswer: lastTurn?.lastAgentMessage?.preview ?? lastText,
    toolSeq: tools.map((t) => seqToken(t)),
  };
}

export interface Alignment {
  rows: Array<{ a?: string; b?: string; same: boolean }>;
  firstDivergence?: number;
  similarity: number;
}

/** Needleman–Wunsch alignment of two tool sequences. */
export function alignSequences(rawA: string[], rawB: string[]): Alignment {
  const a = rawA.map(normalizeSeqToken);
  const b = rawB.map(normalizeSeqToken);
  const n = a.length;
  const m = b.length;
  const score = (x: string, y: string) => (x === y ? 2 : x.split(':').slice(0, 2).join(':') === y.split(':').slice(0, 2).join(':') ? 1 : -1);
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = 1; i <= n; i++) dp[i][0] = -i;
  for (let j = 1; j <= m; j++) dp[0][j] = -j;
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      dp[i][j] = Math.max(dp[i - 1][j - 1] + score(a[i - 1], b[j - 1]), dp[i - 1][j] - 1, dp[i][j - 1] - 1);
    }
  }
  const rows: Alignment['rows'] = [];
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && dp[i][j] === dp[i - 1][j - 1] + score(a[i - 1], b[j - 1])) {
      rows.push({ a: a[i - 1], b: b[j - 1], same: a[i - 1] === b[j - 1] });
      i--;
      j--;
    } else if (i > 0 && dp[i][j] === dp[i - 1][j] - 1) {
      rows.push({ a: a[i - 1], same: false });
      i--;
    } else {
      rows.push({ b: b[j - 1], same: false });
      j--;
    }
  }
  rows.reverse();
  const firstDivergence = rows.findIndex((r) => !r.same);
  const same = rows.filter((r) => r.same).length;
  return { rows, firstDivergence: firstDivergence === -1 ? undefined : firstDivergence, similarity: rows.length ? same / rows.length : 1 };
}

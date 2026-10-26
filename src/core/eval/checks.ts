import type { AttributionResponse, SkillReportResponse } from '../../shared/api';
import type { CheckDef, CheckResult, TurnSummary } from '../../shared/replay';
import type { SessionTrace, ToolCall } from '../../shared/types';
import { attribution } from '../analysis/errors';
import { seqToken } from '../compare/summary';

/**
 * Checks on what turn K did — in the original session or in a replay of it.
 * Deterministic: tools, skills, failures, loops, size, the final answer.
 */

type TraceLike = Pick<SessionTrace, 'turns' | 'calls' | 'tools' | 'invocations'>;

function callsOf(trace: TraceLike, from: number, to: number) {
  const idx = new Set(trace.turns.slice(from, to).flatMap((t) => t.calls));
  return trace.calls.filter((c) => idx.has(c.index));
}

function toolsOf(trace: TraceLike, from: number, to: number): ToolCall[] {
  return callsOf(trace, from, to).flatMap((c) => c.tools.map((id) => trace.tools[id]).filter((t): t is ToolCall => Boolean(t)));
}

/**
 * Summary of turns [from, to) (default: all). `attr` lets callers reuse a computed attribution;
 * `mapText` rewrites the tool calls and the answer (a replay's isolated paths → the real ones).
 */
export function summarizeTurns(trace: SessionTrace, from = 0, to = trace.turns.length, attr?: AttributionResponse, mapText: (s: string) => string = (s) => s): TurnSummary {
  const calls = callsOf(trace, from, to);
  const callIdx = new Set(calls.map((c) => c.index));
  const tools = toolsOf(trace, from, to);
  const loops = (attr ?? attribution(trace)).loops.filter((l) => l.callIndices.every((i) => callIdx.has(i)));
  const turns = trace.turns.slice(from, to);
  const last = turns[turns.length - 1];
  const lastText = [...calls].reverse().find((c) => c.text)?.text?.preview;
  return {
    steps: calls.filter((c) => c.kind === 'response').length,
    tools: tools.length,
    toolErrors: tools.filter((t) => t.isError).length,
    failedCommands: tools.reduce((s, t) => s + t.inner.filter((e) => e.isError && e.kind === 'exec').length, 0),
    loops: loops.length,
    inputTokens: calls.reduce((s, c) => s + (c.usage?.input ?? 0), 0),
    outputTokens: calls.reduce((s, c) => s + (c.usage?.output ?? 0), 0),
    cachedTokens: calls.reduce((s, c) => s + (c.usage?.cached ?? 0), 0),
    durationMs: turns.reduce((s, t) => s + (t.durationMs ?? 0), 0),
    skillsLoaded: [...new Set(trace.invocations.filter((v) => callIdx.has(v.callIndex)).map((v) => v.skill))],
    toolSeq: tools.map((t) => seqToken(t, mapText)),
    finalAnswer: ((a) => (a === undefined ? a : mapText(a)))(last?.lastAgentMessage?.preview ?? lastText),
    status: last?.status ?? 'open',
  };
}

/** `plugin:name` and `name` refer to the same skill. */
function sameSkill(a: string, b: string): boolean {
  const short = (s: string) => s.split(':').pop()!.toLowerCase();
  return a.toLowerCase() === b.toLowerCase() || short(a) === short(b);
}

function matcher(pattern: string): (s: string) => boolean {
  const re = /^\/(.+)\/([a-z]*)$/.exec(pattern);
  if (re) {
    try {
      const r = new RegExp(re[1], re[2].includes('i') ? re[2] : `${re[2]}i`);
      return (s) => r.test(s);
    } catch {
      // not a valid regex: plain text
    }
  }
  const p = pattern.toLowerCase();
  return (s) => s.toLowerCase().includes(p);
}

const QUESTION_END = /[?？]\s*$/;
const QUESTION_ASK = /(请(你)?(确认|告诉我|提供|说明)|你(希望|想要|需要)|要不要|是否需要|需要我|which (one|option)|do you want|would you like|could you (clarify|confirm))/i;

/** Does the answer end by asking the user something (a clarification instead of doing the work)? */
export function asksUser(answer: string | undefined): boolean {
  if (!answer) return false;
  const tail = answer.trim().split('\n').filter((l) => l.trim()).slice(-3).join('\n');
  return QUESTION_END.test(tail) || QUESTION_ASK.test(tail);
}

export interface CheckContext {
  from?: number;
  to?: number;
  /** The run was stopped after its step limit: what depends on the turn's end can't be judged. */
  stoppedAtMax?: boolean;
  /** Full final answer (summaries only keep a preview). */
  answer?: string;
}

export function evaluateChecks(trace: SessionTrace, defs: CheckDef[], ctx: CheckContext = {}): CheckResult[] {
  const from = ctx.from ?? 0;
  const to = ctx.to ?? trace.turns.length;
  const sum = summarizeTurns(trace, from, to);
  const tools = toolsOf(trace, from, to);
  const answer = ctx.answer ?? sum.finalAnswer;
  const unfinished = ctx.stoppedAtMax ? '回放在步数上限处停止，这一轮没有结束' : undefined;
  const verdict = (ok: boolean, detail?: string): Pick<CheckResult, 'status' | 'detail'> => ({ status: ok ? 'pass' : 'fail', detail });
  return defs.map((def): CheckResult => {
    switch (def.kind) {
      case 'skill_loaded':
      case 'skill_not_loaded': {
        const hit = sum.skillsLoaded.find((s) => sameSkill(s, def.skill));
        const loaded = Boolean(hit);
        if (def.kind === 'skill_not_loaded' && !loaded && unfinished) return { def, status: 'na', detail: unfinished };
        if (def.kind === 'skill_loaded' && !loaded && unfinished) return { def, status: 'na', detail: unfinished };
        return { def, ...verdict(def.kind === 'skill_loaded' ? loaded : !loaded, loaded ? '已加载' : sum.skillsLoaded.length ? `加载了 ${sum.skillsLoaded.join('、')}` : '没有加载 skill') };
      }
      case 'tool_called':
      case 'tool_not_called': {
        const m = matcher(def.pattern);
        const hit = tools.find((t) => m(t.name) || m(seqToken(t)) || t.inner.some((e) => m(e.title)));
        const called = Boolean(hit);
        if (!called && unfinished) return { def, status: 'na', detail: unfinished };
        return { def, ...verdict(def.kind === 'tool_called' ? called : !called, hit ? `Step ${hit.callIndex + 1} · ${hit.name}` : '没有匹配的调用') };
      }
      // a failure seen is a fail; none seen in a turn that was stopped early says nothing yet
      case 'no_failed_commands':
        if (!sum.failedCommands && unfinished) return { def, status: 'na', detail: unfinished };
        return { def, ...verdict(sum.failedCommands === 0, sum.failedCommands ? `${sum.failedCommands} 个命令失败` : undefined) };
      case 'no_tool_errors':
        if (!sum.toolErrors && unfinished) return { def, status: 'na', detail: unfinished };
        return { def, ...verdict(sum.toolErrors === 0, sum.toolErrors ? `${sum.toolErrors} 个工具调用失败` : undefined) };
      case 'no_loops':
        if (!sum.loops && unfinished) return { def, status: 'na', detail: unfinished };
        return { def, ...verdict(sum.loops === 0, sum.loops ? `${sum.loops} 处重复调用` : undefined) };
      case 'max_steps':
        if (sum.steps > def.n) return { def, status: 'fail', detail: `${sum.steps} 步` };
        return unfinished ? { def, status: 'na', detail: unfinished } : { def, status: 'pass', detail: `${sum.steps} 步` };
      case 'max_input_tokens':
        if (sum.inputTokens > def.n) return { def, status: 'fail', detail: `${sum.inputTokens} tokens` };
        return unfinished ? { def, status: 'na', detail: unfinished } : { def, status: 'pass', detail: `${sum.inputTokens} tokens` };
      case 'answer_contains':
      case 'answer_not_contains': {
        if (unfinished) return { def, status: 'na', detail: unfinished };
        if (!answer) return { def, status: 'na', detail: '没有最终回答' };
        const has = matcher(def.text)(answer);
        return { def, ...verdict(def.kind === 'answer_contains' ? has : !has) };
      }
      case 'no_question':
        if (unfinished) return { def, status: 'na', detail: unfinished };
        if (!answer) return { def, status: 'na', detail: '没有最终回答' };
        return { def, ...verdict(!asksUser(answer), asksUser(answer) ? '回答以提问结束' : undefined) };
    }
  });
}

/**
 * Checks a case starts with: keep what went right in the original turn K, and
 * ask for the opposite of what went wrong.
 */
export function suggestChecks(trace: SessionTrace, turnIndex: number, skills?: SkillReportResponse): CheckDef[] {
  const sum = summarizeTurns(trace, turnIndex, turnIndex + 1);
  const out: CheckDef[] = [];
  for (const s of sum.skillsLoaded) out.push({ kind: 'skill_loaded', skill: s });
  for (const row of skills?.rows ?? []) {
    const missed = row.flags.includes('maybe_missed') || row.flags.includes('trigger_truncated');
    if (missed && row.relevance?.turnIndex === turnIndex && !out.some((c) => c.kind === 'skill_loaded' && sameSkill(c.skill, row.name))) {
      out.push({ kind: 'skill_loaded', skill: row.name });
    }
  }
  // a failed command usually fails its tool too: one check is enough
  if (sum.failedCommands) out.push({ kind: 'no_failed_commands' });
  else if (sum.toolErrors) out.push({ kind: 'no_tool_errors' });
  if (sum.loops) out.push({ kind: 'no_loops' });
  if (asksUser(sum.finalAnswer)) out.push({ kind: 'no_question' });
  return out;
}

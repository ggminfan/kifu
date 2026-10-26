import type { AttributionResponse, SkillReportResponse } from '../../shared/api';
import type { SessionTrace } from '../../shared/types';

/**
 * The places in a session worth a look, one list for the problem bar (with
 * prev / next), the step markers and a case's default checks: failed tools and
 * commands, loops, aborts and request errors (deterministic), and skills that
 * probably should have triggered or were cut off (heuristic).
 */

export type ProblemKind = 'failed_tool' | 'failed_command' | 'loop' | 'abort' | 'request_error' | 'maybe_missed' | 'trigger_truncated' | 'not_followed';

export interface Problem {
  kind: ProblemKind;
  turnIndex: number;
  callIndex?: number;
  toolId?: string;
  skill?: string;
  title: string;
  detail?: string;
  /** Rule-based facts, or a heuristic guess. */
  certainty: 'fact' | 'heuristic';
}

export const PROBLEM_LABEL: Record<ProblemKind, string> = {
  failed_tool: '工具失败',
  failed_command: '命令失败',
  loop: '循环',
  abort: '中断',
  request_error: '请求错误',
  maybe_missed: '可能漏触发',
  trigger_truncated: '触发词被截断',
  not_followed: '加载未遵循',
};

export function findProblems(trace: Pick<SessionTrace, 'turns' | 'calls' | 'tools'>, attr: AttributionResponse, skills?: SkillReportResponse): Problem[] {
  const turnOf = new Map<number, number>();
  for (const t of trace.turns) for (const c of t.calls) turnOf.set(c, t.index);
  const out: Problem[] = [];

  const failedToolIds = new Set(attr.failedTools.map((f) => f.toolId));
  for (const f of attr.failedTools) {
    out.push({
      kind: 'failed_tool',
      turnIndex: turnOf.get(f.callIndex) ?? 0,
      callIndex: f.callIndex,
      toolId: f.toolId,
      title: f.inner ? f.inner.title : f.name,
      detail: f.inner?.exitCode !== undefined ? `exit ${f.inner.exitCode}` : f.reason,
      certainty: 'fact',
    });
  }
  // failed commands inside a tool that did not fail as a whole (code-mode cells keep going)
  const seen = new Set<string>();
  for (const c of attr.failedCommands) {
    if (failedToolIds.has(c.toolId) || seen.has(c.toolId)) continue;
    seen.add(c.toolId);
    out.push({ kind: 'failed_command', turnIndex: turnOf.get(c.callIndex) ?? 0, callIndex: c.callIndex, toolId: c.toolId, title: c.title, detail: c.exitCode !== undefined ? `exit ${c.exitCode}` : undefined, certainty: 'fact' });
  }
  for (const l of attr.loops) {
    out.push({ kind: 'loop', turnIndex: turnOf.get(l.callIndices[0]) ?? 0, callIndex: l.callIndices[0], toolId: l.toolIds[0], title: l.signature, detail: `×${l.count}`, certainty: 'fact' });
  }
  for (const a of attr.aborts) {
    const turn = trace.turns[a.turnIndex];
    out.push({ kind: 'abort', turnIndex: a.turnIndex, callIndex: turn?.calls[turn.calls.length - 1], title: '这一轮被中断', detail: a.reason, certainty: 'fact' });
  }
  for (const e of attr.requestErrors) {
    const turn = trace.turns[e.turnIndex];
    out.push({ kind: 'request_error', turnIndex: e.turnIndex, callIndex: turn?.calls[turn.calls.length - 1], title: '模型请求出错', detail: e.detail, certainty: 'fact' });
  }

  for (const row of skills?.rows ?? []) {
    const rel = row.relevance;
    if (rel && (row.flags.includes('trigger_truncated') || row.flags.includes('maybe_missed'))) {
      const truncated = row.flags.includes('trigger_truncated');
      const turn = trace.turns[rel.turnIndex];
      out.push({
        kind: truncated ? 'trigger_truncated' : 'maybe_missed',
        turnIndex: rel.turnIndex,
        callIndex: turn?.calls[0],
        skill: row.name,
        title: row.name,
        detail: truncated ? `匹配词只在被截断的部分：${rel.tailOnly.slice(0, 4).join('、')}` : `与用户请求相关：${rel.matched.slice(0, 4).join('、')}`,
        certainty: 'heuristic',
      });
    }
    if (row.flags.includes('not_followed')) {
      const inv = row.invocations[0];
      out.push({
        kind: 'not_followed',
        turnIndex: inv?.turnIndex ?? (inv ? (turnOf.get(inv.callIndex) ?? 0) : 0),
        callIndex: inv?.callIndex,
        toolId: inv?.toolCallId,
        skill: row.name,
        title: row.name,
        detail: '加载后没有用到 SKILL.md 里的命令或路径',
        certainty: 'heuristic',
      });
    }
  }
  return out.sort((a, b) => (a.callIndex ?? Infinity) - (b.callIndex ?? Infinity) || a.turnIndex - b.turnIndex);
}

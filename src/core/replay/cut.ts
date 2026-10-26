import type { LineIndex } from '../parse';
import type { SessionTrace, Turn } from '../../shared/types';

/**
 * Where a session can be replayed from. A replay of turn K continues a copy
 * of the session that ends right before the turn's first record (Codex: its
 * `task_started`; Claude Code: the prompt), with the turn's input
 * sent again — so lines [0, startLine) must hold everything the agent had
 * before the turn and nothing of the turn itself.
 */

export interface TurnCut {
  turnIndex: number;
  turnId: string;
  /** The copy keeps lines [0, startLine). */
  startLine: number;
  /** Size of that copy in bytes. */
  prefixBytes: number;
  replayable: boolean;
  /** Why it cannot be replayed. */
  reasons: string[];
  /** Replayable, but the replay may differ from the original for these reasons. */
  warnings: string[];
}

const FIRST_RECORD: Record<'rollout' | 'claude', (kind: string) => boolean> = {
  rollout: (k) => k === 'event_msg:task_started',
  claude: (k) => k === 'user',
};

/** Background work started before turn K that may still have been running when it began. */
function pendingBefore(trace: Pick<SessionTrace, 'turns' | 'calls' | 'tools'>, turn: Turn): string[] {
  const out: string[] = [];
  const earlier = new Set(trace.turns.filter((t) => t.index < turn.index).flatMap((t) => t.calls));
  const tools = Object.values(trace.tools).filter((t) => earlier.has(t.callIndex));
  if (tools.some((t) => t.status === 'running')) out.push('之前的轮次有没结束的后台任务');
  if (tools.some((t) => t.kind === 'collab' && /spawn/i.test(t.name))) out.push('之前的轮次启动过子 agent');
  return out;
}

export function turnCuts(trace: Pick<SessionTrace, 'meta' | 'turns' | 'calls' | 'tools' | 'forkPrefix'>, index: LineIndex, format: 'rollout' | 'claude' = 'rollout'): TurnCut[] {
  const isFirst = FIRST_RECORD[format];
  const prefixEnd = trace.forkPrefix?.endLine ?? 0;
  // a subagent's "user" messages come from its parent (Codex's guardian reviews, spawned agents)
  const subagent = trace.meta.source === 'subagent' || !!trace.meta.spawn;
  return trace.turns.map((turn) => {
    const startLine = turn.startLine ?? -1;
    const reasons: string[] = [];
    const warnings: string[] = [];
    if (subagent) reasons.push('子 agent 会话，输入来自父会话；请回放父会话的那一轮');
    else if (turn.trigger !== 'user') {
      reasons.push(turn.trigger === 'inter_agent' ? '由其它 agent 的消息触发，不能用一条输入重放' : turn.trigger === 'system' ? '由系统消息触发，不能用一条输入重放' : '找不到这一轮的用户输入');
    }
    if (!turn.input) reasons.push('没有用户输入');
    if (startLine < 0 || !isFirst(index.kinds[startLine] ?? '')) reasons.push('找不到这一轮开始的记录');
    else if (startLine < prefixEnd) reasons.push('在复制来的历史里');
    if (!reasons.length) {
      warnings.push(...pendingBefore(trace, turn));
      if (turn.status === 'aborted') warnings.push('原轮次被中断');
    }
    return {
      turnIndex: turn.index,
      turnId: turn.id,
      startLine,
      prefixBytes: startLine >= 0 ? (index.offsets[startLine] ?? 0) : 0,
      replayable: reasons.length === 0,
      reasons,
      warnings,
    };
  });
}

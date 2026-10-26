import type { AttributionResponse, LoopFinding } from '../../shared/api';
import type { SessionTrace, ToolCall } from '../../shared/types';

/** Deterministic failure signals: failed tools/commands, repeated commands, aborts, request errors. */

function signature(t: ToolCall): string {
  let s: string;
  if (t.kind === 'code_exec' && t.inner.some((e) => e.kind === 'exec')) {
    s = t.inner
      .filter((e) => e.kind === 'exec')
      .map((e) => e.title)
      .join(' ; ');
  } else if (t.argsJson && typeof t.argsJson === 'object') {
    const a = t.argsJson as Record<string, unknown>;
    s = `${t.name} ${String(a.cmd ?? a.command ?? a.file_path ?? a.path ?? a.pattern ?? a.query ?? t.args.preview)}`;
  } else {
    s = `${t.name} ${t.args.preview}`;
  }
  return s.toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 200);
}

export function attribution(trace: SessionTrace, opts: { window?: number; minRepeat?: number } = {}): AttributionResponse {
  const window = opts.window ?? 10;
  const minRepeat = opts.minRepeat ?? 3;
  const tools = trace.calls.flatMap((c) => c.tools.map((id) => trace.tools[id]).filter((t): t is ToolCall => Boolean(t)));

  const failedTools = tools
    .filter((t) => t.isError)
    .map((t) => {
      const inner = t.inner.find((e) => e.isError);
      return {
        toolId: t.id,
        callIndex: t.callIndex,
        name: t.name,
        kind: t.kind,
        reason: t.errorReason,
        inner: inner ? { title: inner.title, exitCode: inner.exitCode } : undefined,
      };
    });

  const failedCommands = tools
    .flatMap((t) => t.inner.filter((e) => e.isError && e.kind === 'exec').map((e) => ({ toolId: t.id, callIndex: t.callIndex, title: e.title, exitCode: e.exitCode })))
    .slice(0, 300);

  // Repeated commands: same signature ≥ minRepeat times with gaps ≤ window calls.
  const bySig = new Map<string, ToolCall[]>();
  for (const t of tools) {
    if (t.kind === 'wait' || t.kind === 'plan' || t.kind === 'collab') continue;
    const sig = signature(t);
    if (!sig) continue;
    const list = bySig.get(sig) ?? [];
    list.push(t);
    bySig.set(sig, list);
  }
  const loops: LoopFinding[] = [];
  for (const [sig, list] of bySig) {
    if (list.length < minRepeat) continue;
    let cluster: ToolCall[] = [list[0]];
    const flush = () => {
      if (cluster.length >= minRepeat) {
        loops.push({ signature: sig, count: cluster.length, callIndices: cluster.map((t) => t.callIndex), toolIds: cluster.map((t) => t.id) });
      }
    };
    for (let i = 1; i < list.length; i++) {
      if (list[i].callIndex - cluster[cluster.length - 1].callIndex <= window) cluster.push(list[i]);
      else {
        flush();
        cluster = [list[i]];
      }
    }
    flush();
  }
  loops.sort((a, b) => b.count - a.count);

  const aborts = trace.turns.flatMap((t) => t.marks.filter((m) => m.kind === 'abort').map((m) => ({ turnIndex: t.index, reason: m.detail })));
  const requestErrors = trace.turns.flatMap((t) => t.marks.filter((m) => m.kind === 'error').map((m) => ({ turnIndex: t.index, detail: m.detail })));
  const first = failedTools[0];

  return {
    failedTools,
    failedCommands,
    loops: loops.slice(0, 50),
    aborts,
    requestErrors,
    firstError: first ? { callIndex: first.callIndex, toolId: first.toolId } : undefined,
  };
}

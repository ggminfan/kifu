import type { AttributionResponse, SkillReportResponse } from '../../shared/api';
import type { LlmCall, SessionTrace, ToolCall } from '../../shared/types';
import { oneLine } from '../text';

/**
 * Compact, anchor-annotated digest of a session for the "问为什么" analyst.
 * Anchors: U<n> user turns, C<n> LLM calls (1-based steps), T:<callId> tools,
 * S:<skill> catalog entries, L:<skill>#L<a>-<b> skill body lines.
 */

export interface DigestInput {
  trace: SessionTrace;
  skills: SkillReportResponse;
  attribution: AttributionResponse;
  focus?: { callIndex?: number; toolId?: string };
  question: string;
  /** Skill bodies to include (name → text). */
  skillBodies: Record<string, string>;
  /** Full text of the focused tool's args/output when available. */
  focusTexts?: { args?: string; output?: string };
}

export interface Digest {
  text: string;
  anchors: Set<string>;
}

const MAX_CHARS = 90_000;

function toolLine(t: ToolCall): string {
  const inner = t.inner
    .slice(0, 3)
    .map((e) => `${e.title}${e.exitCode !== undefined ? ` →exit ${e.exitCode}` : ''}`)
    .join(' ; ');
  const status = t.isError ? 'FAILED' : t.status;
  const args = oneLine(t.args.preview, 160);
  return `  - [T:${t.id}] ${t.name} ${args}${inner ? ` | ${oneLine(inner, 200)}` : ''} | ${status}${t.skill ? ` | loads skill ${t.skill}` : ''}`;
}

function callBlock(trace: SessionTrace, c: LlmCall, detailed: boolean): string {
  const lines: string[] = [];
  const kind = c.kind === 'response' ? '' : ` (${c.kind})`;
  lines.push(`[C${c.index + 1}] Step ${c.index + 1}${kind}${c.usage ? ` in=${c.usage.input} out=${c.usage.output}` : ''}`);
  if (c.reasoning) lines.push(`  reasoning: ${oneLine(c.reasoning.preview, detailed ? 900 : 200)}`);
  if (c.text) lines.push(`  says: ${oneLine(c.text.preview, detailed ? 900 : 200)}`);
  for (const id of c.tools) {
    const t = trace.tools[id];
    if (t) lines.push(toolLine(t));
  }
  return lines.join('\n');
}

function numbered(body: string, maxLines = 260): string {
  return body
    .split('\n')
    .slice(0, maxLines)
    .map((l, i) => `${String(i + 1).padStart(3)}| ${l}`)
    .join('\n');
}

export function buildDigest(input: DigestInput): Digest {
  const { trace, skills, attribution, focus } = input;
  const anchors = new Set<string>();
  const parts: string[] = [];
  const m = trace.meta;
  parts.push(`# 会话 ${m.threadId}`);
  parts.push(`model=${m.model ?? '?'} cli=${m.cliVersion ?? '?'} turns=${trace.turns.length} steps=${trace.calls.length} tools=${Object.keys(trace.tools).length}`);
  parts.push(`\n## 用户问题\n${input.question}`);

  parts.push('\n## Skill 列表（模型在上下文中看到的；~~删除线~~ 为被截断、模型看不到的部分）');
  for (const r of skills.rows) {
    if (!r.listed) continue;
    anchors.add(`S:${r.name}`);
    const tail = r.hiddenTail ? ` ~~${r.hiddenTail}~~` : '';
    const flags = r.flags.length ? ` [${r.flags.join(',')}]` : '';
    parts.push(`- [S:${r.name}] ${oneLine(r.visibleDescription ?? r.fullDescription ?? '', 400)}${tail}${flags}`);
  }

  parts.push('\n## 用户 / agent 输入');
  for (const t of trace.turns) {
    if (!t.input) continue;
    anchors.add(`U${t.index + 1}`);
    parts.push(`[U${t.index + 1}] 第 ${t.index + 1} 轮 (${t.trigger}): ${oneLine(t.input.preview, 1500)}`);
  }

  parts.push('\n## 确定性分析结果');
  for (const r of skills.rows.filter((x) => x.flags.length)) {
    parts.push(`- skill ${r.name}: ${r.flags.join(', ')}${r.relevance ? `; 与 U${r.relevance.turnIndex + 1} 匹配词 ${r.relevance.matched.slice(0, 6).join('/')}` : ''}${r.invocations.length ? `; 加载于 ${r.invocations.map((i) => `C${i.callIndex + 1}`).join(',')}` : ''}`);
  }
  if (attribution.failedTools.length) parts.push(`- 失败的工具调用 ${attribution.failedTools.length} 个：${attribution.failedTools.slice(0, 12).map((f) => `C${f.callIndex + 1}/${f.name}`).join(', ')}`);
  for (const l of attribution.loops.slice(0, 5)) parts.push(`- 重复 ${l.count} 次：${oneLine(l.signature, 120)}（${l.callIndices.slice(0, 6).map((c) => `C${c + 1}`).join(',')}）`);
  for (const a of attribution.aborts) parts.push(`- 第 ${a.turnIndex + 1} 轮被中断 ${a.reason ?? ''}`);

  // Steps: all in one line each, focus window in detail.
  const focusIdx = focus?.callIndex ?? (focus?.toolId ? trace.tools[focus.toolId]?.callIndex : undefined);
  parts.push('\n## 执行轨迹');
  let budget = MAX_CHARS - parts.join('\n').length - 20_000;
  const stepTexts: string[] = [];
  for (const c of trace.calls) {
    const detailed = focusIdx !== undefined && Math.abs(c.index - focusIdx) <= 4;
    const block = callBlock(trace, c, detailed);
    anchors.add(`C${c.index + 1}`);
    for (const id of c.tools) anchors.add(`T:${id}`);
    stepTexts.push(block);
  }
  let steps = stepTexts.join('\n');
  if (steps.length > budget) {
    // Keep the beginning, the focus window and the end.
    const keep = new Set<number>();
    const n = stepTexts.length;
    for (let i = 0; i < Math.min(n, 40); i++) keep.add(i);
    for (let i = Math.max(0, n - 40); i < n; i++) keep.add(i);
    if (focusIdx !== undefined) for (let i = Math.max(0, focusIdx - 15); i < Math.min(n, focusIdx + 15); i++) keep.add(i);
    for (const inv of trace.invocations) keep.add(inv.callIndex);
    const out: string[] = [];
    let skipped = 0;
    for (let i = 0; i < n; i++) {
      if (keep.has(i)) {
        if (skipped) out.push(`  …（省略 ${skipped} 步）`);
        skipped = 0;
        out.push(stepTexts[i]);
      } else skipped++;
    }
    steps = out.join('\n').slice(0, Math.max(budget, 20_000));
  }
  parts.push(steps);

  if (focusIdx !== undefined) {
    parts.push(`\n## 焦点：Step ${focusIdx + 1}${focus?.toolId ? ` / 工具 T:${focus.toolId}` : ''}`);
    if (input.focusTexts?.args) parts.push(`参数：\n${input.focusTexts.args.slice(0, 6000)}`);
    if (input.focusTexts?.output) parts.push(`输出：\n${input.focusTexts.output.slice(0, 6000)}`);
  }

  for (const [name, body] of Object.entries(input.skillBodies)) {
    parts.push(`\n## 已加载 / 相关 skill 正文：${name}（引用格式 L:${name}#L起-止）`);
    parts.push(numbered(body));
    anchors.add(`L:${name}`);
  }

  budget = MAX_CHARS;
  const text = parts.join('\n');
  return { text: text.length > budget ? `${text.slice(0, budget)}\n…（摘要已截断）` : text, anchors };
}

export function anchorValid(ref: string, anchors: Set<string>): boolean {
  const r = ref.trim().replace(/^\[|\]$/g, '');
  if (anchors.has(r)) return true;
  const l = /^(L:[^#]+)#L\d+(-\d+)?$/.exec(r);
  return Boolean(l && anchors.has(l[1]));
}

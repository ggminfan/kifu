import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { anchorValid, buildDigest } from '../../core/analysis/digest';
import { attribution } from '../../core/analysis/errors';
import { quoteFinder } from '../../core/analysis/quotes';
import { skillReport } from '../../core/analysis/skills';
import { dataPaths } from '../config';
import { readText } from './parseCache';
import { parsedSession } from './sessions';
import { diskLookupFor } from './skillFiles';
import { runAnalyst } from '../replay/analyst';

/**
 * "问为什么": LLM-assisted attribution. A digest of the session (with anchors)
 * goes to a bare analyst (the agent CLI with no skills, plugins, hooks or memories, read-only,
 * ephemeral); the JSON answer is validated and every reference/quote is checked
 * against the digest.
 */

const CAUSE_KINDS = ['skill_description', 'skill_content', 'user', 'system_developer', 'agents_md', 'tool_output', 'prior_step', 'subagent', 'memory', 'model_prior'] as const;

export const AskSchema = z.object({
  answer: z.string(),
  confidence: z.enum(['high', 'medium', 'low']).catch('low'),
  causes: z
    .array(
      z.object({
        claim: z.string(),
        kind: z.enum(CAUSE_KINDS).catch('model_prior'),
        weight: z.number().min(0).max(1).catch(0.5),
        evidence: z.array(z.object({ ref: z.string(), quote: z.string().catch('') })).catch([]),
      }),
    )
    .catch([]),
  skill_findings: z
    .array(z.object({ skill: z.string(), role: z.enum(['correct', 'should_trigger', 'should_not_trigger', 'misled', 'ignored']).catch('misled'), problem: z.string() }))
    .catch([]),
  suggested_edits: z
    .array(
      z.object({
        skill: z.string(),
        target: z.enum(['description', 'body']),
        find: z.string().nullable().catch(null),
        replace: z.string(),
        rationale: z.string().catch(''),
      }),
    )
    .catch([]),
});

export type AskAnswer = z.infer<typeof AskSchema>;

export interface AskResult extends AskAnswer {
  causes: Array<AskAnswer['causes'][number] & { evidence: Array<{ ref: string; quote: string; refValid: boolean; quoteVerified: boolean }> }>;
  digestChars: number;
  usage?: { input_tokens?: number; output_tokens?: number };
  attempts: number;
}

export interface AskJob {
  id: string;
  sessionId: string;
  question: string;
  focus?: { callIndex?: number; toolId?: string };
  status: 'running' | 'completed' | 'failed';
  startedAt: number;
  finishedAt?: number;
  result?: AskResult;
  error?: string;
  raw?: string;
}

const jobs = new Map<string, AskJob>();

const SCHEMA_HINT = `{
  "answer": "一段话直接回答用户问题",
  "confidence": "high | medium | low",
  "causes": [{ "claim": "原因", "kind": "${CAUSE_KINDS.join(' | ')}", "weight": 0.0-1.0, "evidence": [{ "ref": "锚点，如 C12 / T:<id> / S:<skill> / L:<skill>#L10-20 / U1", "quote": "从摘要中逐字摘录的原文" }] }],
  "skill_findings": [{ "skill": "skill 名", "role": "correct | should_trigger | should_not_trigger | misled | ignored", "problem": "问题描述" }],
  "suggested_edits": [{ "skill": "skill 名（与 S: 锚点一致）", "target": "description | body", "find": "body 中要替换的原文，description 时为 null", "replace": "新文本（description 时为完整新描述）", "rationale": "为什么这样改" }]
}`;

function analystPrompt(): string {
  return [
    '你是 agent 执行轨迹的归因分析员。下面"---"之后是一次编码 agent 会话的摘要，带锚点：',
    'U<n> 用户/agent 输入；C<n> 第 n 步 LLM 调用；T:<id> 工具调用；S:<skill> 模型看到的 skill 列表条目（~~删除线~~ 部分被截断、模型看不到）；L:<skill>#L起-止 skill 正文行号。',
    '请回答摘要里的"用户问题"：找出导致该行为的上下文原因，重点判断 skill 描述（决定是否触发）和 skill 正文（触发后怎么做）的影响，也要考虑竞争的同类 skill、用户输入和工具输出。',
    '要求：',
    '1. 只依据摘要内容。每条原因都要给证据：ref 必须是摘要中出现过的锚点，quote 必须逐字摘自摘要。',
    '2. 如果是 skill 描述或正文的问题，在 suggested_edits 给出可以直接替换的修改；description 的新描述要短（模型只能看到前一百多个字符），把触发词放在最前面。',
    '3. 不要调用任何工具，直接回答。只输出一个 JSON 对象，不要任何其他文字，不要代码块标记。格式：',
    SCHEMA_HINT,
  ].join('\n');
}

export function extractJson(text: string): unknown {
  const t = text.replace(/^```(?:json)?\s*/m, '').replace(/```\s*$/m, '');
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start === -1 || end <= start) throw new Error('回答中没有 JSON');
  const body = t.slice(start, end + 1).replace(/,\s*([}\]])/g, '$1');
  return JSON.parse(body);
}

/** The workspace's own agent answers, as an analyst with no skills or plugins (see replay/analyst.ts). */
function callAnalyst(jobDir: string, input: string, prompt: string): Promise<{ text: string; usage?: AskResult['usage'] }> {
  return runAnalyst({ jobDir, instructions: prompt, input });
}

export function askBusy(): boolean {
  for (const j of jobs.values()) if (j.status === 'running') return true;
  return false;
}

export function getJob(id: string): AskJob | undefined {
  const live = jobs.get(id);
  if (live) return live;
  // Finished (or interrupted) jobs survive restarts on disk.
  try {
    const saved = JSON.parse(fs.readFileSync(path.join(dataPaths.jobs, path.basename(id), 'job.json'), 'utf8')) as AskJob;
    if (saved.status === 'running') return { ...saved, status: 'failed', error: '服务重启，分析中断，请重新提问' };
    return saved;
  } catch {
    return undefined;
  }
}

export async function startAsk(sessionId: string, question: string, focus?: { callIndex?: number; toolId?: string }): Promise<AskJob> {
  const entry = await parsedSession(sessionId);
  const trace = entry.trace;
  const lookup = diskLookupFor(sessionId);
  const skills = skillReport(trace, lookup);
  const attr = attribution(trace);

  const bodies: Record<string, string> = {};
  const wanted = [
    ...skills.rows.filter((r) => r.invocations.length).map((r) => r.name),
    ...skills.rows.filter((r) => r.flags.includes('maybe_missed')).slice(0, 2).map((r) => r.name),
  ];
  const focusTool = focus?.toolId ? trace.tools[focus.toolId] : undefined;
  if (focusTool?.skill) wanted.unshift(focusTool.skill);
  for (const name of [...new Set(wanted)].slice(0, 4)) {
    const row = skills.rows.find((r) => r.name === name);
    const body = lookup(row?.path, name)?.body;
    if (body) bodies[name] = body;
  }
  const focusTexts: { args?: string; output?: string } = {};
  if (focusTool) {
    focusTexts.args = focusTool.args.ref ? (await readText(entry, focusTool.args.ref)).text : focusTool.args.preview;
    focusTexts.output = focusTool.output?.ref ? (await readText(entry, focusTool.output.ref)).text : focusTool.output?.preview;
  }
  const digest = buildDigest({ trace, skills, attribution: attr, focus, question, skillBodies: bodies, focusTexts });

  const job: AskJob = { id: `q${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`, sessionId, question, focus, status: 'running', startedAt: Date.now() };
  jobs.set(job.id, job);
  const jobDir = path.join(dataPaths.jobs, job.id);
  fs.mkdirSync(jobDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(jobDir, 'digest.md'), digest.text);
  fs.writeFileSync(path.join(jobDir, 'job.json'), JSON.stringify(job, null, 2));

  void (async () => {
    try {
      let attempts = 1;
      let { text, usage } = await callAnalyst(jobDir, digest.text, analystPrompt());
      let parsed = AskSchema.safeParse((() => {
        try {
          return extractJson(text);
        } catch {
          return undefined;
        }
      })());
      if (!parsed.success) {
        attempts++;
        const repair = `${analystPrompt()}\n\n你上一次的回答不是合法 JSON，请只输出符合格式的 JSON 对象。上一次的回答附在摘要末尾的"上次回答"部分。`;
        ({ text, usage } = await callAnalyst(jobDir, `${digest.text}\n\n## 上次回答\n${text}`, repair));
        parsed = AskSchema.safeParse(extractJson(text));
      }
      if (!parsed.success) throw new Error(`回答不符合格式：${parsed.error.issues.slice(0, 3).map((i) => i.message).join('; ')}`);
      const found = quoteFinder([digest.text, ...Object.values(bodies)].join('\n'));
      job.result = {
        ...parsed.data,
        causes: parsed.data.causes.map((c) => ({
          ...c,
          evidence: c.evidence.map((e) => ({ ...e, refValid: anchorValid(e.ref, digest.anchors), quoteVerified: Boolean(e.quote) && found(e.quote!) })),
        })),
        digestChars: digest.text.length,
        usage,
        attempts,
      };
      job.raw = text;
      job.status = 'completed';
    } catch (e) {
      job.error = (e as Error).message;
      job.status = 'failed';
    } finally {
      job.finishedAt = Date.now();
      fs.writeFileSync(path.join(jobDir, 'job.json'), JSON.stringify(job, null, 2));
    }
  })();
  return job;
}

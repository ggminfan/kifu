import fs from 'node:fs';
import path from 'node:path';
import { stringify } from 'yaml';
import { z } from 'zod';
import { quoteFinder } from '../../core/analysis/quotes';
import { tokenSet } from '../../core/analysis/tokens';
import { mineSessions, type MineInput, type MineResult } from '../../core/distill/mine';
import { normalizeText } from '../../core/skills/frontmatter';
import type { Arm, EvalSet } from '../../shared/replay';
import { dataPaths } from '../config';
import { runAnalyst } from '../replay/analyst';
import { getCase, updateCase } from '../replay/cases';
import { addTurns, createSet, mustGetSet, resolveTurns } from '../replay/evals';
import { extractJson } from './askWhy';
import { catalog } from './catalog';
import { previewSkill } from './preview';
import { parsedSession } from './sessions';
import { getSession, listSessions } from './stateDb';
import { createNewSkillVariant, getVariant, SKILL_NAME, type Variant } from './variants';

/**
 * Distilling a skill from sessions: rules mine the shared paths and repeated
 * clarifications (core/distill/mine.ts); the workspace's agent, as an analyst
 * with no skills of its own, writes a draft from that material, with evidence
 * checked against it; the draft is validated (name, the skill listing with it
 * mounted), saved as a brand-new skill variant and evaluated on its source
 * sessions (positives) and unrelated ones (negatives) before it is installed.
 */

export const MAX_SOURCES = 20;

const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);
const norm = (s: string) => s.replace(/\s+/g, ' ').trim();

export async function mineInputs(sessionIds: string[]): Promise<MineInput[]> {
  const out: MineInput[] = [];
  for (const id of sessionIds.slice(0, MAX_SOURCES)) {
    const entry = await parsedSession(id);
    const s = getSession(id);
    out.push({ id, title: s?.title ?? s?.firstUserMessage?.slice(0, 80) ?? entry.trace.turns.find((t) => t.input?.preview)?.input?.preview.slice(0, 80), trace: entry.trace });
  }
  return out;
}

export async function mine(sessionIds: string[]): Promise<MineResult & { titles: Record<string, string> }> {
  const inputs = await mineInputs(sessionIds);
  const r = mineSessions(
    inputs,
    catalog().filter((s) => !s.shadowedBy),
  );
  return { ...r, titles: Object.fromEntries(inputs.map((s) => [s.id, s.title ?? s.id])) };
}

// ------------------------------------------------------------------ draft (analyst)

export const DraftSchema = z.object({
  name: z.string(),
  description: z.string(),
  triggers: z.object({ positive: z.array(z.string()).catch([]), negative: z.array(z.string()).catch([]) }).catch({ positive: [], negative: [] }),
  steps: z.array(z.string()).catch([]),
  clarifications: z.array(z.object({ question: z.string(), answer: z.string() })).catch([]),
  pitfalls: z.array(z.string()).catch([]),
  evidence: z.array(z.object({ session: z.string().catch(''), turn: z.coerce.number().catch(0), quote: z.string().catch('') })).catch([]),
});

export type DraftAnswer = z.infer<typeof DraftSchema>;

export interface Draft extends DraftAnswer {
  body: string;
  evidence: Array<DraftAnswer['evidence'][number] & { sessionId?: string; verified: boolean }>;
}

export interface DraftJob {
  id: string;
  sessionIds: string[];
  status: 'running' | 'completed' | 'failed';
  startedAt: number;
  finishedAt?: number;
  draft?: Draft;
  usage?: { input_tokens?: number; cached_input_tokens?: number; output_tokens?: number };
  error?: string;
}

const jobs = new Map<string, DraftJob>();

function instructions(existing: string[]): string {
  return [
    '你是编码 agent 的 skill 作者。下面"---"之后是同一类任务的几次 agent 会话的摘要：用户的请求和 agent 的回答、用户的追问和纠正（agent 先问了什么、用户怎么答的）、多次会话共有的工具调用路径，以及现有的相近 skill。',
    '请把这些会话里反复出现的做法和反复要澄清的信息沉淀成一个新的 skill：agent 下次遇到同类请求时加载它，直接按它做，少问、少走弯路。',
    '要求：',
    '- name：小写英文字母、数字和连字符，2–40 个字符，说明用途；不能和现有 skill 重名。',
    '- description：一到三句话，先写什么时候用（用户会说的原词作为触发词，中英文都可以），再写什么时候不用。agent 只看 skill 列表里的描述决定是否加载，描述可能被截断，最重要的触发词放在前 120 个字符内。',
    '- triggers.positive / triggers.negative：应该触发 / 不应该触发的典型说法，各 3–6 个短语。',
    '- steps：照着做的步骤，每步一句，可以带具体命令。',
    '- clarifications：用户反复需要回答或纠正的事，写成 question（agent 会问的问题）和 answer（默认就这样做）。',
    '- pitfalls：会话里出过的错和避免方法。',
    '- evidence：每条重要结论的出处。session 用摘要里的会话编号（S1、S2…），turn 用摘要里的轮次编号，quote 是摘要里连续的一段原文：逐字复制，不改写、不拼接、不加省略号，10–40 个字就够。',
    existing.length ? `现有 skill 名称（不能重名）：${existing.slice(0, 80).join(', ')}` : '',
    '只输出一个 JSON 对象，不要其他文字：',
    '{"name": "...", "description": "...", "triggers": {"positive": ["..."], "negative": ["..."]}, "steps": ["..."], "clarifications": [{"question": "...", "answer": "..."}], "pitfalls": ["..."], "evidence": [{"session": "S1", "turn": 1, "quote": "..."}]}',
  ]
    .filter(Boolean)
    .join('\n');
}

/** The material the analyst writes from: sessions (S1…), shared paths, repeated clarifications, similar skills. */
export function material(inputs: MineInput[], mined: MineResult, hint?: string): { text: string; labels: Record<string, string> } {
  const labels = Object.fromEntries(inputs.map((s, i) => [`S${i + 1}`, s.id]));
  const label = Object.fromEntries(inputs.map((s, i) => [s.id, `S${i + 1}`]));
  const parts: string[] = [];
  if (hint?.trim()) parts.push(`## 作者的说明\n${hint.trim()}`);
  parts.push('## 会话');
  for (const s of inputs) {
    parts.push(`### ${label[s.id]} ${s.title ?? ''}`.trim());
    for (const t of s.trace.turns.filter((x) => x.trigger === 'user').slice(0, 8)) {
      parts.push(`- 第 ${t.index + 1} 轮 用户：${cut(norm(t.input?.preview ?? ''), 600)}`);
      if (t.lastAgentMessage?.preview) parts.push(`  agent 最后回答：${cut(norm(t.lastAgentMessage.preview), 400)}`);
    }
  }
  if (mined.paths.length) {
    parts.push('## 共有的工具调用路径');
    for (const p of mined.paths) parts.push(`- ${p.steps.join(' → ')}（${inputs.length > 1 ? `${p.support} 个会话` : `${p.support} 次`}：${p.at.map((a) => `${label[a.sessionId]} 第 ${a.turnIndex + 1} 轮`).join('、')}）`);
  }
  if (mined.clarifications.length) {
    parts.push('## 反复的澄清和纠正');
    for (const c of mined.clarifications) {
      parts.push(`- ${c.items.length} 次（${c.sessions} 个会话）`);
      for (const it of c.items.slice(0, 4)) {
        if (it.question) parts.push(`  - ${label[it.sessionId]} 第 ${it.turnIndex} 轮 agent 问：${cut(norm(it.question), 200)}`);
        parts.push(`  - ${label[it.sessionId]} 第 ${it.turnIndex + 1} 轮 用户${it.kind === 'correction' ? '纠正' : '回答'}：${cut(norm(it.reply), 240)}`);
      }
    }
  }
  if (mined.similar.length) {
    const byKey = new Map(catalog().map((s) => [s.key, s]));
    parts.push('## 现有的相近 skill');
    for (const m of mined.similar) parts.push(`- ${m.key}：${cut(norm(byKey.get(m.key)?.description ?? ''), 300)}`);
  }
  return { text: parts.join('\n'), labels };
}

/** SKILL.md of a draft: frontmatter (name, description) and a body from its steps, defaults and pitfalls. */
export function renderSkill(d: Pick<DraftAnswer, 'name' | 'description' | 'steps' | 'clarifications' | 'pitfalls'>): { raw: string; body: string } {
  const body = [
    `# ${d.name}`,
    '',
    ...(d.steps.length ? ['## 步骤', '', ...d.steps.map((s, i) => `${i + 1}. ${s}`), ''] : []),
    ...(d.clarifications.length ? ['## 默认做法（不用再问）', '', ...d.clarifications.map((c) => `- ${c.question} → ${c.answer}`), ''] : []),
    ...(d.pitfalls.length ? ['## 注意', '', ...d.pitfalls.map((p) => `- ${p}`), ''] : []),
  ].join('\n');
  return { raw: skillMd(d.name, d.description, body), body };
}

export function skillMd(name: string, description: string, body: string): string {
  return `---\n${stringify({ name, description }, { lineWidth: 0 }).trimEnd()}\n---\n\n${body.replace(/^\n+/, '')}`;
}

export function draftJob(id: string): DraftJob | undefined {
  const live = jobs.get(id);
  if (live) return live;
  try {
    const saved = JSON.parse(fs.readFileSync(path.join(dataPaths.jobs, path.basename(id), 'job.json'), 'utf8')) as DraftJob;
    return saved.status === 'running' ? { ...saved, status: 'failed', error: '服务重启，生成中断，请重试' } : saved;
  } catch {
    return undefined;
  }
}

/** Write a draft with the workspace's agent (one analyst call, plus one to repair a malformed answer). */
export async function startDraft(sessionIds: string[], hint?: string): Promise<DraftJob> {
  const inputs = await mineInputs(sessionIds);
  if (!inputs.length) throw new Error('需要至少一个会话');
  const mined = mineSessions(
    inputs,
    catalog().filter((s) => !s.shadowedBy),
  );
  const m = material(inputs, mined, hint);
  const job: DraftJob = { id: `d${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`, sessionIds: inputs.map((s) => s.id), status: 'running', startedAt: Date.now() };
  jobs.set(job.id, job);
  const jobDir = path.join(dataPaths.jobs, job.id);
  fs.mkdirSync(jobDir, { recursive: true, mode: 0o700 });
  const save = () => fs.writeFileSync(path.join(jobDir, 'job.json'), JSON.stringify(job, null, 2));
  save();
  const prompt = instructions(catalog().map((s) => s.name));
  void (async () => {
    try {
      let res = await runAnalyst({ jobDir, instructions: prompt, input: m.text });
      let parsed = DraftSchema.safeParse(safeJson(res.text));
      if (!parsed.success) {
        res = await runAnalyst({ jobDir, instructions: `${prompt}\n\n你上一次的回答不是合法的 JSON，请只输出符合格式的 JSON 对象。上一次的回答附在最后的"上次回答"部分。`, input: `${m.text}\n\n## 上次回答\n${res.text}` });
        parsed = DraftSchema.safeParse(safeJson(res.text));
      }
      if (!parsed.success) throw new Error(`草稿不符合格式：${parsed.error.issues.slice(0, 3).map((i) => i.message).join('; ')}`);
      const d = parsed.data;
      const name = d.name.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
      const found = quoteFinder(m.text);
      job.draft = {
        ...d,
        name,
        body: renderSkill({ ...d, name }).body,
        evidence: d.evidence.map((e) => {
          const sessionId = m.labels[e.session.trim().toUpperCase()];
          const turns = sessionId ? inputs.find((s) => s.id === sessionId)?.trace.turns.length ?? 0 : 0;
          return { ...e, sessionId, verified: Boolean(sessionId) && e.turn >= 1 && e.turn <= turns && found(e.quote) };
        }),
      };
      job.usage = res.usage;
      job.status = 'completed';
    } catch (e) {
      job.error = (e as Error).message;
      job.status = 'failed';
    } finally {
      job.finishedAt = Date.now();
      save();
    }
  })();
  return job;
}

function safeJson(text: string): unknown {
  try {
    return extractJson(text);
  } catch {
    return undefined;
  }
}

// ------------------------------------------------------------------ validation

export interface DraftCheck {
  name: { ok: boolean; message?: string };
  /** How the description shows in the agent's skill listing with the new skill mounted. */
  listing?: {
    visible?: string;
    hiddenTail?: string;
    truncated: boolean | null;
    cap?: number;
    count: number;
    budgetParity: boolean;
    /** Other skills whose visible text changed (the listing shares one budget). */
    othersChanged: Array<{ name: string; before?: string; after?: string }>;
  };
  triggers: Array<{ text: string; where: 'visible' | 'hidden' | 'missing' }>;
  error?: string;
}

export function checkName(name: string): DraftCheck['name'] {
  if (!SKILL_NAME.test(name)) return { ok: false, message: '只能用小写字母、数字和连字符（2–63 个字符），以字母或数字开头' };
  const clash = catalog().find((s) => s.key === name || s.name === name);
  if (clash) return { ok: false, message: `已经有叫 ${name} 的 skill（${clash.dir}）` };
  return { ok: true };
}

/** Name, the listing with the draft mounted (no model call), and whether its trigger words stay visible. */
export async function checkDraft(d: { name: string; description: string; body: string; triggers?: string[] }): Promise<DraftCheck> {
  const out: DraftCheck = { name: checkName(d.name), triggers: [] };
  const dir = path.join(dataPaths.runs, `distill-check-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`);
  const skillDir = path.join(dir, d.name || 'draft');
  try {
    fs.mkdirSync(skillDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), skillMd(d.name || 'draft', d.description, d.body));
    const fake = { id: 'draft', skillKey: d.name, skillName: d.name || 'draft', originalPath: '', baseHash: '', label: 'draft', createdAt: 0, updatedAt: 0, dir: skillDir } satisfies Variant;
    const byName = new Map(catalog().filter((s) => !s.shadowedBy).map((s) => [s.key, s.description]));
    const r = await previewSkill({ skillKey: d.name, variant: fake, fullByName: (n) => byName.get(n) });
    const v = r.variant;
    if (v) {
      out.listing = { visible: v.entry?.description, hiddenTail: v.hiddenTail, truncated: v.truncated, cap: v.snapshot.cap, count: v.snapshot.count, budgetParity: v.snapshot.budgetParity, othersChanged: r.othersChanged };
    }
  } catch (e) {
    out.error = `列表预览失败：${(e as Error).message}`;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  const visible = normalizeText(out.listing?.visible ?? d.description).toLowerCase();
  const full = normalizeText(d.description).toLowerCase();
  out.triggers = (d.triggers ?? []).filter((t) => t.trim()).map((t) => {
    const x = normalizeText(t).toLowerCase();
    return { text: t, where: visible.includes(x) ? 'visible' : full.includes(x) ? 'hidden' : 'missing' };
  });
  return out;
}

// ------------------------------------------------------------------ variant and evaluation

export async function saveDraft(d: { name: string; description: string; body: string; note?: string }): Promise<Variant> {
  const name = checkName(d.name);
  if (!name.ok) throw new Error(name.message);
  return createNewSkillVariant(d.name, skillMd(d.name, d.description, d.body), { note: d.note });
}

/** Recent sessions least like the sources (by request words): negatives for the new skill. */
export function sampleNegatives(exclude: string[], about: string, n: number): string[] {
  const skip = new Set(exclude);
  const words = tokenSet(about);
  return listSessions({ limit: 80 })
    .sessions.filter((s) => !skip.has(s.id) && !s.id.startsWith('case-') && (s.firstUserMessage || s.title))
    .map((s) => {
      const t = tokenSet(`${s.title ?? ''} ${s.firstUserMessage ?? ''}`);
      let common = 0;
      for (const w of t) if (words.has(w)) common++;
      return { id: s.id, score: common / Math.max(1, t.size) };
    })
    .sort((a, b) => a.score - b.score)
    .slice(0, n)
    .map((x) => x.id);
}

/**
 * An evaluation set for a new skill: its source sessions (where it should load,
 * and nothing needs asking any more) and a few unrelated recent sessions
 * (where it must stay out of the way); the arms to compare.
 */
export async function draftSet(variantId: string, sessionIds: string[], o: { negatives?: number } = {}): Promise<{ set: EvalSet; added: number; failed: Array<{ sessionId: string; error: string }>; arms: Arm[] }> {
  const v = getVariant(variantId);
  if (!v) throw new Error('变体不存在');
  const name = v.skillName;
  const set = createSet({ name: `${name} 评测`, skill: name, note: `从 ${sessionIds.length} 个会话提炼的新 skill` });
  const failed: Array<{ sessionId: string; error: string }> = [];
  let added = 0;
  // positives: each source's first request
  const pos = await resolveTurns(sessionIds.slice(0, MAX_SOURCES), 'first');
  const p = await addTurns(
    set.id,
    pos.flatMap((t) => (t.turnIndex === undefined ? [] : [{ sessionId: t.sessionId, turnIndex: t.turnIndex }])),
    'positive',
  );
  for (const caseId of p.added) {
    const c = getCase(caseId);
    if (c && !c.checks.some((x) => x.kind === 'no_question')) updateCase(caseId, { checks: [...c.checks, { kind: 'no_question' }] });
  }
  added += p.added.length;
  failed.push(...p.failed, ...pos.filter((t) => t.turnIndex === undefined).map((t) => ({ sessionId: t.sessionId, error: t.reason ?? '没有可以回放的轮次' })));
  const raw = fs.readFileSync(path.join(v.dir, 'SKILL.md'), 'utf8');
  const negIds = sampleNegatives(sessionIds, raw, o.negatives ?? 4);
  const neg = await resolveTurns(negIds, 'last');
  const n = await addTurns(
    set.id,
    neg.flatMap((t) => (t.turnIndex === undefined ? [] : [{ sessionId: t.sessionId, turnIndex: t.turnIndex }])),
    'negative',
  );
  added += n.added.length;
  failed.push(...n.failed);
  return {
    set: mustGetSet(set.id),
    added,
    failed,
    arms: [
      { label: 'A′', variantIds: [] },
      { label: `+${name}`.slice(0, 40), variantIds: [variantId] },
    ],
  };
}

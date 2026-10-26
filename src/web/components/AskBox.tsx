import { useLocale } from '../../shared/i18n/react';
import { localized, tr } from '../../shared/i18n';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useLocation } from 'wouter';
import type { TraceResponse } from '../../shared/api';
import { api, postJson } from '../lib/api';
import type { CatalogSkill } from '../lib/labApi';
import { parseSkillMdClient } from '../lib/skillmd';
import { Markdown } from './Markdown';
import { Badge, Button, ErrorBox, Spinner, cx } from './ui';

interface Evidence {
  ref: string;
  quote: string;
  refValid: boolean;
  quoteVerified: boolean;
}

interface SuggestedEdit {
  skill: string;
  target: 'description' | 'body';
  find: string | null;
  replace: string;
  rationale: string;
}

interface AskJob {
  id: string;
  status: 'running' | 'completed' | 'failed';
  question: string;
  startedAt: number;
  finishedAt?: number;
  error?: string;
  result?: {
    answer: string;
    confidence: 'high' | 'medium' | 'low';
    causes: Array<{ claim: string; kind: string; weight: number; evidence: Evidence[] }>;
    skill_findings: Array<{ skill: string; role: string; problem: string }>;
    suggested_edits: SuggestedEdit[];
    digestChars: number;
    usage?: { input_tokens?: number; output_tokens?: number };
    attempts: number;
  };
}

const KIND_LABEL: Record<string, string> = localized({
  skill_description: 'skill 描述',
  skill_content: 'skill 正文',
  user: '用户输入',
  system_developer: '系统/developer',
  agents_md: 'AGENTS.md',
  tool_output: '工具输出',
  prior_step: '之前的步骤',
  subagent: '子 agent',
  memory: 'Memory',
  model_prior: '模型自身倾向',
});

const ROLE_LABEL: Record<string, { label: string; tone: 'green' | 'amber' | 'red' | 'zinc' }> = localized({
  correct: { label: '表现正确', tone: 'green' },
  should_trigger: { label: '应该触发', tone: 'amber' },
  should_not_trigger: { label: '不该触发', tone: 'amber' },
  misled: { label: '误导了模型', tone: 'red' },
  ignored: { label: '被忽略', tone: 'zinc' },
});

async function resolveSkillKey(name: string): Promise<string> {
  const catalog = await api<CatalogSkill[]>('/skills');
  const hit = catalog.find((s) => s.key === name) ?? catalog.find((s) => s.key.endsWith(`:${name}`)) ?? catalog.find((s) => s.name === name);
  if (!hit) throw new Error(tr`skill 目录里找不到 ${name}`);
  return hit.key;
}

export function AskBox({
  sessionId,
  trace,
  callIndex,
  toolId,
  onJump,
  onVariant,
  defaultQuestion,
}: {
  sessionId: string;
  trace: TraceResponse;
  callIndex?: number;
  toolId?: string;
  onJump: (callIndex: number, toolId?: string) => void;
  /** A suggested edit became a variant: the caller uses it (the case page adds it as a change) instead of opening the Skills page. */
  onVariant?: (v: { id: string; label: string; skillKey: string }) => void;
  defaultQuestion?: string;
}) {
  useLocale();
  const [, navigate] = useLocation();
  const tool = toolId ? trace.tools[toolId] : undefined;
  const suggestion =
    defaultQuestion ??
    (tool
      ? tr`为什么在 Step ${tool.callIndex + 1} 调用了 ${tool.name}？它是被哪段上下文（skill / 用户输入 / 工具输出）引导的？`
      : callIndex !== undefined
        ? tr`Step ${callIndex + 1} 为什么做出这样的决策？`
        : tr("这个会话里 skill 的触发和执行有什么问题？应该怎样修改 skill 的描述或正文？"));
  const [question, setQuestion] = useState('');
  const [jobId, setJobId] = useState<string>();
  const [error, setError] = useState<unknown>();
  const [editBusy, setEditBusy] = useState<number>();
  const job = useQuery({
    queryKey: ['askJob', jobId],
    queryFn: () => api<AskJob>(`/jobs/${jobId}`),
    enabled: Boolean(jobId),
    refetchInterval: (q) => (q.state.data?.status === 'running' ? 2000 : false),
  });

  const ask = async () => {
    setError(undefined);
    try {
      const j = await postJson<AskJob>(`/sessions/${sessionId}/ask`, { question: question.trim() || suggestion, callIndex, toolId });
      setJobId(j.id);
    } catch (e) {
      setError(e);
    }
  };

  const jumpRef = (ref: string) => {
    const r = ref.replace(/^\[|\]$/g, '');
    const c = /^C(\d+)$/.exec(r);
    if (c) return onJump(Number(c[1]) - 1);
    const t = /^T:(.+)$/.exec(r);
    if (t && trace.tools[t[1]]) return onJump(trace.tools[t[1]].callIndex, t[1]);
    const s = /^[SL]:([^#]+)/.exec(r);
    if (s) navigate(`/skills?skill=${encodeURIComponent(s[1])}&session=${sessionId}`);
  };

  const makeVariant = async (edit: SuggestedEdit, i: number) => {
    setEditBusy(i);
    setError(undefined);
    try {
      const key = await resolveSkillKey(edit.skill);
      const { raw } = await api<{ raw: string }>(`/skills/${encodeURIComponent(key)}`);
      const parsed = parseSkillMdClient(raw);
      const payload: { description?: string; body?: string; label: string; note: string } = { label: tr("AI 建议"), note: edit.rationale };
      if (edit.target === 'description') {
        payload.description = edit.find && parsed.description?.includes(edit.find) ? parsed.description.replace(edit.find, edit.replace) : edit.replace;
      } else {
        payload.body = edit.find && parsed.body.includes(edit.find) ? parsed.body.replace(edit.find, edit.replace) : `${parsed.body.trimEnd()}\n\n${edit.replace}\n`;
      }
      const v = await postJson<{ id: string; label: string }>(`/skills/${encodeURIComponent(key)}/variants`, payload);
      if (onVariant) onVariant({ id: v.id, label: v.label, skillKey: key });
      else navigate(`/skills?skill=${encodeURIComponent(key)}&v=${v.id}&session=${sessionId}`);
    } catch (e) {
      setError(e);
    } finally {
      setEditBusy(undefined);
    }
  };

  const j = job.data;
  const r = j?.result;
  return (
    <div className="border-b border-zinc-200 bg-indigo-50/40 p-2 dark:border-zinc-800 dark:bg-indigo-950/20">
      <div className="mb-1 text-[12px] font-semibold">{tr("问为什么（让模型做归因）")}</div>
      <textarea value={question} onChange={(e) => setQuestion(e.target.value)} rows={2} placeholder={suggestion} className="w-full rounded border border-zinc-300 bg-white px-2 py-1 text-[12px] dark:border-zinc-700 dark:bg-zinc-900" />
      <div className="mt-1 flex items-center gap-2">
        <Button variant="primary" size="xs" onClick={ask} disabled={j?.status === 'running'}>
          {j?.status === 'running' ? tr("分析中…") : tr("开始分析")}
        </Button>
        <span className="text-[10.5px] text-zinc-500">{tr("会把会话摘要发给一个不带 skill / 插件的分析员（用 agent 自己的命令行，一次模型调用，只读、不留会话记录）")}</span>
      </div>
      {error ? <ErrorBox error={error} /> : null}
      {j?.status === 'running' && (
        <div className="mt-2">
          <Spinner label={tr`分析中… ${Math.round((Date.now() - j.startedAt) / 1000)}s`} />
        </div>
      )}
      {j?.status === 'failed' && <ErrorBox error={new Error(j.error ?? tr("分析失败"))} />}
      {r && (
        <div className="mt-2 space-y-2 text-[12px]">
          <div className="rounded border border-zinc-200 bg-white p-2 dark:border-zinc-800 dark:bg-zinc-900">
            <div className="mb-1 flex items-center gap-1.5">
              <Badge tone={r.confidence === 'high' ? 'green' : r.confidence === 'medium' ? 'amber' : 'zinc'}>{tr("置信度")}{r.confidence}</Badge>
              <span className="text-[10.5px] text-zinc-400">{tr("摘要")}{r.digestChars.toLocaleString()}{tr("字")}{r.usage?.input_tokens ? ` · ${r.usage.input_tokens.toLocaleString()} in` : ''}
                {r.attempts > 1 ? tr` · 重试 ${r.attempts - 1} 次` : ''}
              </span>
            </div>
            <Markdown text={r.answer} />
          </div>
          {r.causes.length > 0 && (
            <div>
              <div className="mb-1 font-medium">{tr("原因")}</div>
              {r.causes
                .slice()
                .sort((a, b) => b.weight - a.weight)
                .map((c, i) => (
                  <div key={i} className="mb-1.5 rounded border border-zinc-200 bg-white p-1.5 dark:border-zinc-800 dark:bg-zinc-900">
                    <div className="flex items-center gap-1.5">
                      <Badge tone={c.kind.startsWith('skill') ? 'amber' : 'zinc'}>{KIND_LABEL[c.kind] ?? c.kind}</Badge>
                      <div className="h-1.5 w-16 overflow-hidden rounded bg-zinc-200 dark:bg-zinc-700" title={tr`权重 ${c.weight}`}>
                        <div className="h-full bg-indigo-500" style={{ width: `${Math.round(c.weight * 100)}%` }} />
                      </div>
                      <span className="min-w-0 flex-1">{c.claim}</span>
                    </div>
                    {c.evidence.map((e, k) => (
                      <div key={k} className="mt-1 flex items-start gap-1 pl-1 text-[11px]">
                        <button onClick={() => jumpRef(e.ref)} className={cx('shrink-0 rounded border px-1 font-mono', e.refValid ? 'border-indigo-300 text-indigo-600 hover:bg-indigo-50 dark:border-indigo-700 dark:text-indigo-400' : 'border-zinc-300 text-zinc-400 line-through')} title={e.refValid ? tr("跳转") : tr("摘要中没有这个锚点")}>
                          {e.ref}
                        </button>
                        <span className={cx('min-w-0 flex-1 italic', e.quoteVerified ? 'text-zinc-600 dark:text-zinc-300' : 'text-zinc-400')}>
                          “{e.quote}”{!e.quoteVerified && e.quote ? <span className="not-italic text-amber-600">{tr("（未在原文中找到）")}</span> : null}
                        </span>
                      </div>
                    ))}
                  </div>
                ))}
            </div>
          )}
          {r.skill_findings.length > 0 && (
            <div>
              <div className="mb-1 font-medium">{tr("Skill 结论")}</div>
              {r.skill_findings.map((f, i) => (
                <div key={i} className="mb-0.5 flex items-start gap-1.5">
                  <Badge tone={ROLE_LABEL[f.role]?.tone ?? 'zinc'}>{ROLE_LABEL[f.role]?.label ?? f.role}</Badge>
                  <span className="font-mono">{f.skill}</span>
                  <span className="text-zinc-600 dark:text-zinc-300">{f.problem}</span>
                </div>
              ))}
            </div>
          )}
          {r.suggested_edits.length > 0 && (
            <div>
              <div className="mb-1 font-medium">{tr("修改建议")}</div>
              {r.suggested_edits.map((e, i) => (
                <div key={i} className="mb-1.5 rounded border border-amber-300 bg-amber-50/60 p-1.5 dark:border-amber-800 dark:bg-amber-950/30">
                  <div className="flex items-center gap-1.5">
                    <span className="font-mono font-medium">{e.skill}</span>
                    <Badge tone="amber">{e.target === 'description' ? tr("描述") : tr("正文")}</Badge>
                    <span className="flex-1" />
                    <Button size="xs" onClick={() => void makeVariant(e, i)} disabled={editBusy !== undefined}>
                      {editBusy === i ? tr("生成中…") : onVariant ? tr("生成变体，加入改动") : tr("生成变体并去调试 →")}
                    </Button>
                  </div>
                  {e.find && <div className="mt-1 whitespace-pre-wrap bg-red-50 px-1 font-mono text-[11px] text-red-700 line-through dark:bg-red-950/40 dark:text-red-300">{e.find}</div>}
                  <div className="mt-1 whitespace-pre-wrap bg-emerald-50 px-1 font-mono text-[11px] text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300">{e.replace}</div>
                  {e.rationale && <div className="mt-1 text-[11px] text-zinc-600 dark:text-zinc-400">{e.rationale}</div>}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

import { localized } from '../../shared/i18n';
import type { ToolKind } from '../../shared/types';
import type { Tone } from '../components/ui';

export const CAT_META: Record<string, { label: string; color: string }> = localized({
  system: { label: '系统提示词', color: '#6366f1' },
  permissions: { label: '权限说明', color: '#a5b4fc' },
  developer: { label: 'developer', color: '#818cf8' },
  agents_md: { label: 'AGENTS.md', color: '#c084fc' },
  environment: { label: '环境', color: '#94a3b8' },
  skills_listing: { label: 'Skill 列表', color: '#f59e0b' },
  skill_content: { label: 'Skill 正文', color: '#f97316' },
  memory: { label: 'Memory', color: '#14b8a6' },
  plugins: { label: '插件说明', color: '#5eead4' },
  system_reminder: { label: 'system-reminder', color: '#a8a29e' },
  user: { label: '用户', color: '#22c55e' },
  assistant: { label: '助手输出', color: '#3b82f6' },
  reasoning: { label: '推理', color: '#93c5fd' },
  tool_call: { label: '工具调用', color: '#e879f9' },
  tool_output: { label: '工具输出', color: '#ec4899' },
  inter_agent: { label: 'agent 间消息', color: '#84cc16' },
  compaction_summary: { label: '压缩摘要', color: '#8b5cf6' },
  other: { label: '其他', color: '#d4d4d8' },
  tools_overhead: { label: '工具定义/开销', color: '#cbd5e1' },
});

export const TOOL_META: Record<ToolKind, { label: string; tone: Tone; color: string }> = {
  code_exec: { label: 'exec', tone: 'indigo', color: '#6366f1' },
  shell: { label: 'shell', tone: 'sky', color: '#0ea5e9' },
  file: { label: 'file', tone: 'zinc', color: '#71717a' },
  patch: { label: 'patch', tone: 'green', color: '#10b981' },
  mcp: { label: 'mcp', tone: 'violet', color: '#8b5cf6' },
  skill: { label: 'skill', tone: 'amber', color: '#f59e0b' },
  collab: { label: 'agent', tone: 'pink', color: '#ec4899' },
  web_search: { label: 'web', tone: 'sky', color: '#38bdf8' },
  wait: { label: 'wait', tone: 'zinc', color: '#a1a1aa' },
  plan: { label: 'plan', tone: 'zinc', color: '#a1a1aa' },
  function: { label: 'fn', tone: 'zinc', color: '#a1a1aa' },
  custom: { label: 'custom', tone: 'zinc', color: '#a1a1aa' },
};

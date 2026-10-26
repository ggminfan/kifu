import type { SegmentCat, ToolKind } from '../../shared/types';

/** Map a message content part to the context-composition category it represents. */
export function classifyPart(role: string | undefined, text: string): SegmentCat {
  const t = text.trimStart();
  switch (role) {
    case 'developer':
    case 'system':
      if (t.startsWith('<permissions instructions>')) return 'permissions';
      if (t.startsWith('<skills_instructions>') || t.includes('available for use with the Skill tool')) return 'skills_listing';
      if (t.startsWith('## Memory') || t.startsWith('<memory')) return 'memory';
      if (t.startsWith('<plugins_instructions>') || t.startsWith('<apps_instructions>')) return 'plugins';
      if (t.startsWith('# Environment') || t.startsWith('<environment_context>')) return 'environment';
      if (t.startsWith('<system-reminder>')) return 'system_reminder';
      if (t.startsWith('# AGENTS.md')) return 'agents_md';
      return role === 'system' ? 'system' : 'developer';
    case 'user':
      if (t.startsWith('<system-reminder>')) {
        return t.includes('available for use with the Skill tool') ? 'skills_listing' : 'system_reminder';
      }
      if (t.startsWith('<skill>')) return 'skill_content';
      if (t.startsWith('<environment_context>') || t.startsWith("Today's date is")) return 'environment';
      if (t.startsWith('# AGENTS.md') || t.startsWith('<user_instructions>')) return 'agents_md';
      if (t.startsWith('<recommended_plugins>')) return 'plugins';
      if (
        t.startsWith('The following is a structured') ||
        t.startsWith('<post-compact') ||
        t.startsWith('Another language model started to solve this problem')
      ) {
        return 'compaction_summary';
      }
      if (t.startsWith('<turn_aborted>')) return 'other';
      return 'user';
    case 'assistant':
      return 'assistant';
    default:
      return 'other';
  }
}

const SHELL = new Set(['exec_command', 'Bash', 'shell', 'local_shell', 'write_stdin', 'unified_exec']);
const PATCH = new Set(['apply_patch', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const FILE = new Set(['Read', 'Grep', 'Glob', 'LS', 'view_image', 'read_file', 'list_dir', 'grep_files']);
const COLLAB = new Set(['Agent', 'Task', 'SendMessage', 'spawn_agent', 'send_input', 'wait_agent', 'close_agent', 'resume_agent']);
const WEB = new Set(['web_search', 'WebSearch', 'WebFetch', 'web_fetch']);
const PLAN = new Set(['update_plan', 'TodoWrite']);

/**
 * Codex tags each content part of a context message with its origin
 * (`internal_chat_message_metadata_passthrough.content_item_kinds`, e.g.
 * `agents_md.instructions`, `goal.internal_context`, `user.text`). Known
 * origins decide the category; anything that is not `user.*` is never the
 * user's own input.
 */
const CODEX_KINDS: Record<string, SegmentCat> = {
  agents_md: 'agents_md',
  environments: 'environment',
  permissions: 'permissions',
  host_skills: 'skills_listing',
  skills: 'skill_content',
  plugins: 'plugins',
  apps: 'plugins',
  collaboration_mode: 'developer',
  multi_agent: 'developer',
  'generic.developer_instructions': 'developer',
  'generic.turn_aborted': 'other',
  goal: 'system_reminder',
  hooks: 'system_reminder',
  guardian: 'system_reminder',
  additional_content: 'system_reminder',
};

export function classifyCodexPart(kind: unknown, role: string | undefined, text: string): SegmentCat {
  const base = classifyPart(role, text);
  if (typeof kind !== 'string' || !kind || kind === 'unknown' || kind.startsWith('user.')) return base;
  const mapped = CODEX_KINDS[kind] ?? CODEX_KINDS[kind.split('.')[0]];
  if (mapped) return mapped;
  return base === 'user' ? 'other' : base;
}

export function toolKind(name: string, namespace?: string): ToolKind {
  if (name === 'exec') return 'code_exec';
  if (name === 'wait') return 'wait';
  if (name === 'Skill') return 'skill';
  if (SHELL.has(name)) return 'shell';
  if (PATCH.has(name)) return 'patch';
  if (FILE.has(name)) return 'file';
  if (namespace === 'collaboration' || name.startsWith('collaboration__') || COLLAB.has(name)) return 'collab';
  if (WEB.has(name)) return 'web_search';
  if (PLAN.has(name)) return 'plan';
  if (namespace?.startsWith('mcp__') || name.startsWith('mcp__')) return 'mcp';
  return 'function';
}

/** Model output items (anything else in a commit is input). */
export function isOutputItem(item: { type?: string; role?: string }): boolean {
  return (
    item.type === 'reasoning' ||
    item.type === 'function_call' ||
    item.type === 'custom_tool_call' ||
    item.type === 'local_shell_call' ||
    item.type === 'web_search_call' ||
    (item.type === 'message' && item.role === 'assistant')
  );
}

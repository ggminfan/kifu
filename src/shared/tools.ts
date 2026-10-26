import type { ToolCall } from './types';

/**
 * One-line summaries of tool calls (the command run, the file read, the
 * query …), computed where the full arguments are: the step list shows them
 * without the arguments themselves.
 */

export function firstLine(s: string, max = 140): string {
  const line = s.split('\n').find((l) => l.trim()) ?? '';
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** One-line human summary of a tool call's arguments. */
export function toolSummary(t: Pick<ToolCall, 'kind' | 'args' | 'argsJson' | 'skill'>): string {
  const a = (t.argsJson ?? {}) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === 'string' ? v : '');
  switch (t.kind) {
    case 'code_exec': {
      const src = t.args.preview;
      const cmds = [...src.matchAll(/cmd\s*:\s*(["'`])((?:\\.|(?!\1)[^\\])*)\1/g)].map((m) =>
        m[2].replace(/\\n/g, ' ').replace(/\\(["'`\\])/g, '$1'),
      );
      if (cmds.length) return firstLine(cmds[0]) + (cmds.length > 1 ? `  (+${cmds.length - 1})` : '');
      const calls = [...new Set([...src.matchAll(/tools\.([\w$]+)\s*\(/g)].map((m) => m[1]))];
      if (calls.length) return calls.map((c) => `tools.${c}()`).join(' · ');
      const line = src.split('\n').find((l) => l.trim() && !/^\s*(\/\/|const r = |let |import )/.test(l));
      return firstLine(line ?? src);
    }
    case 'shell':
      return firstLine(str(a.cmd) || str(a.command) || (Array.isArray(a.command) ? (a.command as string[]).join(' ') : '') || t.args.preview);
    case 'file':
      return firstLine(str(a.file_path) || str(a.path) || str(a.pattern) || t.args.preview);
    case 'patch':
      return firstLine(str(a.file_path) || t.args.preview.replace(/^\*\*\* Begin Patch\s*/, ''));
    case 'skill':
      return t.skill ?? firstLine(t.args.preview);
    case 'collab':
      return firstLine(str(a.task_name) || str(a.target) || str(a.description) || str(a.message) || str(a.prompt) || t.args.preview);
    case 'wait':
      return a.cell_id !== undefined ? `cell ${String(a.cell_id)}` : firstLine(t.args.preview);
    case 'web_search':
      return firstLine(str(a.query) || t.args.preview);
    default:
      return firstLine(t.args.preview);
  }
}

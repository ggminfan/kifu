import type { InnerEvent, ParsedCmd } from '../../shared/types';
import { LIMITS, contentText, durationToMs, mkTxt, oneLine } from '../text';

/* eslint-disable @typescript-eslint/no-explicit-any */
type J = Record<string, any>;

/** event_msg types that carry tool execution details. */
export const TOOL_EVENTS = new Set([
  'exec_command_end',
  'mcp_tool_call_end',
  'patch_apply_end',
  'web_search_end',
  'terminal_interaction',
  'view_image_tool_call',
  'collab_agent_spawn_end',
  'collab_agent_interaction_end',
  'collab_waiting_end',
  'collab_close_end',
  'sub_agent_activity',
]);

/** Known event_msg types that duplicate history content or carry no trace information. */
export const QUIET_EVENTS = new Set([
  'agent_message',
  'agent_message_delta',
  'agent_reasoning',
  'agent_reasoning_delta',
  'agent_reasoning_raw_content',
  'agent_reasoning_raw_content_delta',
  'agent_reasoning_section_break',
  'session_configured',
  'background_event',
  'plan_update',
  'turn_diff',
  'warning',
  'mcp_list_tools_response',
  'mcp_startup_update',
  'mcp_startup_complete',
  'exec_command_begin',
  'exec_command_output_delta',
  'mcp_tool_call_begin',
  'patch_apply_begin',
  'web_search_begin',
  'collab_agent_spawn_begin',
  'collab_agent_interaction_begin',
  'collab_waiting_begin',
  'collab_close_begin',
  'stream_error',
  'inbox_status',
  'shutdown_complete',
  'exec_approval_request',
  'apply_patch_approval_request',
  'elicitation_request',
  'list_custom_prompts_response',
  'get_history_entry_response',
  'entered_review_mode',
  'exited_review_mode',
  'undo_started',
  'undo_completed',
  'thread_name_updated',
  'raw_response_item',
  'mode_change_response',
  'thread_settings_applied',
  'turn_context_update',
  'thread_goal_updated',
]);

export function eventCallId(p: J): string | undefined {
  const id = p.type === 'sub_agent_activity' ? p.event_id : (p.call_id ?? p.tool_call_id);
  return typeof id === 'string' && id ? id : undefined;
}

export function commandString(command: unknown): string {
  if (typeof command === 'string') return command;
  if (Array.isArray(command)) {
    const parts = command.map(String);
    const lc = parts.findIndex((x) => x === '-lc' || x === '-c');
    if (lc !== -1 && parts[lc + 1]) return parts[lc + 1];
    return parts.join(' ');
  }
  return '';
}

function statusText(s: unknown): string | undefined {
  if (s === undefined || s === null) return undefined;
  if (typeof s === 'string') return s;
  if (typeof s === 'object') return Object.keys(s as object)[0];
  return String(s);
}

export type EventCore = Omit<InnerEvent, 'callId' | 'innerId' | 'link'>;

/** Normalize a tool-related event_msg payload (`base`: JSON pointer of the payload inside the record). */
export function toInnerEvent(p: J, line: number, ts: string | undefined, blobs: string[], base = '/payload'): EventCore {
  const type = String(p.type);
  const head = { type, line, ts };
  switch (type) {
    case 'exec_command_end': {
      const cmd = commandString(p.command);
      const parsedCmd: ParsedCmd[] | undefined = Array.isArray(p.parsed_cmd)
        ? p.parsed_cmd.map((c: J) => ({ type: String(c.type ?? 'unknown'), cmd: c.cmd, name: c.name, path: c.path }))
        : undefined;
      const out = p.aggregated_output || p.formatted_output || [p.stdout, p.stderr].filter(Boolean).join('\n');
      const ptr = `${base}/${p.aggregated_output ? 'aggregated_output' : p.formatted_output ? 'formatted_output' : 'stdout'}`;
      const exitCode = typeof p.exit_code === 'number' ? p.exit_code : undefined;
      return {
        ...head,
        kind: 'exec',
        title: oneLine(cmd, 240),
        status: statusText(p.status),
        exitCode,
        durationMs: durationToMs(p.duration),
        isError: (exitCode !== undefined && exitCode !== 0) || p.status === 'failed',
        output: mkTxt(out, LIMITS.event, { line, ptr }),
        parsedCmd,
        paths: parsedCmd?.map((c) => c.path).filter((x): x is string => Boolean(x)),
      };
    }
    case 'mcp_tool_call_end': {
      const inv = (p.invocation ?? {}) as J;
      const result = (p.result ?? {}) as J;
      const ok = result.Ok as J | undefined;
      const err = result.Err;
      const text = ok ? contentText(ok.content) : typeof err === 'string' ? err : err ? JSON.stringify(err) : '';
      return {
        ...head,
        kind: 'mcp',
        title: `${inv.server ?? 'mcp'}.${inv.tool ?? '?'}`,
        durationMs: durationToMs(p.duration),
        isError: Boolean(err) || Boolean(ok?.isError ?? ok?.is_error),
        status: err ? 'error' : 'ok',
        output: mkTxt(text, LIMITS.event, { line, ptr: `${base}/result/${ok ? 'Ok/content' : 'Err'}` }),
        blobs: blobs.length ? blobs : undefined,
      };
    }
    case 'patch_apply_end': {
      const changes = (p.changes ?? {}) as Record<string, J>;
      const paths = Object.keys(changes);
      const diff = paths
        .map((f) => {
          const c = changes[f] ?? {};
          const kind = typeof c.type === 'string' ? c.type : Object.keys(c)[0];
          const body = c.unified_diff ?? c.content ?? c.update?.unified_diff ?? c.add?.content ?? '';
          return `${kind ?? 'update'} ${f}\n${body}`;
        })
        .join('\n');
      return {
        ...head,
        kind: 'patch',
        title: paths.length === 1 ? `patch ${paths[0]}` : `patch ${paths.length} files`,
        status: statusText(p.status) ?? (p.success === false ? 'failed' : 'completed'),
        isError: p.success === false || p.status === 'failed',
        output: mkTxt(diff, LIMITS.event, { line, ptr: `${base}/changes` }),
        paths,
      };
    }
    case 'web_search_end': {
      const q = p.query ?? p.action?.query ?? (Array.isArray(p.action?.queries) ? p.action.queries.join(' | ') : '');
      return { ...head, kind: 'web_search', title: `search ${oneLine(String(q), 200)}` };
    }
    case 'terminal_interaction':
      return {
        ...head,
        kind: 'terminal',
        title: `stdin → ${p.process_id ?? '?'}`,
        durationMs: typeof p.duration_ms === 'number' ? p.duration_ms : undefined,
        output: mkTxt(p.stdin, LIMITS.event, { line, ptr: `${base}/stdin` }),
      };
    case 'view_image_tool_call':
      return { ...head, kind: 'other', title: `view image ${p.path ?? ''}`, paths: p.path ? [p.path] : undefined };
    case 'collab_agent_spawn_end':
      return {
        ...head,
        kind: 'collab',
        title: `spawn ${p.new_agent_nickname ?? ''} ${p.new_agent_role ? `(${p.new_agent_role})` : ''}`.trim(),
        status: statusText(p.status),
        threadId: p.new_thread_id ?? undefined,
        isError: p.status === 'not_found',
        output: mkTxt(p.prompt, LIMITS.event, { line, ptr: `${base}/prompt` }),
      };
    case 'collab_agent_interaction_end':
      return {
        ...head,
        kind: 'collab',
        title: 'message → agent',
        status: statusText(p.status),
        threadId: p.receiver_thread_id ?? undefined,
        output: mkTxt(p.prompt, LIMITS.event, { line, ptr: `${base}/prompt` }),
      };
    case 'collab_waiting_end':
      return { ...head, kind: 'collab', title: 'wait agents', status: statusText(p.status) };
    case 'collab_close_end':
      return { ...head, kind: 'collab', title: 'interrupt agent', status: statusText(p.status), threadId: p.receiver_thread_id ?? undefined };
    case 'sub_agent_activity':
      return {
        ...head,
        kind: 'collab',
        title: `${p.kind ?? 'activity'} ${p.agent_path ?? ''}`.trim(),
        status: p.kind,
        threadId: p.agent_thread_id ?? undefined,
      };
    default:
      return { ...head, kind: 'other', title: type };
  }
}

/**
 * Codex reports tool execution as `item_completed` events whose item carries
 * the details. Items with a legacy event equivalent are returned under that
 * event's name (`et`) with a payload `p` using its field names, so the same
 * linking code applies; `id` is the tool call (or `exec-…` inner call) id.
 * Items that only repeat history (messages, reasoning) return undefined.
 */
export function codexItemEvent(item: J, line: number, ts: string | undefined): { et: string; p: J; id: string; core: EventCore } | undefined {
  const id = typeof item.id === 'string' && item.id ? item.id : undefined;
  if (!id) return undefined;
  const base = '/payload/item';
  const as = (et: string): { et: string; p: J; id: string; core: EventCore } => {
    const p = { ...item, type: et };
    return { et, p, id, core: toInnerEvent(p, line, ts, [], base) };
  };
  switch (item.type) {
    case 'CommandExecution':
      return as('exec_command_end');
    case 'FileChange':
      return as('patch_apply_end');
    case 'SubAgentActivity':
      return as('sub_agent_activity');
    case 'ImageView':
      return as('view_image_tool_call');
    case 'McpToolCall': {
      const err = item.error;
      const result = (item.result ?? {}) as J;
      const text = err ? (typeof err === 'string' ? err : String((err as J).message ?? JSON.stringify(err))) : contentText(result.content);
      const isError = item.status === 'failed' || Boolean(err) || Boolean(result.isError ?? result.is_error);
      return {
        et: 'mcp_tool_call_end',
        p: item,
        id,
        core: {
          type: 'mcp_tool_call_end',
          line,
          ts,
          kind: 'mcp',
          title: `${item.server ?? 'mcp'}.${item.tool ?? '?'}`,
          durationMs: durationToMs(item.duration),
          isError,
          status: isError ? 'error' : 'ok',
          output: mkTxt(text, LIMITS.event, { line, ptr: `${base}/${err ? 'error' : 'result/content'}` }),
        },
      };
    }
    case 'WebSearch':
    case 'Extension': {
      if (item.type === 'Extension' && item.kind !== 'web.search') {
        return { et: 'extension', p: item, id, core: { type: 'extension', line, ts, kind: 'other', title: String(item.kind ?? 'extension'), durationMs: durationToMs(item.durationMs) } };
      }
      const q = item.query ?? item.action?.query ?? (Array.isArray(item.action?.queries) ? item.action.queries.join(' | ') : (item.action?.url ?? ''));
      const results = Array.isArray(item.results) && item.results.length ? item.results : undefined;
      return {
        et: 'web_search_end',
        p: item,
        id,
        core: {
          type: 'web_search_end',
          line,
          ts,
          kind: 'web_search',
          title: `search ${oneLine(String(q), 200)}`,
          output: results ? mkTxt(results, LIMITS.event, { line, ptr: `${base}/results` }) : undefined,
        },
      };
    }
    case 'CollabAgentToolCall':
      return {
        et: 'collab_tool_call',
        p: item,
        id,
        core: { type: 'collab_tool_call', line, ts, kind: 'collab', title: String(item.tool ?? 'collab'), status: statusText(item.status), isError: item.status === 'failed' },
      };
    default:
      return undefined;
  }
}

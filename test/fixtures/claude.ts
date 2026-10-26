import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Synthetic Claude Code transcripts (~/.claude/projects/<project>/<session>.jsonl)
 * for tests. Shapes follow the real format; every value is made up.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
type J = Record<string, any>;

export interface Usage {
  input?: number;
  cacheWrite?: number;
  cacheRead?: number;
  output?: number;
}

export class ClaudeTranscriptBuilder {
  readonly lines: J[] = [];
  private t = Date.parse('2026-09-03T00:00:00.000Z');
  private last: string | null = null;
  private n = 0;

  constructor(
    readonly sessionId = 'cc-session-0001',
    readonly agentId?: string,
  ) {}

  /** uuid of the last record written. */
  get lastUuid(): string | null {
    return this.last;
  }

  rec(type: string, extra: J): this {
    this.t += 1000;
    const uuid = `rec-${(++this.n).toString().padStart(4, '0')}`;
    this.lines.push({
      parentUuid: this.last,
      isSidechain: Boolean(this.agentId),
      userType: 'external',
      cwd: '/work/demo',
      sessionId: this.sessionId,
      version: '2.1.286',
      gitBranch: 'main',
      ...(this.agentId ? { agentId: this.agentId } : {}),
      type,
      uuid,
      timestamp: new Date(this.t).toISOString(),
      ...extra,
    });
    this.last = uuid;
    return this;
  }

  prompt(content: string | J[], extra: J = {}): this {
    return this.rec('user', { message: { role: 'user', content }, promptId: `prompt-${this.n + 1}`, ...extra });
  }

  meta(text: string, extra: J = {}): this {
    return this.rec('user', { isMeta: true, message: { role: 'user', content: text }, ...extra });
  }

  /** One API response written as one record per content block (same message.id). */
  assistant(id: string, blocks: J[], usage: Usage, stop: string | null = null, opts: { model?: string; finalOutput?: number } = {}): this {
    blocks.forEach((b, i) => {
      const last = i === blocks.length - 1;
      this.rec('assistant', {
        requestId: `req_${id}`,
        message: {
          id,
          type: 'message',
          role: 'assistant',
          model: opts.model ?? 'claude-demo',
          content: [b],
          stop_reason: last ? stop : null,
          usage: {
            input_tokens: usage.input ?? 0,
            cache_creation_input_tokens: usage.cacheWrite ?? 0,
            cache_read_input_tokens: usage.cacheRead ?? 0,
            output_tokens: last && opts.finalOutput !== undefined ? opts.finalOutput : (usage.output ?? 0),
          },
        },
      });
    });
    return this;
  }

  toolResult(toolUseId: string, content: string | J[], opts: { isError?: boolean; result?: unknown } = {}): this {
    return this.rec('user', {
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content, ...(opts.isError ? { is_error: true } : {}) }] },
      ...(opts.result !== undefined ? { toolUseResult: opts.result } : {}),
    });
  }

  attachment(attachment: J, rendered?: string, role = 'system'): this {
    return this.rec('attachment', { attachment, ...(rendered !== undefined ? { rendered: [{ content: rendered }], renderedRole: role } : {}) });
  }

  system(subtype: string, extra: J = {}): this {
    return this.rec('system', { subtype, ...extra });
  }

  /** Records without a uuid chain (titles, snapshots …). */
  plain(type: string, extra: J): this {
    this.lines.push({ type, ...extra });
    return this;
  }

  /** Writes <dir>/<session>.jsonl, or <dir>/<session>/subagents/agent-<id>.jsonl (+ meta) for a subagent. */
  write(dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kifu-claude-fixture-')), agentMeta?: J): string {
    let file = path.join(dir, `${this.sessionId}.jsonl`);
    if (this.agentId) {
      const sub = path.join(dir, this.sessionId, 'subagents');
      fs.mkdirSync(sub, { recursive: true });
      file = path.join(sub, `agent-${this.agentId}.jsonl`);
      if (agentMeta) fs.writeFileSync(file.replace(/\.jsonl$/, '.meta.json'), JSON.stringify(agentMeta));
    }
    fs.writeFileSync(file, `${this.lines.map((l) => JSON.stringify(l)).join('\n')}\n`);
    return file;
  }
}

export const block = {
  text: (text: string): J => ({ type: 'text', text }),
  thinking: (thinking: string): J => ({ type: 'thinking', thinking, signature: 'sig' }),
  tool: (id: string, name: string, input: J): J => ({ type: 'tool_use', id, name, input, caller: { type: 'direct' } }),
};

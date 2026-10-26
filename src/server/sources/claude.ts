import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { SessionSummary } from '../../shared/api';
import { emptySnapshot, type Snapshot } from './types';

/**
 * Claude Code keeps one JSONL transcript per session under
 * <config dir>/projects/<project slug>/<session id>.jsonl, and the
 * transcripts of its subagents next to it in <session id>/subagents/
 * (agent-<id>.jsonl plus agent-<id>.meta.json naming the Agent tool call that
 * started it). Summaries are read once per file version (size + mtime).
 */

export function claudeHomeDefault(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const dir = env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  return fs.existsSync(path.join(dir, 'projects')) ? dir : undefined;
}

export interface ClaudeProject {
  dir: string;
  sessions: number;
  lastActivity: number;
}

/** Project dirs that contain at least one session (bounded). */
export function listClaudeProjects(claudeHome: string, maxProjects = 500): ClaudeProject[] {
  const root = path.join(claudeHome, 'projects');
  const out: ClaudeProject[] = [];
  let names: string[] = [];
  try {
    names = fs.readdirSync(root);
  } catch {
    return out;
  }
  for (const name of names) {
    if (out.length >= maxProjects) break;
    const dir = path.join(root, name);
    let files: string[] = [];
    try {
      if (!fs.statSync(dir).isDirectory()) continue;
      files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
    } catch {
      continue;
    }
    if (!files.length) continue;
    let last = 0;
    for (const f of files) {
      try {
        last = Math.max(last, fs.statSync(path.join(dir, f)).mtimeMs);
      } catch {
        // gone
      }
    }
    out.push({ dir, sessions: files.length, lastActivity: last });
  }
  return out.sort((a, b) => b.lastActivity - a.lastActivity);
}

interface FileSummary {
  key: string;
  cwd?: string;
  model?: string;
  title?: string;
  firstPrompt?: string;
  gitBranch?: string;
  version?: string;
  entrypoint?: string;
  createdAt?: number;
  updatedAt?: number;
  tokens: number;
}

const cache = new Map<string, FileSummary>();

/** A real typed prompt (not tool results, injected meta messages or command echoes). */
export function promptText(rec: Record<string, unknown>): string | undefined {
  if (rec.type !== 'user' || rec.isMeta || rec.isCompactSummary) return undefined;
  const m = rec.message as { content?: unknown } | undefined;
  let text: string | undefined;
  if (typeof m?.content === 'string') text = m.content;
  else if (Array.isArray(m?.content)) {
    const parts = (m.content as Array<{ type?: string; text?: string }>).filter((p) => p?.type === 'text' && typeof p.text === 'string');
    if (parts.length && parts.length === (m.content as unknown[]).length) text = parts.map((p) => p.text).join('\n');
  }
  if (!text) return undefined;
  const t = text.trim();
  if (!t || t.startsWith('<command-') || t.startsWith('<local-command-') || t.startsWith('Caveat:')) return undefined;
  return t;
}

/** Usage of an assistant record, counted once per API response (message.id). */
export function usageTotal(u: Record<string, number> | undefined): number {
  if (!u) return 0;
  return (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.output_tokens ?? 0);
}

const MAX_LINE = 8 * 1024 * 1024;

export function summarizeFile(file: string, key: string): FileSummary {
  const s: FileSummary = { key, tokens: 0 };
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return s;
  }
  // one API response is split over several records; its last record carries the final usage
  const usageById = new Map<string, number>();
  let lastTs: number | undefined;
  for (const line of text.split('\n')) {
    if (!line || line.length > MAX_LINE) continue;
    let rec: Record<string, unknown>;
    try {
      rec = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const ts = typeof rec.timestamp === 'string' ? Date.parse(rec.timestamp) : NaN;
    if (!Number.isNaN(ts)) {
      s.createdAt ??= ts;
      lastTs = ts;
    }
    if (rec.type === 'custom-title' && typeof rec.customTitle === 'string' && rec.customTitle.trim()) s.title = rec.customTitle.trim();
    if (typeof rec.cwd === 'string') s.cwd ??= rec.cwd;
    if (typeof rec.gitBranch === 'string' && rec.gitBranch) s.gitBranch ??= rec.gitBranch;
    if (typeof rec.version === 'string') s.version ??= rec.version;
    if (typeof rec.entrypoint === 'string') s.entrypoint ??= rec.entrypoint;
    if (rec.type === 'user' && !s.firstPrompt) s.firstPrompt = promptText(rec)?.slice(0, 300);
    if (rec.type === 'assistant') {
      const m = rec.message as { id?: string; model?: string; usage?: Record<string, number> } | undefined;
      if (m?.model && m.model !== '<synthetic>') s.model ??= m.model;
      const id = m?.id ?? (rec.uuid as string | undefined);
      if (id && m?.usage) usageById.set(id, usageTotal(m.usage));
    }
  }
  for (const n of usageById.values()) s.tokens += n;
  s.updatedAt = lastTs;
  return s;
}

function summaryOf(file: string): FileSummary | undefined {
  let st: fs.Stats;
  try {
    st = fs.statSync(file);
  } catch {
    return undefined;
  }
  const key = `${st.size}-${Math.round(st.mtimeMs)}`;
  const hit = cache.get(file);
  if (hit?.key === key) return { ...hit, updatedAt: hit.updatedAt ?? st.mtimeMs, createdAt: hit.createdAt ?? st.mtimeMs };
  const s = summarizeFile(file, key);
  cache.set(file, s);
  return { ...s, updatedAt: s.updatedAt ?? st.mtimeMs, createdAt: s.createdAt ?? st.mtimeMs };
}

/** Subagent ids are the agent-<id> file names: unique, and URL-safe. */
export function subagentSessionId(file: string): string {
  return path.basename(file, '.jsonl');
}

/** Cheap change check for a project dir: its files' sizes and mtimes. */
export function projectStamp(dir: string): string {
  const parts: string[] = [];
  try {
    for (const f of fs.readdirSync(dir)) {
      const p = path.join(dir, f);
      try {
        const st = fs.statSync(p);
        if (f.endsWith('.jsonl')) parts.push(`${f}:${st.size}:${Math.round(st.mtimeMs)}`);
        else if (st.isDirectory()) {
          const sub = path.join(p, 'subagents');
          for (const g of fs.readdirSync(sub)) {
            if (!g.endsWith('.jsonl')) continue;
            const s2 = fs.statSync(path.join(sub, g));
            parts.push(`${f}/${g}:${s2.size}:${Math.round(s2.mtimeMs)}`);
          }
        }
      } catch {
        // no subagents dir
      }
    }
  } catch {
    return '-';
  }
  return `${parts.length}:${hashOf(parts.join('|'))}`;
}

function hashOf(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

export function loadClaudeProject(dir: string): Snapshot {
  const snap = emptySnapshot(projectStamp(dir));
  let files: string[] = [];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
  } catch (e) {
    return emptySnapshot('-', (e as Error).message);
  }
  for (const f of files) {
    const file = path.join(dir, f);
    const id = path.basename(f, '.jsonl');
    const s = summaryOf(file);
    if (!s) continue;
    const kids: string[] = [];
    const subDir = path.join(dir, id, 'subagents');
    let subFiles: string[] = [];
    try {
      subFiles = fs.readdirSync(subDir).filter((g) => g.endsWith('.jsonl'));
    } catch {
      // no subagents
    }
    for (const g of subFiles) {
      const childFile = path.join(subDir, g);
      const cs = summaryOf(childFile);
      if (!cs) continue;
      const childId = subagentSessionId(childFile);
      let meta: { agentType?: string; description?: string } = {};
      try {
        meta = JSON.parse(fs.readFileSync(childFile.replace(/\.jsonl$/, '.meta.json'), 'utf8')) as typeof meta;
      } catch {
        // older Claude Code: no meta file
      }
      kids.push(childId);
      snap.rolloutById.set(childId, childFile);
      snap.byId.set(childId, {
        id: childId,
        title: meta.description,
        firstUserMessage: cs.firstPrompt,
        cwd: cs.cwd,
        model: cs.model,
        tokensUsed: cs.tokens,
        createdAt: cs.createdAt!,
        updatedAt: cs.updatedAt!,
        source: 'subagent',
        agentRole: meta.agentType,
        agentNickname: meta.agentType,
        parentId: id,
        childCount: 0,
        rolloutExists: true,
        archived: false,
        gitBranch: cs.gitBranch,
        cliVersion: cs.version,
        isSubagent: true,
      });
    }
    if (kids.length) snap.children.set(id, kids);
    snap.rolloutById.set(id, file);
    snap.byId.set(id, {
      id,
      title: s.title,
      firstUserMessage: s.firstPrompt,
      cwd: s.cwd,
      model: s.model,
      tokensUsed: s.tokens,
      createdAt: s.createdAt!,
      updatedAt: s.updatedAt!,
      source: s.entrypoint,
      childCount: kids.length,
      rolloutExists: true,
      archived: false,
      gitBranch: s.gitBranch,
      cliVersion: s.version,
      isSubagent: false,
    });
  }
  return snap;
}

/** The cwd the project's sessions ran in (for its label), from the newest session's first lines. */
export function projectCwd(dir: string): string | undefined {
  let newest: { f: string; t: number } | undefined;
  try {
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.jsonl')) continue;
      const t = fs.statSync(path.join(dir, f)).mtimeMs;
      if (!newest || t > newest.t) newest = { f, t };
    }
  } catch {
    return undefined;
  }
  if (!newest) return undefined;
  try {
    const fd = fs.openSync(path.join(dir, newest.f), 'r');
    try {
      const buf = Buffer.alloc(256 * 1024);
      const n = fs.readSync(fd, buf, 0, buf.length, 0);
      const m = /"cwd":"((?:[^"\\]|\\.)*)"/.exec(buf.subarray(0, n).toString('utf8'));
      return m ? (JSON.parse(`"${m[1]}"`) as string) : undefined;
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return undefined;
  }
}

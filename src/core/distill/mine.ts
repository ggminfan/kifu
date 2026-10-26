import type { SessionTrace, ToolCall } from '../../shared/types';
import { Bm25, tokenSet, tokenize } from '../analysis/tokens';
import { asksUser } from '../eval/checks';

/**
 * Mining sessions for a skill (rules, no model): the tool / command paths they
 * share, the clarifications the user had to give again and again, and the
 * existing skills closest to what was asked — the material a new skill (or an
 * edit of an existing one) is distilled from.
 */

export interface MineInput {
  id: string;
  title?: string;
  trace: SessionTrace;
}

export interface StepAt {
  sessionId: string;
  turnIndex: number;
  callIndex: number;
}

/** Steps done in this order in several sessions (one session: several times). */
export interface PathPattern {
  steps: string[];
  /** Sessions it appears in (one session: how often). */
  support: number;
  /** Where it starts, once per session. */
  at: StepAt[];
}

export interface Clarification {
  sessionId: string;
  /** The turn of the user's follow-up, and its first model call (to open it). */
  turnIndex: number;
  callIndex?: number;
  /** answer: the agent asked and the user answered; correction: the user corrected the agent. */
  kind: 'answer' | 'correction';
  question?: string;
  reply: string;
}

export interface ClarificationCluster {
  label: string;
  terms: string[];
  sessions: number;
  items: Clarification[];
}

export interface SkillMatch {
  key: string;
  score: number;
  matched: string[];
}

export interface Request {
  sessionId: string;
  turnIndex: number;
  text: string;
}

export interface MineResult {
  sessions: number;
  requests: Request[];
  paths: PathPattern[];
  clarifications: ClarificationCluster[];
  similar: SkillMatch[];
  suggestion: { mode: 'new'; reason: string } | { mode: 'improve'; skill: string; reason: string };
}

// ------------------------------------------------------------------ steps

/** Commands whose first argument says what they do (`git log`, `npm test`). */
const MULTI = new Set(['git', 'npm', 'pnpm', 'yarn', 'go', 'cargo', 'docker', 'kubectl', 'make', 'python', 'python3', 'pip', 'uv', 'bun', 'npx', 'gh', 'brew', 'mvn', 'gradle', 'node', 'tsx', 'pytest', 'bazel']);
/** Looking around: a path made only of these is not worth a skill. */
const LOOK = new Set(['ls', 'cat', 'sed', 'head', 'tail', 'rg', 'grep', 'find', 'pwd', 'wc', 'echo', 'nl', 'tree', 'stat', 'file', 'which', 'read']);

function shellText(t: ToolCall): string | undefined {
  if (t.kind === 'code_exec') return t.inner.find((e) => e.kind === 'exec')?.title ?? t.inner[0]?.title;
  const a = (t.argsJson ?? {}) as Record<string, unknown>;
  const c = a.cmd ?? a.command;
  if (Array.isArray(c)) {
    const parts = c.map(String);
    // bash -lc "<script>"
    return /^(ba|z)?sh$/.test(parts[0]?.split('/').pop() ?? '') && /^-\w*c$/.test(parts[1] ?? '') ? parts.slice(2).join(' ') : parts.join(' ');
  }
  return typeof c === 'string' ? c : undefined;
}

/** `git log --oneline | head` → `git log`; `cd x && npm test` → `npm test`. */
export function commandStep(cmd: string): string | undefined {
  for (const seg of cmd.split(/&&|\|\||;|\||\n/)) {
    const words = seg
      .trim()
      .split(/\s+/)
      .filter((w) => w && !/^\w+=/.test(w));
    // wrappers say nothing about the command
    while (words.length && ['sudo', 'env', 'time', 'nohup', 'exec'].includes(words[0])) words.shift();
    if (!words.length || words[0] === 'cd' || words[0] === 'export' || words[0] === 'source') continue;
    const head = words[0].split('/').pop()!.replace(/^["']|["']$/g, '');
    const sub = MULTI.has(head) ? words.slice(1).find((w) => !w.startsWith('-') && /^[\w:.-]+$/.test(w)) : undefined;
    return sub ? `${head} ${sub}` : head;
  }
  return undefined;
}

/** A tool call as a step that means the same thing across sessions (no file names, no arguments). */
export function stepOf(t: ToolCall): string | undefined {
  if (t.kind === 'shell' || t.kind === 'code_exec') {
    const cmd = shellText(t);
    return cmd ? commandStep(cmd) : t.name;
  }
  if (t.kind === 'file' || t.kind === 'patch') {
    const a = (t.argsJson ?? {}) as Record<string, unknown>;
    const p = String(a.file_path ?? a.path ?? '');
    const ext = /\.(\w{1,8})$/.exec(p)?.[1];
    return `${t.name}${ext ? ` *.${ext}` : ''}`;
  }
  if (t.kind === 'skill') return `skill ${t.skill ?? t.name}`;
  if (t.kind === 'mcp') return `${t.namespace ? `${t.namespace}.` : ''}${t.name}`;
  if (t.kind === 'wait' || t.kind === 'plan') return undefined;
  return t.name;
}

function isLook(step: string): boolean {
  const head = step.split(' ')[0];
  return LOOK.has(head) || /^(read|view|list|open)/i.test(head);
}

interface Seq {
  steps: string[];
  at: Array<{ turnIndex: number; callIndex: number }>;
}

/** Steps of each user turn, in order, repeats of the same step collapsed. */
function turnSequences(trace: SessionTrace): Seq[] {
  const out: Seq[] = [];
  for (const turn of trace.turns) {
    if (turn.trigger !== 'user') continue;
    const seq: Seq = { steps: [], at: [] };
    for (const ci of turn.calls) {
      const call = trace.calls[ci];
      if (!call) continue;
      for (const id of call.tools) {
        const t = trace.tools[id];
        const step = t ? stepOf(t) : undefined;
        if (!step || seq.steps[seq.steps.length - 1] === step) continue;
        seq.steps.push(step);
        seq.at.push({ turnIndex: turn.index, callIndex: call.index });
      }
    }
    if (seq.steps.length >= 2) out.push(seq);
  }
  return out;
}

function contains(long: string[], short: string[]): boolean {
  for (let i = 0; i + short.length <= long.length; i++) if (short.every((s, j) => long[i + j] === s)) return true;
  return false;
}

/** Shared paths of 2–5 steps, longest first among equally supported ones. */
export function minePaths(inputs: MineInput[], o: { minLen?: number; maxLen?: number; top?: number } = {}): PathPattern[] {
  const minLen = o.minLen ?? 2;
  const maxLen = o.maxLen ?? 5;
  const single = inputs.length === 1;
  const grams = new Map<string, { steps: string[]; sessions: Set<string>; count: number; at: StepAt[] }>();
  for (const s of inputs) {
    const seen = new Set<string>();
    for (const seq of turnSequences(s.trace)) {
      for (let n = minLen; n <= maxLen; n++) {
        for (let i = 0; i + n <= seq.steps.length; i++) {
          const steps = seq.steps.slice(i, i + n);
          if (steps.every(isLook)) continue;
          const key = steps.join('\u0001');
          const g = grams.get(key) ?? { steps, sessions: new Set<string>(), count: 0, at: [] };
          g.count++;
          if (!seen.has(key)) {
            seen.add(key);
            g.sessions.add(s.id);
            g.at.push({ sessionId: s.id, ...seq.at[i] });
          } else if (single) g.at.push({ sessionId: s.id, ...seq.at[i] });
          grams.set(key, g);
        }
      }
    }
  }
  const support = (g: { sessions: Set<string>; count: number }) => (single ? g.count : g.sessions.size);
  const min = single ? 2 : Math.max(2, Math.ceil(inputs.length * 0.4));
  const kept = [...grams.values()].filter((g) => support(g) >= min);
  // a path inside a longer one that is just as common says nothing more
  const maximal = kept.filter((g) => !kept.some((h) => h.steps.length > g.steps.length && support(h) >= support(g) && contains(h.steps, g.steps)));
  return maximal
    .sort((a, b) => support(b) - support(a) || b.steps.length - a.steps.length)
    .slice(0, o.top ?? 8)
    .map((g) => ({ steps: g.steps, support: support(g), at: g.at.slice(0, 6) }));
}

// ------------------------------------------------------------------ clarifications

const CORRECTION = /(不是|不要|别再|不对|错了|我说的是|我的意思是|应该是|而不是|换成|改成|重新来|不用|\binstead\b|\bi meant\b|not what|\bwrong\b|don't|do not|should be|rather than|\bno,)/i;
const MAX_REPLY = 240;

/** Follow-ups where the user answered the agent's question or corrected it. */
export function clarificationsOf(s: MineInput): Clarification[] {
  const out: Clarification[] = [];
  const turns = s.trace.turns;
  for (let k = 1; k < turns.length; k++) {
    const t = turns[k];
    if (t.trigger !== 'user') continue;
    const reply = t.input?.preview?.trim();
    if (!reply || reply.length > MAX_REPLY) continue;
    const prev = turns[k - 1].lastAgentMessage?.preview;
    const at = { sessionId: s.id, turnIndex: t.index, callIndex: t.calls[0] };
    if (asksUser(prev)) out.push({ ...at, kind: 'answer', question: prev?.trim().split('\n').slice(-3).join('\n').slice(-300), reply });
    else if (CORRECTION.test(reply)) out.push({ ...at, kind: 'correction', reply });
  }
  return out;
}

function overlap(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let n = 0;
  for (const t of a) if (b.has(t)) n++;
  return n / Math.min(a.size, b.size);
}

/** The same thing asked or corrected again, across sessions. */
export function clusterClarifications(items: Clarification[], top = 8): ClarificationCluster[] {
  const clusters: Array<{ items: Clarification[]; toks: Set<string>[]; union: Set<string> }> = [];
  for (const it of items) {
    const toks = tokenSet(`${it.question ?? ''} ${it.reply}`);
    const best = clusters.map((c) => ({ c, s: overlap(toks, c.union) })).sort((a, b) => b.s - a.s)[0];
    if (best && best.s >= 0.5) {
      best.c.items.push(it);
      best.c.toks.push(toks);
      for (const t of toks) best.c.union.add(t);
    } else clusters.push({ items: [it], toks: [toks], union: new Set(toks) });
  }
  return clusters
    .map((c) => {
      const counts = new Map<string, number>();
      for (const ts of c.toks) for (const t of ts) counts.set(t, (counts.get(t) ?? 0) + 1);
      const terms = [...counts].filter(([, n]) => n >= Math.max(2, Math.ceil(c.items.length / 2))).sort((a, b) => b[1] - a[1]).map(([t]) => t).slice(0, 8);
      // the most typical item names the cluster
      const label = c.items.map((it, i) => ({ it, s: [...c.toks[i]].reduce((n, t) => n + (counts.get(t) ?? 0), 0) / Math.max(1, c.toks[i].size) })).sort((a, b) => b.s - a.s)[0].it.reply;
      return { label, terms, sessions: new Set(c.items.map((x) => x.sessionId)).size, items: c.items };
    })
    .sort((a, b) => b.sessions - a.sessions || b.items.length - a.items.length)
    .slice(0, top);
}

// ------------------------------------------------------------------ requests and skills

/** What each session asked for: its user turns, the first one first. */
export function requestsOf(s: MineInput, perSession = 6): Request[] {
  return s.trace.turns
    .filter((t) => t.trigger === 'user' && t.input?.preview?.trim())
    .slice(0, perSession)
    .map((t) => ({ sessionId: s.id, turnIndex: t.index, text: t.input!.preview.trim() }));
}

/** Catalog skills closest to the requests (BM25 over name + description). */
export function similarSkills(requests: Request[], catalog: Array<{ key: string; description?: string }>, top = 3): SkillMatch[] {
  if (!catalog.length || !requests.length) return [];
  const docs = catalog.map((s) => tokenize(`${s.key.replace(/[:_-]/g, ' ')} ${s.description ?? ''}`));
  const bm = new Bm25(docs);
  const q = tokenize(requests.map((r) => r.text).join('\n'));
  return catalog
    .map((s, i) => ({ key: s.key, score: Math.round(bm.score(q, i) * 10) / 10, matched: bm.matched(q, i).slice(0, 8) }))
    .filter((m) => m.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, top);
}

/** Mine a few sessions; `catalog` is the agent's skills (to suggest editing one instead of adding another). */
export function mineSessions(inputs: MineInput[], catalog: Array<{ key: string; description?: string }>): MineResult {
  const requests = inputs.flatMap((s) => requestsOf(s));
  const paths = minePaths(inputs);
  const clarifications = clusterClarifications(inputs.flatMap(clarificationsOf));
  // first requests say what the sessions were for
  const firsts = inputs.flatMap((s) => requestsOf(s, 1));
  const similar = similarSkills(firsts.length ? firsts : requests, catalog);
  // sessions that already loaded the closest skill, or a strong match: improve it rather than add a near-duplicate
  const loaded = new Set(inputs.flatMap((s) => s.trace.invocations.map((v) => v.skill.split(':').pop()!)));
  const best = similar[0];
  const suggestion: MineResult['suggestion'] =
    best && (loaded.has(best.key.split(':').pop()!) || best.score >= 4)
      ? {
          mode: 'improve',
          skill: best.key,
          reason: loaded.has(best.key.split(':').pop()!) ? `这些会话已经加载过 ${best.key}，它没把事情做好：改它比再加一个相近的 skill 更合适` : `${best.key} 的描述和这些请求很接近（${best.matched.slice(0, 5).join('、')}）：先考虑改它`,
        }
      : { mode: 'new', reason: best ? `最接近的 ${best.key} 也不太相关，新建一个 skill` : '没有相近的 skill，新建一个' };
  return { sessions: inputs.length, requests, paths, clarifications, similar, suggestion };
}

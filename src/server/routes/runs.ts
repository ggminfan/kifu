import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { alignSequences, summarizeTrace, type ExecSummary } from '../../core/compare/summary';
import '../replay/lab';
import { cancelRun, createRuns, getRun, listRuns, runByThread, subscribe, type RunEvent, type RunOptions } from '../services/runner';
import { NotFound, parsedSession } from '../services/sessions';
import { tmDb } from '../services/tmDb';

export const runRoutes = new Hono();
export const compareRoutes = new Hono();
export const evaluationRoutes = new Hono();

runRoutes.post('/', async (c) => {
  const body = (await c.req.json()) as RunOptions & { variants: Array<string | null>; repeats?: number; confirmInplace?: boolean };
  if (!body.prompt?.trim()) return c.json({ error: '需要 prompt' }, 400);
  if (body.isolation === 'inplace' && !body.confirmInplace) return c.json({ error: '原地运行需要确认' }, 400);
  const repeats = Math.min(5, Math.max(1, Number(body.repeats ?? 1)));
  const variants = (body.variants?.length ? body.variants : [null]).map((v) => v ?? undefined);
  const runs = await createRuns(
    {
      skillKey: body.skillKey,
      prompt: body.prompt,
      testType: body.testType ?? 'trigger',
      isolation: body.isolation ?? 'readonly',
      cwd: body.cwd,
      gitSha: body.gitSha,
      model: body.model || undefined,
      sessionRef: body.sessionRef,
      keepHooks: body.keepHooks,
      allowMcp: body.allowMcp === true,
    },
    variants,
    repeats,
  );
  return c.json(runs);
});

runRoutes.get('/', (c) => c.json(listRuns(c.req.query('experiment') || undefined)));

/** The run (a replay or a Lab trial) that wrote this session; null for an ordinary session (every session page asks). */
runRoutes.get('/by-thread/:threadId', (c) => c.json(runByThread(c.req.param('threadId')) ?? null));

runRoutes.get('/:id', (c) => {
  const r = getRun(c.req.param('id'));
  if (!r) throw new NotFound('运行不存在');
  return c.json(r);
});

runRoutes.post('/:id/cancel', (c) => c.json({ ok: cancelRun(c.req.param('id')) }));

runRoutes.get('/:id/events', (c) => {
  const id = c.req.param('id');
  // a reverse proxy in front must not buffer the stream
  c.header('X-Accel-Buffering', 'no');
  return streamSSE(c, async (stream) => {
    const pending: RunEvent[] = [];
    let wake: (() => void) | undefined;
    const sub = subscribe(id, (e) => {
      pending.push(e);
      wake?.();
    });
    if (!sub) {
      const r = getRun(id);
      await stream.writeSSE({ event: 'done', data: JSON.stringify(r ?? null) });
      return;
    }
    stream.onAbort(() => sub.unsubscribe());
    for (const e of sub.backlog) await stream.writeSSE({ event: e.event, data: JSON.stringify(e.data), id: String(e.seq) });
    if (sub.backlog.some((e) => e.event === 'done')) {
      sub.unsubscribe();
      return;
    }
    for (;;) {
      if (!pending.length) {
        // Heartbeat keeps proxies / tunnels from dropping a quiet stream.
        const beat = await new Promise<boolean>((r) => {
          const t = setTimeout(() => r(true), 15_000);
          wake = () => {
            clearTimeout(t);
            r(false);
          };
        });
        if (beat) {
          await stream.writeSSE({ event: 'ping', data: '' });
          continue;
        }
      }
      wake = undefined;
      const batch = pending.splice(0);
      let done = false;
      for (const e of batch) {
        await stream.writeSSE({ event: e.event, data: JSON.stringify(e.data), id: String(e.seq) });
        if (e.event === 'done') done = true;
      }
      if (done) break;
    }
    sub.unsubscribe();
  });
});

async function summaryFor(ref: string, skill: string): Promise<{ label: string; summary?: ExecSummary; threadId?: string }> {
  if (ref.startsWith('session:')) {
    const id = ref.slice('session:'.length);
    const entry = await parsedSession(id);
    return { label: 'A（原始会话第 1 轮）', summary: summarizeTrace(entry.trace, [skill], { firstTurnOnly: true }), threadId: entry.trace.meta.threadId };
  }
  const run = getRun(ref.replace(/^run:/, ''));
  if (!run) throw new NotFound(`运行 ${ref} 不存在`);
  return { label: run.label, summary: run.kind === 'lab' ? run.result?.summary : undefined, threadId: run.threadId };
}

compareRoutes.get('/', async (c) => {
  const left = c.req.query('left');
  const right = c.req.query('right');
  const skill = c.req.query('skill') ?? '';
  if (!left || !right) return c.json({ error: 'left/right required' }, 400);
  const [a, b] = await Promise.all([summaryFor(left, skill), summaryFor(right, skill)]);
  const alignment = a.summary && b.summary ? alignSequences(a.summary.toolSeq, b.summary.toolSeq) : undefined;
  return c.json({ left: { ref: left, ...a }, right: { ref: right, ...b }, alignment });
});

evaluationRoutes.post('/', async (c) => {
  const body = (await c.req.json()) as { left: string; right: string; verdict: string; note?: string };
  const now = Date.now();
  const existing = tmDb().prepare('select id from evaluations where (left_run = ? and right_run = ?) or (left_run = ? and right_run = ?)').get(body.left, body.right, body.right, body.left) as
    | { id: string }
    | undefined;
  if (existing) {
    tmDb().prepare('update evaluations set left_run = ?, right_run = ?, verdict = ?, note = ?, updated_at = ? where id = ?').run(body.left, body.right, body.verdict, body.note ?? null, now, existing.id);
    return c.json({ id: existing.id });
  }
  const id = `e${now.toString(36)}`;
  tmDb()
    .prepare('insert into evaluations (id, left_run, right_run, verdict, note, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?)')
    .run(id, body.left, body.right, body.verdict, body.note ?? null, now, now);
  return c.json({ id });
});

evaluationRoutes.get('/', (c) => {
  const left = c.req.query('left');
  const right = c.req.query('right');
  if (left && right) {
    const row = tmDb().prepare('select * from evaluations where (left_run = ? and right_run = ?) or (left_run = ? and right_run = ?)').get(left, right, right, left);
    return c.json(row ?? null);
  }
  return c.json(tmDb().prepare('select * from evaluations order by updated_at desc limit 200').all());
});

/** Parse one rollout and print summary statistics: pnpm tsx scripts/parse-one.ts <rollout.jsonl> */
import { parseRollout } from '../src/core/parse';
const f = process.argv[2];
const t0 = Date.now();
const { trace, index } = await parseRollout(f);
const ms = Date.now() - t0;
const t = trace;
console.log(JSON.stringify({
  ms, rss: Math.round(process.memoryUsage().rss / 1e6) + 'MB', lines: index.kinds.length,
  meta: { id: t.meta.threadId.slice(0, 8), source: t.meta.source, model: t.meta.model, cli: t.meta.cliVersion, spawn: !!t.meta.spawn },
  fork: t.forkPrefix, turns: t.turns.length, calls: t.calls.length, kinds: t.calls.reduce((a: Record<string, number>, c) => (a[c.kind] = (a[c.kind] ?? 0) + 1, a), {}),
  noUsage: t.calls.filter((c) => !c.usage).length, tools: Object.keys(t.tools).length, toolErrors: t.totals.toolErrors,
  inner: Object.values(t.tools).reduce((s, x) => s + x.inner.length, 0), links: Object.values(t.tools).flatMap((x) => x.inner.map((e) => e.link)).reduce((a: Record<string, number>, l) => (a[l] = (a[l] ?? 0) + 1, a), {}),
  orphans: t.orphanEvents.length, items: t.items.length, epochs: t.epochs.length, listings: t.listings.map((l) => `${l.format}:${l.entries.length}`).slice(0, 4),
  invocations: t.invocations.map((v) => `${v.mode}:${v.skill}`).slice(0, 6), subagents: t.subagents.length, usageTotal: t.totals.usage.total,
  diags: t.diagnostics.map((d) => `${d.kind}:${d.detail}x${d.count}`).slice(0, 8),
}, null, 1));

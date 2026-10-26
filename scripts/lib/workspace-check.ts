/**
 * One agent workspace through its server endpoint: sessions listed, one
 * parsed. Used by the SSH end-to-end check; aggregates only.
 */

interface Endpoint {
  baseUrl: string;
  token: string;
}

export async function checkWorkspace(ep: Endpoint): Promise<{ ok: boolean; info: string }> {
  const headers = { authorization: `Bearer ${ep.token}` };
  const res = await fetch(`${ep.baseUrl}/api/sessions?limit=50&sub=1`, { headers });
  if (!res.ok) return { ok: false, info: `session list ${res.status}` };
  const body = (await res.json()) as { sessions?: Array<{ id: string; isSubagent?: boolean }>; sources?: unknown[] };
  const rows = body.sessions ?? [];
  const top = rows.find((r) => !r.isSubagent) ?? rows[0];
  if (!top) return { ok: false, info: 'no sessions listed' };
  const t = await fetch(`${ep.baseUrl}/api/sessions/${encodeURIComponent(top.id)}/trace`, { headers });
  const trace = t.ok ? ((await t.json()) as { totals?: { calls: number; tools: number } }) : undefined;
  const calls = trace?.totals?.calls ?? 0;
  return {
    ok: calls > 0,
    info: `${rows.length} sessions (${rows.filter((r) => r.isSubagent).length} subagents) from ${body.sources?.length ?? 0} sources · trace ${t.status}: ${calls} calls, ${trace?.totals?.tools ?? 0} tools`,
  };
}

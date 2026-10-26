/**
 * Headless end-to-end check of the SSH remote path, using the same modules as
 * the desktop app (no UI). Prints aggregates only — never session content.
 *
 *   pnpm e2e:remote --alias devbox
 *   pnpm e2e:remote --alias devbox --codex-roots /data/a/.codex,/data/b/.codex --homes /data/a/.codex,/data/b/.codex
 *
 * Options: --codex-roots / --claude-roots a,b (default: the app's)  --homes a,b (Codex homes expected among the
 * sources)  --agents claude (also open these agents' workspaces)
 * --ssh-bin P  --remote-base P  --control-dir P
 * --accept-host-key [SHA256:…]  --keep (leave connected servers running)
 *
 * Steps: connect (host key, platform probe, install), discover agents, start
 * the Codex server (all homes under the roots in one workspace), check auth,
 * the merged session list and socket permissions through the tunnel, kill the
 * ssh master and wait for the automatic reconnect (same local port), then
 * disconnect and verify that no server process is left on the remote.
 */
import os from 'node:os';
import path from 'node:path';
import { AGENT_LABEL, isAgentKind, type AgentKind } from '../src/shared/agents';
import { DEFAULT_SCAN } from '../src/shared/remote-protocol';
import { health, mintNonce } from '../desktop/src/bun/transport/server-process';
import { SshHost, type RemoteServer } from '../desktop/src/bun/transport/ssh';
import { checkWorkspace } from './lib/workspace-check';

const argv = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = argv.indexOf(`--${name}`);
  if (i === -1) return undefined;
  const v = argv[i + 1];
  return v && !v.startsWith('--') ? v : '';
};
const list = (v: string | undefined) => (v ? v.split(',').filter(Boolean) : undefined);
const expand = (p: string | undefined) => (p && p.startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : p || undefined);

const alias = flag('alias');
if (!alias) {
  console.error('usage: pnpm e2e:remote --alias <ssh host alias> [--codex-roots a,b] [--homes a,b] [--ssh-bin P] [--remote-base P] [--control-dir P] [--accept-host-key [SHA256:…]] [--keep]');
  process.exit(2);
}
const acceptKey = flag('accept-host-key');
const extraAgents = (list(flag('agents')) ?? []).filter((a): a is AgentKind => isAgentKind(a) && a !== 'codex');
/** Where to look for each agent's homes (default: the app's defaults, ~/.codex and $CODEX_HOME …). */
const roots: Record<AgentKind, string[]> = { codex: list(flag('codex-roots')) ?? DEFAULT_SCAN.codex, claude: list(flag('claude-roots')) ?? DEFAULT_SCAN.claude };
const hostOpts = { alias, sshBin: expand(flag('ssh-bin')), controlDir: expand(flag('control-dir')), remoteBase: flag('remote-base') || undefined };
/** Also replay a turn on the remote across a disconnect (needs a fake or real agent there: costs quota with a real one). */
const replayCheck = argv.includes('--replay-check');

const results: Array<{ step: string; ok: boolean }> = [];
let t0 = Date.now();
function record(step: string, ok: boolean, info?: string): void {
  results.push({ step, ok });
  console.log(`${ok ? '✓' : '✗'} ${step}${info ? ` — ${info}` : ''} (${Date.now() - t0}ms)`);
  t0 = Date.now();
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean | Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await cond()) return true;
    await sleep(200);
  }
  return false;
}

const host = new SshHost({ ...hostOpts, log: process.env.E2E_VERBOSE ? (l) => console.log(`    ${l}`) : undefined });
host.onChange(() => {
  if (host.status === 'hostkey' && host.hostKey) {
    const k = host.hostKey;
    console.log(`  host key (${k.kind}): ${k.keyType} ${k.fingerprint} for ${k.hostId} → ${k.knownHostsFile}`);
    const ok = acceptKey === '' || acceptKey === k.fingerprint;
    if (!ok) console.log('  not accepted: verify the fingerprint, then pass --accept-host-key <fingerprint>');
    host.answerHostKey(ok);
  }
});

let exitCode = 0;
try {
  t0 = Date.now();
  await host.connect();
  record('connect', true, `${host.detail} · build ${host.buildId}`);

  const found = await host.discover(roots);
  const codex = found.find((a) => a.agent === 'codex');
  const others = extraAgents.every((a) => found.some((f) => f.agent === a && f.sessions > 0));
  record('discover', Boolean(codex?.sources) && others, found.map((a) => `${a.agent}: ${a.sessions} sessions / ${a.sources} sources`).join(' · ') || 'nothing found');
  if (!codex) throw new Error('no Codex home found on the remote (pass --codex-roots)');

  // one Codex workspace: a single server for every home under the roots
  const server: RemoteServer = host.server({ agent: 'codex', roots: roots.codex });
  const servers = [server];
  const restarts = new Map<RemoteServer, number>();
  for (const s of servers) s.onRestart(() => restarts.set(s, (restarts.get(s) ?? 0) + 1));
  const eps = await Promise.all(servers.map((s) => s.start()));
  const ports = eps.map((ep) => new URL(ep.baseUrl).port);
  record('start the Codex server', eps[0].ready.agent === 'codex', `${eps[0].ready.socket ? 'unix socket' : 'tcp'} → port ${ports[0]} · ${eps[0].ready.sources} sources`);

  for (const ep of eps) {
    const unauth = await fetch(`${ep.baseUrl}/api/health`).then((r) => r.status);
    const h = await health(ep);
    const nonce = await mintNonce(ep);
    const authRes = await fetch(`${ep.baseUrl}/__kifu_auth?n=${encodeURIComponent(nonce)}&next=%2F`, { redirect: 'manual' });
    const cookie = authRes.headers.get('set-cookie')?.split(';')[0] ?? '';
    const page = await fetch(`${ep.baseUrl}/`, { headers: { cookie } }).then((r) => r.status);
    const ok = unauth === 401 && h.ok && authRes.status === 302 && page === 200;
    record(`auth via tunnel (${ep.ready.instanceId})`, ok, `no token ${unauth}, bearer ${h.ok ? 200 : 'fail'}, nonce→cookie ${authRes.status}/${page}, threads ${h.body?.threads ?? '?'}`);
  }

  // every home's sessions in one list, labelled by source
  {
    const ep = eps[0];
    const h = { authorization: `Bearer ${ep.token}` };
    const body = (await (await fetch(`${ep.baseUrl}/api/sessions?limit=500&sub=1`, { headers: h })).json()) as { sessions?: Array<{ id: string; sourceId?: string }>; sources?: Array<{ id: string }> };
    const fromSources = new Set((body.sessions ?? []).map((x) => x.sourceId)).size;
    const expected = list(flag('homes'))?.length ?? codex.sources;
    record('sessions of all homes in one list', (body.sources?.length ?? 0) >= expected && fromSources >= Math.min(expected, body.sessions?.length ?? 0), `${body.sessions?.length ?? 0} sessions from ${fromSources} of ${body.sources?.length ?? 0} sources (expected ${expected})`);
  }

  // Parse one real session through the tunnel: exercises the embedded parse worker on the remote.
  for (const ep of eps) {
    const h = { authorization: `Bearer ${ep.token}` };
    const list = (await (await fetch(`${ep.baseUrl}/api/sessions?limit=20`, { headers: h })).json()) as { sessions?: Array<{ id: string }> };
    const id = list.sessions?.[0]?.id;
    if (!id) {
      record(`parse a session (${ep.ready.instanceId})`, true, 'skipped: no sessions');
      continue;
    }
    const res = await fetch(`${ep.baseUrl}/api/sessions/${encodeURIComponent(id)}/trace`, { headers: h });
    const body = await res.text();
    const err = res.ok ? '' : (JSON.parse(body) as { error?: string }).error ?? res.statusText;
    record(`parse a session (${ep.ready.instanceId})`, res.ok, res.ok ? `${(body.length / 1024).toFixed(0)}KB trace` : `${res.status}: ${err}`);
  }

  // the other agents' workspaces: one more server each
  for (const agent of extraAgents) {
    const s = host.server({ agent, roots: roots[agent] });
    s.onRestart(() => restarts.set(s, (restarts.get(s) ?? 0) + 1));
    try {
      const ep = await s.start();
      servers.push(s);
      eps.push(ep);
      ports.push(new URL(ep.baseUrl).port);
      const w = await checkWorkspace(ep);
      record(`${AGENT_LABEL[agent]} workspace`, ep.ready.agent === agent && w.ok, w.info);
    } catch (e) {
      record(`${AGENT_LABEL[agent]} workspace`, false, (e as Error).message);
    }
  }

  const sock = eps[0].ready.socket;
  if (sock) {
    const r = await host.master!.exec(`exec /bin/sh -c 'ls -ld "$(dirname ${sock})"; ls -l ${sock}'`);
    const perms = r.stdout
      .trim()
      .split('\n')
      .map((l) => l.split(/\s+/)[0].replace(/[@+.]$/, ''));
    record('socket private to the user', perms[0] === 'drwx------' && perms[1] === 'srw-------', perms.join(' '));
  }

  // Kill the master as a network failure would; expect reconnect + every server back on its port — the same (detached) server.
  const pidsBefore = servers.map((s) => s.remotePid);
  const pid = host.master?.pid;
  if (pid) process.kill(pid, 'SIGKILL');
  const back = await until(() => host.status === 'ready' && servers.every((s) => s.status === 'ready' && (restarts.get(s) ?? 0) > 0), 90_000);
  const samePorts = servers.every((s, i) => s.endpoint && new URL(s.endpoint.baseUrl).port === ports[i]);
  const samePids = servers.every((s, i) => s.remotePid === pidsBefore[i]);
  const healthy = (await Promise.all(servers.map((s) => (s.endpoint ? health(s.endpoint) : { ok: false })))).every((h) => h.ok);
  record('reconnect after master kill', back && samePorts && samePids && healthy, `samePorts=${samePorts} sameServers=${samePids} healthy=${healthy}`);

  const seen = new Set<number>([...eps.map((ep) => ep.ready.pid), ...servers.map((s) => s.remotePid ?? 0)].filter(Boolean));
  const alive = async (via: SshHost, pids: number[]) => {
    const r = await via.master!.exec(`exec /bin/sh -c 'n=0; for p in ${pids.join(' ')}; do kill -0 $p 2>/dev/null && n=$((n+1)); done; echo $n'`);
    return Number(r.stdout.trim().split('\n').pop());
  };
  // the app restarted: a new client finds the running server and takes it over with a new token.
  // Each client has its own ssh connection (a restarted app's old one is gone): its own control dir here.
  const controlBase = hostOpts.controlDir ?? path.join(os.homedir(), '.kifu', 'cm');
  const client = (n: number) => new SshHost({ ...hostOpts, controlDir: path.join(controlBase, `c${n}`), log: process.env.E2E_VERBOSE ? (l) => console.log(`    [client ${n}] ${l}`) : undefined });
  let active = host;
  {
    const old = eps[0];
    const next = client(2);
    await next.connect();
    const s2 = next.server({ agent: 'codex', roots: roots.codex });
    const ep2 = await s2.start();
    const oldToken = await fetch(`${old.baseUrl}/api/health`, { headers: { authorization: `Bearer ${old.token}` } }).then((r) => r.status);
    const ok = s2.remotePid === server.remotePid && (await health(ep2)).ok && oldToken === 401;
    record('a new client takes the running server over', ok, `same server ${s2.remotePid === server.remotePid}, new token ok, old token ${oldToken}`);
    // the old client lets go: it must not stop a server it no longer owns
    await host.disconnect();
    await sleep(1000);
    record('the old client leaves it running', (await alive(next, [s2.remotePid!])) === 1 && (await health(ep2)).ok);
    active = next;

    if (replayCheck) {
      // a replay that outlives the client: disconnect while it runs, come back, see it finish
      const h = { authorization: `Bearer ${ep2.token}`, 'content-type': 'application/json', 'x-kifu': '1' };
      const list = (await (await fetch(`${ep2.baseUrl}/api/sessions?limit=20`, { headers: h })).json()) as { sessions?: Array<{ id: string }> };
      let made: { id: string } | undefined;
      for (const x of list.sessions ?? []) {
        const cuts = (await (await fetch(`${ep2.baseUrl}/api/sessions/${encodeURIComponent(x.id)}/cuts`, { headers: h })).json()) as Array<{ turnIndex: number; replayable: boolean }>;
        const cut = Array.isArray(cuts) ? cuts.find((c) => c.replayable) : undefined;
        if (!cut) continue;
        const res = await fetch(`${ep2.baseUrl}/api/cases`, { method: 'POST', headers: h, body: JSON.stringify({ sessionId: x.id, turnIndex: cut.turnIndex }) });
        if (res.ok) made = (await res.json()) as { id: string };
        break;
      }
      if (!made) throw new Error('no replayable turn on the remote');
      const started = await fetch(`${ep2.baseUrl}/api/cases/${made.id}/replays`, { method: 'POST', headers: h, body: JSON.stringify({ arms: [{ label: 'A′', variantIds: [] }], maxSteps: 5, workspace: 'empty' }) });
      const busy = await until(async () => Boolean((await health(ep2)).body?.busy), 15_000);
      record('a replay runs on the remote', started.ok && busy, `HTTP ${started.status}, busy ${busy}`);
      const stillBusy = Boolean((await health(ep2)).body?.busy);
      const s2pid = s2.remotePid!;
      await next.disconnect();
      await sleep(1000);
      const third = client(3);
      await third.connect();
      record('a busy server stays after disconnect', stillBusy && (await alive(third, [s2pid])) === 1, `busy when disconnecting ${stillBusy}`);
      const s3 = third.server({ agent: 'codex', roots: roots.codex });
      const ep3 = await s3.start();
      const h3 = { authorization: `Bearer ${ep3.token}`, 'x-kifu': '1' };
      const sameServer = s3.remotePid === s2pid;
      const done = await until(async () => {
        const replays = (await (await fetch(`${ep3.baseUrl}/api/cases/${made!.id}/replays`, { headers: h3 })).json()) as Array<{ status: string }>;
        return replays.length > 0 && replays.every((r) => r.status !== 'queued' && r.status !== 'running');
      }, 90_000);
      const replays = (await (await fetch(`${ep3.baseUrl}/api/cases/${made.id}/replays`, { headers: h3 })).json()) as Array<{ status: string; result?: { steps?: number; wallMs?: number } }>;
      record('the next client sees it finish', sameServer && done && replays[0]?.status === 'completed', `same server ${sameServer}, ${replays.map((r) => `${r.status} after ${r.result?.steps ?? '?'} steps, ${Math.round((r.result?.wallMs ?? 0) / 1000)}s`).join(', ')}`);
      active = third;
    }
  }

  if (flag('keep') === undefined) {
    // only our own servers: the desktop app may be connected to the same host
    for (const s of active.servers()) if (s.remotePid) seen.add(s.remotePid);
    await active.disconnect();
    await sleep(1500);
    const probe = new SshHost(hostOpts);
    await probe.connect();
    const all = [...seen];
    const left = await alive(probe, all);
    await probe.disconnect();
    record('no remote leftovers', left === 0, `${left} of ${all.length} server processes still running`);
  }
} catch (e) {
  record('error', false, (e as Error).message);
  if (host.error?.detail) console.log(host.error.detail);
  exitCode = 1;
  await host.disconnect().catch(() => undefined);
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : exitCode);

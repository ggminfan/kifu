/**
 * Smoke-test a kifu-server the way the desktop shell runs it:
 * stdin pipe carrying the token, KIFU_READY line, auth on every path, worker
 * parsing, and exit on stdin EOF.
 *
 *   tsx scripts/smoke-server.ts                       # source, run with bun
 *   tsx scripts/smoke-server.ts dist/server/kifu-server-darwin-arm64/bin/kifu-server
 *   tsx scripts/smoke-server.ts <bin> --socket        # listen on a unix socket
 *   tsx scripts/smoke-server.ts <bin> --long          # also hold an idle SSE stream for 60s
 *   tsx scripts/smoke-server.ts --agent codex         # a Codex / Claude Code server (local sessions)
 *   tsx scripts/smoke-server.ts <bin> --synthetic     # generated fixtures, safe for CI
 *
 * Prints statuses and sizes only, never session content.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { parseReadyLine, type ReadyLine } from '../src/shared/remote-protocol';
import { makeSyntheticClaudeHome, makeSyntheticCodexHome } from './lib/synthetic-homes';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const args = process.argv.slice(2);
const bin = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--agent');
const useSocket = args.includes('--socket');
const long = args.includes('--long');
const synthetic = args.includes('--synthetic');
const agentIdx = args.indexOf('--agent');
const agent = agentIdx === -1 ? undefined : args[agentIdx + 1];
const token = `smoke-${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`;

const cmd = bin ? path.resolve(bin) : path.join(root, 'node_modules/.bin/bun');
// Fresh data dir: no parse cache, so the worker really runs (removed afterwards: the cache holds parsed sessions).
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kifu-smoke-'));
const socket = useSocket ? path.join(dataDir, 'server.sock') : undefined;
const roots = synthetic
  ? agent === 'claude'
    ? makeSyntheticClaudeHome(path.join(dataDir, 'claude'))
    : makeSyntheticCodexHome(path.join(dataDir, 'codex'))
  : undefined;
// Never the repo as cwd: the desktop app and SSH sessions start the server elsewhere, and
// Bun silently resolves missing embedded modules against the cwd (that hid a broken worker path).
const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'kifu-smoke-cwd-'));
const cleanup = () => {
  for (const d of [dataDir, cwd]) fs.rmSync(d, { recursive: true, force: true });
};
const cmdArgs = [
  ...(bin ? [] : [path.join(root, 'src/server/cli.ts')]),
  'serve',
  '--token-stdin',
  '--exit-on-stdin-close',
  '--ready',
  '--no-index',
  ...(agent ? ['--agent', agent] : []),
  ...(roots ? ['--roots', roots] : []),
  ...(socket ? ['--socket', socket] : ['--port', '0']),
  '--web-dir',
  path.join(root, 'dist/web'),
  '--data-dir',
  dataDir,
];

type Res = { status: number; headers: http.IncomingHttpHeaders; body: string };

function request(ready: ReadyLine, p: string, opts: { method?: string; headers?: Record<string, string>; maxMs?: number } = {}): Promise<Res> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        ...(ready.socket ? { socketPath: ready.socket } : { host: '127.0.0.1', port: ready.port }),
        path: p,
        method: opts.method ?? 'GET',
        headers: { host: `127.0.0.1:${ready.port ?? 7799}`, ...opts.headers },
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
      },
    );
    req.on('error', reject);
    if (opts.maxMs) req.setTimeout(opts.maxMs, () => req.destroy(new Error('timeout')));
    req.end();
  });
}

const results: Array<{ name: string; ok: boolean; detail?: string }> = [];
const check = (name: string, ok: boolean, detail?: string) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};

async function main() {
  const env = { ...process.env };
  if (synthetic) {
    env.HOME = dataDir;
    for (const key of ['CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'KIFU_HOME', 'KIFU_ROOTS', 'CODEX_BIN', 'KIFU_AGENT']) delete env[key];
  }
  const child = spawn(cmd, cmdArgs, { stdio: ['pipe', 'pipe', 'pipe'], cwd, env });
  // Failure paths must not leave a server running or using deleted fixtures.
  process.once('exit', () => { if (child.exitCode === null) child.kill('SIGKILL'); });
  let stderr = '';
  child.stderr.on('data', (b) => (stderr += b.toString()));
  child.stdin.write(`${token}\n`);
  const ready = await new Promise<ReadyLine>((resolve, reject) => {
    let out = '';
    const t = setTimeout(() => reject(new Error(`no KIFU_READY within 15s; stderr: ${stderr.slice(-800)}`)), 15_000);
    child.once('error', (error) => { clearTimeout(t); reject(error); });
    child.stdout.on('data', (b) => {
      out += b.toString();
      const line = out.split('\n').find((l) => l.startsWith('KIFU_READY '));
      const r = line ? parseReadyLine(line) : undefined;
      if (r) {
        clearTimeout(t);
        resolve(r);
      }
    });
    child.on('exit', (code) => reject(new Error(`server exited (${code}) before ready: ${stderr.slice(-800)}`)));
  });
  check('KIFU_READY', true, `${ready.socket ? `unix:${ready.socket}` : `port ${ready.port}`} build ${ready.buildId} protocol ${ready.protocol}`);

  const bearer = { authorization: `Bearer ${token}` };
  for (const p of ['/', '/assets/missing.js', '/api/health', '/api/runs/x/events', '/api/sessions/x/blob/1/0']) {
    const r = await request(ready, p, { maxMs: 5000 });
    check(`401 without token: ${p}`, r.status === 401, `got ${r.status}`);
  }
  const health = await request(ready, '/api/health', { headers: bearer });
  const h = JSON.parse(health.body) as { version?: string; agent?: string; sources?: number };
  check('Bearer works', health.status === 200, `${h.version ?? ''}`);
  check('health reports the agent', h.agent === (agent ?? 'codex') && (h.sources ?? 0) > 0, `${h.agent}, ${h.sources} sources`);

  const nonce = JSON.parse((await request(ready, '/__kifu/nonce', { method: 'POST', headers: bearer })).body).nonce as string;
  const auth = await request(ready, `/__kifu_auth?n=${encodeURIComponent(nonce)}&next=/lab`);
  const cookie = (auth.headers['set-cookie'] ?? [])[0]?.split(';')[0] ?? '';
  check('nonce → cookie → redirect', auth.status === 302 && auth.headers.location === '/lab' && cookie.startsWith(`kifu_${ready.instanceId}=`), `${auth.status} ${auth.headers.location}`);
  const reuse = await request(ready, `/__kifu_auth?n=${encodeURIComponent(nonce)}&next=/`);
  check('nonce is single-use', reuse.status === 401, `got ${reuse.status}`);
  const page = await request(ready, '/', { headers: { cookie } });
  check('cookie opens the UI', page.status === 200 && page.body.includes('<div id="root">'), `got ${page.status}`);
  const cross = await request(ready, '/api/health', { headers: { cookie, 'sec-fetch-site': 'same-site', 'sec-fetch-mode': 'cors' } });
  check('cross-instance fetch rejected', cross.status === 403, `got ${cross.status}`);

  const list = JSON.parse((await request(ready, '/api/sessions?limit=1', { headers: bearer })).body) as { sessions: Array<{ id: string }> };
  const id = list.sessions[0]?.id;
  if (id) {
    const t0 = Date.now();
    const trace = await request(ready, `/api/sessions/${id}/trace`, { headers: bearer, maxMs: 120_000 });
    check('worker parse (trace)', trace.status === 200, `${trace.status} ${(trace.body.length / 1024).toFixed(0)}KB in ${Date.now() - t0}ms`);
    const view = JSON.parse(trace.body) as { calls?: Array<{ index: number }>; totals?: { calls: number; tools: number } };
    check('trace has calls', (view.calls?.length ?? 0) > 0, `${view.totals?.calls ?? 0} calls, ${view.totals?.tools ?? 0} tools`);
    const last = view.calls?.[view.calls.length - 1];
    if (last) {
      const ctx = await request(ready, `/api/sessions/${id}/calls/${last.index}/context`, { headers: bearer, maxMs: 60_000 });
      const items = ctx.status === 200 ? (JSON.parse(ctx.body) as { items: Array<{ ref: { line: number; ptr: string; json?: string }; chars: number }> }).items : [];
      check('call context', ctx.status === 200 && items.length > 0, `${ctx.status}, ${items.length} items`);
      const big = items.filter((i) => i.chars > 0).sort((a, b) => b.chars - a.chars)[0];
      if (big) {
        const q = new URLSearchParams({ line: String(big.ref.line), ptr: big.ref.ptr, ...(big.ref.json ? { json: big.ref.json } : {}) });
        const text = await request(ready, `/api/sessions/${id}/text?${q}`, { headers: bearer, maxMs: 60_000 });
        const got = text.status === 200 ? (JSON.parse(text.body) as { chars: number }).chars : -1;
        check('lazy text read', text.status === 200 && got > 0, `${text.status}, ${got} chars (item ${big.chars})`);
      }
    }
  } else {
    check('worker parse (trace)', false, 'no sessions to parse');
  }

  if (long) {
    const t0 = Date.now();
    const sse = await request(ready, '/api/runs/does-not-exist/events', { headers: bearer, maxMs: 70_000 }).catch((e) => ({ status: -1, body: String(e), headers: {} }));
    check('SSE request completes', sse.status === 200, `${sse.status} after ${Date.now() - t0}ms`);
  }

  const exitAt = Date.now();
  const exited = new Promise<number>((resolve) => child.on('exit', () => resolve(Date.now() - exitAt)));
  child.stdin.end();
  const ms = await Promise.race([exited, new Promise<number>((r) => setTimeout(() => r(-1), 3000))]);
  check('exits on stdin EOF', ms >= 0 && ms < 1500, ms >= 0 ? `${ms}ms` : 'still running after 3s');
  if (ms < 0) child.kill('SIGKILL');
  if (socket) check('socket removed', !fs.existsSync(socket));

  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  cleanup();
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  cleanup();
  process.exit(2);
});

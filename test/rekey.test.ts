import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

/**
 * A detached server is taken over by the next desktop client: it describes
 * itself in a state file, and `rekey` hands it a new token through its
 * control socket (stdin → socket, never argv or a file). The old token stops
 * working; sockets and the state file go when it exits.
 */

const root = path.resolve(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tmrk-'));
const run = path.join(tmp, 'run');
const sock = path.join(run, 's.sock');
const ctl = path.join(run, 's.ctl');
const state = path.join(run, 's.json');
let server: ChildProcess | undefined;

afterAll(() => {
  server?.kill('SIGKILL');
  fs.rmSync(tmp, { recursive: true, force: true });
});

function get(token: string): Promise<number> {
  return new Promise((resolve) => {
    const req = http.request({ socketPath: sock, path: '/api/health', headers: { authorization: `Bearer ${token}`, 'x-kifu': '1' } }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on('error', () => resolve(0));
    req.end();
  });
}

function cli(args: string[], input?: string): Promise<{ code: number | null; stdout: string }> {
  return new Promise((resolve) => {
    const p = spawn(path.join(root, 'node_modules/.bin/tsx'), [path.join(root, 'src/server/cli.ts'), ...args], { env: { ...process.env, NODE_OPTIONS: '--disable-warning=ExperimentalWarning' } });
    let stdout = '';
    p.stdout.on('data', (b) => (stdout += b));
    p.on('exit', (code) => resolve({ code, stdout }));
    p.stdin.end(input ?? '');
  });
}

describe('taking over a detached server', () => {
  it('rekeys through the control socket; the old token stops working', async () => {
    const a = 'token-a-0123456789abcdef';
    const b = 'token-b-0123456789abcdef';
    server = spawn(
      path.join(root, 'node_modules/.bin/tsx'),
      [path.join(root, 'src/server/cli.ts'), 'serve', '--socket', sock, '--token-stdin', '--control', ctl, '--state-file', state, '--no-index', '--ready', '--data-dir', path.join(tmp, 'data'), '--replay', 'here'],
      { env: { ...process.env, NODE_OPTIONS: '--disable-warning=ExperimentalWarning' }, stdio: ['pipe', 'pipe', 'pipe'] },
    );
    server.stdin!.write(`${a}\n`);
    const ready = await new Promise<{ pid: number }>((resolve, reject) => {
      let out = '';
      server!.stdout!.on('data', (d) => {
        out += d;
        const m = /KIFU_READY (\{.*\})/.exec(out);
        if (m) resolve(JSON.parse(m[1]) as { pid: number });
      });
      server!.on('exit', () => reject(new Error('server exited')));
    });
    const st = JSON.parse(fs.readFileSync(state, 'utf8')) as { pid: number; control: string; socket: string; buildId: string };
    expect(st).toMatchObject({ pid: ready.pid, control: ctl, socket: sock });
    expect(fs.statSync(state).mode & 0o777).toBe(0o600);
    expect(fs.statSync(ctl).mode & 0o777).toBe(0o600);
    expect(await get(a)).toBe(200);

    // a token too short, or no running server: refused
    expect((await cli(['rekey', '--control', ctl], 'short\n')).code).toBe(1);
    expect((await cli(['rekey', '--control', path.join(run, 'nope.ctl')], `${b}\n`)).code).toBe(1);
    expect(await get(a)).toBe(200);

    expect((await cli(['rekey', '--control', ctl], `${b}\n`)).code).toBe(0);
    expect(await get(a)).toBe(401);
    expect(await get(b)).toBe(200);

    server.kill('SIGTERM');
    await new Promise((r) => server!.once('exit', r));
    expect([fs.existsSync(state), fs.existsSync(ctl), fs.existsSync(sock)]).toEqual([false, false, false]);
  }, 60_000);
});

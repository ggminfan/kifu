import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/server/app';
import { Auth, authMiddleware } from '../src/server/auth';
import { parseFlags, serveOptions } from '../src/server/cli';
import { config } from '../src/server/config';
import { findCodexHomes } from '../src/server/discover';

function app(auth: Auth) {
  const a = new Hono();
  a.use('*', authMiddleware(auth));
  a.get('/api/x', (c) => c.json({ ok: true }));
  a.post('/api/x', (c) => c.json({ ok: true }));
  a.get('/', (c) => c.html('<p>ui</p>'));
  return a;
}

const H = { host: '127.0.0.1:7788' };

describe('auth middleware', () => {
  const auth = new Auth('secret-token', 'abc123');
  const a = app(auth);
  const req = (p: string, init: RequestInit & { headers?: Record<string, string> } = {}) => a.request(`http://127.0.0.1:7788${p}`, { ...init, headers: { ...H, ...(init.headers ?? {}) } });

  it('rejects everything without credentials', async () => {
    expect((await req('/api/x')).status).toBe(401);
    expect((await req('/', { headers: { accept: 'text/html' } })).status).toBe(401);
    expect((await req('/api/x', { headers: { authorization: 'Bearer wrong' } })).status).toBe(401);
  });

  it('accepts the bearer token (shell)', async () => {
    expect((await req('/api/x', { headers: { authorization: 'Bearer secret-token' } })).status).toBe(200);
    expect((await req('/api/x', { method: 'POST', headers: { authorization: 'Bearer secret-token' } })).status).toBe(200);
  });

  it('exchanges a single-use nonce for a per-instance cookie', async () => {
    expect((await req('/__kifu/nonce', { method: 'POST' })).status).toBe(401);
    expect((await req('/__kifu/nonce', { headers: { authorization: 'Bearer secret-token' } })).status).toBe(401); // GET
    const { nonce } = (await (await req('/__kifu/nonce', { method: 'POST', headers: { authorization: 'Bearer secret-token' } })).json()) as { nonce: string };
    const res = await req(`/__kifu_auth?n=${nonce}&next=/lab`);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/lab');
    const cookie = res.headers.get('set-cookie')!;
    expect(cookie).toMatch(/^kifu_abc123=/);
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Strict/);
    const jar = cookie.split(';')[0];
    expect((await req('/', { headers: { cookie: jar } })).status).toBe(200);
    expect((await req('/api/x', { headers: { cookie: jar } })).status).toBe(200);
    // single use
    expect((await req(`/__kifu_auth?n=${nonce}&next=/`)).status).toBe(401);
    // open redirects are neutralized
    const n2 = ((await (await req('/__kifu/nonce', { method: 'POST', headers: { authorization: 'Bearer secret-token' } })).json()) as { nonce: string }).nonce;
    expect((await req(`/__kifu_auth?n=${n2}&next=//evil.example`)).headers.get('location')).toBe('/');
  });

  it('guards cookie sessions against CSRF and other instances', async () => {
    const { nonce } = (await (await req('/__kifu/nonce', { method: 'POST', headers: { authorization: 'Bearer secret-token' } })).json()) as { nonce: string };
    const jar = (await req(`/__kifu_auth?n=${nonce}`)).headers.get('set-cookie')!.split(';')[0];
    expect((await req('/api/x', { method: 'POST', headers: { cookie: jar } })).status).toBe(403); // no x-kifu
    expect((await req('/api/x', { method: 'POST', headers: { cookie: jar, 'x-kifu': '1' } })).status).toBe(200);
    expect((await req('/api/x', { method: 'POST', headers: { cookie: jar, 'x-kifu': '1', origin: 'http://127.0.0.1:9999' } })).status).toBe(403);
    expect((await req('/api/x', { headers: { cookie: jar, 'sec-fetch-site': 'same-site', 'sec-fetch-mode': 'cors' } })).status).toBe(403);
    // a cookie minted by another server instance does not work here
    const other = new Auth('other', 'zzz999');
    expect((await req('/api/x', { headers: { cookie: `kifu_abc123=${other.sessionValue()}` } })).status).toBe(401);
    // non-local Host header (DNS rebinding)
    expect((await a.request('http://evil.example/api/x', { headers: { host: 'evil.example', authorization: 'Bearer secret-token' } })).status).toBe(403);
  });

  it('without a token (pnpm dev) only the local guards apply', async () => {
    const dev = app(new Auth(undefined, 'dev'));
    expect((await dev.request('http://127.0.0.1:7788/api/x', { headers: H })).status).toBe(200);
    expect((await dev.request('http://127.0.0.1:7788/__kifu_auth?next=/lab', { headers: H })).status).toBe(302);
  });
});

describe('web bundle', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kifu-web-'));
  const saved = config.webDir;
  afterAll(() => {
    config.webDir = saved;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('is served gzipped (it goes through the SSH tunnel), hashed assets cached for good', async () => {
    fs.mkdirSync(path.join(dir, 'assets'));
    fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><div id="root"></div>');
    const js = 'console.log("kifu");\n'.repeat(400);
    fs.writeFileSync(path.join(dir, 'assets', 'index-abc.js'), js);
    config.webDir = dir;
    const a = createApp(new Auth(undefined, 'dev'));
    const res = await a.request('http://127.0.0.1:7788/assets/index-abc.js', { headers: { ...H, 'accept-encoding': 'gzip' } });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-encoding')).toBe('gzip');
    expect(res.headers.get('cache-control')).toContain('immutable');
    expect(await new Response(res.body!.pipeThrough(new DecompressionStream('gzip'))).text()).toBe(js);
    // a client-side route gets the page, never cached
    const page = await a.request('http://127.0.0.1:7788/s/some-session', { headers: H });
    expect(page.headers.get('cache-control')).toBe('no-cache');
    expect(await page.text()).toContain('root');
  });
});

describe('cli flags', () => {
  it('parses serve flags', () => {
    const { command, flags } = parseFlags(['serve', '--socket', '/r/x.sock', '--token-stdin', '--idle-exit', '600', '--agent', 'codex', '--codex-home', '/w/codex', '--label=devbox', '--no-index']);
    expect(command).toBe('serve');
    expect(serveOptions(flags)).toMatchObject({ socket: '/r/x.sock', tokenStdin: true, idleExit: 600, agent: 'codex', codexHome: '/w/codex', label: 'devbox', index: false });
    expect(() => serveOptions(parseFlags(['serve', '--agent', 'other']).flags)).toThrow(/未知的 agent/);
  });
});

describe('discover', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });

  it('finds homes under globbed roots, dedupes symlinks, survives loops', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kifu-discover-'));
    dirs.push(root);
    const users = path.join(root, 'users');
    for (const id of ['u1', 'u2']) fs.mkdirSync(path.join(users, id, '.codex', 'sessions', '2026'), { recursive: true });
    fs.mkdirSync(path.join(users, 'u3', '.codex'), { recursive: true }); // not a home
    fs.mkdirSync(path.join(root, 'projects', 'p1', '.codex', 'sessions', '2026'), { recursive: true });
    fs.symlinkSync(path.join(root, 'projects', 'p1'), path.join(root, 'projects', 'alias')); // same home again
    fs.symlinkSync(root, path.join(root, 'projects', 'loop')); // cycle

    const found = findCodexHomes([`${users}/*/.codex`, path.join(root, 'projects')], { maxDepth: 3 });
    expect(found.map((h) => path.relative(root, h)).sort()).toEqual(['projects/p1/.codex', 'users/u1/.codex', 'users/u2/.codex']);
  });

  it('ignores missing roots and unset variables', () => {
    const prev = process.env.CODEX_HOME;
    delete process.env.CODEX_HOME;
    try {
      expect(findCodexHomes(['/nonexistent/x', '$CODEX_HOME', '/nonexistent/*/.codex'])).toEqual([]);
    } finally {
      if (prev !== undefined) process.env.CODEX_HOME = prev;
    }
  });
});

import fs from 'node:fs';
import path from 'node:path';
import type { Context } from 'hono';

/** Runtime-agnostic static file handler for the built web UI with SPA fallback. */

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

export function serveWeb(webDir: string) {
  const root = path.resolve(webDir);
  const index = path.join(root, 'index.html');
  return (c: Context): Response | undefined => {
    if (c.req.method !== 'GET' && c.req.method !== 'HEAD') return undefined;
    let rel: string;
    try {
      rel = decodeURIComponent(new URL(c.req.url).pathname);
    } catch {
      return undefined;
    }
    if (rel.startsWith('/api/')) return undefined;
    const file = path.resolve(root, `.${rel}`);
    if (!file.startsWith(root)) return new Response('forbidden', { status: 403 });
    let target = file;
    let st: fs.Stats | undefined;
    try {
      st = fs.statSync(file);
    } catch {
      st = undefined;
    }
    if (!st?.isFile()) {
      if (path.extname(rel)) return new Response('not found', { status: 404 });
      target = index; // client-side route
      if (!fs.existsSync(target)) return undefined;
    }
    const body = c.req.method === 'HEAD' ? null : fs.readFileSync(target);
    const immutable = rel.startsWith('/assets/');
    return new Response(body, {
      headers: {
        'content-type': TYPES[path.extname(target)] ?? 'application/octet-stream',
        'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
      },
    });
  };
}

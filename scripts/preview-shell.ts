/**
 * The desktop shell in a plain browser, with its mock API (made-up data):
 * bundles desktop/src/shell into dist/shell-preview and serves it.
 *
 *   pnpm preview:shell [--port 7792]
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(repo, 'dist', 'shell-preview');
const port = Number(process.argv[process.argv.indexOf('--port') + 1] || 7792) || 7792;

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
const build = spawnSync(path.join(repo, 'node_modules', '.bin', 'bun'), ['build', path.join(repo, 'desktop', 'src', 'shell', 'index.tsx'), '--target', 'browser', '--outdir', out], { stdio: 'inherit' });
if (build.status !== 0) process.exit(build.status ?? 1);
for (const f of ['index.html', 'shell.css']) fs.copyFileSync(path.join(repo, 'desktop', 'src', 'shell', f), path.join(out, f));

const TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' };
http
  .createServer((req, res) => {
    const name = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname).replace(/^\/+/, '') || 'index.html';
    const file = path.join(out, path.normalize(name));
    if (!file.startsWith(out) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404).end('not found');
      return;
    }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  })
  .listen(port, '127.0.0.1', () => console.log(`shell preview on http://127.0.0.1:${port}/`));

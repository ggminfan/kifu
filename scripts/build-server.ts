/**
 * Compile kifu-server with Bun into self-contained executables and
 * package them (bin + web UI + manifest) for the desktop shell.
 *
 *   tsx scripts/build-server.ts                 # darwin-arm64 + linux-x64 + linux-arm64
 *   tsx scripts/build-server.ts --remote        # linux targets only
 *   tsx scripts/build-server.ts --target darwin-arm64
 *
 *   tsx scripts/build-server.ts --target darwin-arm64 --runtime /path/to/modified/bun
 *
 * Output: dist/server/<target>/{bin/kifu-server, web/, manifest.json}
 *         dist/server/kifu-server-<target>.tar.gz (+ .sha256)
 */
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { PROTOCOL, type ServerManifest } from '../src/shared/remote-protocol';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as { version: string };
const bun = path.join(root, 'node_modules/.bin/bun');

const TARGETS: Record<string, { bunTarget: string; runtime?: string }> = {
  'darwin-arm64': { bunTarget: 'bun-darwin-arm64' },
  'linux-x64': { bunTarget: 'bun-linux-x64', runtime: 'node_modules/@oven/bun-linux-x64/bin/bun' },
  'linux-arm64': { bunTarget: 'bun-linux-arm64', runtime: 'node_modules/@oven/bun-linux-aarch64/bin/bun' },
};

const args = process.argv.slice(2);
const only = args.includes('--target') ? [args[args.indexOf('--target') + 1]] : args.includes('--remote') ? ['linux-x64', 'linux-arm64'] : Object.keys(TARGETS);
const replacementIndex = args.indexOf('--runtime');
const replacement = replacementIndex >= 0 ? args[replacementIndex + 1] : undefined;
if (replacementIndex >= 0 && (!replacement || !args.includes('--target'))) throw new Error('--runtime requires a path and one explicit --target');
const replacementRuntime = replacement ? path.resolve(replacement) : undefined;
if (replacementRuntime && !fs.statSync(replacementRuntime).isFile()) throw new Error('Replacement runtime must be a file');
const buildId = `${pkg.version}-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`;
const webDir = path.join(root, 'dist/web');
if (!fs.existsSync(path.join(webDir, 'index.html'))) throw new Error('dist/web missing — run `pnpm build` first');

execFileSync(process.execPath, [path.join(root, 'scripts/licenses.mjs')], { cwd: root, stdio: 'inherit' });

for (const target of only) {
  const t = TARGETS[target];
  if (!t) throw new Error(`unknown target ${target}`);
  const out = path.join(root, 'dist/server', target);
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(path.join(out, 'bin'), { recursive: true });
  const binPath = path.join(out, 'bin/kifu-server');
  const cmd = [
    'build', '--compile', `--target=${t.bunTarget}`,
    '--define', `__KIFU_BUILD_ID__=${JSON.stringify(buildId)}`,
    '--define', `__KIFU_VERSION__=${JSON.stringify(pkg.version)}`,
    '--define', '__KIFU_COMPILED__=true',
    ...(replacementRuntime ? ['--compile-executable-path', replacementRuntime] : t.runtime && fs.existsSync(path.join(root, t.runtime)) ? ['--compile-executable-path', path.join(root, t.runtime)] : []),
    'src/server/cli.ts', 'src/server/workers/parseWorker.ts',
    '--outfile', binPath,
  ];
  const t0 = Date.now();
  execFileSync(bun, cmd, { cwd: root, stdio: ['ignore', 'inherit', 'inherit'] });
  fs.cpSync(webDir, path.join(out, 'web'), { recursive: true });
  fs.cpSync(path.join(root, 'dist/licenses'), path.join(out, 'licenses'), { recursive: true });
  const sha256 = createHash('sha256').update(fs.readFileSync(binPath)).digest('hex');
  const manifest: ServerManifest = { name: 'kifu-server', version: pkg.version, buildId, protocol: PROTOCOL, target, sha256, builtAt: new Date().toISOString() };
  fs.writeFileSync(path.join(out, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  const tarball = path.join(root, 'dist/server', `kifu-server-${target}.tar.gz`);
  execFileSync('python3', [path.join(root, 'scripts/package-archive.py'), out, tarball, 'bin', 'web', 'licenses', 'manifest.json'], { stdio: 'inherit' });
  const tarSha = createHash('sha256').update(fs.readFileSync(tarball)).digest('hex');
  fs.writeFileSync(`${tarball}.sha256`, `${tarSha}  ${path.basename(tarball)}\n`);
  const mb = (n: number) => `${(n / 1024 / 1024).toFixed(1)}MB`;
  console.log(`✓ ${target}: bin ${mb(fs.statSync(binPath).size)}, tarball ${mb(fs.statSync(tarball).size)}, ${((Date.now() - t0) / 1000).toFixed(1)}s, build ${buildId}`);
}

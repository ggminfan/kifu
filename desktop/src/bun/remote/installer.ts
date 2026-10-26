import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ServerManifest } from '../../../../src/shared/remote-protocol';
import { shQuote } from '../ssh/args';
import { baseAssignment, type RemotePlatform, type Target } from './platform';

/**
 * Server packages shipped inside the app (one tarball per remote target) and
 * the remote install step: upload over the existing master with `cat >`,
 * verify sha256, unpack into a temp dir, smoke-run the binary, then move it
 * into $base/remote/versions/<buildId>. The newest 3 builds are kept.
 */

export interface LocalPackage {
  target: Target;
  tarball: string;
  size: number;
  manifest: ServerManifest;
  tarSha256: string;
}

const here = path.dirname(fileURLToPath(import.meta.url));

/** Packaged app: Resources/app/remote. Dev / scripts: the repo's dist/server. */
export function packageDirs(): string[] {
  return [
    process.env.KIFU_REMOTE_PKG_DIR,
    path.resolve(here, '../remote'), // bundled: Resources/app/bun/index.js → Resources/app/remote
    path.resolve('../Resources/app/remote'), // packaged app, cwd = Contents/MacOS
    path.resolve(here, '../../../../dist/server'), // running from source
  ].filter((d): d is string => Boolean(d));
}

const shaCache = new Map<string, string>();

function fileSha256(file: string): string {
  const side = `${file}.sha256`;
  if (fs.existsSync(side)) {
    const v = fs.readFileSync(side, 'utf8').trim().split(/\s+/)[0];
    if (/^[0-9a-f]{64}$/.test(v)) return v;
  }
  const key = `${file}:${fs.statSync(file).mtimeMs}`;
  let v = shaCache.get(key);
  if (!v) {
    v = createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    shaCache.set(key, v);
  }
  return v;
}

export function findPackage(target: Target, dirs = packageDirs()): LocalPackage | undefined {
  for (const dir of dirs) {
    const tarball = path.join(dir, `kifu-server-${target}.tar.gz`);
    if (!fs.existsSync(tarball)) continue;
    const manifestFile = [path.join(dir, `${target}.manifest.json`), path.join(dir, target, 'manifest.json')].find((f) => fs.existsSync(f));
    if (!manifestFile) continue;
    const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8')) as ServerManifest;
    return { target, tarball, size: fs.statSync(tarball).size, manifest, tarSha256: fileSha256(tarball) };
  }
  return undefined;
}

export type InstallDecision = { action: 'reuse'; buildId: string } | { action: 'install'; buildId: string } | { action: 'unsupported'; reason: string } | { action: 'missing-package'; target: Target };

export function decideInstall(platform: RemotePlatform, pkg: LocalPackage | undefined): InstallDecision {
  if (platform.unsupported || !platform.target) return { action: 'unsupported', reason: platform.unsupported ?? '不支持的平台' };
  if (!pkg) return { action: 'missing-package', target: platform.target };
  if (platform.installed.includes(pkg.manifest.buildId)) return { action: 'reuse', buildId: pkg.manifest.buildId };
  return { action: 'install', buildId: pkg.manifest.buildId };
}

export const KEEP_VERSIONS = 3;

/** The tarball arrives on stdin. */
export function installCommand(pkg: LocalPackage, base?: string): string {
  const id = shQuote(pkg.manifest.buildId);
  return [
    'set -e',
    baseAssignment(base),
    'v="$b/remote/versions"',
    `id=${id}`,
    'tmp="$v/.tmp-$id-$$"',
    'mkdir -p "$v"',
    'chmod 700 "$b" "$b/remote" 2>/dev/null || true',
    'find "$v" -maxdepth 1 -name ".tmp-*" -mtime +0 -exec rm -rf {} + 2>/dev/null || true',
    'rm -rf "$tmp"',
    'mkdir "$tmp"',
    'cat > "$tmp/pkg.tgz"',
    's=$( (sha256sum "$tmp/pkg.tgz" 2>/dev/null || shasum -a 256 "$tmp/pkg.tgz" 2>/dev/null) | cut -d " " -f 1)',
    `if test -n "$s"; then test "$s" = ${pkg.tarSha256} || { echo "KIFU_INSTALL_ERROR checksum $s"; rm -rf "$tmp"; exit 3; }; fi`,
    'tar -xzf "$tmp/pkg.tgz" -C "$tmp"',
    'rm -f "$tmp/pkg.tgz"',
    'chmod 755 "$tmp/bin/kifu-server"',
    'if "$tmp/bin/kifu-server" version > "$tmp/version.out" 2>&1; then rm -f "$tmp/version.out"; else echo "KIFU_INSTALL_ERROR exec"; head -c 600 "$tmp/version.out"; rm -rf "$tmp"; exit 4; fi',
    'rm -rf "$v/$id"',
    'mv "$tmp" "$v/$id"',
    `ls -1t "$v" | grep -v "^[.]" | tail -n +${KEEP_VERSIONS + 1} | while read -r o; do rm -rf "$v/$o"; done`,
    'echo KIFU_INSTALL_OK',
  ].join('; ');
}

export interface InstallResult {
  ok: boolean;
  error?: string;
}

export function parseInstallOutput(stdout: string, stderr: string, code: number | null): InstallResult {
  if (stdout.includes('KIFU_INSTALL_OK') && code === 0) return { ok: true };
  const i = stdout.indexOf('KIFU_INSTALL_ERROR');
  if (i !== -1) {
    const rest = stdout.slice(i + 'KIFU_INSTALL_ERROR'.length).trim();
    if (rest.startsWith('checksum')) return { ok: false, error: '上传的服务端包校验失败（sha256 不一致），请重试' };
    if (rest.startsWith('exec')) {
      const detail = rest.slice(4).trim().slice(0, 600);
      if (/GLIBC_|glibc/i.test(detail)) return { ok: false, error: `远端 glibc 版本过低，服务端无法运行：${detail}` };
      return { ok: false, error: `服务端在远端无法运行：${detail || '未知原因'}` };
    }
    return { ok: false, error: rest.slice(0, 300) };
  }
  if (/No space left on device|Disk quota exceeded/i.test(stderr)) return { ok: false, error: '远端磁盘空间不足' };
  return { ok: false, error: `安装失败（退出码 ${code ?? '?'}）：${stderr.trim().split('\n').slice(-4).join(' ').slice(0, 400)}` };
}

/** Stream the tarball into `cat >` with progress callbacks. */
export function tarballFeeder(pkg: LocalPackage, onProgress: (done: number, total: number) => void): (stdin: NodeJS.WritableStream) => Promise<void> {
  return async (stdin) => {
    const stream = fs.createReadStream(pkg.tarball, { highWaterMark: 256 * 1024 });
    let done = 0;
    let lastReport = 0;
    for await (const chunk of stream) {
      const buf = chunk as Buffer;
      const ok = stdin.write(buf);
      done += buf.length;
      if (Date.now() - lastReport > 200) {
        lastReport = Date.now();
        onProgress(done, pkg.size);
      }
      if (!ok) await new Promise<void>((r) => stdin.once('drain', () => r()));
    }
    onProgress(pkg.size, pkg.size);
  };
}

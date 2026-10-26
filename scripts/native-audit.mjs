// Audit the actual macOS package and server archives against reviewed native inputs.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const lock = JSON.parse(fs.readFileSync(path.join(root, 'licenses/native/binaries.lock.json'), 'utf8'));
const hash = (p) => {
  const h = createHash('sha256');
  const fd = fs.openSync(p, 'r');
  const buffer = Buffer.alloc(1024 * 1024);
  try { let n; while ((n = fs.readSync(fd, buffer, 0, buffer.length, null))) h.update(buffer.subarray(0, n)); } finally { fs.closeSync(fd); }
  return h.digest('hex');
};
const app = path.join(root, 'desktop/build/stable-macos-arm64/Kifu.app');
const native = path.join(app, 'Contents/MacOS');
const assert = (v, msg) => { if (!v) throw new Error(msg); };
const verifyArchiveMetadata = (file) => {
  execFileSync('python3', ['-c', `import sys,tarfile
with tarfile.open(sys.argv[1]) as t:
 for m in t:
  assert (m.uid,m.gid,m.uname,m.gname)==(0,0,'',''), 'Local archive ownership: '+m.name
  assert not any(k.startswith(('SCHILY.', 'LIBARCHIVE.')) or k in ('atime','ctime') for k in m.pax_headers), 'Private extended metadata: '+m.name
`, file], { stdio: 'pipe' });
};
const records = [];
for (const r of lock.desktop) {
  const p = path.join(native, r.file);
  assert(hash(p) === r.sha256, `Native binary changed; review sources/notices: ${r.file}`);
  records.push({ file: `Kifu.app/Contents/MacOS/${r.file}`, sha256: r.sha256, source: r.source });
}
assert(JSON.stringify(fs.readdirSync(native).sort()) === JSON.stringify(lock.desktop.map((r) => r.file).sort()), 'Unknown or missing native component; review inventory');
const frameworks = path.join(app, 'Contents/Frameworks');
assert(!fs.existsSync(frameworks) || fs.readdirSync(frameworks).length === 0, 'New bundled framework requires license review');
for (const r of lock.serverRuntimes) assert(hash(path.join(root, r.file)) === r.sha256, `Server runtime changed: ${r.target}`);
assert(hash(path.join(app, 'Contents/Resources/app/server/bin/kifu-server')) === hash(path.join(root, 'dist/server/darwin-arm64/bin/kifu-server')), 'Embedded local server differs from release server');
for (const target of ['linux-x64', 'linux-arm64']) assert(hash(path.join(app, `Contents/Resources/app/remote/kifu-server-${target}.tar.gz`)) === hash(path.join(root, `dist/server/kifu-server-${target}.tar.gz`)), `Embedded remote package differs: ${target}`);
const notices = JSON.parse(fs.readFileSync(path.join(root, 'licenses/native/notices.lock.json'), 'utf8'));
const mandatory = ['LICENSE', 'TRADEMARKS.md', 'THIRD_PARTY_NOTICES.md', 'docs/PROVENANCE.md', 'npm-notices.txt', 'native/sources.lock.json', 'native/binaries.lock.json', 'native/REBUILD.md', 'docs/RELEASING.md', 'docs/VERIFICATION.md', ...notices.map((n) => `native/${n.file}`)];
for (const name of ['LICENSE', 'TRADEMARKS.md']) assert(hash(path.join(root, 'dist/licenses', name)) === hash(path.join(root, name)), `Collected policy is stale: ${name}`);
const locations = [path.join(app, 'Contents/Resources/app/licenses'), ...lock.serverRuntimes.map((r) => path.join(root, 'dist/server', r.target, 'licenses'))];
for (const location of locations) for (const name of mandatory) assert(hash(path.join(location, name)) === hash(path.join(root, 'dist/licenses', name)), `Missing/stale packaged notice: ${path.relative(root, location)}/${name}`);
for (const r of lock.serverRuntimes) {
  const tar = path.join(root, 'dist/server', `kifu-server-${r.target}.tar.gz`);
  verifyArchiveMetadata(tar);
  const names = execFileSync('tar', ['-tzf', tar], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  for (const file of mandatory) assert(names.split('\n').includes(`licenses/${file}`), `Server archive omits ${file}`);
  const policy = execFileSync('tar', ['-xOf', tar, 'licenses/TRADEMARKS.md']);
  assert(createHash('sha256').update(policy).digest('hex') === hash(path.join(root, 'TRADEMARKS.md')), `Server archive has stale brand policy: ${r.target}`);
  records.push({ file: path.relative(root, tar), sha256: hash(tar) });
}
const out = path.join(root, 'dist/release');
fs.mkdirSync(out, { recursive: true });
const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'))).version;
const sources = path.join(out, `kifu-${version}-source-materials.tar.gz`);
assert(fs.existsSync(sources), 'Source companion missing; run pnpm native:sources before release');
const shaLine = fs.readFileSync(`${sources}.sha256`, 'utf8').split(/\s+/)[0];
assert(hash(sources) === shaLine, 'Source companion checksum mismatch');
const sourceManifest = JSON.parse(execFileSync('tar', ['-xOf', sources, 'SHA256.json'], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }));
verifyArchiveMetadata(sources);
const sourceNames = [...new Set(execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: root, encoding: 'utf8' }).split('\0').filter((n) => n && !n.startsWith('.claude/')))];
for (const name of sourceNames) assert(sourceManifest[`kifu/${name}`] === hash(path.join(root, name)), `Source companion is stale: ${name}; rerun pnpm native:sources`);
for (const r of JSON.parse(fs.readFileSync(path.join(root, 'licenses/native/sources.lock.json'), 'utf8'))) assert(sourceManifest[`native-sources/${r.archive}`] === r.sha256, `Companion missing locked source: ${r.id}`);
records.push({ file: path.relative(root, sources), sha256: shaLine });
const update = path.join(root, 'desktop/artifacts/stable-macos-arm64-Kifu.app.tar.zst');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'kifu-update-audit-'));
try {
  const tar = path.join(scratch, 'app.tar');
  execFileSync(path.join(native, 'zig-zstd'), ['decompress', '-i', update, '-o', tar, '--no-timing'], { stdio: 'pipe' });
  verifyArchiveMetadata(tar);
} finally { fs.rmSync(scratch, { recursive: true, force: true }); }
records.push({ file: path.relative(root, update), sha256: hash(update) });
fs.writeFileSync(`${update}.sha256`, `${hash(update)}  ${path.basename(update)}\n`);
for (const name of fs.readdirSync(path.join(root, 'desktop/artifacts')).filter((n) => n.endsWith('.dmg'))) {
  const p = path.join(root, 'desktop/artifacts', name);
  records.push({ file: path.relative(root, p), sha256: hash(p) });
  fs.writeFileSync(`${p}.sha256`, `${hash(p)}  ${name}\n`);
}
fs.writeFileSync(path.join(out, 'native-audit.json'), JSON.stringify({ verifiedAt: new Date().toISOString(), platform: `${process.platform}-${process.arch}`, records, limits: ['Runtime source rebuild not executed; see licenses/native/REBUILD.md.', 'Linux artifacts cross-compiled; native execution is a separate release check.', 'Not developer-signed or notarized.'] }, null, 2) + '\n');
console.log(`Verified ${lock.desktop.length} desktop native binaries, ${lock.serverRuntimes.length} server runtimes, packaged notices, and source companion. Report: dist/release/native-audit.json`);

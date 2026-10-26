// Invoke the native CLI directly: Electrobun 1.18.1's npm wrapper reports
// signal termination as exit code 0, which can make a failed build look green.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const desktop = path.join(root, 'desktop');
const pkgDir = path.join(desktop, 'node_modules/electrobun');
const native = path.join(pkgDir, 'bin', process.platform === 'win32' ? 'electrobun.exe' : 'electrobun');

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: desktop, stdio: 'inherit', ...options });
  if (result.error || result.signal || result.status !== 0) {
    console.error(`Electrobun command failed: ${result.error?.message ?? result.signal ?? result.status}`);
    process.exit(result.status || 1);
  }
}

if (!fs.existsSync(native)) {
  // Use the dependency's downloader, then independently validate its output.
  run(process.execPath, [path.join(pkgDir, 'bin/electrobun.cjs'), '--help']);
  if (!fs.existsSync(native)) throw new Error('Electrobun CLI download produced no executable');
}

if (process.platform === 'darwin' && process.arch === 'arm64') {
  const signature = spawnSync('codesign', ['--verify', native], { encoding: 'utf8' });
  if (signature.status !== 0) {
    const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'));
    const digest = createHash('sha256').update(fs.readFileSync(native)).digest('hex');
    // Verified against GitHub release v1.18.1. Its tarball SHA-256 is
    // 1ef4a4b42a957d3349f491f7fbe53153d1d5f427bacbda340c8d7fadce6b58d9.
    // Only this exact upstream binary has the known invalid ad-hoc signature.
    if (pkg.version !== '1.18.1' || digest !== 'bdd366630b6437e3ce346d6f4881500ea2e671b465806d50a7e1d3e5de2f3663') {
      throw new Error('Electrobun CLI signature is invalid and its checksum is not the known upstream release; reinstall and verify the dependency.');
    }
    console.log('Repairing the verified Electrobun 1.18.1 CLI ad-hoc signature.');
    run('codesign', ['--force', '--sign', '-', native]);
    run('codesign', ['--verify', native]);
  }
}

const startedAt = Date.now();
run(native, process.argv.slice(2));
if (process.platform === 'darwin' && process.arch === 'arm64' && process.argv[2] === 'build' && process.argv.includes('--env=stable')) {
  // Check actual outputs as well as the CLI exit status. Old artifacts cannot
  // turn a failed invocation into a successful release build.
  for (const output of ['build/stable-macos-arm64/Kifu.app/Contents/MacOS/launcher', 'artifacts/stable-macos-arm64-Kifu.dmg']) {
    const file = path.join(desktop, output);
    if (!fs.existsSync(file) || fs.statSync(file).size === 0) throw new Error(`Missing desktop build output: ${output}`);
  }
  const dmg = fs.statSync(path.join(desktop, 'artifacts/stable-macos-arm64-Kifu.dmg'));
  if (dmg.mtimeMs < startedAt - 1000) throw new Error('Desktop build did not produce a fresh DMG');
  // Electrobun's tar records contain the build account's name and UID. Package
  // the identical app contents with neutral metadata before distributing updates.
  const build = path.join(desktop, 'build/stable-macos-arm64');
  const archive = path.join(desktop, 'artifacts/stable-macos-arm64-Kifu.app.tar');
  try {
    run('python3', [path.join(root, 'scripts/package-archive.py'), build, archive, 'Kifu.app']);
    run(path.join(build, 'Kifu.app/Contents/MacOS/zig-zstd'), ['compress', '-i', archive, '-o', `${archive}.zst`, '-l', '19', '--no-timing']);
  } finally { fs.rmSync(archive, { force: true }); }
  console.log('Verified Kifu.app and fresh DMG build outputs.');
}

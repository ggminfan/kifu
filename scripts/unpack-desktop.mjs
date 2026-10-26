// Package a ready-to-run macOS app. Electrobun 1.18.1's runtime extractor can
// report UnexpectedEndOfStream after unpacking an otherwise valid tar archive.
// Extract during the build with macOS libarchive instead, before signing/DMG.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

if (process.env.ELECTROBUN_OS === 'macos') {
  const build = path.resolve(process.env.ELECTROBUN_BUILD_DIR ?? '');
  const wrapper = path.resolve(process.env.ELECTROBUN_WRAPPER_BUNDLE_PATH ?? '');
  if (path.dirname(wrapper) !== build || path.basename(wrapper) !== 'Kifu.app') {
    throw new Error('Unexpected app bundle path; refusing to replace it');
  }
  const resources = path.join(wrapper, 'Contents/Resources');
  const payloads = fs.readdirSync(resources).filter((name) => /^[a-z0-9]+\.tar\.zst$/.test(name));
  if (payloads.length !== 1) throw new Error('Expected exactly one generated app payload');
  const payload = path.join(resources, payloads[0]);
  const staging = fs.mkdtempSync(path.join(build, '.unpack-'));
  try {
    execFileSync('/usr/bin/tar', ['-xf', payload, '-C', staging], { stdio: 'inherit' });
    const app = path.join(staging, 'Kifu.app');
    for (const file of ['Contents/MacOS/launcher', 'Contents/Resources/app/bun/index.js', 'Contents/Info.plist']) {
      if (!fs.statSync(path.join(app, file)).size) throw new Error(`Empty app file: ${file}`);
    }
    fs.rmSync(wrapper, { recursive: true });
    fs.renameSync(app, wrapper);
    console.log('Verified and unpacked Kifu.app for direct launch (no first-run extraction).');
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

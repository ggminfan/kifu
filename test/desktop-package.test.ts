import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, expect, it } from 'vitest';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function fixture(valid = true) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kifu-package-test-'));
  roots.push(root);
  const wrapper = path.join(root, 'Kifu.app');
  const resources = path.join(wrapper, 'Contents/Resources');
  fs.mkdirSync(resources, { recursive: true });
  fs.writeFileSync(path.join(resources, 'metadata.json'), 'original wrapper');
  const source = path.join(root, 'source');
  for (const file of ['Contents/MacOS/launcher', 'Contents/Info.plist', ...(valid ? ['Contents/Resources/app/bun/index.js'] : [])]) {
    const target = path.join(source, 'Kifu.app', file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, 'generated app');
  }
  // libarchive detects the content, not the extension; no compression needed in this fixture.
  const archive = spawnSync('/usr/bin/tar', ['-cf', path.join(resources, 'test123.tar.zst'), '-C', source, 'Kifu.app']);
  expect(archive.status).toBe(0);
  return { root, wrapper, resources };
}
function unpack(root: string, wrapper: string) {
  return spawnSync(process.execPath, [path.resolve('scripts/unpack-desktop.mjs')], {
    env: { ...process.env, ELECTROBUN_OS: 'macos', ELECTROBUN_BUILD_DIR: root, ELECTROBUN_WRAPPER_BUNDLE_PATH: wrapper }, encoding: 'utf8',
  });
}
it('packages a complete app without a runtime extraction wrapper', () => {
  const { root, wrapper, resources } = fixture();
  const result = unpack(root, wrapper);
  expect(result.status, result.stderr).toBe(0);
  expect(fs.readFileSync(path.join(wrapper, 'Contents/MacOS/launcher'), 'utf8')).toBe('generated app');
  expect(fs.existsSync(path.join(resources, 'metadata.json'))).toBe(false);
  expect(fs.readdirSync(root).some((name) => name.startsWith('.unpack-'))).toBe(false);
});
it('keeps the wrapper intact when the payload is incomplete', () => {
  const { root, wrapper, resources } = fixture(false);
  expect(unpack(root, wrapper).status).not.toBe(0);
  expect(fs.readFileSync(path.join(resources, 'metadata.json'), 'utf8')).toBe('original wrapper');
});
it('refuses to replace paths outside the generated build directory', () => {
  const { root, wrapper, resources } = fixture();
  expect(unpack(path.join(root, 'different-build'), wrapper).status).not.toBe(0);
  expect(fs.existsSync(path.join(resources, 'metadata.json'))).toBe(true);
});

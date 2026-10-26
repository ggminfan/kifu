import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { beforeAll, expect, it } from 'vitest';
import { PRODUCT_AUTHOR, PRODUCT_COPYRIGHT } from '../src/shared/brand';

beforeAll(() => {
  fs.mkdirSync('dist/licenses/upstream', { recursive: true });
  fs.writeFileSync('dist/licenses/upstream/stale-fixture.txt', 'stale test notice');
  execFileSync(process.execPath, ['scripts/licenses.mjs'], { stdio: 'pipe' });
});
it('keeps the requested author consistent without rewriting dependency copyrights', () => {
  expect(PRODUCT_AUTHOR).toBe('Liam');
  expect(PRODUCT_COPYRIGHT).toBe('Copyright © 2026 Liam');
  for (const name of ['package.json', 'desktop/package.json']) expect(JSON.parse(fs.readFileSync(name, 'utf8')).author).toBe(PRODUCT_AUTHOR);
  expect(fs.readFileSync('dist/licenses/LICENSE', 'utf8')).toContain('Copyright (c) 2026 Liam');
  expect(fs.readFileSync('dist/licenses/npm-notices.txt', 'utf8')).toContain('Copyright');
  expect(fs.readFileSync('dist/licenses/upstream/electrobun-1.18.1-LICENSE.txt', 'utf8')).toContain('Blackboard Technologies');
});
it('does not publish local paths in the dependency inventory', () => {
  const text = fs.readFileSync('dist/licenses/inventory.json', 'utf8');
  expect(text).not.toContain(process.cwd());
  expect(text).not.toMatch(/\/Users\/|\/home\/|"paths"/);
  const records = JSON.parse(text);
  expect(records.length).toBeGreaterThan(0);
  expect(records.filter((r: { status: string }) => r.status === 'review-required').map((r: { name: string; version: string }) => `${r.name}@${r.version}`)).toEqual([]);
});
it('retains both Lucide and Feather terms for inline icons', () => {
  const text = fs.readFileSync('dist/licenses/upstream/lucide-LICENSE.txt', 'utf8');
  expect(text).toContain('ISC License');
  expect(text).toContain('Cole Bemis');
  expect(text).toContain('MIT License');
});
it('preserves linked notice files in the packaged layout', () => {
  expect(fs.existsSync('dist/licenses/upstream/stale-fixture.txt')).toBe(false);
  for (const name of ['THIRD_PARTY_NOTICES.md', 'README.md', 'native/REBUILD.md', 'docs/RELEASING.md', 'docs/VERIFICATION.md']) {
  const text = fs.readFileSync(path.join('dist/licenses', name), 'utf8');
  for (const match of text.matchAll(/\]\(([^)]+)\)/g)) {
    if (/^https?:/.test(match[1])) continue;
    expect(fs.existsSync(path.join('dist/licenses', path.dirname(name), match[1])), match[1]).toBe(true);
  }
  }
});

it('includes the pinned native source materials and original native copyright notices', () => {
  const binaryLock = JSON.parse(fs.readFileSync('licenses/native/binaries.lock.json', 'utf8'));
  const sources = JSON.parse(fs.readFileSync('licenses/native/sources.lock.json', 'utf8'));
  for (const r of [...binaryLock.desktop, ...binaryLock.serverRuntimes]) {
    expect(sources.some((s: { id: string }) => s.id === r.source), r.source).toBe(true);
  }
  for (const name of ['sources.lock.json', 'notices.lock.json', 'binaries.lock.json', 'REBUILD.md']) {
    expect(fs.readFileSync(`dist/licenses/native/${name}`, 'utf8')).toBe(fs.readFileSync(`licenses/native/${name}`, 'utf8'));
  }
  const patch = fs.readFileSync('dist/licenses/native/notices/zig-bsdiff-b7bc5e37cbaf.txt', 'utf8');
  expect(patch).toContain('Colin Percival');
  expect(patch).toContain('Yoav Givati');
  const tinycc = fs.readFileSync('dist/licenses/native/notices/tinycc-05f0fafaa3be.txt', 'utf8');
  expect(tinycc).toContain('GNU LESSER GENERAL PUBLIC LICENSE');
});

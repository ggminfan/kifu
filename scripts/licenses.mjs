// Preserve installed dependency notices without publishing local installation paths.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { parse } from 'yaml';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'dist/licenses');
const upstream = path.join(root, 'licenses/upstream');
const sources = JSON.parse(fs.readFileSync(path.join(upstream, 'sources.json'), 'utf8'));
for (const entry of sources) {
  const digest = createHash('sha256').update(fs.readFileSync(path.join(upstream, entry.file))).digest('hex');
  if (digest !== entry.sha256) throw new Error(`Upstream notice changed: ${entry.file}`);
}
const native = path.join(root, 'licenses/native');
const nativeNotices = JSON.parse(fs.readFileSync(path.join(native, 'notices.lock.json'), 'utf8'));
for (const entry of nativeNotices) {
  const digest = createHash('sha256').update(fs.readFileSync(path.join(native, entry.file))).digest('hex');
  if (digest !== entry.sha256) throw new Error(`Native notice changed: ${entry.file}`);
}
const nativeLock = JSON.parse(fs.readFileSync(path.join(native, 'binaries.lock.json'), 'utf8'));
const rootPackage = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const desktopPackage = JSON.parse(fs.readFileSync(path.join(root, 'desktop/package.json'), 'utf8'));
if (rootPackage.devDependencies.bun !== nativeLock.bunVersion || desktopPackage.dependencies.electrobun !== nativeLock.electrobunVersion) throw new Error('Native runtime version changed: refresh native sources and notices before packaging');

// Resolve the store used by this installation, even when tests isolate HOME.
const installed = parse(fs.readFileSync(path.join(root, 'node_modules/.modules.yaml'), 'utf8'));
const dependencies = Object.values(JSON.parse(execFileSync('pnpm', [`--config.store-dir=${path.dirname(installed.storeDir)}`, 'licenses', 'list', '--prod', '--json'], { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }))).flat();
const fallback = {
  'electrobun@1.18.1': 'electrobun-1.18.1-LICENSE.txt',
  'wouter@3.13.0': 'wouter-3.13.0-LICENSE.txt',
};
const records = [];
const sections = [];
for (const dep of dependencies.sort((a, b) => a.name.localeCompare(b.name))) {
  for (const location of dep.paths) {
    const pkg = JSON.parse(fs.readFileSync(path.join(location, 'package.json'), 'utf8'));
    const id = `${pkg.name}@${pkg.version}`;
    const notices = fs.readdirSync(location).filter((name) => /^(licen[sc]e|unlicen[sc]e|copying|notice|copyright)(?:[.-]|$)/i.test(name) && fs.statSync(path.join(location, name)).isFile()).sort()
      .map((name) => ({ source: name, text: fs.readFileSync(path.join(location, name), 'utf8') }));
    if (!notices.length && pkg.name === 'degenerator') {
      const readme = fs.readFileSync(path.join(location, 'README.md'), 'utf8');
      const at = readme.indexOf('License\n-------');
      if (at !== -1) notices.push({ source: 'README.md (License section)', text: readme.slice(at) });
    }
    if (!notices.length && fallback[id]) notices.push({ source: `upstream/${fallback[id]}`, text: fs.readFileSync(path.join(upstream, fallback[id]), 'utf8') });
    const record = { name: pkg.name, version: pkg.version, license: dep.license, noticeFiles: notices.map((n) => n.source), status: notices.length ? 'notice-collected' : id === 'bun-types@1.4.2' ? 'development-only-no-text' : 'review-required' };
    records.push(record);
    sections.push(`\n${'='.repeat(72)}\n${id}\nDeclared license: ${dep.license}\n${notices.length ? notices.map((n) => `\n--- ${n.source} ---\n${n.text}`).join('\n') : 'REVIEW REQUIRED: no license text shipped in this npm package. Metadata alone is not a license notice.'}\n`);
  }
}
// Rebuild the notice tree, so removed source notices cannot linger in releases.
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
for (const name of ['LICENSE', 'TRADEMARKS.md', 'THIRD_PARTY_NOTICES.md']) fs.copyFileSync(path.join(root, name), path.join(out, name));
fs.writeFileSync(path.join(out, 'THIRD_PARTY_NOTICES.md'), fs.readFileSync(path.join(root, 'THIRD_PARTY_NOTICES.md'), 'utf8').replaceAll('licenses/README.md', 'README.md').replaceAll('licenses/upstream/', 'upstream/'));
fs.mkdirSync(path.join(out, 'docs'), { recursive: true });
for (const name of ['PROVENANCE.md', 'RELEASING.md', 'VERIFICATION.md']) fs.writeFileSync(path.join(out, 'docs', name), fs.readFileSync(path.join(root, 'docs', name), 'utf8').replaceAll('](../licenses/', '](../'));
fs.copyFileSync(path.join(root, 'licenses/README.md'), path.join(out, 'README.md'));
fs.cpSync(upstream, path.join(out, 'upstream'), { recursive: true });
fs.cpSync(native, path.join(out, 'native'), { recursive: true });
fs.writeFileSync(path.join(out, 'npm-notices.txt'), 'Kifu dependency notices\nConservative inventory of installed production dependencies; not a precise bundle-content inventory. Native source notices and rebuild materials are in native/. See README.md for scope.\n' + sections.join('\n'));
fs.writeFileSync(path.join(out, 'inventory.json'), JSON.stringify(records, null, 2) + '\n');
const unresolved = records.filter((r) => r.status === 'review-required').map((r) => `${r.name}@${r.version}`);
console.log(`Collected npm inventory: ${records.length} packages (bun-types is type-only metadata); ${nativeNotices.length} native notice records. Unexpected missing notices: ${unresolved.join(', ') || 'none'}.`);

if (unresolved.length) throw new Error('New dependency without license text; review before packaging.');

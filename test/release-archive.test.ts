import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
const fixture = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kifu-archive-'));
  roots.push(root);
  fs.mkdirSync(path.join(root, 'bin'));
  fs.writeFileSync(path.join(root, 'bin/server'), 'synthetic executable\n', { mode: 0o755 });
  fs.symlinkSync('server', path.join(root, 'bin/current'));
  return root;
};
it('produces reproducible archives without local ownership or extended metadata', () => {
  const root = fixture();
  const files = ['first.tar.gz', 'second.tar.gz'].map(name => path.join(root, name));
  for (const file of files) execFileSync('python3', ['scripts/package-archive.py', root, file, 'bin']);
  expect(fs.readFileSync(files[0])).toEqual(fs.readFileSync(files[1]));
  const result = JSON.parse(execFileSync('python3', ['-c', `import tarfile,json,sys
with tarfile.open(sys.argv[1]) as t:
 print(json.dumps({'members':[{'name':m.name,'uid':m.uid,'gid':m.gid,'uname':m.uname,'gname':m.gname,'mtime':m.mtime,'mode':m.mode,'pax':m.pax_headers,'link':m.linkname} for m in t], 'content':t.extractfile('bin/server').read().decode()}))`, files[0]], { encoding: 'utf8' }));
  expect(result.content).toBe('synthetic executable\n');
  for (const m of result.members) expect(m).toMatchObject({ uid: 0, gid: 0, uname: '', gname: '', mtime: 0, pax: {} });
  expect(result.members.find((m: { name: string }) => m.name === 'bin/server').mode & 0o777).toBe(0o755);
  expect(result.members.find((m: { name: string }) => m.name === 'bin/current').link).toBe('server');
});
it('rejects package members that escape the package root', () => {
  const root = fixture();
  for (const member of ['../outside', '/absolute', '.']) {
    expect(spawnSync('python3', ['scripts/package-archive.py', root, path.join(root, 'bad.tar'), member]).status).not.toBe(0);
  }
});

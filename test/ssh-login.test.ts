import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { captureLoginEnvironment, decodeEnvironment, restoreEnvironment, loginShell } from '../desktop/src/bun/env/hydrate';
import { normalizeSshInput, validateSecret } from '../desktop/src/shared/ssh';
import { connectionArgs, masterArgs, probeArgs, recordKeyArgs, resolveArgs } from '../desktop/src/bun/ssh/args';
import { createAskpass } from '../desktop/src/bun/ssh/askpass';
import { SshMaster } from '../desktop/src/bun/ssh/master';
import { ConnectionManager } from '../desktop/src/bun/app/connections';
import { loadState } from '../desktop/src/bun/app/store';
import { listConfigHosts } from '../desktop/src/bun/ssh/resolve';
const dirs: string[] = [];
const temp = () => { const dir = fs.mkdtempSync('/tmp/kifu-login-test-'); dirs.push(dir); return dir; };
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
const run = (command: string, args: string[], env?: NodeJS.ProcessEnv) => new Promise<{ code: number | null; stdout: string }>((resolve, reject) => {
  const p = spawn(command, args, { env, stdio: ['ignore', 'pipe', 'ignore'] }); let stdout = '';
  p.stdout.on('data', b => stdout += b); p.on('error', reject); p.on('close', code => resolve({ code, stdout }));
});
it('captures real sh/bash/zsh login environments without exposing terminal noise', async () => {
  const home = temp();
  const value = 'first\nLOOKS_LIKE=another variable\n\ntrailing=中文';
  for (const shell of ['/bin/sh', '/bin/bash', '/bin/zsh'].filter(fs.existsSync)) {
    const result = await captureLoginEnvironment({ PATH: '/usr/bin:/bin', HOME: home, SHELL: shell, KIFU_TEST_VALUE: value }, shell);
    expect(result?.KIFU_TEST_VALUE, shell).toBe(value);
    expect(result?.KIFU_RESOLVING_ENV).toBe('1');
  }
});
it.skipIf(!fs.existsSync('/bin/zsh'))('ignores noisy startup output and retains a snapshot before a failed exit hook', async () => {
  const home = temp();
  fs.writeFileSync(path.join(home, '.zshrc'), "echo 'PATH=fake-banner'; export KIFU_TEST_VALUE='actual'; TRAPEXIT() { echo 'EXIT=noise'; return 7; }\n");
  const result = await captureLoginEnvironment({ PATH: '/usr/bin:/bin', HOME: home, ZDOTDIR: home }, '/bin/zsh');
  expect(result?.KIFU_TEST_VALUE).toBe('actual');
  expect(result?.PATH).not.toBe('fake-banner');
});
it('bounds failed captures and preserves the original environment', async () => {
  const shell = path.join(temp(), 'slow-shell');
  fs.writeFileSync(shell, '#!/bin/sh\nexec sleep 20\n', { mode: 0o700 });
  expect(await captureLoginEnvironment({ PATH: '/usr/bin:/bin' }, shell, 50)).toBeUndefined();
  const env = { PATH: '/original', TERM: 'xterm', SSH_AUTH_SOCK: '/agent' };
  expect(restoreEnvironment(env).ok).toBe(false);
  expect(env.PATH).toBe('/original');
  expect(loginShell({ SHELL: '/invalid shell;command' })).not.toBe('/invalid shell;command');
});
it('restores keys and PATH while excluding capture-shell bookkeeping', () => {
  const env: NodeJS.ProcessEnv = { PATH: '/a:/b', TERM: 'xterm', PWD: '/original' };
  const summary = restoreEnvironment(env, { PATH: '/b:/c:/c', TERM: 'dumb', PWD: '/shell', KIFU_RESOLVING_ENV: '1', KRB5CCNAME: 'cache', EMPTY: '' });
  expect(env).toEqual({ PATH: '/b:/c:/a', TERM: 'xterm', PWD: '/original', KRB5CCNAME: 'cache', EMPTY: '' });
  expect(summary).toMatchObject({ ok: true, added: 2, has: { KRB5CCNAME: true } });
  expect(JSON.stringify(summary)).not.toContain('cache');
  for (const value of ['null', '[]', '{"PATH":2}', '{"KEY":"bad\\u0000value"}']) expect(decodeEnvironment(Buffer.from(value))).toBeUndefined();
});
it('validates manual targets and keeps credentials outside saved connection options', () => {
  const r = normalizeSshInput({ alias: ' user@host.example ', label: ' Work ', port: 2222, authentication: 'password', secret: 'not-a-real-password' });
  expect(r).toMatchObject({ alias: 'user@host.example', label: 'Work', options: { port: 2222, authentication: 'password' } });
  expect(JSON.stringify(r.options)).not.toContain('not-a-real-password');
  expect(normalizeSshInput({ alias: '[::1]' }).alias).toBe('::1');
  for (const alias of ['-oProxyCommand=bad', 'host; command', 'user:password@host', 'host:2222', 'user@', 'a@b@c']) expect(() => normalizeSshInput({ alias })).toThrow();
  for (const port of [0, -1, 65536, 2.5, NaN]) expect(() => normalizeSshInput({ alias: 'host', port })).toThrow();
  expect(() => normalizeSshInput({ alias: 'host', authentication: 'identity', identityFile: '-bad' })).toThrow();
  expect(() => validateSecret('line\nbreak')).toThrow();
});
it('applies endpoint overrides consistently to resolve, trust probes and authentication', () => {
  const options = { port: 2222, user: 'alice', authentication: 'identity' as const, identityFile: '~/key with spaces' };
  const ctx = { sshBin: 'ssh', alias: 'host', controlPath: '/tmp/control', options };
  for (const args of [masterArgs(ctx, true), resolveArgs('host', options), probeArgs('host', '/empty', options), recordKeyArgs('host', '/known', options)]) {
    expect(args).toContain('2222'); expect(args).toContain('alice'); expect(args).toContain(path.join(os.homedir(), 'key with spaces'));
  }
  expect(masterArgs(ctx, true)).toContain('BatchMode=no');
  expect(masterArgs({ ...ctx, options: { authentication: 'password' } }, true)).toContain('PubkeyAuthentication=no');
  expect(masterArgs(ctx)).toContain('BatchMode=yes');
  expect(connectionArgs(options)).toContain('StrictHostKeyChecking=yes');
});
it('discovers concrete aliases with quoted includes, inline comments and equals syntax', () => {
  expect(listConfigHosts('Host = dev staging *.example !skip # comment\nInclude "conf dir/*.conf" # not a path\nHost "quoted"')).toEqual({ hosts: ['dev', 'staging', 'quoted'], includes: ['conf dir/*.conf'] });
});
it('cancels during askpass setup before spawning an SSH process', async () => {
  const master = new SshMaster({ sshBin: '/does/not/exist', alias: 'host', controlPath: path.join(temp(), 'control') }, () => {}, 'synthetic-password');
  const pending = master.start();
  await master.stop();
  await expect(pending).rejects.toThrow('连接已取消');
  expect(master.pid).toBeUndefined();
});
it('delivers a credential over private IPC, rejects unrelated prompts, and removes files', async () => {
  const secret = 'synthetic-$password-测试';
  const bridge = await createAskpass(secret);
  const helper = bridge.env.SSH_ASKPASS!;
  try {
    expect(JSON.stringify(bridge.env)).not.toContain(secret);
    for (const file of fs.readdirSync(path.dirname(helper))) {
      const p = path.join(path.dirname(helper), file);
      if (fs.statSync(p).isFile()) expect(fs.readFileSync(p, 'utf8')).not.toContain(secret);
    }
    expect((fs.statSync(path.dirname(helper)).mode & 0o777)).toBe(0o700);
    expect((await run(helper, ['Are you sure you want to continue connecting?'], bridge.env)).code).not.toBe(0);
    expect(await run(helper, ["alice@host's password:"], bridge.env)).toEqual({ code: 0, stdout: secret + '\n' });
  } finally { await bridge.close(); }
  expect(fs.existsSync(helper)).toBe(false);
});
it('runs askpass through the master process without a secret in argv or logs', async () => {
  const dir = temp(), secret = 'synthetic-master-secret', capture = path.join(dir, 'argv.json');
  const script = path.join(dir, 'ssh.cjs');
  fs.writeFileSync(script, `const {spawnSync}=require('node:child_process');require('node:fs').writeFileSync(${JSON.stringify(capture)},JSON.stringify(process.argv));const r=spawnSync(process.env.SSH_ASKPASS,["user@host's password:"],{env:process.env});if(r.stdout.toString().trim()!==${JSON.stringify(secret)}) process.exit(1);process.stderr.write(r.stdout);console.log('KIFU_MASTER_READY');process.stdin.resume();process.stdin.on('end',()=>process.exit(0));`);
  const wrapper = path.join(dir, 'ssh');
  fs.writeFileSync(wrapper, `#!/bin/sh\nexec '${process.execPath}' '${script}' "$@"\n`, { mode: 0o700 });
  const logs: string[] = [];
  const master = new SshMaster({ sshBin: wrapper, alias: 'host', controlPath: path.join(dir, 'cm'), options: { authentication: 'password' } }, (line) => logs.push(line), secret);
  try { await master.start(5000); expect(master.alive).toBe(true); expect(fs.readFileSync(capture, 'utf8')).not.toContain(secret); expect(logs.join()).not.toContain(secret); } finally { await master.stop(); }
});
it('persists manual settings but never the submitted password or passphrase', async () => {
  const old = process.env.KIFU_DESKTOP_STORE;
  process.env.KIFU_DESKTOP_STORE = path.join(temp(), 'connections.json');
  const manager = new ConnectionManager({ onChange() {}, onToast() {}, onRestarted() {} });
  try {
    const id = manager.addSsh({ alias: '127.0.0.1', label: 'Test server', port: 2222, user: 'test', authentication: 'password', secret: 'synthetic-store-secret' });
    expect(manager.view().connections.find(c => c.id === id)).toMatchObject({ label: 'Test server', ssh: { port: 2222, user: 'test', authentication: 'password' } });
    expect(JSON.stringify(manager.view())).not.toContain('synthetic-store-secret');
    await new Promise(r => setTimeout(r, 250));
    const text = fs.readFileSync(process.env.KIFU_DESKTOP_STORE, 'utf8');
    expect(text).not.toContain('synthetic-store-secret');
    expect(loadState().connections.find(c => c.id === id)?.ssh?.port).toBe(2222);
    await manager.removeConnection(id);
    await new Promise(r => setTimeout(r, 250));
  } finally { if (old) process.env.KIFU_DESKTOP_STORE = old; else delete process.env.KIFU_DESKTOP_STORE; }
});

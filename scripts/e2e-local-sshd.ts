/**
 * Run the SSH end-to-end check against a throwaway, unprivileged sshd on
 * 127.0.0.1 (real OpenSSH: ControlMaster, -O forward to unix sockets, host key
 * confirmation, EOF propagation) — no remote machine needed.
 *
 *   pnpm e2e:local-sshd
 *
 * Everything lives in a temp dir (keys, sshd/ssh configs, known_hosts, two
 * synthetic CODEX_HOMEs, a synthetic Claude Code config dir and the fake agent
 * that sshd sets for its sessions). The "remote" data root and control
 * sockets use unique, short /tmp directories, also removed afterwards.
 * Requires a local server
 * package: pnpm build:server.
 */
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { makeSyntheticClaudeHome, makeSyntheticCodexHome } from './lib/synthetic-homes';
import { SshMaster } from '../desktop/src/bun/ssh/master';
import { shQuote } from '../desktop/src/bun/ssh/args';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const sshd = ['/usr/sbin/sshd', '/usr/local/sbin/sshd'].find((p) => fs.existsSync(p));
if (!sshd) {
  console.error('sshd not found');
  process.exit(2);
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kifu-e2e-sshd-'));
fs.chmodSync(dir, 0o700);
// Short paths for Unix sockets; never delete or reuse a user's ~/.kifu data.
const remoteBase = fs.mkdtempSync('/tmp/kifu-e2e-r-');
const controlDir = fs.mkdtempSync('/tmp/kifu-e2e-c-');
fs.chmodSync(remoteBase, 0o700);
fs.chmodSync(controlDir, 0o700);

const port = await new Promise<number>((resolve) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => {
    const p = (s.address() as net.AddressInfo).port;
    s.close(() => resolve(p));
  });
});

const keygen = (file: string, comment: string) => execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', file, '-C', comment]);
keygen(path.join(dir, 'host_ed25519'), 'kifu-e2e-host');
keygen(path.join(dir, 'id_ed25519'), 'kifu-e2e-client');
fs.copyFileSync(path.join(dir, 'id_ed25519.pub'), path.join(dir, 'authorized_keys'));
const passphrase = 'kifu synthetic key passphrase';
const encryptedIdentity = path.join(dir, 'encrypted_ed25519');
execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', passphrase, '-f', encryptedIdentity]);
fs.appendFileSync(path.join(dir, 'authorized_keys'), fs.readFileSync(`${encryptedIdentity}.pub`));
fs.chmodSync(path.join(dir, 'authorized_keys'), 0o600);

// the "remote" agent is the fake one (no model calls): a wrapper with an absolute node, whatever the login shell's PATH
const fakeAgent = path.join(dir, 'fake-codex');
fs.writeFileSync(fakeAgent, `#!/bin/sh\nexec '${process.execPath}' '${path.join(root, 'test/fixtures/fake-agent.mjs')}' "$@"\n`, { mode: 0o755 });

const user = os.userInfo().username;
fs.writeFileSync(
  path.join(dir, 'sshd_config'),
  [
    `Port ${port}`,
    'ListenAddress 127.0.0.1',
    `HostKey ${dir}/host_ed25519`,
    `PidFile ${dir}/sshd.pid`,
    `AuthorizedKeysFile ${dir}/authorized_keys`,
    'UsePAM no',
    'StrictModes no',
    'PasswordAuthentication no',
    'KbdInteractiveAuthentication no',
    'PubkeyAuthentication yes',
    'AllowStreamLocalForwarding yes',
    'AllowTcpForwarding yes',
    `AllowUsers ${user}`,
    'LogLevel VERBOSE',
    // the remote's Codex and Claude Code: synthetic homes (never the user's own) and the fake agent for replays
    `SetEnv CODEX_HOME=${dir}/codex/h1 CLAUDE_CONFIG_DIR=${dir}/claude CODEX_BIN=${fakeAgent} FAKE_STEPS=3 FAKE_STEP_MS=5000`,
    '',
  ].join('\n'),
);
fs.writeFileSync(
  path.join(dir, 'ssh_config'),
  ['Host kifu-e2e', '  HostName 127.0.0.1', `  Port ${port}`, `  User ${user}`, `  IdentityFile ${dir}/id_ed25519`, '  IdentitiesOnly yes', '  IdentityAgent none', `  UserKnownHostsFile ${dir}/known_hosts`, '  GlobalKnownHostsFile /dev/null', '  GSSAPIAuthentication no', ''].join('\n'),
);
const wrapper = path.join(dir, 'ssh');
fs.writeFileSync(wrapper, `#!/bin/sh\nexec ssh -F '${dir}/ssh_config' "$@"\n`, { mode: 0o755 });

// two synthetic Codex homes with one made-up session each and a Claude Code dir (no user data)
const homes = ['h1', 'h2'].map((h, i) => makeSyntheticCodexHome(path.join(dir, 'codex', h), `e2e-codex-${i + 1}`));
makeSyntheticClaudeHome(path.join(dir, 'claude'));

const daemon = spawn(sshd, ['-D', '-e', '-f', path.join(dir, 'sshd_config')], { stdio: ['ignore', 'ignore', 'pipe'] });
let sshdLog = '';
daemon.stderr.on('data', (b: Buffer) => (sshdLog += b.toString()));
const cleanup = () => {
  // servers are detached (they outlive their client): stop any of ours a failed run left behind
  spawnSync('pkill', ['-f', `${remoteBase}/remote/versions/`]);
  daemon.kill('SIGTERM');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(remoteBase, { recursive: true, force: true });
  fs.rmSync(controlDir, { recursive: true, force: true });
};
process.on('SIGINT', () => {
  cleanup();
  process.exit(130);
});

const up = await (async () => {
  for (let i = 0; i < 50; i++) {
    const ok = await new Promise<boolean>((r) => {
      const c = net.connect(port, '127.0.0.1', () => (c.destroy(), r(true)));
      c.on('error', () => r(false));
    });
    if (ok) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
})();
if (!up) {
  console.error(`sshd did not start:\n${sshdLog}`);
  cleanup();
  process.exit(1);
}
console.log(`sshd on 127.0.0.1:${port} (temp dir ${dir})\n`);

// Manual host/port/user + encrypted identity exercise the real OpenSSH askpass
// path. Trust only this test's generated host key, without touching ~/.ssh.
const authKnownHosts = path.join(dir, 'auth_known_hosts');
fs.writeFileSync(authKnownHosts, `[127.0.0.1]:${port} ${fs.readFileSync(path.join(dir, 'host_ed25519.pub'), 'utf8')}`);
const authWrapper = path.join(dir, 'ssh-auth');
fs.writeFileSync(authWrapper, `#!/bin/sh\nexec ssh -F /dev/null -o ${shQuote(`UserKnownHostsFile=${authKnownHosts}`)} -o GlobalKnownHostsFile=/dev/null -o IdentityAgent=none "$@"\n`, { mode: 0o700 });
const authMaster = new SshMaster({ sshBin: authWrapper, alias: '127.0.0.1', controlPath: path.join(controlDir, 'auth'), options: { port, user, authentication: 'identity', identityFile: encryptedIdentity } }, () => {}, passphrase);
try {
  await authMaster.start(15_000);
  const proof = await authMaster.exec('printf kifu-auth-ok');
  if (proof.code !== 0 || proof.stdout !== 'kifu-auth-ok') throw new Error('encrypted identity authentication failed');
  console.log('PASS manual host/port/user with encrypted identity via private askpass');
} catch (error) {
  console.error(error);
  await authMaster.stop();
  cleanup();
  process.exit(1);
}
await authMaster.stop();

const code = await new Promise<number>((resolve) => {
  const child = spawn(
    path.join(root, 'node_modules/.bin/tsx'),
    [
      path.join(root, 'scripts/e2e-remote.ts'),
      '--alias', 'kifu-e2e',
      '--ssh-bin', wrapper,
      '--remote-base', remoteBase,
      '--control-dir', controlDir,
      '--accept-host-key',
      // only the synthetic homes, not this user's ~/.codex and ~/.claude
      '--codex-roots', `${dir}/codex`,
      '--claude-roots', '$CLAUDE_CONFIG_DIR',
      '--homes', homes.join(','),
      '--agents', 'claude',
      '--replay-check',
    ],
    { stdio: 'inherit', env: { ...process.env, KIFU_REMOTE_PKG_DIR: path.join(root, 'dist/server'), NODE_OPTIONS: '--disable-warning=ExperimentalWarning' } },
  );
  child.on('exit', (c) => resolve(c ?? 1));
});
cleanup();
process.exit(code);

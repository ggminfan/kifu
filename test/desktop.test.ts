import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { agentScan, connectionEnabled, ConnectionManager, scanOf, workspaceId } from '../desktop/src/bun/app/connections';
import { agentArgs, discoverArgs } from '../desktop/src/bun/transport/server-process';
import { claimInstance, endPreviousInstance, lockFileFor, looksLikeOurApp, releaseInstance } from '../desktop/src/bun/app/instance';
import { sourceLabel } from '../src/shared/agents';
import { mergePath, decodeEnvironment } from '../desktop/src/bun/env/hydrate';
import { decideInstall, installCommand, parseInstallOutput, type LocalPackage } from '../desktop/src/bun/remote/installer';
import { loginEnv, parseProbe, probeCommand, targetFor } from '../desktop/src/bun/remote/platform';
import { Backoff } from '../desktop/src/bun/remote/reconnect';
import { parseLauncherOutput, SshHost } from '../desktop/src/bun/transport/ssh';
import { controlPathFor, execArgs, masterArgs, shCommand, shQuote } from '../desktop/src/bun/ssh/args';
import { classifySshError } from '../desktop/src/bun/ssh/errors';
import { knownHostsLineFingerprint, parseChangedHostKey, parseServerHostKey } from '../desktop/src/bun/ssh/hostkey';
import { knownHostsId, listConfigHosts, parseSshG, readConfigHosts, validAlias } from '../desktop/src/bun/ssh/resolve';
import { DEFAULT_SCAN, parseReadyLine, READY_PREFIX } from '../src/shared/remote-protocol';

const tmpDirs: string[] = [];
function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'kifu-desktop-test-'));
  tmpDirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

/** Run a command line the way the remote login shell would: `sh -c <line>`. */
async function sh(line: string, env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const { execFileSync } = await import('node:child_process');
  return execFileSync('/bin/sh', ['-c', line], { encoding: 'utf8', env });
}

describe('ssh args and quoting', () => {
  it('quotes values for a POSIX shell', async () => {
    for (const v of ['plain', "it's", 'a b', '$HOME `x` "q"', '', "''", '; rm -rf /']) {
      expect(await sh(`printf %s ${shQuote(v)}`)).toBe(v);
    }
  });

  it('shCommand survives a second shell layer', async () => {
    const script = `x=${shQuote("it's a $HOME test")}; printf %s "$x"`;
    expect(await sh(shCommand(script))).toBe("it's a $HOME test");
    expect(() => shCommand('a\nb')).toThrow();
  });

  it('builds master/exec args that override config commands and ttys', () => {
    const ctx = { sshBin: 'ssh', alias: 'devbox', controlPath: '/x/cm/abc-1' };
    const m = masterArgs(ctx);
    expect(m.slice(0, 3)).toEqual(['-M', '-S', '/x/cm/abc-1']);
    expect(m).toContain('RemoteCommand=none');
    expect(m).toContain('ClearAllForwardings=yes');
    expect(m).not.toContain('StrictHostKeyChecking=yes'); // the user's own setting applies
    expect(m.at(-2)).toBe('devbox');
    const e = execArgs(ctx, 'true');
    expect(e.at(-2)).toBe('devbox');
    expect(e.at(-1)).toBe('true');
    expect(e).toContain('ControlMaster=no');
  });

  it('control paths are short and per process', () => {
    const p = controlPathFor('/Users/someone/.kifu/cm', 'a-very-long-alias-name.example.internal', 12345);
    expect(p).toMatch(/\/[0-9a-f]{12}-12345$/);
    expect(Buffer.byteLength(p) + 17).toBeLessThan(104); // OpenSSH appends a temp suffix while binding
  });
});

describe('ssh -G and ~/.ssh/config', () => {
  const G = ['user dev', 'hostname 10.1.2.3', 'port 2222', 'userknownhostsfile ~/.ssh/known_hosts ~/.ssh/known_hosts2', 'proxycommand ssh -W %h:%p jump', 'gssapiauthentication yes', 'hostkeyalias none'].join('\n');

  it('parses the effective config', () => {
    const h = parseSshG('devbox', G);
    expect(h).toMatchObject({ alias: 'devbox', user: 'dev', hostname: '10.1.2.3', port: 2222, proxyCommand: 'ssh -W %h:%p jump', gssapi: true, hostKeyAlias: undefined });
    expect(h.userKnownHostsFiles[0]).toBe(path.join(os.homedir(), '.ssh/known_hosts'));
    expect(knownHostsId(h)).toBe('[10.1.2.3]:2222');
    expect(knownHostsId({ ...h, port: 22 })).toBe('10.1.2.3');
  });

  it('lists concrete hosts and follows Include', () => {
    expect(listConfigHosts('Host a b *.corp !x\n  HostName 1.2.3.4\nHost c\nInclude conf.d/*').hosts).toEqual(['a', 'b', 'c']);
    const dir = tmp();
    fs.mkdirSync(path.join(dir, 'conf.d'));
    fs.writeFileSync(path.join(dir, 'config'), `Host top\nInclude ${path.join(dir, 'conf.d')}/*.conf\n`);
    fs.writeFileSync(path.join(dir, 'conf.d', 'a.conf'), 'Host inc-a\n');
    fs.writeFileSync(path.join(dir, 'conf.d', 'b.conf'), 'Host inc-b top\nInclude ' + path.join(dir, 'config') + '\n'); // cycle
    expect(readConfigHosts(path.join(dir, 'config'))).toEqual(['top', 'inc-a', 'inc-b']);
  });

  it('rejects aliases ssh would parse as options', () => {
    expect(validAlias('devbox')).toBe(true);
    expect(validAlias('dev@10.0.0.1')).toBe(true);
    expect(validAlias('-oProxyCommand=touch /tmp/x')).toBe(false);
    expect(validAlias('a b')).toBe(false);
    expect(validAlias('')).toBe(false);
  });
});

describe('ssh error classification', () => {
  const cases: Array<[string, string, number | null]> = [
    ['host_key_unknown', 'Host key verification failed.\n', 255],
    ['host_key_unknown', 'No ED25519 host key is known for [127.0.0.1]:22022 and you have requested strict checking.\nHost key verification failed.\n', 255],
    ['host_key_changed', '@@@@@@@@@@@\n@    WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!     @\n@@@@@@@@@@@\nThe fingerprint for the ED25519 key sent by the remote host is\nSHA256:abc.\nOffending ECDSA key in /Users/x/.ssh/known_hosts:12\nHost key verification failed.\n', 255],
    ['kerberos', 'debug1: Unspecified GSS failure.  Minor code may provide more information\nNo Kerberos credentials available (default cache: API:1234)\n\ndev@box: Permission denied (gssapi-with-mic).\n', 255],
    ['kerberos', 'dev@box: Permission denied (gssapi-with-mic,gssapi-keyex).\n', 255],
    ['auth', 'dev@box: Permission denied (publickey,gssapi-with-mic).\n', 255],
    ['auth', 'dev@127.0.0.1: Permission denied (publickey).\n', 255],
    ['dns', 'ssh: Could not resolve hostname nope: nodename nor servname provided, or not known\n', 255],
    ['timeout', 'ssh: connect to host 10.0.0.1 port 22: Operation timed out\n', 255],
    ['refused', 'ssh: connect to host 127.0.0.1 port 2: Connection refused\n', 255],
    ['proxy', 'kex_exchange_identification: Connection closed by remote host\nConnection closed by UNKNOWN port 65535\n', 255],
    ['forward_prohibited', 'channel 3: open failed: administratively prohibited: open failed\n', null],
    ['port_in_use', 'mux_client_forward: forwarding request failed: Port forwarding failed\n', 255],
    ['max_sessions', 'mux_client_request_session: session request failed: Session open refused by peer\n', 255],
    ['no_space', 'cat: write error: No space left on device\n', 1],
    ['remote_command_missing', 'sh: 1: /home/u/.kifu/remote/versions/x/bin/kifu-server: not found\n', 127],
    ['unknown', 'something odd\n', 3],
  ];
  it.each(cases)('%s', (kind, stderr, code) => {
    expect(classifySshError(stderr, code).kind).toBe(kind);
  });

  it('ignores control-socket noise and hides debug lines from details', () => {
    const info = classifySshError('Control socket connect(/x/cm/abc): No such file or directory\ndebug1: Reading configuration data\nssh: connect to host h port 22: Connection refused\n', 255);
    expect(info.kind).toBe('refused');
    expect(info.retryable).toBe(true);
    expect(info.detail).not.toContain('debug1');
  });

  it('marks auth and host-key failures as not retryable', () => {
    expect(classifySshError('Host key verification failed.', 255).retryable).toBe(false);
    expect(classifySshError('x@y: Permission denied (publickey).', 255).retryable).toBe(false);
  });
});

describe('host keys', () => {
  it('reads the probed fingerprint from DEBUG1 output', () => {
    const out = 'debug1: Connecting to 127.0.0.1 [127.0.0.1] port 22022.\ndebug1: Server host key: ssh-ed25519 SHA256:JW6niZ6bSCvb+j59XaQUaFx3EXbMgPDyf4ptnojtszQ\nNo ED25519 host key is known for [127.0.0.1]:22022\n';
    expect(parseServerHostKey(out)).toEqual({ keyType: 'ssh-ed25519', fingerprint: 'SHA256:JW6niZ6bSCvb+j59XaQUaFx3EXbMgPDyf4ptnojtszQ' });
    expect(parseServerHostKey('nothing here')).toBeUndefined();
  });

  it('computes fingerprints like ssh-keygen -l', () => {
    // throwaway test keys; fingerprints taken from `ssh-keygen -lf`
    expect(knownHostsLineFingerprint('[127.0.0.1]:22022 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIL47gFrXkGDn+htXO+Xnik/+CiDGsbJRkfhi2xnVEK1b')).toBe('SHA256:JW6niZ6bSCvb+j59XaQUaFx3EXbMgPDyf4ptnojtszQ');
    expect(
      knownHostsLineFingerprint(
        '|1|salt=|hash= ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTYAAABBBGCKLIAoFv3kSJm5rEDcHZpHojuo75MHmIk6Sy1PfoScumYQvhNfsFLfEQmu5HGgJJpW0AKi0PtQVxO8tNKYoRE= comment',
      ),
    ).toBe('SHA256:tNkaBk3SMQV7W10fu5z6bC9OOxGkpaSeZOER43vpWoU');
    expect(knownHostsLineFingerprint('@cert-authority *.corp ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIL47gFrXkGDn+htXO+Xnik/+CiDGsbJRkfhi2xnVEK1b')).toBe('SHA256:JW6niZ6bSCvb+j59XaQUaFx3EXbMgPDyf4ptnojtszQ');
    expect(knownHostsLineFingerprint('garbage')).toBeUndefined();
  });

  it('parses the changed-key banner', () => {
    const stderr = 'The fingerprint for the ED25519 key sent by the remote host is\nSHA256:newfp+/AA.\nPlease contact your system administrator.\nOffending ECDSA key in /Users/x/.ssh/known_hosts:12\n';
    expect(parseChangedHostKey(stderr)).toEqual({ keyType: 'ED25519', fingerprint: 'SHA256:newfp+/AA', offending: '/Users/x/.ssh/known_hosts:12' });
  });
});

describe('remote platform probe', () => {
  const out = (lines: string[]) => ['motd noise from .bashrc', 'KIFU_PROBE_BEGIN', ...lines, 'KIFU_PROBE_END'].join('\n');

  it('parses a glibc Linux host', () => {
    const p = parseProbe(
      out(['uname=Linux x86_64', 'libc=ldd (Ubuntu GLIBC 2.35-0ubuntu3.8) 2.35', 'home=/home/dev', 'user=dev', 'uid=1000', 'shell=/bin/zsh', 'base=/home/dev/.kifu', 'installed=0.1.0-a', 'installed=0.1.0-b', 'lpath=/home/dev/.local/bin:/usr/bin', 'lcodexhome=', 'lclaudedir=']),
    );
    expect(p).toMatchObject({ target: 'linux-x64', libc: 'glibc', glibcVersion: '2.35', home: '/home/dev', installed: ['0.1.0-a', '0.1.0-b'], loginPath: '/home/dev/.local/bin:/usr/bin', loginCodexHome: undefined, unsupported: undefined });
    expect(loginEnv(p)).toEqual([]);
  });

  it('passes the login shell’s agent home variables on (the $CODEX_HOME, $CLAUDE_CONFIG_DIR scan directories)', () => {
    const p = parseProbe(out(['uname=Linux x86_64', 'lcodexhome=/data/codex home', 'lclaudedir=/data/claude']));
    expect(p).toMatchObject({ loginCodexHome: '/data/codex home', loginClaudeConfigDir: '/data/claude' });
    expect(loginEnv(p)).toEqual(["CODEX_HOME='/data/codex home'", 'export CODEX_HOME', 'CLAUDE_CONFIG_DIR=/data/claude', 'export CLAUDE_CONFIG_DIR']);
  });

  it('flags musl, old glibc and unknown platforms', () => {
    expect(parseProbe(out(['uname=Linux x86_64', 'libc=musl libc (x86_64)'])).unsupported).toMatch(/musl/);
    expect(parseProbe(out(['uname=Linux aarch64', 'libc=ldd (GNU libc) 2.12'])).unsupported).toMatch(/2\.12/);
    expect(parseProbe(out(['uname=FreeBSD amd64', 'libc='])).unsupported).toMatch(/FreeBSD/);
    expect(parseProbe(out(['uname=Darwin arm64', 'libc=sh: ldd: command not found'])).target).toBe('darwin-arm64');
    expect(() => parseProbe('no markers')).toThrow();
  });

  it('maps uname to build targets', () => {
    expect(targetFor('Linux aarch64')).toBe('linux-arm64');
    expect(targetFor('Linux x86_64')).toBe('linux-x64');
    expect(targetFor('Darwin x86_64')).toBeUndefined();
  });

  it('runs as a single /bin/sh line', async () => {
    // SHELL that is not a known POSIX shell: skip the login-shell PATH lookup (keeps the test hermetic)
    const out = await sh(shCommand(probeCommand('/nonexistent/kifu-base')), { ...process.env, SHELL: '/nonexistent/fish' });
    const p = parseProbe(out);
    expect(p.base).toBe('/nonexistent/kifu-base');
    expect(p.installed).toEqual([]);
    expect(p.uname).toBe((await sh('uname -sm')).trim());
    expect(p.loginPath).toBeUndefined();
  });

  it('reads PATH and the agent homes from a POSIX login shell, whole', async () => {
    // a throwaway HOME: only the system profile runs
    const out = await sh(shCommand(probeCommand('/nonexistent/kifu-base')), { HOME: tmp(), PATH: '/usr/bin:/bin', SHELL: '/bin/sh', CODEX_HOME: '/x/codex home', CLAUDE_CONFIG_DIR: '/x/claude' });
    const p = parseProbe(out);
    expect(p.loginPath).toMatch(/^\/.*\/usr\/bin/);
    expect(p).toMatchObject({ loginCodexHome: '/x/codex home', loginClaudeConfigDir: '/x/claude' });
  });
});

describe('install decisions', () => {
  const pkg: LocalPackage = {
    target: 'linux-x64',
    tarball: '/x.tar.gz',
    size: 10,
    tarSha256: 'a'.repeat(64),
    manifest: { name: 'kifu-server', version: '0.1.0', buildId: '0.1.0-new', protocol: 1, target: 'linux-x64', sha256: 'b'.repeat(64), builtAt: '' },
  };
  const platform = parseProbe('KIFU_PROBE_BEGIN\nuname=Linux x86_64\nlibc=ldd (GNU libc) 2.31\ninstalled=0.1.0-old\nKIFU_PROBE_END');

  it('reuses, installs, or refuses', () => {
    expect(decideInstall(platform, pkg)).toEqual({ action: 'install', buildId: '0.1.0-new' });
    expect(decideInstall({ ...platform, installed: ['0.1.0-new'] }, pkg)).toEqual({ action: 'reuse', buildId: '0.1.0-new' });
    expect(decideInstall(platform, undefined)).toEqual({ action: 'missing-package', target: 'linux-x64' });
    expect(decideInstall({ ...platform, unsupported: 'musl' }, pkg).action).toBe('unsupported');
  });

  it('remote scripts are csh/fish safe: one line, no ! and no backslashes', async () => {
    const host = new SshHost({ alias: 'devbox', log: () => {} });
    host.platform = parseProbe('KIFU_PROBE_BEGIN\nuname=Linux x86_64\nlibc=ldd (GNU libc) 2.31\nlpath=/usr/bin:/bin\nlcodexhome=/data/codex\nKIFU_PROBE_END');
    host.buildId = '0.1.0-new';
    const scripts = [
      installCommand(pkg),
      probeCommand(),
      host.launcherScript({ spec: { agent: 'codex', roots: ["/w/it's here", '$CODEX_HOME'] }, name: 'codex-abc', tcp: false }),
      host.launcherScript({ spec: { agent: 'claude' }, name: 'claude-abc', tcp: true }),
      host.stateScript('codex-abc'),
      host.rekeyScript("/run/it's.ctl"),
      host.killScript(1234),
    ];
    for (const s of scripts) {
      // the only backslash allowed is the '\'' escape for values that contain a quote
      expect(s.replaceAll(`'\\''`, '')).not.toMatch(/[\n!\\]/);
      expect(() => shCommand(s)).not.toThrow();
    }
    expect(scripts[0]).toContain(pkg.tarSha256);
    expect(scripts[2]).toContain(`--agent codex --roots '/w/it'\\''s here,$CODEX_HOME'`);
    expect(scripts[2]).toContain('--socket "$s"');
    // the scan directories as the login shell sets them
    expect(scripts[2]).toContain('CODEX_HOME=/data/codex; export CODEX_HOME');
    expect(scripts[3]).toContain('--port 0');
    expect(scripts[3]).toContain('--agent claude');
    // detached, found again by its state file, taken over through its control socket, gone when idle
    expect(scripts[2]).toContain('--token-stdin --control "$c" --state-file "$f"');
    expect(scripts[2]).toContain('--idle-exit 600 --ready');
    expect(scripts[2]).toContain('setsid');
    expect(scripts[2]).not.toContain('--exit-on-stdin-close');
    expect(scripts[4]).toContain('KIFU_ALIVE');
    expect(scripts[5]).toContain(`rekey --control '/run/it'\\''s.ctl'`);
    // and they parse as sh
    const { execFileSync } = await import('node:child_process');
    for (const s of scripts) execFileSync('/bin/sh', ['-n', '-c', s]);
  });

  it('install script rejects a corrupted upload', async () => {
    const base = tmp();
    const bad = { ...pkg, tarSha256: 'f'.repeat(64) };
    const { execFileSync } = await import('node:child_process');
    let out = '';
    try {
      execFileSync('/bin/sh', ['-c', installCommand(bad, base)], { input: 'not a tarball', encoding: 'utf8' });
    } catch (e) {
      out = String((e as { stdout?: string }).stdout ?? '');
      expect((e as { status?: number }).status).toBe(3);
    }
    expect(out).toContain('KIFU_INSTALL_ERROR checksum');
    expect(fs.readdirSync(path.join(base, 'remote', 'versions'))).toEqual([]);
  });

  it('reads the launcher output', () => {
    const ready = `motd\nKIFU_READY {"protocol":3,"agent":"codex","version":"0.1.0","buildId":"b","instanceId":"i1","pid":4242,"socket":"/run/codex-abc.sock","dataDir":"/d"}\n`;
    expect(parseLauncherOutput(ready, '', 0).ready).toMatchObject({ pid: 4242, socket: '/run/codex-abc.sock' });
    expect(parseLauncherOutput("KIFU_START_FAILED\n/lib64/libc.so.6: version `GLIBC_2.18' not found\n", '', 3).error).toMatch(/glibc/);
    expect(parseLauncherOutput('KIFU_START_TIMEOUT\n', '', 4).error).toContain('60 秒');
    expect(parseLauncherOutput('', 'sh: 1: exec: not found\n', 127).error).toMatch(/not found/);
  });

  it('explains install failures', () => {
    expect(parseInstallOutput('KIFU_INSTALL_OK\n', '', 0).ok).toBe(true);
    expect(parseInstallOutput('KIFU_INSTALL_ERROR checksum abc\n', '', 3).error).toMatch(/校验/);
    expect(parseInstallOutput('KIFU_INSTALL_ERROR exec\n/lib64/libc.so.6: version `GLIBC_2.18\' not found\n', '', 4).error).toMatch(/glibc/);
    expect(parseInstallOutput('', 'cat: write error: No space left on device', 1).error).toMatch(/磁盘/);
  });
});

describe('workspaces and sources', () => {
  it('names sources the way the session list shows them', () => {
    expect(sourceLabel('/home/dev/.codex', '/home/dev')).toBe('~/.codex');
    expect(sourceLabel('/data/.claude', '/home/dev')).toBe('/data/.claude');
    expect(sourceLabel('/data/projects/agent-eval/work/.codex', '/home/dev')).toBe('…/work/.codex');
  });

  it('keys workspaces by connection and agent', () => {
    expect(workspaceId('ssh:devbox', 'codex')).toBe('ssh:devbox::codex');
    expect(workspaceId('local', 'claude')).toBe('local::claude');
  });
});

describe('protocol, env, backoff', () => {
  it('parses KIFU_READY lines among other output', () => {
    const line = `banner ${READY_PREFIX}${JSON.stringify({ protocol: 1, version: '0.1.0', buildId: 'b', instanceId: 'i', pid: 1, socket: '/s', dataDir: '/d' })}`;
    expect(parseReadyLine(line)?.socket).toBe('/s');
    expect(parseReadyLine('KIFU_READY {broken')).toBeUndefined();
    expect(parseReadyLine('hello')).toBeUndefined();
  });

  it('decodes environment values without interpreting their lines', () => {
    const snapshot = { PATH: '/a:/b', MULTI: 'one\nTWO=value\n\n', SSH_AUTH_SOCK: '/tmp/agent' };
    expect(decodeEnvironment(Buffer.from(JSON.stringify(snapshot)))).toEqual(snapshot);
    expect(decodeEnvironment(Buffer.from('broken'))).toBeUndefined();
  });

  it('keeps inherited PATH entries the login shell did not add again', () => {
    // started from a terminal that loaded nvm: the login shell's rc skips nvm when NVM_BIN is set
    expect(mergePath('/opt/homebrew/bin:/usr/bin:/bin', '/u/.nvm/versions/node/v22/bin:/usr/bin:/bin')).toBe('/opt/homebrew/bin:/usr/bin:/bin:/u/.nvm/versions/node/v22/bin');
    // started from Finder: launchd's PATH adds nothing new
    expect(mergePath('/opt/homebrew/bin:/usr/bin:/bin', '/usr/bin:/bin:/usr/sbin:/sbin')).toBe('/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin');
    expect(mergePath(undefined, '/usr/bin')).toBe('/usr/bin');
  });

  it('backs off exponentially up to 30s and resets', () => {
    const b = new Backoff(1000, 30_000, () => 0.5); // no jitter
    expect([b.next(), b.next(), b.next(), b.next(), b.next(), b.next(), b.next()]).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000]);
    b.reset();
    expect(b.next()).toBe(1000);
    const j = new Backoff(1000, 30_000, () => 1);
    expect(j.next()).toBe(1200);
  });
});

describe('single instance per store', () => {
  const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'kifu-lock-'));

  it('recognizes our app processes only (builds from before the rename too)', () => {
    expect(looksLikeOurApp('./bun /Users/u/w/desktop/build/dev-macos-arm64/Kifu-dev.app/Contents/MacOS/../Resources/main.js')).toBe(true);
    expect(looksLikeOurApp('/Applications/Kifu.app/Contents/MacOS/launcher')).toBe(true);
    expect(looksLikeOurApp('./bun /Users/u/w/desktop/build/dev-macos-arm64/Trace Monitor-dev.app/Contents/MacOS/../Resources/main.js')).toBe(true);
    expect(looksLikeOurApp('/Applications/Trace Monitor.app/Contents/MacOS/launcher')).toBe(true);
    expect(looksLikeOurApp('/usr/bin/vim connections.json')).toBe(false);
    expect(looksLikeOurApp('/Applications/Kifu Notes.app.bak/launcher')).toBe(false);
  });

  it('takes the store over from a running older instance, leaves other processes alone', async () => {
    const dir = tmpDir();
    const lock = lockFileFor(path.join(dir, 'connections.json'));
    // nothing there yet, or a pid that is gone: just claim
    expect(await claimInstance(lock)).toEqual({});
    fs.writeFileSync(lock, JSON.stringify({ pid: 999_999 }));
    expect(await claimInstance(lock)).toEqual({});
    expect(JSON.parse(fs.readFileSync(lock, 'utf8')).pid).toBe(process.pid);

    // a live process that is not the app (pid reuse): untouched
    const other = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    fs.writeFileSync(lock, JSON.stringify({ pid: other.pid }));
    expect(await claimInstance(lock, 500)).toEqual({});
    expect(other.exitCode).toBeNull();
    other.kill();

    // an older instance of the app: asked to quit (SIGTERM)
    const app = path.join(dir, 'Kifu-test.app', 'Contents', 'MacOS');
    fs.mkdirSync(app, { recursive: true });
    fs.symlinkSync(process.execPath, path.join(app, 'bun'));
    const old = spawn(path.join(app, 'bun'), ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    await new Promise((r) => setTimeout(r, 300));
    fs.writeFileSync(lock, JSON.stringify({ pid: old.pid }));
    const exited = new Promise((r) => old.on('exit', r));
    expect(await claimInstance(lock)).toEqual({ previous: old.pid });
    await exited;
    releaseInstance(lock);
    expect(fs.existsSync(lock)).toBe(false);
  });

  it('ends a build from before the rename on the old store without claiming that store', async () => {
    const dir = tmpDir();
    const lock = lockFileFor(path.join(dir, '.trace-monitor', 'desktop', 'connections.json'));
    const app = path.join(dir, 'Trace Monitor-test.app', 'Contents', 'MacOS');
    fs.mkdirSync(app, { recursive: true });
    fs.mkdirSync(path.dirname(lock), { recursive: true });
    fs.symlinkSync(process.execPath, path.join(app, 'bun'));
    const old = spawn(path.join(app, 'bun'), ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    await new Promise((r) => setTimeout(r, 300));
    fs.writeFileSync(lock, JSON.stringify({ pid: old.pid }));
    const exited = new Promise((r) => old.on('exit', r));
    expect(await endPreviousInstance(lock)).toEqual({ previous: old.pid });
    await exited;
    expect(JSON.parse(fs.readFileSync(lock, 'utf8')).pid).toBe(old.pid);
  });
});

describe('connections: 本机 on demand, agents and scan directories per connection', () => {
  it('scans the enabled agents, each in its own directories (the defaults unless changed)', () => {
    const stored = { id: 'ssh:a', kind: 'ssh' as const, alias: 'a', agents: { codex: { enabled: false }, claude: { roots: ['/data/claude'] } } };
    expect(scanOf(stored)).toEqual({ claude: ['/data/claude'] });
    expect(scanOf({ id: 'local', kind: 'local' })).toEqual({ codex: DEFAULT_SCAN.codex, claude: DEFAULT_SCAN.claude });
    expect(agentScan(stored, 'claude')).toEqual({ enabled: true, roots: ['/data/claude'], custom: true });
    expect(agentScan(stored, 'codex')).toEqual({ enabled: false, roots: DEFAULT_SCAN.codex, custom: false });
    expect(discoverArgs(scanOf(stored))).toEqual(['discover', '--claude-roots', '/data/claude']);
    expect(discoverArgs(DEFAULT_SCAN)).toEqual(['discover', '--codex-roots', DEFAULT_SCAN.codex.join(','), '--claude-roots', DEFAULT_SCAN.claude.join(',')]);
    expect(agentArgs({ agent: 'codex' })).toEqual(['--agent', 'codex', '--roots', '~/.codex,$CODEX_HOME']);
    expect(agentArgs({ agent: 'claude', roots: ['/data/claude'] })).toEqual(['--agent', 'claude', '--roots', '/data/claude']);
    expect(connectionEnabled({ id: 'local', kind: 'local' })).toBe(false);
    expect(connectionEnabled({ id: 'local', kind: 'local', enabled: true })).toBe(true);
    expect(connectionEnabled({ id: 'ssh:a', kind: 'ssh', alias: 'a' })).toBe(true);
  });

  it('a fresh install starts with 本机 off, an older store keeps it on; settings are saved', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kifu-conn-'));
    const saved = { store: process.env.KIFU_DESKTOP_STORE, home: process.env.HOME };
    // a made-up home: logs and ~/.ssh/config stay out of the test
    process.env.HOME = dir;
    process.env.KIFU_DESKTOP_STORE = path.join(dir, 'connections.json');
    const hooks = { onChange() {}, onRestarted() {}, onToast() {} };
    try {
      const fresh = new ConnectionManager(hooks);
      const local = () => fresh.view().connections.find((c) => c.id === 'local')!;
      expect(local()).toMatchObject({ enabled: false, agents: [] });
      expect(local().scan.map((a) => [a.agent, a.enabled, a.custom])).toEqual([
        ['codex', true, false],
        ['claude', true, false],
      ]);
      expect(fresh.view().workspaces).toEqual([]);
      expect(() => fresh.openWorkspace('local', 'codex')).toThrow(/本机还没有启用/);

      fresh.setAgentScan('local', 'claude', { enabled: false });
      fresh.setAgentScan('local', 'codex', { roots: ['/data/codex', ' ', '/data/codex'] });
      expect(local().scan.find((a) => a.agent === 'codex')).toMatchObject({ roots: ['/data/codex'], custom: true });
      fresh.setAgentScan('local', 'codex', { roots: [...DEFAULT_SCAN.codex] }); // the defaults again: not stored
      expect(local().scan.find((a) => a.agent === 'codex')).toMatchObject({ roots: DEFAULT_SCAN.codex, custom: false });
      await new Promise((r) => setTimeout(r, 400)); // debounced save
      const file = JSON.parse(fs.readFileSync(process.env.KIFU_DESKTOP_STORE, 'utf8')) as { connections: unknown[] };
      expect(file.connections[0]).toEqual({ id: 'local', kind: 'local', enabled: false, agents: { claude: { enabled: false } } });

      // a store from before 本机 had a switch (it was on), with custom directories and 本机 tabs
      fs.writeFileSync(process.env.KIFU_DESKTOP_STORE, JSON.stringify({ version: 1, connections: [{ id: 'local', kind: 'local', agents: { codex: { roots: ['/old'] } } }], workspaces: [{ connId: 'local', agent: 'codex' }, { connId: 'local', agent: 'claude' }] }));
      const old = new ConnectionManager(hooks).view();
      expect(old.connections[0]).toMatchObject({ enabled: true });
      expect(old.connections[0].scan[0]).toMatchObject({ agent: 'codex', roots: ['/old'], custom: true });
      expect(old.workspaces.map((w) => w.id)).toEqual(['local::codex', 'local::claude']);
      // an agent that is not scanned has no tab
      fs.writeFileSync(process.env.KIFU_DESKTOP_STORE, JSON.stringify({ version: 1, connections: [{ id: 'local', kind: 'local', enabled: true, agents: { codex: { enabled: false } } }], workspaces: [{ connId: 'local', agent: 'codex' }] }));
      expect(new ConnectionManager(hooks).view().workspaces).toEqual([]);
    } finally {
      if (saved.store === undefined) delete process.env.KIFU_DESKTOP_STORE;
      else process.env.KIFU_DESKTOP_STORE = saved.store;
      process.env.HOME = saved.home;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('a store shared with another build', () => {
  it('writes back what this build does not know, unchanged and after its own entries', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kifu-shared-'));
    const saved = { store: process.env.KIFU_DESKTOP_STORE, home: process.env.HOME };
    process.env.HOME = dir;
    process.env.KIFU_DESKTOP_STORE = path.join(dir, 'connections.json');
    const hooks = { onChange() {}, onRestarted() {}, onToast() {} };
    // made-up entries of another build: a kind of connection and an agent this one does not know
    const future = { id: 'future:1', kind: 'future', name: 'elsewhere', settings: { deep: [1, { two: 2 }] } };
    const theirTabs = [
      { connId: 'local', agent: 'other', route: '/x' },
      { connId: 'future:1', agent: 'codex', route: '/' },
      { connId: 'future:1', agent: 'other' },
    ];
    try {
      fs.writeFileSync(
        process.env.KIFU_DESKTOP_STORE,
        JSON.stringify({
          version: 1,
          connections: [
            { id: 'local', kind: 'local', enabled: true, agents: { other: { roots: ['/o'], extra: true } }, recent: { other: 5, codex: 4 } },
            future,
            { id: 'ssh:box', kind: 'ssh', alias: 'box', agents: { other: { enabled: false } } },
            { id: 'ssh:gone', kind: 'ssh', alias: 'gone' },
          ],
          workspaces: [theirTabs[0], { connId: 'local', agent: 'codex', route: '/s/a' }, theirTabs[1], { connId: 'ssh:gone', agent: 'other' }, theirTabs[2]],
          activeId: 'local::codex',
        }),
      );
      const m = new ConnectionManager(hooks);
      // this build sees only its own
      expect(m.view().connections.map((c) => c.id)).toEqual(['local', 'ssh:box', 'ssh:gone']);
      expect(m.view().workspaces.map((w) => w.id)).toEqual(['local::codex']);
      expect(m.view().connections[0].agents.map((a) => a.agent)).toEqual(['codex']);
      // its changes are saved; the rest is written back as it was, after its own entries
      m.setAgentScan('ssh:box', 'claude', { enabled: false });
      m.routeChanged('local::codex', '/s/b');
      await m.removeConnection('ssh:gone'); // its tabs of another build go with it
      await new Promise((r) => setTimeout(r, 400)); // debounced save
      const file = JSON.parse(fs.readFileSync(process.env.KIFU_DESKTOP_STORE, 'utf8')) as { connections: unknown[]; workspaces: unknown[]; activeId: string };
      expect(file.connections).toEqual([
        { id: 'local', kind: 'local', enabled: true, agents: { other: { roots: ['/o'], extra: true } }, recent: { other: 5, codex: 4 } },
        { id: 'ssh:box', kind: 'ssh', alias: 'box', agents: { other: { enabled: false }, claude: { enabled: false } } },
        future,
      ]);
      expect(file.workspaces).toEqual([{ connId: 'local', agent: 'codex', route: '/s/b' }, ...theirTabs]);
      expect(file.activeId).toBe('local::codex');
      // and the next start reads the same
      const again = new ConnectionManager(hooks).view();
      expect(again.connections.map((c) => c.id)).toEqual(['local', 'ssh:box']);
      expect(again.workspaces.map((w) => [w.id, w.route])).toEqual([['local::codex', '/s/b']]);
    } finally {
      if (saved.store === undefined) delete process.env.KIFU_DESKTOP_STORE;
      else process.env.KIFU_DESKTOP_STORE = saved.store;
      process.env.HOME = saved.home;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

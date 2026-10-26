import type { SshOptions } from '../../shared/ssh';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { probeArgs, recordKeyArgs } from './args';
import { sshError } from './errors';
import { run } from './proc';
import { knownHostsId, type ResolvedHost } from './resolve';

/**
 * Host key confirmation without ssh-keyscan (which ignores ProxyCommand):
 * probe the fingerprint through ssh, let the user compare it, then let ssh
 * record the key into a temp file and append that line to the user's
 * known_hosts only if it matches what the user confirmed.
 */

export interface HostKeyProbe {
  keyType: string;
  fingerprint: string;
}

export interface HostKeyPrompt extends HostKeyProbe {
  kind: 'unknown' | 'changed';
  /** Name known_hosts uses for this host, e.g. devbox or [1.2.3.4]:2222. */
  hostId: string;
  knownHostsFile: string;
  /** For changed keys: where the old key is recorded. */
  offending?: string;
}

/** `debug1: Server host key: ssh-ed25519 SHA256:…` */
export function parseServerHostKey(debugOutput: string): HostKeyProbe | undefined {
  const m = /Server host key: (\S+) (SHA256:[A-Za-z0-9+/]+=*)/.exec(debugOutput);
  return m ? { keyType: m[1], fingerprint: m[2] } : undefined;
}

/** From the "REMOTE HOST IDENTIFICATION HAS CHANGED" banner. */
export function parseChangedHostKey(stderr: string): { fingerprint?: string; keyType?: string; offending?: string } {
  const fp = /fingerprint for the (\S+) key sent by the remote host is\s*\n?\s*(SHA256:[A-Za-z0-9+/]+=*)/i.exec(stderr);
  const off = /Offending \S+ key in (\S+?):(\d+)/.exec(stderr);
  return { keyType: fp?.[1], fingerprint: fp?.[2], offending: off ? `${off[1]}:${off[2]}` : undefined };
}

/** SHA256 fingerprint of a known_hosts line (`host keytype base64 [comment]`, optional @marker). */
export function knownHostsLineFingerprint(line: string): string | undefined {
  const parts = line.trim().split(/\s+/);
  if (parts[0]?.startsWith('@')) parts.shift();
  const b64 = parts[2];
  if (!b64 || !/^[A-Za-z0-9+/]+=*$/.test(b64)) return undefined;
  const digest = createHash('sha256').update(Buffer.from(b64, 'base64')).digest('base64');
  return `SHA256:${digest.replace(/=+$/, '')}`;
}

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kifu-hostkey-'));
}

export async function probeHostKey(sshBin: string, alias: string, options?: SshOptions): Promise<HostKeyProbe> {
  const dir = tempDir();
  try {
    const empty = path.join(dir, 'known_hosts');
    fs.writeFileSync(empty, '', { mode: 0o600 });
    const r = await run(sshBin, probeArgs(alias, empty, options), { timeoutMs: 45_000 });
    const key = parseServerHostKey(r.stderr);
    if (!key) throw sshError('unknown', '无法获取远端主机指纹', r.stderr.split('\n').filter((l) => !l.startsWith('debug1:')).slice(-8).join('\n'), true);
    return key;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

export function promptFor(host: ResolvedHost, probe: HostKeyProbe, changed?: { offending?: string }): HostKeyPrompt {
  return {
    ...probe,
    kind: changed ? 'changed' : 'unknown',
    hostId: knownHostsId(host),
    knownHostsFile: host.userKnownHostsFiles[0] ?? path.join(os.homedir(), '.ssh', 'known_hosts'),
    offending: changed?.offending,
  };
}

/**
 * Record the key the user confirmed. Refuses if the key ssh sees now differs
 * from `expected` (it changed between probe and confirmation).
 */
export async function acceptHostKey(sshBin: string, alias: string, prompt: HostKeyPrompt, backupDir: string, options?: SshOptions): Promise<void> {
  const target = prompt.knownHostsFile;
  if (target === '/dev/null') throw sshError('host_key_unknown', 'known_hosts 被配置为 /dev/null，无法记录指纹；请在 ~/.ssh/config 中调整 UserKnownHostsFile');
  const dir = tempDir();
  try {
    const temp = path.join(dir, 'known_hosts');
    fs.writeFileSync(temp, '', { mode: 0o600 });
    await run(sshBin, recordKeyArgs(alias, temp, options), { timeoutMs: 45_000 });
    const lines = fs.readFileSync(temp, 'utf8').split('\n').filter((l) => l.trim() && !l.startsWith('#'));
    const match = lines.filter((l) => knownHostsLineFingerprint(l) === prompt.fingerprint);
    if (!match.length) throw sshError('host_key_changed', '远端返回的指纹和刚才确认的不一致，已取消（可能存在中间人攻击）');

    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    if (fs.existsSync(target)) {
      fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
      fs.copyFileSync(target, path.join(backupDir, `known_hosts-${Date.now()}`));
      if (prompt.kind === 'changed') {
        const r = await run('ssh-keygen', ['-R', prompt.hostId, '-f', target], { timeoutMs: 15_000 });
        if (r.code !== 0) throw sshError('host_key_changed', `删除旧指纹失败：${r.stderr.trim()}`);
      }
    }
    const existing = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : '';
    const prefix = existing && !existing.endsWith('\n') ? '\n' : '';
    fs.appendFileSync(target, `${prefix}${match.join('\n')}\n`, { mode: 0o600 });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

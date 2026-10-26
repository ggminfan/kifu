import os from 'node:os';
import path from 'node:path';
import type { SshOptions } from '../../shared/ssh';
import { createHash } from 'node:crypto';

/**
 * Argument builders for the system `ssh` binary. We never parse ~/.ssh/config
 * ourselves: the Host alias is passed through so OpenSSH applies ProxyCommand,
 * GSSAPI, IdentityFile, agent and StrictHostKeyChecking settings exactly as in
 * the user's terminal. All sessions to a host share one ControlMaster.
 */

export interface SshContext {
  sshBin: string;
  alias: string;
  /** ControlMaster socket owned by this app process. */
  controlPath: string;
  options?: SshOptions;
}

/**
 * Per-process control socket: another app instance (dev + packaged) never
 * shares or tears down our master. Short enough for sun_path once OpenSSH
 * appends its 17-byte temp suffix.
 */
export function controlPathFor(controlDir: string, alias: string, pid = process.pid): string {
  return `${controlDir}/${createHash('sha256').update(alias).digest('hex').slice(0, 12)}-${pid}`;
}

export const KEEPALIVE = ['-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=2', '-o', 'ConnectTimeout=20'];

/** Never let the user's config inject commands, ttys, forwards or agent/X11 forwarding into our connections. */
const SAFE = ['-o', 'RemoteCommand=none', '-o', 'RequestTTY=no', '-o', 'ForwardAgent=no', '-o', 'ForwardX11=no', '-o', 'PermitLocalCommand=no'];

/** Printed by the master's own session once authentication finished and the mux socket listens. */
export const MASTER_READY = 'KIFU_MASTER_READY';

/**
 * The master's session prints the marker and then waits for stdin EOF. When
 * the app dies, stdin closes, this session ends, and OpenSSH keeps the master
 * only until the last multiplexed session is gone: no orphaned connections.
 */
export const MASTER_COMMAND = `exec /bin/sh -c 'echo ${MASTER_READY}; exec cat >/dev/null'`;


export function connectionArgs(options?: SshOptions): string[] {
  if (!options) return [];
  const file = options.identityFile?.startsWith('~/') ? path.join(os.homedir(), options.identityFile.slice(2)) : options.identityFile;
  return [
    ...(options.port ? ['-p', String(options.port)] : []),
    ...(options.user ? ['-l', options.user] : []),
    ...(options.authentication === 'identity' && file ? ['-i', file, '-o', 'IdentitiesOnly=yes'] : []),
    '-o', 'StrictHostKeyChecking=yes',
  ];
}
function authenticationArgs(options?: SshOptions): string[] {
  if (options?.authentication === 'password') return ['-o', 'PreferredAuthentications=password,keyboard-interactive', '-o', 'PubkeyAuthentication=no', '-o', 'GSSAPIAuthentication=no', '-o', 'PasswordAuthentication=yes', '-o', 'KbdInteractiveAuthentication=yes', '-o', 'NumberOfPasswordPrompts=1'];
  if (options?.authentication === 'identity') return ['-o', 'PreferredAuthentications=publickey', '-o', 'PasswordAuthentication=no', '-o', 'KbdInteractiveAuthentication=no'];
  return [];
}

export function masterArgs(ctx: SshContext, interactive = false): string[] {
  return [
    '-M',
    '-S', ctx.controlPath,
    '-o', 'ControlPersist=no',
    '-o', interactive ? 'BatchMode=no' : 'BatchMode=yes',
    ...authenticationArgs(ctx.options),
    ...connectionArgs(ctx.options),
    ...KEEPALIVE,
    '-o', 'ClearAllForwardings=yes',
    ...SAFE,
    '-T',
    ctx.alias,
    MASTER_COMMAND,
  ];
}

/** Run a command over the master connection. */
export function execArgs(ctx: SshContext, remoteCommand: string): string[] {
  return ['-S', ctx.controlPath, '-o', 'ControlMaster=no', '-o', 'BatchMode=yes', ...SAFE, ...authenticationArgs(ctx.options), ...connectionArgs(ctx.options), '-T', ctx.alias, remoteCommand];
}

export function controlArgs(ctx: SshContext, op: 'check' | 'exit' | 'forward' | 'cancel', forward?: string): string[] {
  return ['-S', ctx.controlPath, '-O', op, ...(forward ? ['-L', forward] : []), ...connectionArgs(ctx.options), ctx.alias];
}

export function resolveArgs(alias: string, options?: SshOptions): string[] {
  return ['-G', ...connectionArgs(options), alias];
}

const ISOLATED = ['-o', 'ControlPath=none', '-o', 'ControlMaster=no', '-o', 'GlobalKnownHostsFile=/dev/null'];

/**
 * Fingerprint probe through ssh itself (works with ProxyCommand, unlike
 * ssh-keyscan): with an empty known_hosts and strict checking, ssh logs the
 * server key at DEBUG1 and stops before authenticating.
 */
export function probeArgs(alias: string, emptyKnownHosts: string, options?: SshOptions): string[] {
  return [
    '-o', 'BatchMode=yes',
    '-o', 'StrictHostKeyChecking=yes',
    '-o', `UserKnownHostsFile=${emptyKnownHosts}`,
    '-o', 'LogLevel=DEBUG1',
    ...ISOLATED,
    ...KEEPALIVE,
    ...SAFE,
    ...connectionArgs(options),
    '-T', alias, 'true',
  ];
}

/**
 * Let ssh write the host key line itself (accept-new into a temp file, same
 * host naming and hashing as the user's config) while offering no
 * authentication method at all, so nothing is sent to the server.
 */
export function recordKeyArgs(alias: string, tempKnownHosts: string, options?: SshOptions): string[] {
  return [
    '-o', 'BatchMode=yes',
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', `UserKnownHostsFile=${tempKnownHosts}`,
    '-o', 'PubkeyAuthentication=no',
    '-o', 'PasswordAuthentication=no',
    '-o', 'KbdInteractiveAuthentication=no',
    '-o', 'GSSAPIAuthentication=no',
    '-o', 'HostbasedAuthentication=no',
    ...ISOLATED,
    ...KEEPALIVE,
    ...SAFE,
    ...connectionArgs(options),
    '-T', alias, 'true',
  ];
}

/** POSIX single-quote a string for a remote /bin/sh command line. */
export function shQuote(s: string): string {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(s)) return s;
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * `exec /bin/sh -c '<script>'`: independent of the remote login shell. The
 * script must be a single line without `!` so csh-family shells accept it.
 */
export function shCommand(script: string): string {
  if (script.includes('\n')) throw new Error('remote scripts must be a single line');
  return `exec /bin/sh -c ${shQuote(script)}`;
}

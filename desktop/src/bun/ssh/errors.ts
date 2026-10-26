/**
 * Turn ssh stderr into an actionable, user-facing explanation.
 * Order matters: host-key problems first (they also say "verification failed"),
 * then Kerberos (also an auth failure), then generic auth, network, remote.
 */

export type SshErrorKind =
  | 'host_key_unknown'
  | 'host_key_changed'
  | 'kerberos'
  | 'auth'
  | 'dns'
  | 'timeout'
  | 'refused'
  | 'proxy'
  | 'forward_prohibited'
  | 'port_in_use'
  | 'max_sessions'
  | 'no_space'
  | 'remote_command_missing'
  | 'unknown';

export interface SshErrorInfo {
  kind: SshErrorKind;
  message: string;
  /** Retrying automatically makes sense (network blips), not for auth / host-key problems. */
  retryable: boolean;
  detail: string;
}

const RULES: Array<{ kind: SshErrorKind; re: RegExp; message: string; retryable: boolean }> = [
  { kind: 'host_key_changed', re: /REMOTE HOST IDENTIFICATION HAS CHANGED|Host key for .* has changed/i, message: '远端主机指纹和 known_hosts 中记录的不一致，需要确认后才能继续', retryable: false },
  { kind: 'host_key_unknown', re: /No \S+ host key is known for|Host key verification failed|host key is not known/i, message: '第一次连接这台主机，需要先确认主机指纹', retryable: false },
  { kind: 'kerberos', re: /No Kerberos credentials|Ticket expired|Credentials cache .* not found|Unspecified GSS failure|GSS(API)? (failure|error)|krb5|Permission denied \((gssapi-[a-z-]+,?)+\)/i, message: 'Kerberos 票据不可用或已过期，请先在终端执行 kinit 后重试', retryable: false },
  { kind: 'auth', re: /Permission denied \(|Too many authentication failures|Authentication failed|no more authentication methods/i, message: 'SSH 认证失败：请检查用户名、密码、身份文件或 ssh-agent / Kerberos 凭证', retryable: false },
  { kind: 'dns', re: /Could not resolve hostname|Name or service not known|nodename nor servname/i, message: '无法解析主机名，请检查网络或 ~/.ssh/config 中的 HostName', retryable: true },
  { kind: 'timeout', re: /Connection timed out|Operation timed out|timed out during banner exchange|Connection to .* timed out/i, message: '连接超时，请检查网络 / VPN / 跳板机', retryable: true },
  { kind: 'refused', re: /Connection refused/i, message: '连接被拒绝：sshd 没有运行或端口不对', retryable: true },
  { kind: 'proxy', re: /kex_exchange_identification|Connection closed by UNKNOWN|ProxyCommand|proxy dialer|Connection reset by peer|Broken pipe/i, message: '连接在握手阶段被关闭：可能是跳板机 / ProxyCommand 失败', retryable: true },
  { kind: 'forward_prohibited', re: /administratively prohibited/i, message: '远端 sshd 禁止这种端口转发', retryable: false },
  { kind: 'port_in_use', re: /Address already in use|cannot listen to port|Port forwarding failed/i, message: '本地端口被占用，换一个端口重试', retryable: true },
  { kind: 'max_sessions', re: /Session open refused by peer/i, message: '远端 sshd 拒绝了新会话（MaxSessions 上限），请先关闭一些窗口', retryable: true },
  { kind: 'no_space', re: /No space left on device|Disk quota exceeded/i, message: '远端磁盘空间不足', retryable: false },
  { kind: 'remote_command_missing', re: /: command not found|: not found\s*$|No such file or directory\s*$/im, message: '远端缺少需要的命令或文件', retryable: false },
];

/** Noise that would otherwise match the rules above. */
const IGNORE = /^(Control socket connect\(|Warning: Permanently added)/;

export function classifySshError(stderr: string, exitCode?: number | null): SshErrorInfo {
  // debug lines still count for matching (OpenSSH reports GSSAPI details only at DEBUG) but not for display
  const lines = stderr.split('\n').filter((l) => l.trim() && !IGNORE.test(l));
  const text = lines.join('\n');
  const detail = lines
    .filter((l) => !/^debug\d: /.test(l))
    .slice(-12)
    .join('\n')
    .slice(0, 1200);
  for (const r of RULES) {
    if (r.re.test(text)) return { kind: r.kind, message: r.message, retryable: r.retryable, detail };
  }
  if (exitCode === 127) return { kind: 'remote_command_missing', message: '远端缺少需要的命令', retryable: false, detail };
  return { kind: 'unknown', message: `ssh 失败（退出码 ${exitCode ?? '?'}）`, retryable: true, detail };
}

export class SshError extends Error {
  constructor(readonly info: SshErrorInfo) {
    super(info.message);
  }
}

export function sshError(kind: SshErrorKind, message: string, detail = '', retryable = false): SshError {
  return new SshError({ kind, message, detail, retryable });
}

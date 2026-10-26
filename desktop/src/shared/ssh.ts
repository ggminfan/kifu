/** Persistable connection preferences. Credentials are deliberately separate. */
export interface SshOptions {
  port?: number;
  user?: string;
  authentication?: 'auto' | 'identity' | 'password';
  identityFile?: string;
}
export interface AddSshInput extends SshOptions {
  alias: string;
  label?: string;
  /** Password or identity-file passphrase, held in memory only. */
  secret?: string;
}

export function validateSecret(secret: unknown): string | undefined {
  if (secret === undefined || secret === '') return undefined;
  if (typeof secret !== 'string' || secret.length > 4096 || /[\r\n\0]/.test(secret)) throw new Error('密码或口令不能包含换行，且不能超过 4096 个字符');
  return secret;
}

export function normalizeSshInput(input: AddSshInput): { alias: string; label: string; options: SshOptions; secret?: string } {
  let alias = typeof input.alias === 'string' ? input.alias.trim() : '';
  if (!/^[A-Za-z0-9_\[:][A-Za-z0-9_.@%:+\[\]-]*$/.test(alias) || alias.length > 255 || alias.split('@').length > 2) throw new Error('请输入有效的主机名、IP 地址或 SSH 别名');
  const at = alias.indexOf('@');
  const login = at < 0 ? undefined : alias.slice(0, at);
  let hostname = at < 0 ? alias : alias.slice(at + 1);
  if (login && !/^[A-Za-z0-9_][A-Za-z0-9_.-]*\$?$/.test(login)) throw new Error('请输入有效的主机名、IP 地址或 SSH 别名');
  if (hostname.startsWith('[') && hostname.endsWith(']')) hostname = hostname.slice(1, -1);
  if (hostname.includes(':')) {
    try { new URL(`http://[${hostname.split('%')[0]}]/`); } catch { throw new Error('请输入有效的主机名、IP 地址或 SSH 别名'); }
  } else if (!/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(hostname)) throw new Error('请输入有效的主机名、IP 地址或 SSH 别名');
  alias = login ? `${login}@${hostname}` : hostname;
  const user = input.user?.trim() || undefined;
  if (user && (!/^[A-Za-z0-9_][A-Za-z0-9_.-]*\$?$/.test(user) || alias.includes('@'))) throw new Error('用户名无效，或已在主机名中指定');
  if (input.port !== undefined && (!Number.isInteger(input.port) || input.port < 1 || input.port > 65535)) throw new Error('SSH 端口必须是 1 到 65535 的整数');
  const authentication = input.authentication ?? 'auto';
  if (!['auto', 'identity', 'password'].includes(authentication)) throw new Error('请选择有效的认证方式');
  const identityFile = input.identityFile?.trim();
  if (authentication === 'identity' && (!identityFile || !/^(\/|~\/)/.test(identityFile) || /[\r\n\0]/.test(identityFile))) throw new Error('请选择或填写身份文件的绝对路径');
  const label = input.label?.trim() || alias;
  if (label.length > 100 || /[\r\n\0]/.test(label)) throw new Error('显示名称不能超过 100 个字符或包含换行');
  return { alias, label, options: { port: input.port, user, authentication, ...(authentication === 'identity' ? { identityFile } : {}) }, secret: authentication === 'auto' ? undefined : validateSecret(input.secret) };
}

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** What `ssh -G <alias>` says about a destination. */
export interface ResolvedHost {
  alias: string;
  hostname: string;
  user?: string;
  port: number;
  hostKeyAlias?: string;
  userKnownHostsFiles: string[];
  proxyCommand?: string;
  proxyJump?: string;
  gssapi: boolean;
}

function expandHome(p: string): string {
  return p === '~' ? os.homedir() : p.startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : p;
}

export function parseSshG(alias: string, output: string): ResolvedHost {
  const kv = new Map<string, string>();
  for (const line of output.split('\n')) {
    const i = line.indexOf(' ');
    if (i <= 0) continue;
    const key = line.slice(0, i).toLowerCase();
    if (!kv.has(key)) kv.set(key, line.slice(i + 1).trim());
  }
  const none = (v: string | undefined) => (v && v !== 'none' ? v : undefined);
  return {
    alias,
    hostname: kv.get('hostname') ?? alias,
    user: kv.get('user'),
    port: Number(kv.get('port') ?? 22),
    hostKeyAlias: none(kv.get('hostkeyalias')),
    userKnownHostsFiles: (kv.get('userknownhostsfile') ?? '~/.ssh/known_hosts ~/.ssh/known_hosts2').split(/\s+/).filter(Boolean).map(expandHome),
    proxyCommand: none(kv.get('proxycommand')),
    proxyJump: none(kv.get('proxyjump')),
    gssapi: kv.get('gssapiauthentication') === 'yes',
  };
}

/** The name known_hosts uses for this destination ([host]:port when not 22). */
export function knownHostsId(h: ResolvedHost): string {
  const name = h.hostKeyAlias ?? h.hostname;
  return h.port === 22 || h.hostKeyAlias ? name : `[${name}]:${h.port}`;
}

/** Host aliases in one config file (exact names only, no wildcards) plus its Include patterns. */
export function listConfigHosts(configText: string): { hosts: string[]; includes: string[] } {
  const hosts: string[] = [];
  const includes: string[] = [];
  for (const line of configText.split('\n')) {
    const parts: string[] = [];
    let current = '', quote = '', escaped = false;
    for (const char of line.trim().replace(/^(Host|Include)\s*=\s*/i, '$1 ')) {
      if (escaped) { current += char; escaped = false; continue; }
      if (char === '\\') { escaped = true; continue; }
      if (quote) { if (char === quote) quote = ''; else current += char; continue; }
      if (char === '"' || char === "'") { quote = char; continue; }
      if (char === '#') break;
      if (/\s/.test(char)) { if (current) parts.push(current); current = ''; } else current += char;
    }
    if (current) parts.push(current);
    if (quote || escaped) continue;
    const directive = parts.shift()?.toLowerCase();
    if (directive === 'include') includes.push(...parts);
    if (directive === 'host') for (const host of parts) if (!/[*?!]/.test(host) && validAlias(host) && !hosts.includes(host)) hosts.push(host);
  }
  return { hosts, includes };
}

/** Expand an Include pattern (relative to ~/.ssh, `*`/`?` in the last segment only). */
function expandInclude(pattern: string, sshDir: string): string[] {
  let p = pattern.startsWith('~/') ? path.join(os.homedir(), pattern.slice(2)) : pattern;
  if (!path.isAbsolute(p)) p = path.join(sshDir, p);
  const base = path.basename(p);
  if (!/[*?]/.test(base)) return [p];
  const re = new RegExp(`^${base.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`);
  try {
    return fs
      .readdirSync(path.dirname(p))
      .filter((n) => re.test(n))
      .sort()
      .map((n) => path.join(path.dirname(p), n));
  } catch {
    return [];
  }
}

/** All concrete Host aliases from ~/.ssh/config, following Include. */
export function readConfigHosts(file = path.join(os.homedir(), '.ssh', 'config'), depth = 0, seen = new Set<string>()): string[] {
  if (depth > 5 || seen.has(file)) return [];
  seen.add(file);
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const { hosts, includes } = listConfigHosts(text);
  const out = [...hosts];
  for (const pat of includes) for (const f of expandInclude(pat, path.join(os.homedir(), '.ssh'))) out.push(...readConfigHosts(f, depth + 1, seen));
  return [...new Set(out)];
}

/** Aliases go on the ssh command line: never allow something ssh would parse as an option. */
export function validAlias(alias: string): boolean {
  return /^[A-Za-z0-9_\[:][A-Za-z0-9_.@%:+\[\]-]*$/.test(alias) && alias.length <= 255;
}

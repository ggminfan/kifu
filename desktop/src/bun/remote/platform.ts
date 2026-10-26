import { shQuote } from '../ssh/args';

/**
 * One round trip that tells us everything needed before installing or
 * starting a server: OS/arch/libc, home, installed server builds, and the
 * login shell's PATH and agent home variables (non-interactive ssh sessions
 * usually lack ~/.local/bin and whatever the user's rc files add).
 */

export type Target = 'linux-x64' | 'linux-arm64' | 'darwin-arm64';

export interface RemotePlatform {
  uname: string;
  target?: Target;
  libc: 'glibc' | 'musl' | 'darwin' | 'unknown';
  glibcVersion?: string;
  home: string;
  user: string;
  uid: string;
  shell: string;
  /** Remote data root, normally $HOME/.kifu. */
  base: string;
  installed: string[];
  loginPath?: string;
  loginCodexHome?: string;
  loginClaudeConfigDir?: string;
  /** Why we cannot run a server here (unsupported platform). */
  unsupported?: string;
}

/**
 * Shell fragment that sets `b` to the remote data root. The default one first takes
 * over ~/.trace-monitor from builds before the rename, when there is no ~/.kifu yet.
 */
export function baseAssignment(base?: string): string {
  return base ? `b=${shQuote(base)}` : 'b="$HOME/.kifu"; test -e "$b" || { test -d "$HOME/.trace-monitor" && mv "$HOME/.trace-monitor" "$b"; } || true';
}

/** Exports of the agents' home variables as the login shell sets them (the $CODEX_HOME, $CLAUDE_CONFIG_DIR scan directories). */
export function loginEnv(p: RemotePlatform | undefined): string[] {
  const out: string[] = [];
  const vars: Array<[string, string | undefined]> = [
    ['CODEX_HOME', p?.loginCodexHome],
    ['CLAUDE_CONFIG_DIR', p?.loginClaudeConfigDir],
  ];
  for (const [k, v] of vars) if (v) out.push(`${k}=${shQuote(v)}`, `export ${k}`);
  return out;
}

export function probeCommand(base?: string): string {
  return [
    baseAssignment(base),
    'echo KIFU_PROBE_BEGIN',
    'echo "uname=$(uname -sm 2>/dev/null)"',
    'echo "libc=$( (ldd --version 2>&1 || true) | head -n 1)"',
    'echo "home=$HOME"',
    'echo "user=$(id -un 2>/dev/null)"',
    'echo "uid=$(id -u 2>/dev/null)"',
    'echo "shell=$SHELL"',
    'echo "base=$b"',
    'for d in "$b"/remote/versions/*; do test -f "$d/manifest.json" && echo "installed=${d##*/}"; done',
    't=""',
    'command -v timeout >/dev/null 2>&1 && t="timeout 10"',
    'lp=""',
    'lch=""',
    'lcc=""',
    `case "\${SHELL##*/}" in bash|zsh|ksh|mksh|sh|dash) out=$($t "$SHELL" -ilc 'echo "KIFU_LP=$PATH"; echo "KIFU_LCH=\${CODEX_HOME:-}"; echo "KIFU_LCC=\${CLAUDE_CONFIG_DIR:-}"' </dev/null 2>/dev/null); lp=$(echo "$out" | grep "^KIFU_LP=" | tail -n 1 | cut -c9-); lch=$(echo "$out" | grep "^KIFU_LCH=" | tail -n 1 | cut -c10-); lcc=$(echo "$out" | grep "^KIFU_LCC=" | tail -n 1 | cut -c10-) ;; esac`,
    'echo "lpath=$lp"',
    'echo "lcodexhome=$lch"',
    'echo "lclaudedir=$lcc"',
    'echo KIFU_PROBE_END',
  ].join('; ');
}

export function targetFor(uname: string): Target | undefined {
  const [os, arch] = uname.trim().split(/\s+/);
  if (os === 'Linux' && (arch === 'x86_64' || arch === 'amd64')) return 'linux-x64';
  if (os === 'Linux' && (arch === 'aarch64' || arch === 'arm64')) return 'linux-arm64';
  if (os === 'Darwin' && arch === 'arm64') return 'darwin-arm64';
  return undefined;
}

function versionLess(a: string, b: string): boolean {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x < y;
  }
  return false;
}

/** Bun's Linux builds need glibc >= 2.17. */
export const MIN_GLIBC = '2.17';

export function parseProbe(stdout: string): RemotePlatform {
  const start = stdout.indexOf('KIFU_PROBE_BEGIN');
  const end = stdout.indexOf('KIFU_PROBE_END', start);
  if (start === -1 || end === -1) throw new Error('远端探测输出不完整');
  const kv = new Map<string, string>();
  const installed: string[] = [];
  for (const line of stdout.slice(start, end).split('\n')) {
    const i = line.indexOf('=');
    if (i <= 0) continue;
    const k = line.slice(0, i).trim();
    const v = line.slice(i + 1).trim();
    if (k === 'installed') installed.push(v);
    else kv.set(k, v);
  }
  const uname = kv.get('uname') ?? '';
  const libcLine = kv.get('libc') ?? '';
  const target = targetFor(uname);
  let libc: RemotePlatform['libc'] = 'unknown';
  let glibcVersion: string | undefined;
  if (uname.startsWith('Darwin')) libc = 'darwin';
  else if (/musl/i.test(libcLine)) libc = 'musl';
  else if (/GNU|GLIBC/i.test(libcLine)) {
    libc = 'glibc';
    glibcVersion = /(\d+\.\d+)\s*$/.exec(libcLine)?.[1];
  }
  let unsupported: string | undefined;
  if (!target) unsupported = `暂不支持这个平台：${uname || '未知'}`;
  else if (libc === 'musl') unsupported = '远端是 musl libc（如 Alpine），暂时只提供 glibc 版本的服务端';
  else if (glibcVersion && versionLess(glibcVersion, MIN_GLIBC)) unsupported = `远端 glibc ${glibcVersion} 过低（需要 ≥ ${MIN_GLIBC}）`;
  const opt = (k: string) => kv.get(k) || undefined;
  return {
    uname,
    target,
    libc,
    glibcVersion,
    home: kv.get('home') ?? '',
    user: kv.get('user') ?? '',
    uid: kv.get('uid') ?? '',
    shell: kv.get('shell') ?? '',
    base: kv.get('base') ?? '',
    installed,
    loginPath: opt('lpath'),
    loginCodexHome: opt('lcodexhome'),
    loginClaudeConfigDir: opt('lclaudedir'),
    unsupported,
  };
}

export function describePlatform(p: RemotePlatform): string {
  const libc = p.libc === 'glibc' ? `glibc ${p.glibcVersion ?? '?'}` : p.libc === 'darwin' ? '' : p.libc;
  return [p.uname, libc].filter(Boolean).join(' · ');
}

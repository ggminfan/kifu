import { AGENT_KINDS, isAgentKind } from '../shared/agents';
import { DEFAULT_SCAN, PROTOCOL, type AgentScan } from '../shared/remote-protocol';
import { BUILD_ID, IS_COMPILED, VERSION } from './build-info';
import { discoverAgents } from './discover';
import { readStdinLine } from './runtime/lifecycle';
import { rekeyRunning, serve, ServeError, type ServeOptions } from './serve';

/**
 * kifu-server — the binary the desktop shell runs locally and on SSH remotes.
 *
 *   serve     [--host H] [--port N | --socket PATH] [--token-stdin | --no-auth] [--exit-on-stdin-close]
 *             [--idle-exit SEC] [--agent codex|claude] [--roots a,b,...] [--codex-home P]
 *             [--claude-home P] [--data-dir P] [--web-dir P] [--label TEXT] [--no-index] [--ready]
 *             [--control PATH] [--state-file PATH]
 *               --roots: scan directories for the agent's homes (one workspace over all of them)
 *               --control / --state-file: a detached server the next desktop client takes over
 *   rekey     --control PATH                            the new token on stdin: the running server accepts only it
 *   discover  [--codex-roots a,b] [--claude-roots a,b] [--max-depth N]
 *               only the agents given (none given: all, with their default directories);
 *               prints JSON: { agents: [...] }
 *   version                                             prints JSON
 */

type Flags = Record<string, string | boolean>;

export function parseFlags(argv: string[]): { command: string; flags: Flags } {
  const [command = 'serve', ...rest] = argv;
  const flags: Flags = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (!a.startsWith('--')) continue;
    const eq = a.indexOf('=');
    if (eq !== -1) {
      flags[a.slice(2, eq)] = a.slice(eq + 1);
      continue;
    }
    const key = a.slice(2);
    const next = rest[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      flags[key] = next;
      i++;
    } else {
      flags[key] = true;
    }
  }
  return { command, flags };
}

const str = (v: string | boolean | undefined): string | undefined => (typeof v === 'string' ? v : undefined);
const num = (v: string | boolean | undefined): number | undefined => (typeof v === 'string' && v !== '' ? Number(v) : undefined);

export function serveOptions(flags: Flags): ServeOptions {
  const agent = str(flags.agent);
  if (agent !== undefined && !isAgentKind(agent)) throw new ServeError(`未知的 agent：${agent}（codex、claude）`);
  return {
    agent,
    roots: str(flags.roots)?.split(',').filter(Boolean),
    codexHome: str(flags['codex-home']),
    claudeHome: str(flags['claude-home']),
    host: str(flags.host),
    port: num(flags.port),
    socket: str(flags.socket),
    tokenStdin: Boolean(flags['token-stdin']),
    noAuth: Boolean(flags['no-auth']),
    exitOnStdinClose: Boolean(flags['exit-on-stdin-close']),
    idleExit: num(flags['idle-exit']),
    dataDir: str(flags['data-dir']),
    webDir: str(flags['web-dir']),
    label: str(flags.label),
    index: !flags['no-index'],
    ready: Boolean(flags.ready),
    control: str(flags.control),
    stateFile: str(flags['state-file']),
  };
}

export async function main(argv: string[]): Promise<number> {
  const { command, flags } = parseFlags(argv);
  switch (command) {
    case 'serve':
      try {
        await serve(serveOptions(flags));
        return -1; // keep running
      } catch (e) {
        if (e instanceof ServeError) {
          process.stderr.write(`${e.message}\n`);
          return 2;
        }
        throw e;
      }
    case 'discover': {
      const scan: AgentScan = {};
      for (const agent of AGENT_KINDS) {
        const v = str(flags[`${agent}-roots`]);
        if (v !== undefined) scan[agent] = v.split(',').filter(Boolean);
      }
      const agents = discoverAgents(Object.keys(scan).length ? scan : DEFAULT_SCAN, { maxDepth: num(flags['max-depth']) });
      process.stdout.write(`${JSON.stringify({ agents })}\n`);
      return 0;
    }
    case 'rekey': {
      const control = str(flags.control);
      if (!control) {
        process.stderr.write('usage: kifu-server rekey --control PATH  (the token on stdin)\n');
        return 2;
      }
      const token = (await readStdinLine()).trim();
      return (await rekeyRunning(control, token)) ? 0 : 1;
    }
    case 'version':
      process.stdout.write(`${JSON.stringify({ name: 'kifu-server', version: VERSION, buildId: BUILD_ID, protocol: PROTOCOL })}\n`);
      return 0;
    default:
      process.stderr.write(`unknown command: ${command}\nusage: kifu-server serve|discover|rekey|version [flags]\n`);
      return 2;
  }
}

// Entry point when run as a binary / script.
const isEntry = typeof process !== 'undefined' && process.argv[1] !== undefined && /cli\.(ts|js|mjs)$|kifu-server/.test(process.argv[1]);
if (isEntry || IS_COMPILED) {
  main(process.argv.slice(2)).then(
    (code) => {
      if (code >= 0) process.exit(code);
    },
    (e) => {
      console.error(e);
      process.exit(1);
    },
  );
}

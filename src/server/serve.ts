import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { migrateLegacyHome } from '../shared/legacy-home';
import { READY_PREFIX, PROTOCOL, type ReadyLine } from '../shared/remote-protocol';
import { createApp } from './app';
import { Auth } from './auth';
import { BUILD_ID, VERSION } from './build-info';
import { config, configure, ensureDataDirs, type ConfigOverrides } from './config';
import { listen } from './runtime/listen';
import { onStdinEof, prepareSocketDir, readStdinLine, startIdleExit, touchActivity } from './runtime/lifecycle';
import { configureSources, refreshSources } from './sources/registry';
import { askBusy } from './services/askWhy';
import { runIndexer } from './services/indexer';
import { initRunner, killAllRuns, runnerBusy } from './services/runner';
import { registerCases } from './replay/cases';
import { initEvals } from './replay/evals';
import { startHousekeeping } from './replay/storage';

export interface ServeOptions extends ConfigOverrides {
  /** Scan these directories for the agent's homes (all of them form the workspace) instead of one home. */
  roots?: string[];
  /** One Codex home / Claude Code config dir instead of scanning. */
  codexHome?: string;
  claudeHome?: string;
  port?: number;
  socket?: string;
  /** Read the auth token from the first stdin line. */
  tokenStdin?: boolean;
  /** Development only: no token. Refused together with --socket. */
  noAuth?: boolean;
  exitOnStdinClose?: boolean;
  /** Exit after this many idle seconds (0 = never). */
  idleExit?: number;
  index?: boolean;
  /** Print the KIFU_READY line (desktop shell protocol). */
  ready?: boolean;
  /**
   * A unix socket (made 0600, in a 0700 dir) where a new client hands over a new
   * token: a detached server outlives the desktop app that started it, and the
   * next one takes it over without any token being stored (see `rekey`).
   */
  control?: string;
  /** Where to describe this server (pid, socket, control, build) for the next client to find it; removed on exit. */
  stateFile?: string;
}

export class ServeError extends Error {}

export async function serve(o: ServeOptions): Promise<void> {
  // builds from before the rename kept everything in ~/.trace-monitor (an explicit data dir is the caller's business)
  if (!o.dataDir && !process.env.KIFU_HOME) migrateLegacyHome();
  const agent = o.agent ?? 'codex';
  configure({ ...o, agent });
  const home = agent === 'codex' ? o.codexHome : o.claudeHome;
  configureSources({ agent, home, roots: home ? undefined : o.roots });
  const found = refreshSources();
  ensureDataDirs();
  initRunner();
  initEvals();
  registerCases();
  startHousekeeping();

  let token: string | undefined;
  if (o.tokenStdin) token = (await readStdinLine()).trim();
  if (!token && !o.noAuth) throw new ServeError('需要 --token-stdin（或开发时使用 --no-auth）');
  if (!token && o.socket) throw new ServeError('--socket 必须配合 --token-stdin 使用');

  const instanceId = randomBytes(6).toString('hex');
  const auth = new Auth(token, instanceId);
  const app = createApp(auth, touchActivity);

  if (o.socket) prepareSocketDir(o.socket);
  let listener;
  try {
    listener = await listen({ fetch: app.fetch, host: config.host, port: o.port ?? config.port, socket: o.socket });
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === 'EADDRINUSE' || /in use/i.test(err.message)) {
      throw new ServeError(
        `端口 ${o.port ?? config.port} 已被占用：可能已经有一个 Kifu 在运行（另一个终端或预览窗口）。\n关掉它，或者换个端口：KIFU_PORT=7790 pnpm dev`,
      );
    }
    throw e;
  }

  const control = o.control ? await listenControl(o.control, auth) : undefined;

  let stopping = false;
  const shutdown = async (code = 0) => {
    if (stopping) return;
    stopping = true;
    killAllRuns();
    control?.close();
    for (const f of [o.control, o.stateFile]) {
      if (!f) continue;
      try {
        fs.unlinkSync(f);
      } catch {
        // already gone
      }
    }
    const force = setTimeout(() => process.exit(code), 800);
    force.unref?.();
    try {
      await listener.close();
    } catch {
      // closing anyway
    }
    if (o.socket) {
      try {
        fs.unlinkSync(o.socket);
      } catch {
        // already gone
      }
    }
    process.exit(code);
  };
  process.on('SIGTERM', () => void shutdown(0));
  process.on('SIGINT', () => void shutdown(0));
  // ssh session torn down: stop agent runs instead of dying with them orphaned (a detached server outlives it)
  if (o.exitOnStdinClose) process.on('SIGHUP', () => void shutdown(0));
  else process.on('SIGHUP', () => undefined);
  if (o.exitOnStdinClose) onStdinEof(() => void shutdown(0));
  if (o.idleExit) startIdleExit(o.idleExit, () => runnerBusy() || askBusy(), () => void shutdown(0));

  if (o.ready) {
    const line: ReadyLine = {
      protocol: PROTOCOL,
      agent,
      sources: found.length,
      version: VERSION,
      buildId: BUILD_ID,
      instanceId,
      pid: process.pid,
      host: listener.host,
      port: listener.port,
      socket: listener.socket,
      dataDir: config.tmHome,
    };
    // the state file first: whoever sees the ready line may read it right away
    if (o.stateFile) writeState(o.stateFile, { ...line, control: o.control, startedAt: Date.now() });
    process.stdout.write(`${READY_PREFIX}${JSON.stringify(line)}\n`);
  } else {
    console.log(`Kifu API on ${listener.socket ? `unix:${listener.socket}` : `http://${listener.host}:${listener.port}`}`);
    console.log(`  ${agent}: ${found.length} 个来源  data=${config.tmHome}`);
  }

  if (o.index !== false && process.env.KIFU_NO_INDEX !== '1') {
    const tick = () => void runIndexer().catch((e) => console.error('indexer:', e));
    setTimeout(tick, 1500).unref?.();
    setInterval(tick, 60_000).unref?.();
  }
}

/** The control socket: one line per connection, `rekey <token>`, answered with `ok`. */
async function listenControl(file: string, auth: Auth): Promise<net.Server> {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  try {
    fs.unlinkSync(file);
  } catch {
    // no stale socket
  }
  const server = net.createServer((c) => {
    let buf = '';
    c.setEncoding('utf8');
    c.setTimeout(5000, () => c.destroy());
    c.on('data', (d: string) => {
      buf += d;
      if (buf.length > 4096) return c.destroy();
      const nl = buf.indexOf('\n');
      if (nl === -1) return;
      const [cmd, token] = buf.slice(0, nl).trim().split(/\s+/, 2);
      if (cmd === 'rekey' && token && token.length >= 16) {
        auth.rekey(token);
        c.end('ok\n');
      } else c.end('error\n');
    });
    c.on('error', () => undefined);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(file, () => resolve());
  });
  fs.chmodSync(file, 0o600);
  return server;
}

function writeState(file: string, state: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/** `kifu-server rekey --control PATH`: the new token comes on stdin, never in argv. */
export async function rekeyRunning(control: string, token: string): Promise<boolean> {
  return new Promise((resolve) => {
    const c = net.createConnection(control);
    let answer = '';
    c.setEncoding('utf8');
    c.setTimeout(5000, () => {
      c.destroy();
      resolve(false);
    });
    c.on('connect', () => c.write(`rekey ${token}\n`));
    c.on('data', (d: string) => (answer += d));
    c.on('end', () => resolve(answer.trim() === 'ok'));
    c.on('error', () => resolve(false));
  });
}

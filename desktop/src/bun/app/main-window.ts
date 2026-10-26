import { BrowserView, BrowserWindow, Utils } from 'electrobun/bun';
import { PRODUCT_NAME } from '../../../../src/shared/brand';
import type { ShellCommand, ShellRPC, Toast } from '../../shared/shell';
import { fileLogger, logDir } from '../transport/local';
import type { ConnectionManager } from './connections';
import { validateSecret } from '../../shared/ssh';

/**
 * The single main window. Its page (views://shell) is local code with RPC to
 * this process; every workspace UI runs in a sandboxed <electrobun-webview>
 * inside it (no RPC, navigation pinned to its own server).
 */

type Requests = ShellRPC['bun']['requests'];
type Handlers = { [K in keyof Requests]: (params: Requests[K]['params']) => Requests[K]['response'] | Promise<Requests[K]['response']> };

const log = fileLogger('shell');
const seen = new Set<string>();
const reports: Array<{ event: string; id?: string; detail?: string }> = [];

/** A web page in the default browser. */
function openExternalUrl(url: string): void {
  if (/^https?:\/\//i.test(url)) Utils.openExternal(url);
}

/** Requests the shell has made / lifecycle reports it sent (diagnostics and the self-test). */
export function shellSeen(name: string): boolean {
  return seen.has(name);
}

export function shellReports(): ReadonlyArray<{ event: string; id?: string; detail?: string }> {
  return reports;
}

/** Log method names only: params may contain transient credentials and must never be logged. */
function logged(h: Handlers): Handlers {
  const out = {} as Record<string, (p: unknown) => unknown>;
  for (const [name, fn] of Object.entries(h) as Array<[string, (p: unknown) => unknown]>) {
    out[name] = (params) => {
      if (!seen.has(name) || (name !== 'getState' && name !== 'routeChanged' && name !== 'report')) log(`rpc ${name}`);
      seen.add(name);
      return fn(params);
    };
  }
  return out as Handlers;
}

/** Commands sent before the shell page has loaded (e.g. menu → 设置… while reopening the window). */
let shellLoaded = false;
let shellLoadCount = 0;
const queued: ShellCommand[] = [];

function defineRpc(model: ConnectionManager) {
  const handlers: Handlers = {
    getState: () => {
      if (!shellLoaded) {
        shellLoaded = true;
        shellLoadCount++;
        setTimeout(() => {
          for (const c of queued.splice(0)) current?.rpc.send.command(c);
        }, 50);
      }
      return model.view();
    },
    addSsh: (input) => ({ id: model.addSsh(input) }),
    refreshSshHosts: () => model.refreshSshHosts(),
    chooseIdentityFile: async () => (await Utils.openFileDialog({ startingFolder: "~/.ssh", canChooseFiles: true, canChooseDirectory: false, allowsMultipleSelection: false })).find(Boolean),
    removeConnection: ({ id }) => model.removeConnection(id),
    // long-running actions report progress through state pushes
    connect: ({ id, secret }) => {
      validateSecret(secret);
      void model.connect(id, secret).catch(() => log('connect request failed'));
    },
    disconnect: ({ id }) => model.disconnect(id),
    discover: ({ id }) => {
      void model.discover(id);
    },
    setEnabled: ({ id, enabled }) => model.setEnabled(id, enabled),
    setAgentScan: ({ id, agent, enabled, roots }) => model.setAgentScan(id, agent, { enabled, roots }),
    answerHostKey: ({ id, accept }) => model.answerHostKey(id, accept),
    openWorkspace: ({ connId, agent }) => ({ id: model.openWorkspace(connId, agent) }),
    activateWorkspace: ({ id }) => model.activate(id),
    closeWorkspace: ({ id }) => model.closeWorkspace(id),
    moveWorkspace: ({ id, to }) => model.moveWorkspace(id, to),
    retryWorkspace: ({ id }) => model.retryWorkspace(id),
    workspaceUrl: ({ id, next }) => model.workspaceUrl(id, next),
    routeChanged: ({ id, route }) => model.routeChanged(id, route),
    setUi: (patch) => model.setUi(patch),
    openExternal: ({ url }) => openExternalUrl(url),
    openLogs: () => {
      Utils.openPath(logDir());
    },
    report: ({ event, id, detail }) => {
      reports.push({ event, id, detail });
      if (reports.length > 500) reports.splice(0, reports.length - 500);
      log(`shell ${event}${id ? ` ${id}` : ''}${detail ? ` ${detail}` : ''}`);
    },
  };
  return BrowserView.defineRPC<ShellRPC>({
    maxRequestTime: 120_000,
    handlers: { requests: logged(handlers), messages: {} },
  });
}

let current: { win: BrowserWindow; rpc: ReturnType<typeof defineRpc> } | undefined;

const DEFAULT_FRAME = { x: 120, y: 80, width: 1480, height: 940 };

export function openMainWindow(model: ConnectionManager): void {
  if (current) {
    current.win.activate();
    return;
  }
  shellLoaded = false;
  const rpc = defineRpc(model);
  const saved = model.savedWindowFrame();
  const frame = saved && saved.width >= 800 && saved.height >= 500 ? { x: saved.x, y: saved.y, width: saved.width, height: saved.height } : DEFAULT_FRAME;
  const win = new BrowserWindow({
    title: PRODUCT_NAME,
    url: 'views://shell/index.html',
    frame,
    titleBarStyle: 'hiddenInset',
    // relative to the default position; clamps at the bottom of the title bar area (centers in a ~42px bar)
    trafficLightOffset: { x: 2, y: 16 },
    rpc,
  });
  // the shell can call into this process: it must only ever show its own page
  win.webview.setNavigationRules(['^*', 'views://shell/*']);
  if (saved?.maximized) win.maximize();

  let saveTimer: ReturnType<typeof setTimeout> | undefined;
  const remember = () => {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      try {
        if (win.isFullScreen()) return;
        const maximized = win.isMaximized();
        const f = maximized && saved ? saved : win.getFrame();
        model.rememberWindowFrame({ x: f.x, y: f.y, width: f.width, height: f.height, maximized });
      } catch {
        // window gone
      }
    }, 400);
  };
  win.on('resize', remember);
  win.on('move', remember);
  win.on('close', () => {
    current = undefined;
  });
  current = { win, rpc };
}

export function pushState(model: ConnectionManager): void {
  try {
    current?.rpc.send.state(model.view());
  } catch (e) {
    console.error('shell push failed', e);
  }
}

export function sendCommand(cmd: ShellCommand): void {
  if (!current) return;
  if (shellLoaded) current.rpc.send.command(cmd);
  else queued.push(cmd);
}

export function sendToast(t: Toast): void {
  current?.rpc.send.toast(t);
}

export function sendRestarted(id: string): void {
  current?.rpc.send.workspaceRestarted({ id });
}

export function setWindowTitle(title: string): void {
  current?.win.setTitle(`${PRODUCT_NAME} — ${title}`);
}

/** Self-test only: how many times the shell page has loaded; close the window. */
export function shellLoads(): number {
  return shellLoadCount;
}

export function closeMainWindow(): void {
  current?.win.close();
}

/** Self-test only: run a script in the shell page. */
export function evalInShell(js: string): void {
  current?.win.webview.executeJavascript(js);
}

export function mainWindowOpen(): boolean {
  return Boolean(current);
}

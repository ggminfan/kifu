import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AGENT_KINDS } from '../../../../src/shared/agents';
import type { ServerEndpoint } from '../transport/server-process';
import { fileLogger, logDir } from '../transport/local';
import type { ConnectionManager } from './connections';
import { closeMainWindow, evalInShell, openMainWindow, sendCommand, shellLoads, shellReports, shellSeen } from './main-window';

/**
 * Development self-test, only when KIFU_AUTOTEST=1. Uses the app the way a
 * person would: a driver injects small scripts into the shell page that click
 * buttons, type and press keys, then checks the shell's DOM, the app state
 * and what the embedded webviews reported. Writes PASS/FAIL lines to
 * logs/autotest.log (aggregates only, no session content).
 *
 * KIFU_AUTOTEST_SSH=<alias>: also add/connect that host (host key prompt, tabs,
 * reconnect, disconnect). KIFU_AUTOTEST_SSH_BAD=<alias>: a host that fails to
 * connect (error panel, toast, retry). KIFU_AUTOTEST_PHASE=restore: a second run
 * against the same store (see runRestore).
 */

const log = fileLogger('autotest');

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(cond: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (cond()) return;
    await sleep(150);
  }
  throw new Error(`timeout: ${what}`);
}

const reported = (event: string, id?: string) => shellReports().some((r) => r.event === event && (id === undefined || r.id === id));
const count = (event: string, id?: string) => shellReports().filter((r) => r.event === event && (id === undefined || r.id === id)).length;

let seq = 0;

/** Run `body` in the shell (helpers: $, $$, byTitle, byText, click, mousedown, type, key) and return its value. */
async function ui<T = unknown>(body: string, timeoutMs = 6000): Promise<T> {
  const tag = `ui-${++seq}`;
  evalInShell(`(async () => {
    const $ = (s) => document.querySelector(s);
    const $$ = (s) => [...document.querySelectorAll(s)];
    const byTitle = (t) => $$('button').find((b) => (b.title || '').startsWith(t));
    const byText = (sel, t) => $$(sel).find((b) => (b.textContent || '').includes(t));
    const need = (el, what) => { if (!el) throw new Error('not found: ' + what); return el; };
    const click = (el, what) => { need(el, what).click(); return true; };
    const mousedown = (el, what) => { need(el, what).dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 })); return true; };
    const type = (el, value, what) => {
      need(el, what);
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(el, value);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    };
    const key = (k, target) => (target || window).dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
    try {
      const result = await (async () => { ${body} })();
      window.__kifuReport(${JSON.stringify(tag)}, JSON.stringify({ ok: true, result: result === undefined ? null : result }));
    } catch (e) {
      window.__kifuReport(${JSON.stringify(tag)}, JSON.stringify({ ok: false, error: String((e && e.message) || e) }));
    }
  })();`);
  await waitFor(() => reported(tag), timeoutMs, `shell script ${tag}`);
  const r = JSON.parse(shellReports().find((x) => x.event === tag)!.detail ?? '{}') as { ok: boolean; result?: T; error?: string };
  if (!r.ok) throw new Error(r.error);
  return r.result as T;
}

/** Poll a DOM condition in the shell (the page's own timers may be paused while the window is hidden). */
async function uiUntil(expr: string, timeoutMs: number, what: string): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await ui<boolean>(`return Boolean(${expr});`).catch(() => false)) return;
    await sleep(200);
  }
  throw new Error(`timeout: ${what}`);
}

/** Successful trace parses a server has logged (KIFU_LOG_REQUESTS=1). */
function traceHits(logName: string): number {
  try {
    return (fs.readFileSync(path.join(logDir(), `${logName}.log`), 'utf8').match(/GET \/api\/sessions\/[^ ]+\/trace 200/g) ?? []).length;
  } catch {
    return 0;
  }
}

/** Run a script inside the visible workspace page (it cannot report back: check navigation and server logs). */
async function inWorkspace(js: string): Promise<unknown> {
  await uiUntil(`$$('electrobun-webview').some((t) => !t.classList.contains('ws-hidden'))`, 10_000, 'visible workspace view');
  return ui(`const tag = $$('electrobun-webview').find((t) => !t.classList.contains('ws-hidden')); need(tag, 'visible workspace view'); tag.executeJavascript(${JSON.stringify(js)}); return true;`);
}

const CLICK_FIRST_SESSION = "document.querySelector('[data-session-row]') && document.querySelector('[data-session-row]').click()";
const OPEN_SKILLS = "document.querySelector('a[href=\"/skills\"]') && document.querySelector('a[href=\"/skills\"]').click()";

const lastRoute = (id: string) => [...shellReports()].reverse().find((r) => r.event === 'navigated' && r.id === id)?.detail;

function lastTraceId(logName: string): string | undefined {
  try {
    const all = [...fs.readFileSync(path.join(logDir(), `${logName}.log`), 'utf8').matchAll(/GET \/api\/sessions\/([^/ ]+)\/trace 200/g)];
    return all.at(-1)?.[1];
  } catch {
    return undefined;
  }
}

function apiHits(logName: string, re: RegExp): number {
  try {
    return (fs.readFileSync(path.join(logDir(), `${logName}.log`), 'utf8').match(re) ?? []).length;
  } catch {
    return 0;
  }
}

/**
 * Click the first session in the visible workspace page until it is open (the
 * list may still be loading): its trace request shows in our log — or, for an
 * SSH server (detached: it logs on its own machine), the page is on /s/<id>
 * (a reopened tab may already be) and that server serves the trace.
 */
async function openFirstSession(logName: string, remote?: { id: string; endpoint: () => ServerEndpoint | undefined }): Promise<void> {
  const before = traceHits(logName);
  const end = Date.now() + 30_000;
  while (Date.now() < end) {
    await inWorkspace(CLICK_FIRST_SESSION);
    for (let i = 0; i < 10; i++) {
      await sleep(200);
      if (traceHits(logName) > before) return;
      const route = remote ? lastRoute(remote.id) : undefined;
      const ep = remote?.endpoint();
      if (ep && route?.startsWith('/s/')) {
        const res = await fetch(`${ep.baseUrl}/api/sessions/${route.slice(3).split('?')[0]}/trace`, { headers: { authorization: `Bearer ${ep.token}` } }).catch(() => undefined);
        if (res?.ok) {
          await res.arrayBuffer();
          return;
        }
      }
    }
  }
  throw new Error('no session opened (trace not parsed)');
}

/** WebKit pauses timers in windows that are not visible (e.g. on another Space); page events then arrive late. */
let pageTimers = true;

/** Set a textarea's value the way typing would (React listens for input events). */
const TYPE_AREA = `const typeArea = (el, value, what) => { need(el, what); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(el, value); el.dispatchEvent(new Event('input', { bubbles: true })); return true; };`;

export async function runAutotest(model: ConnectionManager): Promise<void> {
  if (process.env.KIFU_AUTOTEST_PHASE === 'restore') return runRestore(model);
  log('---- autotest start');
  let failed = 0;
  const step = async (name: string, fn: () => Promise<string | void>) => {
    const t0 = Date.now();
    try {
      const info = await fn();
      log(`PASS ${name}${info ? ` — ${info}` : ''} (${Date.now() - t0}ms)`);
    } catch (e) {
      failed++;
      log(`FAIL ${name}: ${(e as Error).message} (${Date.now() - t0}ms)`);
    }
  };
  const view = () => model.view();
  const ws = (id: string) => view().workspaces.find((w) => w.id === id);
  const lastView = (id: string) => [...shellReports()].reverse().find((r) => (r.event === 'view-shown' || r.event === 'view-hidden') && r.id === id)?.event;

  await step('shell loaded', () => waitFor(() => shellSeen('getState'), 20_000, 'getState'));
  await step('window visibility (affects timer-driven page events)', async () => {
    const vis = await ui<string>(`setTimeout(() => window.__kifuReport('timer-fired'), 50); return document.visibilityState;`);
    await sleep(2000);
    pageTimers = reported('timer-fired');
    return `visibilityState=${vis}, page timers ${pageTimers ? 'run' : 'paused (route events are checked by simulation)'}`;
  });

  // ---- 本机 is a connection like the others: off on a fresh install, turned on when wanted
  let local: string | undefined;
  const localConn = () => view().connections.find((x) => x.id === 'local')!;
  await step('fresh install: 本机 is off, the welcome page offers to turn it on', async () => {
    if (localConn().enabled) throw new Error('本机 is on in a fresh store');
    await uiUntil(`$('.welcome-card') && $('[data-action="enable-local"]')`, 5000, 'welcome page with 启用本机');
    await uiUntil(`!$('.group[data-conn="local"]')`, 2000, 'no 本机 in the sidebar');
  });
  await step('turn 本机 on from the welcome page: it is scanned', async () => {
    await ui(`return click($('[data-action="enable-local"]'), 'enable 本机');`);
    await waitFor(() => localConn().enabled && Boolean(localConn().discoveredAt) && !localConn().discovering, 30_000, 'scanned');
    await uiUntil(`$('.group[data-conn="local"] [data-agent]')`, 5000, 'its agents in the sidebar');
    await uiUntil(`$('.group[data-conn="local"] img.agent-icon')`, 2000, 'agent logos');
    return localConn().agents.map((a) => `${a.agent} ${a.sessions}`).join(', ');
  });
  await step('open 本机 Codex from the welcome page', async () => {
    await ui(`return click(byText('.welcome-item', 'Codex'), 'welcome Codex');`);
    local = 'local::codex';
    await waitFor(() => view().activeId === local && ws(local!)?.status === 'ready', 30_000, 'server ready');
    await waitFor(() => reported('navigated', local), 15_000, 'page loaded');
    return `${ws(local)!.connLabel} · ${ws(local)!.title}`;
  });

  await step('open a session inside the 本机 page (parses its trace)', async () => {
    if (!local) throw new Error('no local tab');
    await openFirstSession('local');
    if (pageTimers) await waitFor(() => (lastRoute(local!) ?? '').startsWith('/s/'), 15_000, 'route reported to the shell');
    else model.routeChanged(local, `/s/${lastTraceId('local')}`);
    return `route ${view().workspaces.find((w) => w.id === local)?.route}`;
  });

  await step('close the main window and reopen it (dock click): same page', async () => {
    if (!local) throw new Error('no local tab');
    const loads = shellLoads();
    const views = count('webview-created', local);
    const traces = traceHits('local');
    closeMainWindow();
    await sleep(800);
    openMainWindow(model);
    await waitFor(() => shellLoads() > loads, 15_000, 'shell reloaded');
    await waitFor(() => count('webview-created', local!) > views, 15_000, 'workspace view recreated');
    await waitFor(() => (lastRoute(local!) ?? '').startsWith('/s/'), 15_000, 'reopened on the same session');
    await waitFor(() => traceHits('local') > traces, 30_000, 'session trace loaded again');
  });

  // ---- settings dialog: every way of closing it, and the view underneath must let clicks through
  await step('settings: open with the gear, close with ✕', async () => {
    await ui(`return click(byTitle('设置'), 'gear');`);
    await uiUntil(`$('.modal.settings')`, 3000, 'dialog open');
    if (local) await waitFor(() => lastView(local!) === 'view-hidden', 3000, 'workspace view hidden + passthrough');
    await ui(`return click($('.modal-close'), 'close button');`);
    await uiUntil(`!$('.modal.settings')`, 3000, 'dialog closed');
    if (local) await waitFor(() => lastView(local!) === 'view-shown', 3000, 'workspace view back');
  });
  await step('settings: ⌘, from the menu, close with Esc', async () => {
    sendCommand({ name: 'openSettings' });
    await uiUntil(`$('.modal.settings')`, 3000, 'dialog open');
    await ui(`key('Escape'); return true;`);
    await uiUntil(`!$('.modal.settings')`, 3000, 'dialog closed');
  });
  await step('settings: click outside closes', async () => {
    await ui(`return click(byTitle('设置'), 'gear');`);
    await uiUntil(`$('.modal.settings')`, 3000, 'dialog open');
    await ui(`return mousedown($('.modal-backdrop'), 'backdrop');`);
    await uiUntil(`!$('.modal.settings')`, 3000, 'dialog closed');
  });
  await step('settings: pages switch', async () => {
    await ui(`return click(byTitle('设置'), 'gear');`);
    await uiUntil(`$('.modal.settings')`, 3000, 'dialog open');
    for (const page of ['关于', '连接']) {
      await ui(`return click(byText('.nav-item', ${JSON.stringify(page)}), 'nav ${page}');`);
      await uiUntil(`$('.nav-item.active') && $('.nav-item.active').textContent.includes(${JSON.stringify(page)})`, 3000, `page ${page}`);
    }
    await ui(`return click($('.modal-close'), 'close');`);
    await uiUntil(`!$('.modal')`, 3000, 'closed');
  });

  // ---- per connection: which agents, and where to look for them
  const scanOf = (agent: string) => localConn().scan.find((a) => a.agent === agent)!;
  await step('settings: 本机 lists its agents; turning Claude Code off hides it, on brings it back', async () => {
    sendCommand({ name: 'openSettings' });
    await uiUntil(`$('.agent-card[data-agent="claude"] .switch') && $('.agent-card[data-agent="codex"] img.agent-icon')`, 3000, 'agent cards with logos');
    await ui(`return click($('.agent-card[data-agent="claude"] .switch'), 'Claude Code off');`);
    await waitFor(() => !scanOf('claude').enabled, 3000, 'Claude Code off');
    await uiUntil(`!$('.group[data-conn="local"] [data-agent="claude"]')`, 5000, 'Claude Code gone from the sidebar');
    await ui(`return click($('.agent-card[data-agent="claude"] .switch'), 'Claude Code on');`);
    await waitFor(() => scanOf('claude').enabled && localConn().agents.some((a) => a.agent === 'claude'), 30_000, 'Claude Code scanned again');
    await uiUntil(`$('.group[data-conn="local"] [data-agent="claude"]')`, 5000, 'Claude Code back in the sidebar');
    return `${localConn().agents.find((a) => a.agent === 'claude')?.sessions ?? 0} Claude Code sessions`;
  });
  await step('settings: change the Codex scan directories, the open workspace follows, restore the defaults', async () => {
    const extra = path.join(os.tmpdir(), 'kifu-autotest-no-such-root');
    const restarted = count('navigated', local);
    await ui(`${TYPE_AREA} const t = $('.agent-card[data-agent="codex"] textarea'); return typeArea(t, t.value + String.fromCharCode(10) + ${JSON.stringify(extra)}, 'Codex directories');`);
    await ui(`return click(byText('.agent-card[data-agent="codex"] button', '保存'), 'save');`);
    await waitFor(() => scanOf('codex').custom && scanOf('codex').roots.includes(extra), 3000, 'custom directories saved');
    await uiUntil(`byText('.agent-card[data-agent="codex"] button', '恢复默认')`, 3000, 'restore button');
    await ui(`return click(byText('.agent-card[data-agent="codex"] button', '恢复默认'), 'restore');`);
    await waitFor(() => !scanOf('codex').custom, 3000, 'defaults back');
    await waitFor(() => ws(local!)?.status === 'ready', 30_000, 'Codex workspace ready after its server picked up the directories');
    if (local) await waitFor(() => count('navigated', local!) > restarted, 15_000, 'tab signed in again');
    await ui(`return click($('.modal-close'), 'close');`);
    await uiUntil(`!$('.modal')`, 3000, 'closed');
    return scanOf('codex').roots.join(' ');
  });

  // ---- quick open, sidebar
  await step('quick open: + opens, typing filters, Esc closes, toggles', async () => {
    await ui(`return click(byTitle('打开工作区'), '+');`);
    await uiUntil(`$('.quick')`, 3000, 'popover open');
    const n = await ui<number>(`type($('.quick-input input'), 'codex', 'search'); return $$('.quick-item').length;`);
    await ui(`key('Escape', $('.quick-input input')); return true;`);
    await uiUntil(`!$('.quick')`, 3000, 'popover closed by Esc');
    await ui(`return click(byTitle('打开工作区'), '+');`);
    await uiUntil(`$('.quick')`, 3000, 'reopen');
    await ui(`return click(byTitle('打开工作区'), '+');`);
    await uiUntil(`!$('.quick')`, 3000, 'second click on + closes');
    return `${n} matches for "codex"`;
  });
  await step('⌘T (menu) opens quick open', async () => {
    sendCommand({ name: 'quickOpen' });
    await uiUntil(`$('.quick')`, 3000, 'popover open');
    await ui(`key('Escape', $('.quick-input input')); return true;`);
    await uiUntil(`!$('.quick')`, 3000, 'closed');
  });
  await step('gear opens the host list, sidebar + opens the add form', async () => {
    await ui(`return click(byTitle('设置'), 'gear');`);
    await uiUntil(`$('.remote-page')`, 3000, 'remote page');
    await ui(`return click($('.modal-close'), 'close');`);
    await uiUntil(`!$('.modal')`, 3000, 'closed');
  });
  await step('sidebar: hide and show again', async () => {
    await ui(`return click(byTitle('隐藏侧边栏'), 'hide');`);
    await uiUntil(`!$('.sidebar') && $('.titlebar.lights')`, 3000, 'sidebar hidden');
    if (view().ui.sidebarOpen) throw new Error('state not saved');
    await ui(`return click(byTitle('显示侧边栏'), 'show');`);
    await uiUntil(`$('.sidebar')`, 3000, 'sidebar back');
  });
  await step('welcome page when every tab is closed, reopen from it', async () => {
    if (!local) throw new Error('no local tab');
    await ui(`return click($('.tab.active .tab-close'), 'tab close');`);
    await uiUntil(`$('.welcome-card')`, 3000, 'welcome shown');
    await ui(`return click(byText('.welcome-item', 'Codex'), 'welcome item');`);
    await waitFor(() => view().activeId === local && ws(local!)?.status === 'ready', 20_000, 'tab reopened');
    await waitFor(() => count('navigated', local) >= 2, 15_000, 'page loaded again');
  });

  // ---- the other agents on 本机: a workspace each, opened from the sidebar, sessions parse
  for (const agent of AGENT_KINDS.filter((a) => a !== 'codex')) {
    const row = view().connections.find((c) => c.id === 'local')?.agents.find((a) => a.agent === agent);
    if (!row || row.missing || !row.sessions) {
      log(`SKIP 本机 ${agent}: no sessions on this machine`);
      continue;
    }
    await step(`本机 ${row.label}: open from the sidebar, open a session`, async () => {
      const id = `local::${agent}`;
      await ui(`return click($('.group[data-conn="local"] [data-agent="${agent}"]'), 'sidebar ${agent}');`);
      await waitFor(() => view().activeId === id && ws(id)?.status === 'ready', 30_000, 'workspace ready');
      await waitFor(() => reported('navigated', id), 15_000, 'page loaded');
      await openFirstSession('local');
      const tab = await ui<string>(`return ($('.tab.active') || {}).textContent || '';`);
      return `${row.sessions} sessions · tab "${tab.trim()}"`;
    });
  }
  if (local) {
    await step('back to 本机 Codex from the sidebar', async () => {
      await ui(`return click($('.group[data-conn="local"] [data-agent="codex"]'), 'sidebar codex');`);
      await waitFor(() => view().activeId === local, 10_000, 'Codex tab active');
    });
  }
  await step('turn 本机 off in Settings: its tabs close and it leaves the sidebar; on again', async () => {
    sendCommand({ name: 'openSettings' });
    await uiUntil(`$('.modal.settings') && $('.detail-head .switch')`, 3000, '本机 settings');
    await ui(`return click($('.detail-head .switch'), '本机 off');`);
    await waitFor(() => !localConn().enabled && !view().workspaces.some((w) => w.connId === 'local'), 10_000, 'off, tabs closed');
    await uiUntil(`!$('.group[data-conn="local"]')`, 3000, 'gone from the sidebar');
    await ui(`return click($('.detail-head .switch'), '本机 on');`);
    await waitFor(() => localConn().enabled && localConn().agents.length > 0, 30_000, 'scanned again');
    await ui(`return click($('.modal-close'), 'close');`);
    await uiUntil(`!$('.modal')`, 3000, 'closed');
    local = model.openWorkspace('local', 'codex');
    await waitFor(() => ws(local!)?.status === 'ready', 30_000, 'Codex reopened');
  });

  // ---- SSH: add host from Settings, host key prompt, auto-open, tabs, reconnect, disconnect
  const alias = process.env.KIFU_AUTOTEST_SSH;
  if (alias) {
    const connId = `ssh:${alias}`;
    let remote: string | undefined;
    await step(`add ${alias} from Settings, trust host key, default home opens`, async () => {
      await ui(`return click(byTitle('添加 SSH 主机'), 'sidebar +');`);
      await uiUntil(`$('.add-row input')`, 3000, 'add form');
      await ui(`type($('.add-row input'), ${JSON.stringify(alias)}, 'alias'); return true;`);
      await ui(`return click(byText('.add-row button', '添加并连接'), 'add button');`);
      await uiUntil(`$('.modal.hostkey')`, 30_000, 'host key dialog');
      await ui(`return click(byText('.modal.hostkey button', '信任并连接'), 'trust');`);
      await waitFor(() => view().workspaces.some((w) => w.connId === connId && w.status === 'ready'), 60_000, 'remote tab ready');
      remote = view().workspaces.find((w) => w.connId === connId)!.id;
      await uiUntil(`!$('.modal')`, 5000, 'settings closed after connecting');
      await waitFor(() => reported('navigated', remote!), 15_000, 'remote page loaded');
      const c = view().connections.find((x) => x.id === connId)!;
      return `stages ${c.stages.map((st) => `${st.id}:${st.status}`).join(',')}`;
    });
    await step('remote card shows the host and the tab is active', async () => {
      await uiUntil(`$('.remote-card') && $('.remote-card').textContent.includes(${JSON.stringify(alias)})`, 3000, 'remote card');
      if (view().activeId !== remote) throw new Error('remote tab not active');
    });
    await step('switch tabs by clicking them; hidden view lets clicks through', async () => {
      if (!local || !remote) throw new Error('missing tabs');
      await ui(`return mousedown($$('.tab')[0], 'first tab');`);
      await waitFor(() => view().activeId === local, 3000, 'local active');
      await waitFor(() => lastView(remote!) === 'view-hidden' && lastView(local!) === 'view-shown', 3000, 'views swapped');
      await ui(`return mousedown($$('.tab')[1], 'second tab');`);
      await waitFor(() => view().activeId === remote, 3000, 'remote active');
      await waitFor(() => lastView(local!) === 'view-hidden' && lastView(remote!) === 'view-shown', 3000, 'views swapped back');
      return `${count('webview-created')} webviews for ${view().workspaces.length} tabs`;
    });
    await step('reconnect after the ssh link dies: banner, then the tab signs in again', async () => {
      if (!remote) throw new Error('missing tab');
      const runtime = model.runtimeOf(connId) as unknown as { master?: { pid?: number } };
      if (!runtime.master?.pid) throw new Error('no ssh master');
      const before = count('navigated', remote);
      process.kill(runtime.master.pid, 'SIGKILL');
      await uiUntil(`$('.banner')`, 10_000, 'reconnecting banner');
      await waitFor(() => ws(remote!)?.status === 'ready', 60_000, 'back to ready');
      await waitFor(() => count('navigated', remote!) > before, 15_000, 'tab reloaded');
      await uiUntil(`!$('.banner')`, 5000, 'banner gone');
    });
    await step('⌘R reloads the active tab', async () => {
      if (!remote) throw new Error('missing tab');
      const before = count('navigated', remote);
      sendCommand({ name: 'reload' });
      await waitFor(() => count('navigated', remote!) > before, 15_000, 'reloaded');
    });
    await step('disconnect from the remote card closes its tabs', async () => {
      await ui(`return click(byText('.remote-card button', '断开'), 'disconnect');`);
      await waitFor(() => !view().workspaces.some((w) => w.connId === connId), 10_000, 'remote tabs closed');
      await waitFor(() => view().connections.find((x) => x.id === connId)?.status === 'idle', 10_000, 'host idle');
      if (view().activeId !== local) throw new Error('active tab did not fall back to 本机');
    });
    await step('open a remote home from the sidebar reconnects', async () => {
      const created = count('webview-created');
      await ui(`const g = $$('.group').find((x) => x.querySelector('.group-label')?.textContent === ${JSON.stringify(alias)}); return click(g && g.querySelector('.home'), 'remote home');`);
      await waitFor(() => view().workspaces.some((w) => w.connId === connId && w.status === 'ready'), 60_000, 'remote tab ready');
      remote = view().workspaces.find((w) => w.connId === connId)!.id;
      await waitFor(() => count('webview-created') > created, 15_000, 'new view created');
      await waitFor(() => lastView(remote!) === 'view-shown' || count('webview-created', remote!) > 0, 5000, 'view shown');
    });
    await step('open a session inside the remote page (parses its trace remotely)', async () => {
      if (!remote) throw new Error('missing tab');
      await openFirstSession(`ssh-${alias}`, { id: remote, endpoint: () => model.endpointOf(remote!) });
      if (pageTimers) await waitFor(() => (lastRoute(remote!) ?? '').startsWith('/s/'), 15_000, 'route reported to the shell');
    });
    await step('close the remote tab with ⌘W', async () => {
      if (view().activeId !== remote) throw new Error('remote not active');
      sendCommand({ name: 'closeTab' });
      await waitFor(() => !view().workspaces.some((w) => w.id === remote), 5000, 'tab closed');
    });
    // leave a state for the restore phase: 本机 on the Skills page, remote tab active on a session
    await step('prepare restore: 本机 → Skills, remote tab on a session', async () => {
      if (!local) throw new Error('no local tab');
      model.activate(local);
      await sleep(400);
      const labHits = apiHits('local', /GET \/api\/skills /g);
      await inWorkspace(OPEN_SKILLS);
      await waitFor(() => apiHits('local', /GET \/api\/skills /g) > labHits, 15_000, 'Skills opened (its API called)');
      if (pageTimers) await waitFor(() => lastRoute(local!) === '/skills', 10_000, 'route reported');
      else model.routeChanged(local, '/skills');
      const created = count('webview-created');
      remote = model.openWorkspace(connId, 'codex');
      await waitFor(() => ws(remote!)?.status === 'ready' && count('webview-created') > created, 60_000, 'remote ready');
      await openFirstSession(`ssh-${alias}`, { id: remote, endpoint: () => model.endpointOf(remote!) });
      if (pageTimers) await waitFor(() => (lastRoute(remote!) ?? '').startsWith('/s/'), 15_000, 'route reported');
      else model.routeChanged(remote, `/s/${lastTraceId(`ssh-${alias}`)}`);
      await sleep(1000); // let the debounced store write happen
      return `${view().workspaces.length} tabs`;
    });
  }

  const bad = process.env.KIFU_AUTOTEST_SSH_BAD;
  if (bad) {
    await step(`a host that cannot connect shows an error with retry`, async () => {
      const id = model.addSsh(bad);
      sendCommand({ name: 'openSettings', page: 'connections' });
      await uiUntil(`$('.modal.settings')`, 3000, 'settings');
      await ui(`return click(byText('.list-item', ${JSON.stringify(bad)}), 'host in list');`);
      await ui(`return click(byText('.remote-detail button', '连接'), 'connect');`);
      await waitFor(() => view().connections.find((x) => x.id === id)?.status === 'error', 30_000, 'error state');
      await uiUntil(`$('.callout.bad') && byText('.remote-detail button', '重试')`, 3000, 'error callout + retry');
      await uiUntil(`$('.toast-error')`, 3000, 'error toast');
      const msg = view().connections.find((x) => x.id === id)!.error!.message;
      await ui(`return click($('.modal-close'), 'close');`);
      await uiUntil(`!$('.modal')`, 3000, 'closed');
      return msg;
    });
  }

  await step('no shell or webview errors', async () => {
    const errs = shellReports().filter((r) => r.event === 'webview-error' || r.event === 'js-error');
    if (errs.length) throw new Error(errs.map((e) => `${e.event}: ${e.detail}`).join('; '));
  });

  log(`---- autotest done (${failed} failed)`);
}

/** Second run against the same store: tabs, the active tab and every tab's page come back. */
async function runRestore(model: ConnectionManager): Promise<void> {
  log('---- autotest (restore) start');
  let failed = 0;
  const step = async (name: string, fn: () => Promise<string | void>) => {
    const t0 = Date.now();
    try {
      const info = await fn();
      log(`PASS ${name}${info ? ` — ${info}` : ''} (${Date.now() - t0}ms)`);
    } catch (e) {
      failed++;
      log(`FAIL ${name}: ${(e as Error).message} (${Date.now() - t0}ms)`);
    }
  };
  const view = () => model.view();
  const alias = process.env.KIFU_AUTOTEST_SSH ?? '';
  const tabs = view().workspaces;
  const remote = tabs.find((w) => w.kind === 'ssh');
  const local = tabs.find((w) => w.kind === 'local');
  await step('tabs and the active tab are restored', async () => {
    if (!remote || !local) throw new Error(`expected a local and a remote tab, got ${tabs.length}`);
    if (view().activeId !== remote.id) throw new Error('active tab not restored');
    return `${tabs.length} tabs`;
  });
  await step('active remote tab reconnects and reopens its session', async () => {
    if (!remote) throw new Error('no remote tab');
    if (!remote.route.startsWith('/s/')) throw new Error(`stored route ${remote.route}`);
    await waitFor(() => view().workspaces.find((w) => w.id === remote.id)?.status === 'ready', 60_000, 'remote ready');
    await waitFor(() => (lastRoute(remote.id) ?? '').startsWith('/s/'), 20_000, 'restored session route');
    // the server (detached, logging on its own machine) serves that session's trace
    const ep = model.endpointOf(remote.id);
    const res = ep ? await fetch(`${ep.baseUrl}/api/sessions/${(lastRoute(remote.id) ?? '').slice(3).split('?')[0]}/trace`, { headers: { authorization: `Bearer ${ep.token}` } }) : undefined;
    if (!res?.ok) throw new Error(`trace ${res?.status ?? 'no endpoint'}`);
    await res.arrayBuffer();
    return remote.route.slice(0, 12);
  });
  await step('本机 tab opens on Skills when activated', async () => {
    if (!local) throw new Error('no local tab');
    model.activate(local.id);
    await waitFor(() => lastRoute(local.id) === '/skills', 30_000, 'restored /skills');
  });
  log(`---- autotest done (${failed} failed)`);
}

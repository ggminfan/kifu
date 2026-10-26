import { systemText, tr, getLocale, type Locale } from '../../../src/shared/i18n';
import { useLocale } from '../../../src/shared/i18n/react';
import type { WebviewTagElement } from 'electrobun/view';
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import type { ConnectionView, ShellState, WorkspaceView } from '../shared/shell';
import { api, inApp } from './rpc';
import type { SettingsPage } from './Settings';
import { AgentIcon, connIcon, ErrorHint, Icon, isRemote, relTime, Spinner, StageList } from './ui';

type OpenSettings = (page: SettingsPage, focus?: string, adding?: boolean) => void;

/**
 * The content area. Each opened workspace gets one sandboxed
 * <electrobun-webview> (a native view layered over this page): no RPC into the
 * app, navigation pinned to its own server, external links handed to the
 * system browser. Views stay alive while their tab is open, so switching tabs
 * keeps scroll positions and selections.
 */

export interface StackHandle {
  reload(id: string): void;
  devtools(id: string): void;
  /** Re-send overlay masks (popovers, toasts) so they stay visible and clickable above the views. */
  refreshMasks(): void;
}

interface Entry {
  locale?: Locale;
  el: WebviewTagElement;
  baseUrl: string;
  initialized: boolean;
  shown: boolean;
  /** Tab closed while the native view was still being created: destroy it once creation finishes. */
  cancelled?: boolean;
}

function eventUrl(e: CustomEvent): string | undefined {
  const d = e.detail as unknown;
  if (typeof d === 'string') return d;
  if (d && typeof d === 'object' && 'url' in d) return String((d as { url: unknown }).url);
  return undefined;
}

function waitInitialized(el: WebviewTagElement, timeoutMs = 10_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const tick = () => {
      if (el.webviewId != null) resolve();
      else if (Date.now() - t0 > timeoutMs) reject(new Error('webview did not initialize'));
      else setTimeout(tick, 25);
    };
    tick();
  });
}

const VISIBLE = new Set(['ready', 'restarting']);
const languageScript = () => `window.__KIFU_LANGUAGE__=${JSON.stringify(getLocale())};window.dispatchEvent(new CustomEvent('kifu:language',{detail:window.__KIFU_LANGUAGE__}));`;

export const WorkspaceStack = forwardRef<
  StackHandle,
  { state: ShellState; cover: boolean; onOpenSettings: OpenSettings; onConnectAndOpen: (id: string) => void }
>(function WorkspaceStack({ state, cover, onOpenSettings, onConnectAndOpen }, ref) {
  useLocale();
  const host = useRef<HTMLDivElement>(null);
  const entries = useRef(new Map<string, Entry>());
  const creating = useRef(new Set<string>());
  const latest = useRef({ state, cover });
  latest.current = { state, cover };

  /**
   * Electrobun decides which native view gets the mouse by position and stacking
   * order and does not skip hidden views. A hidden view must therefore also be
   * set to pass mouse events through, or it keeps swallowing clicks meant for
   * the view below it (another tab) or for the shell (dialogs, status panels).
   */
  const applyVisibility = () => {
    const { state: s, cover: c } = latest.current;
    for (const [id, e] of entries.current) {
      if (e.initialized && e.locale !== getLocale()) {
        e.el.setAttribute('preload', languageScript());
        e.el.executeJavascript(languageScript());
        e.locale = getLocale();
      }
      const ws = s.workspaces.find((w) => w.id === id);
      const show = Boolean(ws && id === s.activeId && VISIBLE.has(ws.status) && !c);
      e.el.classList.toggle('ws-hidden', !show);
      if (!e.initialized || e.shown === show) continue;
      if (show) {
        e.el.togglePassthrough(false);
        e.el.toggleHidden(false);
        e.el.syncDimensions(true);
      } else {
        e.el.toggleHidden(true);
        e.el.togglePassthrough(true);
      }
      e.shown = show;
      api.report(show ? 'view-shown' : 'view-hidden', id);
    }
  };

  const load = async (id: string, entry: Entry) => {
    const { url, baseUrl } = await api.workspaceUrl(id);
    entry.baseUrl = baseUrl;
    entry.el.setNavigationRules(['^*', `${baseUrl}/*`]);
    entry.el.loadURL(url);
  };

  const create = async (ws: WorkspaceView) => {
    if (!inApp || !host.current || entries.current.has(ws.id) || creating.current.has(ws.id)) return;
    creating.current.add(ws.id);
    try {
      const { url, baseUrl } = await api.workspaceUrl(ws.id, ws.route);
      if (!latest.current.state.workspaces.some((w) => w.id === ws.id) || !host.current) return;
      const el = document.createElement('electrobun-webview');
      el.setAttribute('preload', languageScript());
      el.setAttribute('sandbox', '');
      el.setAttribute('masks', '.kifu-mask');
      el.setAttribute('src', url);
      el.className = 'ws-view';
      // Electrobun initializes the tag in requestAnimationFrame, which WebKit pauses while the
      // window is hidden (another Space, minimized). Initialize right away instead and turn the
      // deferred call into a no-op so the native view is created exactly once.
      const init = (Object.getPrototypeOf(el) as { initWebview?: () => Promise<void> }).initWebview;
      if (init) (el as unknown as { initWebview: () => Promise<void> }).initWebview = () => Promise.resolve();
      host.current.appendChild(el);
      const entry: Entry = { el, baseUrl, initialized: false, shown: true };
      entries.current.set(ws.id, entry);
      const onNav = (e: CustomEvent) => {
        if (entry.initialized) entry.el.executeJavascript(languageScript());
        const u = eventUrl(e);
        if (!u || !u.startsWith(entry.baseUrl) || u.includes('/__kifu_auth')) return;
        const route = u.slice(entry.baseUrl.length) || '/';
        void api.routeChanged(ws.id, route);
        api.report('navigated', ws.id, route.split('?')[0]);
      };
      el.on('did-navigate', onNav);
      el.on('did-navigate-in-page', onNav);
      el.on('new-window-open', (e) => {
        const u = eventUrl(e);
        if (u && /^https?:\/\//i.test(u) && !u.startsWith(entry.baseUrl)) void api.openExternal(u);
      });
      if (init) await init.call(el);
      else await waitInitialized(el);
      if (el.webviewId == null) throw new Error('webview did not initialize');
      if (entry.cancelled) {
        // removing the element now (with its id known) tells Electrobun to destroy the native view
        el.remove();
        return;
      }
      entry.initialized = true;
      el.setNavigationRules(['^*', `${baseUrl}/*`]);
      api.report('webview-created', ws.id);
      applyVisibility();
    } catch (e) {
      api.report('webview-error', ws.id, (e as Error).message);
    } finally {
      creating.current.delete(ws.id);
    }
  };

  // keep views in step with the open tabs
  useEffect(() => {
    for (const [id, e] of entries.current) {
      if (!state.workspaces.some((w) => w.id === id)) {
        // an element removed before its native view exists would leave that view behind
        if (e.initialized) e.el.remove();
        else e.cancelled = true;
        entries.current.delete(id);
      }
    }
    const active = state.workspaces.find((w) => w.id === state.activeId);
    if (active && active.status === 'ready' && !entries.current.has(active.id)) void create(active);
    applyVisibility();
  });

  useImperativeHandle(ref, () => ({
    reload(id) {
      const e = entries.current.get(id);
      if (e?.initialized) void load(id, e).catch((err) => api.report('webview-error', id, (err as Error).message));
    },
    devtools(id) {
      entries.current.get(id)?.el.toggleDevTools();
    },
    refreshMasks() {
      for (const e of entries.current.values()) if (e.initialized && e.shown) e.el.syncDimensions(true);
    },
  }));

  // the reconnect banner is an overlay too
  const banner = state.workspaces.find((w) => w.id === state.activeId)?.status === 'restarting';
  useEffect(() => {
    for (const e of entries.current.values()) if (e.initialized && e.shown) e.el.syncDimensions(true);
  }, [banner]);

  const active = state.workspaces.find((w) => w.id === state.activeId);
  const conn = active && state.connections.find((c) => c.id === active.connId);
  return (
    <div className="stack">
      <div ref={host} className="stack-views" />
      {!active ? (
        <Welcome state={state} onOpenSettings={onOpenSettings} onConnectAndOpen={onConnectAndOpen} />
      ) : !VISIBLE.has(active.status) ? (
        <StatusPanel ws={active} conn={conn} onOpenSettings={onOpenSettings} />
      ) : !inApp ? (
        <div className="preview-placeholder">
          <Icon name={connIcon(active.kind)} size={28} />
          <div>
            {systemText(active.connLabel)} · {active.title}
          </div>
          <div className="muted small">{tr("（预览模式：这里是该工作区的会话 / Skill Lab 界面）")}</div>
        </div>
      ) : null}
      {active?.status === 'restarting' && (
        <div className="banner kifu-mask">
          <Spinner size={12} />{tr("连接中断，正在重连")}{systemText(active.connLabel)}{tr("… 恢复后会自动刷新这个页面")}</div>
      )}
    </div>
  );
});

function busyText(c: ConnectionView): string {
  if (c.status === 'error') return tr("连接失败，点此重试");
  if (c.status === 'idle') return tr("连接并打开");
  return tr("连接中…");
}

function StatusPanel({ ws, conn, onOpenSettings }: { ws: WorkspaceView; conn?: ConnectionView; onOpenSettings: OpenSettings }) {
  useLocale();
  const ssh = isRemote(ws.kind);
  if (ws.status === 'error') {
    return (
      <div className="panel">
        <div className="panel-card">
          <div className="panel-title error">
            <Icon name="alert" size={18} />{tr("无法打开")}{systemText(ws.connLabel)} · {ws.title}
          </div>
          <p className="panel-msg">{systemText(ws.error ?? conn?.error?.message) || tr("未知错误")}</p>
          {conn?.error && <ErrorHint conn={conn} />}
          {ssh && conn && conn.stages.some((s) => s.status !== 'pending') && <StageList stages={conn.stages} />}
          {conn?.error?.detail && (
            <details className="details">
              <summary>{tr("详细信息")}</summary>
              <pre>{conn.error.detail}</pre>
            </details>
          )}
          <div className="actions">
            <button className="primary" onClick={() => void api.retryWorkspace(ws.id)}>{tr("重试")}</button>
            {ssh && <button onClick={() => onOpenSettings('connections', ws.connId)}>{tr("连接设置")}</button>}
            <button className="ghost" onClick={() => void api.closeWorkspace(ws.id)}>{tr("关闭标签")}</button>
          </div>
        </div>
      </div>
    );
  }
  if (ws.status === 'idle') {
    return (
      <div className="panel">
        <div className="panel-card">
          <div className="panel-title">
            <Icon name={connIcon(ws.kind)} size={18} />
            {systemText(ws.connLabel)} · {ws.title}
          </div>
          <p className="panel-msg muted">{ssh ? tr("这个工作区所在的主机还没有连接。") : tr("服务没有运行。")}</p>
          <div className="actions">
            <button className="primary" onClick={() => void api.retryWorkspace(ws.id)}>
              {ssh ? tr`连接 ${systemText(ws.connLabel)}` : tr("启动")}
            </button>
          </div>
        </div>
      </div>
    );
  }
  const connecting = ssh && ws.status === 'connecting' && conn;
  return (
    <div className="panel">
      <div className="panel-card">
        <div className="panel-title">
          <Spinner size={16} />
          {connecting ? tr`正在连接 ${systemText(ws.connLabel)}` : tr`正在打开 ${ws.title}`}
        </div>
        {connecting ? (
          <>
            <StageList stages={conn.stages} progress={conn.progress} />
            {conn.status === 'hostkey' && <p className="hint">{tr("请在弹出的窗口里确认主机指纹。")}</p>}
          </>
        ) : (
          <p className="panel-msg muted">{tr("正在启动")}{ws.title}{tr("的服务…")}</p>
        )}
      </div>
    </div>
  );
}

function Welcome({ state, onOpenSettings, onConnectAndOpen }: { state: ShellState; onOpenSettings: OpenSettings; onConnectAndOpen: (id: string) => void }) {
  useLocale();
  const local = state.connections.find((c) => c.kind === 'local');
  const remotes = state.connections.filter((c) => isRemote(c.kind));
  const [, force] = useState(0);
  useEffect(() => {
    const t = setInterval(() => force((n) => n + 1), 30_000);
    return () => clearInterval(t);
  }, []);
  const localAgents = local?.agents.filter((a) => !a.missing) ?? [];
  return (
    <div className="panel welcome">
      <div className="welcome-card">
        <div className="welcome-mark" />
        <h1>{tr("打开一个工作区")}</h1>
        <p className="muted">{tr("工作区是一台机器上某个 Agent（Codex、Claude Code）的全部会话。机器可以是本机，也可以是通过 SSH 连接的开发机。")}</p>
        {local && (
          <>
            <div className="welcome-section">{tr("本机")}</div>
            {!local.enabled ? (
              <button className="welcome-item" data-action="enable-local" onClick={() => void api.setEnabled(local.id, true)}>
                <Icon name="laptop" size={15} />
                <span className="grow">{tr("启用本机")}</span>
                <span className="muted small">{tr("查看这台电脑上的 Codex、Claude Code 会话")}</span>
              </button>
            ) : localAgents.length ? (
              localAgents.map((a) => (
                <button key={a.agent} className="welcome-item" onClick={() => void api.openWorkspace(local.id, a.agent)} title={a.latestTitle ? tr`最近：${a.latestTitle}` : undefined}>
                  <AgentIcon agent={a.agent} size={16} />
                  <span className="grow">{a.label}</span>
                  <span className="muted small">
                    {a.sessions}{tr("个会话")}{a.lastActivity ? ` · ${relTime(a.lastActivity)}` : ''}
                  </span>
                </button>
              ))
            ) : (
              <button className="welcome-item" onClick={() => onOpenSettings('connections', local.id)}>
                <Icon name="laptop" size={15} />
                <span className="grow">{local.discovering ? tr("正在扫描本机…") : tr("本机没有找到会话")}</span>
                <span className="muted small">{tr("调整扫描设置")}</span>
              </button>
            )}
          </>
        )}
        <div className="welcome-section">{tr("远端")}</div>
        {remotes.map((c) => (
          <button key={c.id} className="welcome-item" onClick={() => onConnectAndOpen(c.id)} title={c.detail}>
            <Icon name={connIcon(c.kind)} size={15} />
            <span className="grow">{systemText(c.label)}</span>
            <span className="muted small">{c.status === 'ready' ? tr`打开 · ${c.agents.filter((a) => !a.missing).map((a) => a.label).join('、') || tr("没有找到 Agent")}` : busyText(c)}</span>
          </button>
        ))}
        <button className="welcome-item add" onClick={() => onOpenSettings('connections', undefined, true)}>
          <Icon name="plus" size={15} />
          <span className="grow">{tr("添加 SSH 主机")}</span>
        </button>
      </div>
    </div>
  );
}

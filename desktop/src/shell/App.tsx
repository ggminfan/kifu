import { SshCredentialDialog } from './AddSsh';
import { systemText, tr, configureLanguage } from '../../../src/shared/i18n';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocale } from '../../../src/shared/i18n/react';
import type { ShellCommand, ShellState, Toast } from '../shared/shell';
import { api, inApp } from './rpc';
import { HostKeyDialog, SettingsDialog, type SettingsPage, type SettingsTarget } from './Settings';
import { Sidebar } from './Sidebar';
import { TitleBar } from './TitleBar';
import { cx, Icon } from './ui';
import { WorkspaceStack, type StackHandle } from './WorkspaceStack';

interface ToastItem extends Toast {
  id: number;
}

let toastSeq = 0;

export function App() {
  useLocale();
  const [state, setState] = useState<ShellState | null>(null);
  const [settings, setSettings] = useState<SettingsTarget | null>(null);
  const [quickOpen, setQuickOpen] = useState(false);
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  /** Connect started from Settings: once it is up, close Settings and open the host's most recently active agent. */
  const [pending, setPending] = useState<string>();
  const stack = useRef<StackHandle>(null);
  const stateRef = useRef(state);
  stateRef.current = state;

  const toast = useCallback((t: Toast) => {
    const id = ++toastSeq;
    setToasts((all) => [...all.slice(-3), { ...t, id }]);
    setTimeout(() => setToasts((all) => all.filter((x) => x.id !== id)), t.level === 'error' ? 9000 : 4500);
  }, []);

  const openSettings = useCallback((page: SettingsPage = 'connections', focus?: string, adding?: boolean) => {
    setQuickOpen(false);
    setSettings({ page, focus, adding });
  }, []);

  /** Connect a host and open its most recently active agent once it is up. */
  const connectAndOpen = useCallback((id: string) => {
    setPending(id);
    void api.connect(id);
  }, []);

  useEffect(() => {
    (window as unknown as { __kifuReport: (event: string, detail?: string) => void }).__kifuReport = (event, detail) => api.report(event, undefined, detail);
    const onError = (e: ErrorEvent) => api.report('js-error', undefined, `${e.message} @${e.filename?.split('/').pop()}:${e.lineno}`);
    const onRejection = (e: PromiseRejectionEvent) => api.report('js-error', undefined, `unhandled: ${String((e.reason as Error)?.message ?? e.reason)}`);
    window.addEventListener('error', onError);
    window.addEventListener('unhandledrejection', onRejection);
    return () => {
      window.removeEventListener('error', onError);
      window.removeEventListener('unhandledrejection', onRejection);
    };
  }, []);

  useEffect(() => {
    const receiveState = (next: ShellState) => {
      configureLanguage(next.ui.language ?? 'system', next.systemLocale ?? navigator.language);
      setState(next);
    };
    void api.getState().then(receiveState);
    const offs = [
      api.onState(receiveState),
      api.onToast(toast),
      api.onRestarted((id) => stack.current?.reload(id)),
      api.onCommand((c: ShellCommand) => {
        const s = stateRef.current;
        if (!s) return;
        const i = s.workspaces.findIndex((w) => w.id === s.activeId);
        switch (c.name) {
          case 'toggleSidebar':
            void api.setUi({ sidebarOpen: !s.ui.sidebarOpen });
            break;
          case 'openSettings':
            openSettings(c.page ?? 'connections', undefined, c.adding);
            break;
          case 'closeTab':
            if (s.activeId) void api.closeWorkspace(s.activeId);
            break;
          case 'reload':
            if (s.activeId) stack.current?.reload(s.activeId);
            break;
          case 'nextTab':
          case 'prevTab': {
            const n = s.workspaces.length;
            if (n > 1) void api.activateWorkspace(s.workspaces[(i + (c.name === 'nextTab' ? 1 : n - 1)) % n].id);
            break;
          }
          case 'selectTab':
            if (s.workspaces[c.index]) void api.activateWorkspace(s.workspaces[c.index].id);
            break;
          case 'devtools':
            if (s.activeId) stack.current?.devtools(s.activeId);
            break;
          case 'quickOpen':
            setSettings(null);
            setQuickOpen(true);
            break;
        }
      }),
    ];
    return () => offs.forEach((off) => off());
  }, [toast, openSettings]);

  // shortcuts that only make sense while the shell itself has focus
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      const s = stateRef.current;
      if (!s || !e.metaKey) return;
      if (/^[1-9]$/.test(e.key)) {
        const ws = e.key === '9' ? s.workspaces.at(-1) : s.workspaces[Number(e.key) - 1];
        if (ws) (e.preventDefault(), void api.activateWorkspace(ws.id));
      }
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, []);

  useEffect(() => {
    if (!pending || !state) return;
    const c = state.connections.find((x) => x.id === pending);
    // a just-added host shows up with the next state push; idle = connect not started yet
    if (!c || c.status === 'idle') return;
    if (c.status === 'error') {
      setPending(undefined);
      return;
    }
    if (c.status !== 'ready' || !c.discoveredAt || c.discovering) return;
    setPending(undefined);
    setSettings((cur) => (cur?.page === 'connections' ? null : cur));
    // the agent with the most recent activity (Codex on a tie)
    const found = c.agents.filter((a) => !a.missing && a.sessions > 0);
    const target = [...found].sort((a, b) => (b.lastActivity ?? 0) - (a.lastActivity ?? 0))[0] ?? c.agents.find((a) => !a.missing);
    if (target) void api.openWorkspace(c.id, target.agent).catch(() => undefined);
    else toast({ level: 'info', title: tr`已连接 ${c.label}`, description: tr("没有找到会话：可以在设置 → 连接里调整这台机器的 Agent 和扫描目录。") });
  }, [pending, state, toast]);

  // popovers and toasts float above the workspace view: refresh its masks whenever they change
  const overlayKey = `${quickOpen}|${toasts.map((t) => t.id).join(',')}`;
  useEffect(() => {
    const t = setTimeout(() => stack.current?.refreshMasks(), 0);
    return () => clearTimeout(t);
  }, [overlayKey]);

  if (!state) return <div className="boot" />;
  const hostKeyConn = state.connections.find((c) => c.hostKey);
  const credentialConn = state.connections.find((c) => c.status === 'error' && ['password_required', 'auth'].includes(c.error?.kind ?? '') && ['password', 'identity'].includes(c.ssh?.authentication ?? ''));
  const cover = Boolean(settings || hostKeyConn || credentialConn);

  return (
    <div className={cx('app', !inApp && 'preview')}>
      {state.ui.sidebarOpen && <Sidebar state={state} onOpenSettings={openSettings} />}
      <div className="main">
        <TitleBar
          state={state}
          quickOpen={quickOpen}
          setQuickOpen={setQuickOpen}
          onOpenSettings={() => openSettings('connections')}
          onOpenAbout={() => openSettings('about')}
          onAddHost={() => openSettings('connections', undefined, true)}
          onConnectAndOpen={connectAndOpen}
        />
        <WorkspaceStack ref={stack} state={state} cover={cover} onOpenSettings={openSettings} onConnectAndOpen={connectAndOpen} />
      </div>
      {settings && <SettingsDialog state={state} target={settings} onClose={() => setSettings(null)} onNavigate={setSettings} onConnecting={setPending} />}
      {hostKeyConn && <HostKeyDialog c={hostKeyConn} />}
      {!hostKeyConn && credentialConn && <SshCredentialDialog key={`${credentialConn.id}:${credentialConn.steps.at(-1)?.at}`} c={credentialConn} onConnecting={setPending} />}
      {toasts.length > 0 && (
        <div className="toasts">
          {toasts.map((t) => (
            <div key={t.id} className={cx('toast', 'kifu-mask', `toast-${t.level}`)}>
              <Icon name={t.level === 'error' ? 'alert' : t.level === 'success' ? 'check' : t.level === 'warn' ? 'shield' : 'circle'} size={15} />
              <div className="toast-text">
                <div className="toast-title">{systemText(t.title)}</div>
                {t.description && <div className="toast-desc">{systemText(t.description)}</div>}
              </div>
              <button className="icon-btn sm" onClick={() => setToasts((all) => all.filter((x) => x.id !== t.id))}>
                <Icon name="x" size={12} />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

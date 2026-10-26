import { systemText, tr } from '../../../src/shared/i18n';
import { useLocale } from '../../../src/shared/i18n/react';
import { useEffect, useRef, useState } from 'react';
import type { AgentView, ConnectionView, ShellState } from '../shared/shell';
import { api } from './rpc';
import type { SettingsPage } from './Settings';
import { AgentIcon, busy, connIcon, connStatusText, cx, Dot, Icon, isRemote, relTime, Spinner } from './ui';

type OpenSettings = (page: SettingsPage, focus?: string, adding?: boolean) => void;

/**
 * Workspace explorer: 本机 (once turned on) and SSH hosts, each with the
 * agents found there (Codex, Claude Code — those the connection scans).
 * Clicking an agent opens (or switches to) its workspace tab — all of its
 * sessions on that machine; for a remote that is not connected yet, opening
 * one connects first.
 */

export function Sidebar({ state, onOpenSettings }: { state: ShellState; onOpenSettings: OpenSettings }) {
  useLocale();
  const [width, setWidth] = useState(state.ui.sidebarWidth);
  const drag = useRef<{ x: number; w: number } | null>(null);
  useEffect(() => setWidth(state.ui.sidebarWidth), [state.ui.sidebarWidth]);

  const startResize = (e: React.MouseEvent) => {
    e.preventDefault();
    drag.current = { x: e.clientX, w: width };
    const move = (ev: MouseEvent) => {
      if (!drag.current) return;
      setWidth(Math.max(200, Math.min(420, drag.current.w + ev.clientX - drag.current.x)));
    };
    const up = (ev: MouseEvent) => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      if (!drag.current) return;
      const w = Math.max(200, Math.min(420, drag.current.w + ev.clientX - drag.current.x));
      drag.current = null;
      void api.setUi({ sidebarWidth: w });
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };

  const active = state.workspaces.find((w) => w.id === state.activeId);
  const activeConn = active && state.connections.find((c) => c.id === active.connId);
  const toggle = (id: string) => {
    const collapsed = state.ui.collapsed.includes(id) ? state.ui.collapsed.filter((x) => x !== id) : [...state.ui.collapsed, id];
    void api.setUi({ collapsed });
  };

  return (
    <aside className="sidebar" style={{ width }}>
      <div className="sidebar-top electrobun-webkit-app-region-drag">
        <span className="grow" />
        <button className="icon-btn electrobun-webkit-app-region-no-drag" title={tr("隐藏侧边栏（⌘B）")} onClick={() => void api.setUi({ sidebarOpen: false })}>
          <Icon name="sidebar" />
        </button>
      </div>
      <div className="sidebar-head">
        <span>{tr("工作区")}</span>
        <button className="icon-btn" title={tr("添加 SSH 主机")} onClick={() => onOpenSettings('connections', undefined, true)}>
          <Icon name="plus" />
        </button>
      </div>
      <div className="sidebar-scroll">
        {state.connections
          .filter((c) => c.enabled)
          .map((c) => (
            <Group key={c.id} c={c} activeId={state.activeId} collapsed={state.ui.collapsed.includes(c.id)} onToggle={() => toggle(c.id)} onOpenSettings={onOpenSettings} />
          ))}
      </div>
      {activeConn && isRemote(activeConn.kind) && <RemoteCard c={activeConn} onOpenSettings={onOpenSettings} />}
      <div className="sidebar-foot">
        <button className="foot-btn" onClick={() => onOpenSettings('connections')}>
          <Icon name="settings" size={14} />{tr("设置")}</button>
        <button className="foot-btn" onClick={() => void api.openLogs()}>
          <Icon name="file" size={14} />{tr("日志")}</button>
      </div>
      <div className="resizer" onMouseDown={startResize} />
    </aside>
  );
}

function Group({ c, activeId, collapsed, onToggle, onOpenSettings }: { c: ConnectionView; activeId?: string; collapsed: boolean; onToggle: () => void; onOpenSettings: OpenSettings }) {
  useLocale();
  const ssh = isRemote(c.kind);
  const connected = c.status === 'ready';
  const offline = ssh && (c.status === 'idle' || c.status === 'error');
  return (
    <div className="group" data-conn={c.id}>
      <div className="group-head" onClick={onToggle}>
        <Icon name={collapsed ? 'chevronRight' : 'chevronDown'} size={12} className="chev" />
        <Icon name={connIcon(c.kind)} size={14} />
        <span className="group-label" title={c.detail}>
          {systemText(c.label)}
        </span>
        {ssh && !connected && <span className={cx('group-state', c.status === 'error' && 'bad')}>{busy(c.status) ? <Spinner size={11} /> : null}{connStatusText(c)}</span>}
        {ssh && connected && <Dot status="ready" />}
        <span className="group-actions" onClick={(e) => e.stopPropagation()}>
          {(!ssh || connected) && (
            <button className="icon-btn sm" title={tr("重新扫描")} disabled={c.discovering} onClick={() => void api.discover(c.id)}>
              <Icon name="refresh" size={13} />
            </button>
          )}
          {ssh && (connected || busy(c.status) || c.status === 'hostkey' ? (
            <button className="icon-btn sm" title={tr("断开")} onClick={() => void api.disconnect(c.id)}>
              <Icon name="power" size={13} />
            </button>
          ) : (
            <button className="icon-btn sm" title={tr("连接")} onClick={() => void api.connect(c.id)}>
              <Icon name="power" size={13} />
            </button>
          ))}
          <button className="icon-btn sm" title={tr("连接设置：Agent 与扫描目录")} onClick={() => onOpenSettings('connections', c.id)}>
            <Icon name="settings" size={13} />
          </button>
        </span>
      </div>
      {!collapsed && (
        <div className="group-body">
          {c.status === 'error' && c.error && (
            <div className="group-error">
              <span title={c.error.detail}>{systemText(c.error.message)}</span>
              <span className="links">
                <button className="link" onClick={() => void api.connect(c.id)}>{tr("重试")}</button>
                <button className="link" onClick={() => onOpenSettings('connections', c.id)}>{tr("详情")}</button>
              </span>
            </div>
          )}
          {ssh && c.status === 'idle' && c.agents.length === 0 && (
            <button className="row-btn" onClick={() => void api.connect(c.id)}>{tr("连接")}{systemText(c.label)}
            </button>
          )}
          {c.agents.map((a) => (
            <AgentRow key={a.agent} c={c} a={a} active={a.workspaceId !== undefined && a.workspaceId === activeId} dim={offline || Boolean(a.missing)} />
          ))}
          {c.discovering && c.agents.length === 0 && <div className="group-note">{tr("正在扫描…")}</div>}
          {c.discoverError && <div className="group-note bad">{systemText(c.discoverError)}</div>}
          {(connected || !ssh) && c.discoveredAt && c.agents.length === 0 && !c.discovering && (
            <div className="group-note">
              {c.scan.some((a) => a.enabled) ? tr`没有找到${c.scan.filter((a) => a.enabled).map((a) => a.label).join('、')}的会话。` : tr("没有启用任何 Agent。")}
              <button className="link" onClick={() => onOpenSettings('connections', c.id)}>{tr("调整扫描设置")}</button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** One agent on the connection: opens (or switches to) its workspace — all of its sessions there. */
function AgentRow({ c, a, active, dim }: { c: ConnectionView; a: AgentView; active: boolean; dim: boolean }) {
  useLocale();
  const meta = [
    a.missing ? tr("这次扫描没有找到") : tr`${a.sessions} 个会话`,
    a.sources > 1 ? tr`${a.sources} 个${a.agent === 'claude' ? tr("项目") : tr("来源")}` : undefined,
    a.lastActivity ? relTime(a.lastActivity) : a.recent ? tr`上次打开 ${relTime(a.recent)}` : undefined,
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <button
      className={cx('home', active && 'active', a.workspaceId && 'open', dim && 'dim')}
      data-agent={a.agent}
      title={a.latestTitle ? tr`最近：${a.latestTitle}` : undefined}
      onClick={() => void api.openWorkspace(c.id, a.agent).catch(() => undefined)}
    >
      <AgentIcon agent={a.agent} size={15} className="home-icon" />
      <span className="home-main">
        <span className="home-title">{a.label}</span>
        {meta && <span className="home-meta">{meta}</span>}
      </span>
      {a.workspaceId && <span className="open-dot" title={tr("已打开")} />}
    </button>
  );
}

/** Show the active workspace’s remote connection and a disconnect action. */
function RemoteCard({ c, onOpenSettings }: { c: ConnectionView; onOpenSettings: OpenSettings }) {
  useLocale();
  const endpoint = c.detail?.split(' · ')[0];
  return (
    <div className="remote-card">
      <div className="remote-row" onClick={() => onOpenSettings('connections', c.id)} title={tr("连接设置")}>
        <Icon name={connIcon(c.kind)} size={15} className="accent" />
        <div className="remote-text">
          <div className="remote-title">{tr("远端：")}{systemText(c.label)}</div>
          {endpoint && <div className="remote-sub">{endpoint}</div>}
        </div>
      </div>
      <div className="remote-state">
        <Dot status={c.status} />
        <span className={cx(c.status === 'error' && 'bad')}>{connStatusText(c)}</span>
        <span className="grow" />
        <button className="small-btn" onClick={() => void api.disconnect(c.id)}>
          <Icon name="power" size={12} />{tr("断开")}</button>
      </div>
    </div>
  );
}

import { systemText, getLocale, tr } from '../../../src/shared/i18n';
import { useLocale } from '../../../src/shared/i18n/react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { AgentKind, ShellState, WorkspaceView } from '../shared/shell';
import { api } from './rpc';
import { isAgentKind } from '../../../src/shared/agents';
import { PRODUCT_ICON, PRODUCT_NAME, PRODUCT_NAME_ZH } from '../../../src/shared/brand';
import { AgentIcon, busy, connIcon, cx, Dot, Icon, isRemote, Spinner, Wordmark, type IconName } from './ui';

/**
 * Title bar = tab strip: one tab per open workspace. Empty
 * areas drag the window; with the sidebar hidden it leaves room for the
 * traffic lights.
 */
export function TitleBar({
  state,
  quickOpen,
  setQuickOpen,
  onOpenSettings,
  onOpenAbout,
  onAddHost,
  onConnectAndOpen,
}: {
  state: ShellState;
  quickOpen: boolean;
  setQuickOpen: (v: boolean) => void;
  onOpenSettings: () => void;
  onOpenAbout: () => void;
  onAddHost: () => void;
  onConnectAndOpen: (id: string) => void;
}) {
  useLocale();
  const [dragId, setDragId] = useState<string>();
  return (
    <div className={cx('titlebar', 'electrobun-webkit-app-region-drag', !state.ui.sidebarOpen && 'lights')}>
      {!state.ui.sidebarOpen && (
        <button className="icon-btn electrobun-webkit-app-region-no-drag" title={tr("显示侧边栏（⌘B）")} onClick={() => void api.setUi({ sidebarOpen: true })}>
          <Icon name="sidebar" />
        </button>
      )}
      <div className="tabs">
        {state.workspaces.map((w, i) => (
          <Tab
            key={w.id}
            ws={w}
            active={w.id === state.activeId}
            dragging={dragId === w.id}
            onDragStart={() => setDragId(w.id)}
            onDragEnd={() => setDragId(undefined)}
            onDrop={() => {
              if (dragId && dragId !== w.id) void api.moveWorkspace(dragId, i);
              setDragId(undefined);
            }}
          />
        ))}
      </div>
      {/* outside the scrolling tab strip so the popover is not clipped */}
      <div className="new-tab-wrap electrobun-webkit-app-region-no-drag">
        <button className={cx('icon-btn', quickOpen && 'on')} title={tr("打开工作区")} onClick={() => setQuickOpen(!quickOpen)}>
          <Icon name="plus" size={15} />
        </button>
        {quickOpen && <QuickOpen state={state} onClose={() => setQuickOpen(false)} onAddHost={onAddHost} onConnectAndOpen={onConnectAndOpen} />}
      </div>
      <span className="grow" />
      <button className="brand-mark electrobun-webkit-app-region-no-drag" title={tr`关于 ${PRODUCT_NAME}（${PRODUCT_NAME_ZH}）`} onClick={onOpenAbout}>
        <img src={PRODUCT_ICON} width={18} height={18} alt="" draggable={false} />
        <Wordmark height={13} />
      </button>
      <button className="icon-btn electrobun-webkit-app-region-no-drag" title={tr("设置（⌘,）")} onClick={onOpenSettings}>
        <Icon name="settings" />
      </button>
    </div>
  );
}

function Tab({ ws, active, dragging, onDragStart, onDragEnd, onDrop }: { ws: WorkspaceView; active: boolean; dragging: boolean; onDragStart: () => void; onDragEnd: () => void; onDrop: () => void }) {
  useLocale();
  return (
    <div
      className={cx('tab', 'electrobun-webkit-app-region-no-drag', active && 'active', dragging && 'dragging')}
      title={`${systemText(ws.connLabel)} · ${ws.title}`}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = 'move';
        onDragStart();
      }}
      onDragEnd={onDragEnd}
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        onDrop();
      }}
      onMouseDown={(e) => {
        if (e.button === 1) {
          e.preventDefault();
          void api.closeWorkspace(ws.id);
        } else if (e.button === 0 && !active) void api.activateWorkspace(ws.id);
      }}
    >
      <AgentIcon agent={ws.agent} size={14} className="tab-icon" />
      {isRemote(ws.kind) && <span className="tab-conn">{systemText(ws.connLabel)}</span>}
      <span className="tab-title">{ws.title}</span>
      {busy(ws.status) ? <Spinner size={11} /> : ws.status === 'error' ? <Dot status="error" /> : null}
      <button
        className="tab-close"
        title={tr("关闭（⌘W）")}
        onMouseDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation();
          void api.closeWorkspace(ws.id);
        }}
      >
        <Icon name="x" size={12} />
      </button>
    </div>
  );
}

/** Search every known home (all connections) and open one; also the way in when the sidebar is hidden. */
function QuickOpen({ state, onClose, onAddHost, onConnectAndOpen }: { state: ShellState; onClose: () => void; onAddHost: () => void; onConnectAndOpen: (id: string) => void }) {
  useLocale();
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), []);
  useEffect(() => {
    // the + button lives in the same wrapper: let its own click toggle the popover
    const down = (e: MouseEvent) => {
      const wrap = box.current?.parentElement;
      if (wrap && !wrap.contains(e.target as Node)) onClose();
    };
    window.addEventListener('mousedown', down);
    return () => window.removeEventListener('mousedown', down);
  }, [onClose]);

  const items = useMemo(() => {
    const out: Array<{ key: string; connId: string; conn: string; icon: IconName | AgentKind; title: string; sub: string; action: () => void }> = [];
    for (const c of state.connections) {
      if (!c.enabled) continue;
      for (const a of c.agents) {
        out.push({
          key: `${c.id}::${a.agent}`,
          connId: c.id,
          conn: c.label,
          icon: a.agent,
          title: a.label,
          sub: a.missing ? tr("这次扫描没有找到") : tr`${a.sessions} 个会话${a.sources > 1 ? tr` · ${a.sources} 个${a.agent === 'claude' ? tr("项目") : tr("来源")}` : ''}`,
          action: () => void api.openWorkspace(c.id, a.agent).catch(() => undefined),
        });
      }
      if (isRemote(c.kind) && c.status !== 'ready' && c.agents.length === 0) {
        out.push({ key: `${c.id}::connect`, connId: c.id, conn: c.label, icon: connIcon(c.kind), title: tr`连接 ${systemText(c.label)}`, sub: c.detail ?? tr("连接后打开它最近使用的 Agent"), action: () => onConnectAndOpen(c.id) });
      }
    }
    const needle = q.trim().toLowerCase();
    return needle ? out.filter((x) => `${x.conn} ${x.title} ${x.sub}`.toLowerCase().includes(needle)) : out;
  }, [state.connections, q, onConnectAndOpen, getLocale()]);

  useEffect(() => setSel(0), [q]);
  const run = (i: number) => {
    const it = items[i];
    if (!it) return;
    it.action();
    onClose();
  };

  return (
    <div className="quick kifu-mask" ref={box} onMouseDown={(e) => e.stopPropagation()}>
      <div className="quick-input">
        <Icon name="search" size={14} />
        <input
          ref={input}
          value={q}
          placeholder={tr("搜索工作区（主机、Agent）")}
          spellCheck={false}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') (e.preventDefault(), setSel((s) => Math.min(items.length - 1, s + 1)));
            else if (e.key === 'ArrowUp') (e.preventDefault(), setSel((s) => Math.max(0, s - 1)));
            else if (e.key === 'Enter') run(sel);
            else if (e.key === 'Escape') onClose();
          }}
        />
      </div>
      <div className="quick-list">
        {items.map((it, i) => (
          <button key={it.key} className={cx('quick-item', i === sel && 'sel')} onMouseEnter={() => setSel(i)} onClick={() => run(i)} title={it.sub}>
            {isAgentKind(it.icon) ? <AgentIcon agent={it.icon} size={14} /> : <Icon name={it.icon} size={13} />}
            <span className="quick-conn">{it.conn}</span>
            <span className="quick-title">{it.title}</span>
          </button>
        ))}
        {items.length === 0 && <div className="quick-empty">{tr("没有匹配的工作区")}</div>}
      </div>
      <button
        className="quick-foot"
        onClick={() => {
          onClose();
          onAddHost();
        }}
      >
        <Icon name="plus" size={13} />{tr("添加 SSH 主机…")}</button>
    </div>
  );
}

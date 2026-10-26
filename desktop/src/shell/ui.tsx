import { systemText, localized, tr } from '../../../src/shared/i18n';
import { useLocale } from '../../../src/shared/i18n/react';
import type { ReactNode } from 'react';
import { AGENT_ICON } from '../../../src/shared/agent-icons';
import { BRAND_GOLD, PRODUCT_NAME, WORDMARK } from '../../../src/shared/brand';
import type { AgentKind, ConnectionView, ConnKind, ConnStatus, StageView, WorkspaceStatus } from '../shared/shell';

export const cx = (...c: Array<string | false | undefined | null | 0>) => c.filter(Boolean).join(' ');

// Lucide icons (ISC; Feather-derived icons retain MIT).
// Copyright notices: licenses/upstream/lucide-LICENSE.txt.
// The original import revision was not recorded.

const PATHS: Record<string, ReactNode> = {
  laptop: <path d="M20 16V7a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v9m16 0H4m16 0 1.28 2.55a1 1 0 0 1-.9 1.45H3.62a1 1 0 0 1-.9-1.45L4 16" />,
  server: (
    <>
      <rect width="20" height="8" x="2" y="2" rx="2" />
      <rect width="20" height="8" x="2" y="14" rx="2" />
      <path d="M6 6h.01M6 18h.01" />
    </>
  ),
  plus: <path d="M5 12h14M12 5v14" />,
  x: <path d="M18 6 6 18M6 6l12 12" />,
  chevronRight: <path d="m9 18 6-6-6-6" />,
  chevronDown: <path d="m6 9 6 6 6-6" />,
  settings: (
    <>
      <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
      <circle cx="12" cy="12" r="3" />
    </>
  ),
  refresh: (
    <>
      <path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8" />
      <path d="M21 3v5h-5" />
    </>
  ),
  power: <path d="M12 2v10M18.4 6.6a9 9 0 1 1-12.77.04" />,
  sidebar: (
    <>
      <rect width="18" height="18" x="3" y="3" rx="2" />
      <path d="M9 3v18" />
    </>
  ),
  folder: <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />,
  box: (
    <>
      <path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z" />
      <path d="m3.3 7 8.7 5 8.7-5M12 22V12" />
    </>
  ),
  home: (
    <>
      <path d="M15 21v-8a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v8" />
      <path d="M3 10a2 2 0 0 1 .709-1.528l7-5.999a2 2 0 0 1 2.582 0l7 5.999A2 2 0 0 1 21 10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
    </>
  ),
  check: <path d="M20 6 9 17l-5-5" />,
  alert: (
    <>
      <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3" />
      <path d="M12 9v4M12 17h.01" />
    </>
  ),
  shield: (
    <>
      <path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z" />
      <path d="M12 8v4M12 16h.01" />
    </>
  ),
  circle: <circle cx="12" cy="12" r="8" />,
  skip: (
    <>
      <circle cx="12" cy="12" r="8" />
      <path d="M8.5 12h7" />
    </>
  ),
  file: (
    <>
      <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" />
      <path d="M14 2v4a2 2 0 0 0 2 2h4M16 13H8M16 17H8M10 9H8" />
    </>
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </>
  ),
};

export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 16, className }: { name: IconName; size?: number; className?: string }) {
  useLocale();
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className={cx('icon', className)} aria-hidden="true">
      {PATHS[name]}
    </svg>
  );
}

export function connIcon(kind: ConnKind): IconName {
  return kind === 'ssh' ? 'server' : 'laptop';
}

export const isRemote = (kind: ConnKind) => kind !== 'local';

/** The drawn Kifu wordmark in the surrounding text colour, its spark in gold. */
export function Wordmark({ height = 14, className }: { height?: number; className?: string }) {
  useLocale();
  return (
    <svg viewBox={WORDMARK.viewBox} height={height} width={(height * WORDMARK.width) / WORDMARK.height} className={className} role="img" aria-label={PRODUCT_NAME}>
      <g fill="currentColor">
        {WORDMARK.fills.map((d) => (
          <path key={d} d={d} />
        ))}
      </g>
      <g fill="none" stroke="currentColor" strokeWidth={WORDMARK.stroke}>
        {WORDMARK.strokes.map((d) => (
          <path key={d} d={d} />
        ))}
      </g>
      <path d={WORDMARK.spark} fill={BRAND_GOLD} />
    </svg>
  );
}

/** The agent's own logo (Codex, Claude). */
export function AgentIcon({ agent, size = 16, className }: { agent: AgentKind; size?: number; className?: string }) {
  useLocale();
  return <img src={AGENT_ICON[agent]} width={size} height={size} alt="" draggable={false} className={cx('agent-icon', className)} />;
}

export function Switch({ on, onChange, disabled, label }: { on: boolean; onChange: (on: boolean) => void; disabled?: boolean; label?: string }) {
  useLocale();
  return (
    <button type="button" role="switch" aria-checked={on} aria-label={label} title={label} disabled={disabled} className={cx('switch', on && 'on')} onClick={() => onChange(!on)}>
      <span className="knob" />
    </button>
  );
}

export function Spinner({ size = 14 }: { size?: number }) {
  useLocale();
  return <span className="spinner" style={{ width: size, height: size }} />;
}

// ---- status ------------------------------------------------------------------------------

export const CONN_STATUS: Record<ConnStatus, string> = localized({
  idle: '未连接',
  connecting: '连接中…',
  hostkey: '待确认指纹',
  installing: '安装服务端…',
  ready: '已连接',
  reconnecting: '重连中…',
  error: '连接失败',
});

export function connStatusText(c: ConnectionView): string {
  if (c.status === 'installing' && c.progress?.total) return tr`安装服务端 ${Math.round((c.progress.done / c.progress.total) * 100)}%`;
  return CONN_STATUS[c.status];
}

export function busy(status: ConnStatus | WorkspaceStatus): boolean {
  return status === 'connecting' || status === 'installing' || status === 'reconnecting' || status === 'starting' || status === 'restarting';
}

export function Dot({ status }: { status: ConnStatus | WorkspaceStatus }) {
  useLocale();
  const tone = status === 'ready' ? 'ok' : status === 'error' ? 'bad' : status === 'hostkey' ? 'info' : busy(status) ? 'busy' : 'off';
  return <span className={cx('dot', `dot-${tone}`)} />;
}

export function StageList({ stages, progress }: { stages: StageView[]; progress?: ConnectionView['progress'] }) {
  useLocale();
  return (
    <ol className="stages">
      {stages.map((s) => (
        <li key={s.id} className={cx('stage', `stage-${s.status}`)}>
          <span className="stage-icon">
            {s.status === 'success' ? <Icon name="check" size={14} /> : s.status === 'running' ? <Spinner size={13} /> : s.status === 'error' ? <Icon name="x" size={14} /> : s.status === 'skipped' ? <Icon name="skip" size={14} /> : <Icon name="circle" size={14} />}
          </span>
          <span className="stage-label">{systemText(s.label)}</span>
          {s.message && <span className="stage-msg" title={systemText(s.message)}>{systemText(s.message)}</span>}
          {s.id === 'install' && s.status === 'running' && progress?.total ? <ProgressBar done={progress.done} total={progress.total} /> : null}
        </li>
      ))}
    </ol>
  );
}

export function ProgressBar({ done, total }: { done: number; total: number }) {
  useLocale();
  const pct = total ? Math.min(100, Math.round((done / total) * 100)) : 0;
  const mb = (n: number) => (n / 1024 / 1024).toFixed(1);
  return (
    <div className="progress">
      <div className="bar">
        <div style={{ width: `${pct}%` }} />
      </div>
      <span>
        {mb(done)} / {mb(total)} MB
      </span>
    </div>
  );
}

/** What to do about a connection error, beyond the message itself. */
export function ErrorHint({ conn }: { conn: ConnectionView }) {
  useLocale();
  const kind = conn.error?.kind;
  if (kind === 'kerberos')
    return (
      <p className="hint">{tr("在终端执行")}<code className="cmd">kinit</code>{tr("，然后点「重试」。")}</p>
    );
  if (kind === 'auth')
    return (
      <p className="hint">{tr("先确认在终端执行")}<code className="cmd">ssh {conn.alias}</code>{tr("不需要输入密码就能登录。")}</p>
    );
  if (kind === 'dns' || kind === 'timeout' || kind === 'proxy') return <p className="hint">{tr("检查网络、VPN 或跳板机后重试。")}</p>;
  return null;
}

// ---- formatting -------------------------------------------------------------------------

export function relTime(ms?: number): string {
  if (!ms) return '';
  const d = Date.now() - ms;
  if (d < 60_000) return tr("刚刚");
  if (d < 3600_000) return tr`${Math.floor(d / 60_000)} 分钟前`;
  if (d < 86400_000) return tr`${Math.floor(d / 3600_000)} 小时前`;
  return tr`${Math.floor(d / 86400_000)} 天前`;
}

export function displayPath(p: string, homeDir?: string): string {
  return homeDir && p.startsWith(`${homeDir}/`) ? `~${p.slice(homeDir.length)}` : p;
}

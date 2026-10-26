import { AddSsh } from './AddSsh';
import { systemText, getLocale, tr, localized } from '../../../src/shared/i18n';
import { useLocale, LanguageSelect } from '../../../src/shared/i18n/react';
import { useEffect, useRef, useState } from 'react';
import { PRODUCT_COPYRIGHT, PRODUCT_LICENSE, PRODUCT_ICON_FULL, PRODUCT_NAME, PRODUCT_NAME_ZH, TAGLINE } from '../../../src/shared/brand';
import type { AgentScanView, ConnectionView, ShellState } from '../shared/shell';
import { api } from './rpc';
import { AgentIcon, connIcon, connStatusText, cx, displayPath, Dot, ErrorHint, Icon, isRemote, StageList, Switch } from './ui';

export type SettingsPage = 'connections' | 'about';

export interface SettingsTarget {
  page: SettingsPage;
  focus?: string;
  adding?: boolean;
}

/** In-window application and connection settings. */
export function SettingsDialog({ state, target, onClose, onNavigate, onConnecting }: { state: ShellState; target: SettingsTarget; onClose: () => void; onNavigate: (t: SettingsTarget) => void; onConnecting: (id: string) => void }) {
  useLocale();
  useEffect(() => {
    const key = (e: KeyboardEvent) => e.key === 'Escape' && !document.querySelector('.modal.hostkey') && onClose();
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [onClose]);
  const nav: Array<[SettingsPage, string]> = [
    ['connections', tr("连接")],
    ['about', tr("关于")],
  ];
  return (
    <div className="modal-backdrop kifu-mask" onMouseDown={onClose}>
      <div className="modal settings" onMouseDown={(e) => e.stopPropagation()}>
        <nav className="settings-nav">
          <div className="settings-title">{tr("设置")}</div>
          {nav.map(([id, label]) => (
            <button key={id} className={cx('nav-item', target.page === id && 'active')} onClick={() => onNavigate({ page: id })}>
              {label}
            </button>
          ))}
        </nav>
        <section className="settings-body">
          <div className="language-settings">
            <LanguageSelect value={state.ui.language ?? 'system'} onChange={(language) => { void api.setUi({ language }); }} />
            <p className="muted small">{tr('简体中文系统使用中文，其他系统语言使用英文。手动选择会保留，下次启动继续生效。')}</p>
          </div>
          <button className="icon-btn modal-close" title={tr("关闭（Esc）")} onClick={onClose}>
            <Icon name="x" />
          </button>
          {target.page === 'connections' && <ConnectionsPage state={state} target={target} onNavigate={onNavigate} onConnecting={onConnecting} />}
          {target.page === 'about' && <AboutPage state={state} />}
        </section>
      </div>
    </div>
  );
}

function listSub(c: ConnectionView): string {
  if (c.kind === 'local') return c.enabled ? (c.agents.length ? c.agents.map((a) => a.label).join('、') : tr("已启用")) : tr("未启用");
  return c.detail?.split(' · ')[0] ?? tr("未连接过");
}

/** Every connection (本机 first), each with the agents it scans; add SSH hosts here. */
function ConnectionsPage({ state, target, onNavigate, onConnecting }: { state: ShellState; target: SettingsTarget; onNavigate: (t: SettingsTarget) => void; onConnecting: (id: string) => void }) {
  useLocale();
  const adding = Boolean(target.adding);
  const selected = state.connections.find((c) => c.id === target.focus) ?? state.connections[0];
  const added = (id: string) => {
    onNavigate({ page: 'connections', focus: id });
    onConnecting(id);
    void api.connect(id);
  };
  return (
    <div className="remote-page">
      <aside className="remote-list">
        <div className="list-head">
          <span>{tr("连接")}</span>
          <button className="icon-btn sm" title={tr("添加 SSH 主机")} onClick={() => onNavigate({ page: 'connections', adding: true })}>
            <Icon name="plus" size={14} />
          </button>
        </div>
        {state.connections.map((c) => (
          <button key={c.id} data-conn={c.id} className={cx('list-item', !adding && selected?.id === c.id && 'active', !c.enabled && 'off')} onClick={() => onNavigate({ page: 'connections', focus: c.id })}>
            <Icon name={connIcon(c.kind)} size={14} />
            <span className="list-text">
              <span className="list-title">{systemText(c.label)}</span>
              <span className="list-sub">{listSub(c)}</span>
            </span>
            {isRemote(c.kind) ? <Dot status={c.status} /> : <Dot status={c.enabled ? 'ready' : 'idle'} />}
          </button>
        ))}
        <button className={cx('list-item', 'add-item', adding && 'active')} onClick={() => onNavigate({ page: 'connections', adding: true })}>
          <Icon name="plus" size={14} />
          <span className="list-text">
            <span className="list-title">{tr("添加连接")}</span>
            <span className="list-sub">{tr("SSH 主机")}</span>
          </span>
        </button>
      </aside>
      <div className="remote-detail">
        {adding ? <AddSsh state={state} onAdded={added} /> : selected ? <ConnectionDetails key={selected.id} c={selected} onConnecting={onConnecting} /> : null}
      </div>
    </div>
  );
}

const SCAN_HINT: Record<AgentScanView['agent'], string> = localized({
  codex: '查找 CODEX_HOME（含 state_5.sqlite 或 sessions/ 的目录）。找到多个时合在一个 Codex 工作区里。',
  claude: '查找 Claude Code 的配置目录（含 projects/ 的目录，如 ~/.claude）。每个项目是一个来源。',
});

/** One agent on the connection: scanned or not, where, and what the last scan found. */
function AgentScanCard({ c, scan }: { c: ConnectionView; scan: AgentScanView }) {
  useLocale();
  const [text, setText] = useState(scan.roots.join('\n'));
  const saved = scan.roots.join('\n');
  useEffect(() => setText(saved), [saved]);
  const found = c.agents.find((a) => a.agent === scan.agent && !a.missing);
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const dirty = lines.join('\n') !== saved;
  const scanned = c.kind === 'local' ? c.enabled && Boolean(c.discoveredAt) : c.status === 'ready' && Boolean(c.discoveredAt);
  let status: string;
  if (!scan.enabled) status = tr("不扫描");
  else if (c.discovering) status = tr("扫描中…");
  else if (found) status = tr`${found.sessions} 个会话 · ${found.sources} 个${scan.agent === 'claude' ? tr("项目") : tr("目录")}`;
  else if (scanned) status = tr("没有找到");
  else status = isRemote(c.kind) ? tr("连接后扫描") : tr("启用后扫描");
  return (
    <div className={cx('agent-card', !scan.enabled && 'off')} data-agent={scan.agent}>
      <div className="agent-card-head">
        <AgentIcon agent={scan.agent} size={18} />
        <span className="agent-card-title">{scan.label}</span>
        <span className={cx('agent-card-status', found && scan.enabled && 'found')}>{status}</span>
        <span className="grow" />
        <Switch on={scan.enabled} label={scan.enabled ? tr`不再扫描 ${scan.label}` : tr`扫描 ${scan.label}`} onChange={(on) => void api.setAgentScan(c.id, scan.agent, { enabled: on })} />
      </div>
      {scan.enabled && (
        <>
          <p className="muted small">{SCAN_HINT[scan.agent]}</p>
          <label className="field-label">{tr("扫描目录（每行一个）")}</label>
          <textarea rows={Math.min(5, Math.max(2, lines.length + 1))} spellCheck={false} value={text} placeholder={scan.defaultRoots.join('\n')} onChange={(e) => setText(e.target.value)} />
          {found?.paths && found.paths.length > 0 && (
            <div className="found-paths small" title={found.paths.join('\n')}>{tr("找到：")}{found.paths.slice(0, 3).map((p) => displayPath(p, c.homeDir)).join('、')}
              {found.paths.length > 3 ? tr` 等 ${found.paths.length} 个` : ''}
            </div>
          )}
          <div className="actions">
            <button className="primary" disabled={!dirty} onClick={() => void api.setAgentScan(c.id, scan.agent, { roots: lines })}>{tr("保存")}{scanned ? tr("并重新扫描") : ''}
            </button>
            {scan.custom && (
              <button onClick={() => void api.setAgentScan(c.id, scan.agent, { roots: [] })} title={scan.defaultRoots.join('\n')}>{tr("恢复默认")}</button>
            )}
            {dirty && <button className="ghost" onClick={() => setText(saved)}>{tr("撤销修改")}</button>}
          </div>
        </>
      )}
    </div>
  );
}

function ConnectionDetails({ c, onConnecting }: { c: ConnectionView; onConnecting: (id: string) => void }) {
  useLocale();
  const [confirm, setConfirm] = useState(false);
  useEffect(() => {
    if (!confirm) return;
    const t = setTimeout(() => setConfirm(false), 3000);
    return () => clearTimeout(t);
  }, [confirm]);
  const remote = isRemote(c.kind);
  const connected = c.status !== 'idle' && c.status !== 'error';
  return (
    <div className="detail-col">
      <div className="detail-head">
        <div className="grow">
          <h3>
            {systemText(c.label)}
            {remote ? <span className={cx('pill', `pill-${c.status}`)}>{connStatusText(c)}</span> : <span className={cx('pill', c.enabled && 'pill-ready')}>{c.enabled ? tr("已启用") : tr("未启用")}</span>}
          </h3>
          {c.detail && <div className="muted small">{c.detail}</div>}
        </div>
        {!remote && <Switch on={c.enabled} label={c.enabled ? tr("停用本机") : tr("启用本机")} onChange={(on) => void api.setEnabled(c.id, on)} />}
      </div>
      {!remote && !c.enabled && <p className="muted">{tr("启用后扫描这台电脑上的 Codex 和 Claude Code 会话（按下面的设置），在左侧栏里出现「本机」。停用会关闭本机的标签。")}</p>}
      {remote && c.stages.some((s) => s.status !== 'pending') && (
        <div className="box">
          <div className="box-title">{tr("连接过程")}</div>
          <StageList stages={c.stages} progress={c.progress} />
        </div>
      )}
      {c.status === 'error' && c.error && (
        <div className="callout bad">
          <div className="callout-title">{systemText(c.error.message)}</div>
          <ErrorHint conn={c} />
          {c.error.detail && (
            <details className="details">
              <summary>{tr("详细信息")}</summary>
              <pre>{c.error.detail}</pre>
            </details>
          )}
        </div>
      )}
      {remote && (
        <div className="actions">
          {!connected ? (
            <button
              className="primary"
              onClick={() => {
                onConnecting(c.id);
                void api.connect(c.id);
              }}
            >
              {c.status === 'error' ? tr("重试") : tr("连接")}
            </button>
          ) : (
            <button onClick={() => void api.disconnect(c.id)}>{tr("断开")}</button>
          )}
          {c.status === 'ready' && (
            <button onClick={() => void api.discover(c.id)} disabled={c.discovering}>
              {c.discovering ? tr("扫描中…") : tr("重新扫描")}
            </button>
          )}
          <span className="grow" />
          <button className={cx('ghost-danger', confirm && 'confirming')} onClick={() => (confirm ? void api.removeConnection(c.id) : setConfirm(true))}>
            {confirm ? tr("确认移除？") : tr("移除")}
          </button>
        </div>
      )}
      <div className="section-head">
        <span>{tr("Agent 与扫描目录")}</span>
        {!remote && c.enabled && (
          <button className="link small" onClick={() => void api.discover(c.id)} disabled={c.discovering}>
            {c.discovering ? tr("扫描中…") : tr("重新扫描")}
          </button>
        )}
      </div>
      <p className="muted small section-note">{tr("选择在")}{c.kind === 'local' ? tr("这台电脑") : tr("这台机器")}{tr("上查找哪些 Agent 的会话，以及去哪里找。每行一个位置，支持 ~、开头的 $变量（如 $CODEX_HOME，取")}{remote ? tr("远端") : ''}{tr("登录 shell 里的值）和路径里的 *，最多向下找 3 层。")}</p>
      {c.scan.map((s) => (
        <AgentScanCard key={s.agent} c={c} scan={s} />
      ))}
      {c.steps.length > 0 && (
        <details className="log">
          <summary>{remote ? tr("连接日志") : tr("日志")}</summary>
          <ol>
            {c.steps
              .slice()
              .reverse()
              .map((s, i) => (
                <li key={`${s.at}-${i}`} className={`log-${s.level}`}>
                  <time>{new Date(s.at).toLocaleTimeString(getLocale(), { hour12: false })}</time>
                  <span>{systemText(s.text)}</span>
                </li>
              ))}
          </ol>
        </details>
      )}
    </div>
  );
}

function AboutPage({ state }: { state: ShellState }) {
  useLocale();
  return (
    <div className="detail-col">
      <div className="about-head">
        <img src={PRODUCT_ICON_FULL} width={64} height={64} alt="" draggable={false} />
        <div>
          <h3>
            {PRODUCT_NAME} <span className="muted">{PRODUCT_NAME_ZH}</span>
          </h3>
          <p className="muted">{tr(TAGLINE)}</p>
        </div>
      </div>
      <p className="muted">{tr("版本")}{state.version}{tr("。Codex 和 Claude Code 会话的执行过程可视化和问题定位，Codex 会话的回放调试、评测，以及 skill 调优和提炼。")}</p>
      <p className="muted">{PRODUCT_COPYRIGHT} · {PRODUCT_LICENSE}</p>
      <p className="muted small">{tr('Kifu 是独立项目，非 OpenAI 或 Anthropic 官方产品。第三方组件保留各自的许可证与版权。')}</p>
      <p className="muted small">{tr('许可证与第三方通知随应用附在 Contents/Resources/app/licenses 目录中。')}</p>
      <div className="box">
        <div className="kv">
          <span>{tr("日志")}</span>
          <code>{state.logDir}</code>
        </div>
        <div className="kv">
          <span>{tr("数据")}</span>
          <code>{tr("~/.kifu（本机和每台远端各自一份）")}</code>
        </div>
      </div>
      <div className="actions">
        <button onClick={() => void api.openLogs()}>{tr("打开日志目录")}</button>
      </div>
    </div>
  );
}

/** Host key confirmation, wherever the connection was started from. */
export function HostKeyDialog({ c }: { c: ConnectionView }) {
  useLocale();
  const k = c.hostKey!;
  const changed = k.kind === 'changed';
  const [verified, setVerified] = useState(false);
  useEffect(() => setVerified(false), [k.fingerprint]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => e.key === 'Escape' && void api.answerHostKey(c.id, false);
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [c.id]);
  return (
    <div className="modal-backdrop kifu-mask">
      <div className="modal hostkey">
        <h3 className={cx(changed && 'bad')}>{changed ? tr`${systemText(c.label)} 的主机指纹变了` : tr`信任 ${systemText(c.label)}？`}</h3>
        <p className="muted">
          {changed
            ? tr("远端返回的指纹和 known_hosts 中的记录不一致。可能是主机重装，也可能是中间人攻击。请先通过可信渠道核对新指纹。")
            : tr("第一次连接这台主机。请核对下面的指纹，例如在远端执行 ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub，或向管理员确认。")}
        </p>
        <div className="box">
          <div className="kv">
            <span>{tr("主机")}</span>
            <code>{k.hostId}</code>
          </div>
          <div className="kv">
            <span>{tr("密钥类型")}</span>
            <code>{k.keyType}</code>
          </div>
          <div className="kv fp">
            <span>{tr("指纹")}</span>
            <code>{k.fingerprint}</code>
          </div>
          <div className="kv">
            <span>known_hosts</span>
            <code>{k.knownHostsFile}</code>
          </div>
          {changed && k.offending && (
            <div className="kv">
              <span>{tr("旧记录")}</span>
              <code>{k.offending}</code>
            </div>
          )}
        </div>
        {changed && (
          <label className="check">
            <input type="checkbox" checked={verified} onChange={(e) => setVerified(e.target.checked)} />{tr("我已经通过可信渠道核对了新指纹")}</label>
        )}
        <p className="muted small">{tr("确认后写入 known_hosts，写入前会先备份原文件。")}</p>
        <div className="actions end">
          <button onClick={() => void api.answerHostKey(c.id, false)}>{tr("取消")}</button>
          <button className={changed ? 'danger' : 'primary'} disabled={changed && !verified} onClick={() => void api.answerHostKey(c.id, true)}>
            {changed ? tr("替换为新指纹并连接") : tr("信任并连接")}
          </button>
        </div>
      </div>
    </div>
  );
}

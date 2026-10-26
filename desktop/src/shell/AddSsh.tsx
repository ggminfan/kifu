import { useState } from 'react';
import { systemText, tr } from '../../../src/shared/i18n';
import { useLocale } from '../../../src/shared/i18n/react';
import { normalizeSshInput, type AddSshInput, type SshOptions } from '../shared/ssh';
import type { ConnectionView, ShellState } from '../shared/shell';
import { api } from './rpc';
import { cx, Icon } from './ui';

const modes: NonNullable<SshOptions['authentication']>[] = ['auto', 'identity', 'password'];
const modeLabel = (mode: typeof modes[number]) => mode === 'auto' ? tr('自动／免密') : mode === 'identity' ? tr('身份文件') : tr('密码');

export function AddSsh({ state, onAdded }: { state: ShellState; onAdded: (id: string) => void }) {
  useLocale();
  const [manual, setManual] = useState(false);
  const [selected, setSelected] = useState('');
  const [label, setLabel] = useState('');
  const [host, setHost] = useState('');
  const [user, setUser] = useState('');
  const [port, setPort] = useState('');
  const [authentication, setAuthentication] = useState<typeof modes[number]>('auto');
  const [identityFile, setIdentityFile] = useState('');
  const [secret, setSecret] = useState('');
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const save = async () => {
    setError('');
    if (manual && authentication === 'password' && !secret) { setError(tr('请输入 SSH 密码后连接')); return; }
    const input: AddSshInput = manual ? { alias: host, label, user, port: port ? Number(port) : undefined, authentication, identityFile, secret } : { alias: selected };
    try {
      normalizeSshInput(input);
      setBusy(true);
      const { id } = await api.addSsh(input);
      setSecret('');
      onAdded(id);
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  const refresh = async () => {
    setRefreshing(true); setError('');
    try { await api.refreshSshHosts(); setSelected(''); } catch (e) { setError((e as Error).message); } finally { setRefreshing(false); }
  };
  return (
    <form className="detail-col ssh-add" onSubmit={(e) => { e.preventDefault(); void save(); }}>
      <div className="detail-head"><h3>{tr('添加 SSH 连接')}</h3></div>
      <div className="ssh-mode" aria-label={tr('连接来源')}>
        <button type="button" aria-pressed={!manual} className={cx(!manual && 'active')} onClick={() => { setManual(false); setSecret(''); setError(''); }}>{tr('自动发现')}</button>
        <button type="button" aria-pressed={manual} className={cx(manual && 'active')} onClick={() => { setManual(true); setError(''); }}>{tr('手动添加')}</button>
      </div>
      {!manual ? <>
        <p className="muted small">{tr('读取 ~/.ssh/config 及其 Include 中的主机，不会扫描网络或自动连接。')}</p>
        <div className="ssh-discovery" role="listbox" aria-label={tr('已发现的 SSH 连接')}>
          {!state.sshHosts.length && <div className="ssh-empty"><Icon name="server" size={28} /><span>{tr('未发现 SSH 连接')}</span><span className="muted small">{tr('可以刷新配置，或手动填写主机信息。')}</span></div>}
          {state.sshHosts.map((alias) => <button key={alias} type="button" role="option" aria-selected={selected === alias} className={cx('ssh-discovered', selected === alias && 'selected')} onClick={() => setSelected(alias)}><Icon name="server" size={16} /><span>{alias}</span>{selected === alias && <Icon name="check" size={16} />}</button>)}
        </div>
        <div className="actions"><button type="button" disabled={refreshing || busy} onClick={() => void refresh()}>{refreshing ? tr('刷新中…') : tr('刷新')}</button><span className="grow" /><button type="submit" className="primary" disabled={!selected || busy}>{busy ? tr('正在保存…') : tr('添加并连接')}</button></div>
      </> : <>
        <label className="ssh-field">{tr('显示名称（可选）')}<input autoFocus value={label} maxLength={100} placeholder={tr('例如：开发服务器')} onChange={(e) => setLabel(e.target.value)} /></label>
        <label className="ssh-field">{tr('主机名')}<input required value={host} placeholder="host.com / user@host.com / 192.0.2.1" autoCapitalize="off" autoCorrect="off" spellCheck={false} onChange={(e) => setHost(e.target.value)} /></label>
        <div className="ssh-fields-row">
          <label className="ssh-field">{tr('用户名（可选）')}<input value={user} placeholder={tr('使用当前用户或 SSH 配置')} autoCapitalize="off" spellCheck={false} onChange={(e) => setUser(e.target.value)} /></label>
          <label className="ssh-field">{tr('SSH 端口（可选）')}<input type="number" min={1} max={65535} step={1} value={port} placeholder="22" onChange={(e) => setPort(e.target.value)} /></label>
        </div>
        <div className="ssh-mode" aria-label={tr('认证方式')}>
          {modes.map((mode) => <button key={mode} type="button" aria-pressed={authentication === mode} className={cx(authentication === mode && 'active')} onClick={() => { setAuthentication(mode); setSecret(''); setError(''); }}>{modeLabel(mode)}</button>)}
        </div>
        {authentication === 'auto' && <p className="muted small">{tr('使用 SSH 配置、ssh-agent、已有密钥或 Kerberos；服务器允许时也支持无需凭证的连接。')}</p>}
        {authentication === 'identity' && <label className="ssh-field">{tr('身份文件路径')}<div className="add-row"><input required value={identityFile} placeholder="~/.ssh/id_ed25519" spellCheck={false} onChange={(e) => setIdentityFile(e.target.value)} /><button type="button" onClick={() => { void api.chooseIdentityFile().then((file) => { if (file) setIdentityFile(file); }).catch((e) => setError(e.message)); }}>{tr('选择文件')}</button></div></label>}
        {authentication !== 'auto' && <label className="ssh-field">{authentication === 'password' ? tr('SSH 密码') : tr('密钥口令（可选）')}<input type="password" maxLength={4096} autoComplete="new-password" value={secret} required={authentication === 'password'} onChange={(e) => setSecret(e.target.value)} /></label>}
        <p className="muted small">{tr('仅保存连接信息和身份文件路径。密码或口令仅用于当前连接，断开或退出后清除。')}</p>
        <div className="actions end"><button type="button" disabled={busy} onClick={() => { setManual(false); setSecret(''); }}>{tr('返回')}</button><button type="submit" className="primary" disabled={!host.trim() || busy}>{busy ? tr('正在保存…') : tr('保存并连接')}</button></div>
      </>}
      {error && <div role="alert" className="error-text">{systemText(error)}</div>}
      <p className="muted small">{tr('首次连接须确认主机指纹；连接成功后自动发现 Codex 和 Claude Code 会话。')}</p>
    </form>
  );
}

export function SshCredentialDialog({ c, onConnecting }: { c: ConnectionView; onConnecting: (id: string) => void }) {
  useLocale();
  const [secret, setSecret] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const cancel = () => { setSecret(''); void api.disconnect(c.id); };
  return <div className="modal-backdrop kifu-mask" onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); cancel(); } }}>
    <form className="modal hostkey ssh-credential" role="dialog" aria-modal="true" aria-label={tr('SSH 身份验证')} onSubmit={(e) => {
      e.preventDefault(); setBusy(true); setError('');
      void api.connect(c.id, secret).then(() => { setSecret(''); onConnecting(c.id); }).catch((err) => { setError(err.message); setBusy(false); });
    }}>
      <h3>{tr('SSH 身份验证')}</h3><p>{c.label}</p>
      <p className="muted small">{systemText(c.error?.message ?? '')}</p>
      <label className="ssh-field">{c.ssh?.authentication === 'password' ? tr('SSH 密码') : tr('密钥口令')}<input autoFocus required type="password" maxLength={4096} autoComplete="new-password" value={secret} onChange={(e) => setSecret(e.target.value)} /></label>
      <p className="muted small">{tr('仅保留在当前连接的内存中，不写入磁盘。')}</p>
      {error && <p role="alert" className="error-text">{systemText(error)}</p>}
      <div className="actions end"><button type="button" onClick={cancel}>{tr('取消')}</button><button className="primary" type="submit" disabled={busy || !secret}>{busy ? tr('正在连接…') : tr('连接')}</button></div>
    </form>
  </div>;
}

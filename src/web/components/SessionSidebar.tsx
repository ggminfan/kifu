import { useLocale } from '../../shared/i18n/react';
import { tr, localized } from '../../shared/i18n';
import { useEffect, useState } from 'react';
import { useLocation, useSearch } from 'wouter';
import type { SessionSummary, SessionTreeNode } from '../../shared/api';
import { useHealth, useIndexStatus, useSessions, useSkillUsage, useTree } from '../lib/api';
import { basename, fmtTokens, relTime, shortId } from '../lib/format';
import { AddToSetDialog } from './eval/AddToSet';
import { Badge, Button, ErrorBox, Spinner, cx } from './ui';

function useDebounced<T>(v: T, ms: number): T {
  const [d, setD] = useState(v);
  useEffect(() => {
    const t = setTimeout(() => setD(v), ms);
    return () => clearTimeout(t);
  }, [v, ms]);
  return d;
}

function SessionRow({ s, selected, onOpen, showSource, picked }: { s: SessionSummary; selected: boolean; onOpen: (id: string) => void; showSource: boolean; picked?: { on: boolean; toggle: () => void } }) {
  useLocale();
  const title = s.title || s.firstUserMessage || s.agentNickname || s.id;
  return (
    <button
      data-session-row
      onClick={() => (picked ? picked.toggle() : onOpen(s.id))}
      className={cx(
        'block w-full border-b border-zinc-100 px-3 py-2 text-left hover:bg-zinc-100 dark:border-zinc-900 dark:hover:bg-zinc-900',
        selected && !picked && 'bg-indigo-50 dark:bg-indigo-950/50',
        picked?.on && 'bg-indigo-50 dark:bg-indigo-950/50',
        !s.rolloutExists && 'opacity-60',
      )}
      title={s.rolloutExists ? undefined : tr("记录文件已经不在了（被删除或移走），打开只能看到这条提示")}
    >
      <div className="flex items-start gap-2">
        {picked && <input type="checkbox" readOnly checked={picked.on} className="mt-0.5 shrink-0" tabIndex={-1} />}
        <div className="line-clamp-2 min-w-0 flex-1 text-[12.5px] font-medium leading-snug">{title}</div>
      </div>
      <div className="mt-1 flex items-center gap-1.5 text-[11px] text-zinc-500">
        {showSource && s.sourceLabel && (
          <span className="shrink-0 rounded bg-zinc-100 px-1 text-[10.5px] text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300" title={tr("来源")}>
            {s.sourceLabel}
          </span>
        )}
        <span className="truncate" title={s.cwd}>{basename(s.cwd)}</span>
        <span>·</span>
        <span className="shrink-0">{relTime(s.updatedAt)}</span>
        <span className="flex-1" />
        {s.summary && s.summary.toolErrors > 0 && <Badge tone="red" title={tr("失败的工具调用")}>✗ {s.summary.toolErrors}</Badge>}
        {s.summary && s.summary.skills.length > 0 && <Badge tone="amber" title={s.summary.skills.join('\n')}>⚑ {s.summary.skills.length}</Badge>}
        {s.childCount > 0 && <Badge tone="pink" title={tr("子 agent 数量")}>⑂ {s.childCount}</Badge>}
        <span className="shrink-0 font-mono">{fmtTokens(s.tokensUsed)}</span>
      </div>
    </button>
  );
}

function TreeNode({ node, depth, current, onOpen }: { node: SessionTreeNode; depth: number; current?: string; onOpen: (id: string) => void }) {
  useLocale();
  const s = node.session;
  const label = s.agentNickname ? `${s.agentNickname}${s.agentRole ? ` · ${s.agentRole}` : ''}` : s.title || s.firstUserMessage || shortId(s.id);
  return (
    <>
      <button
        onClick={() => onOpen(s.id)}
        className={cx('flex w-full items-center gap-1 py-0.5 pr-2 text-left text-[12px] hover:bg-zinc-100 dark:hover:bg-zinc-900', current === s.id && 'bg-indigo-50 font-medium text-indigo-700 dark:bg-indigo-950/50 dark:text-indigo-300')}
        style={{ paddingLeft: 8 + depth * 14 }}
        title={s.agentPath ?? s.id}
      >
        <span className="text-zinc-400">{depth ? '└' : '●'}</span>
        <span className="min-w-0 flex-1 truncate">{label}</span>
        {!s.rolloutExists && <span className="text-amber-600">!</span>}
        <span className="font-mono text-[10px] text-zinc-400">{fmtTokens(s.tokensUsed)}</span>
      </button>
      {node.children.map((c) => (
        <TreeNode key={c.session.id} node={c} depth={depth + 1} current={current} onOpen={onOpen} />
      ))}
    </>
  );
}

const SIGNAL_LABEL: Record<string, string> = localized({ loaded: '加载了', missed: '可能漏触发', truncated: '描述被截断', listed: '列出了' });
const MISSING_KEY = 'kifu.sessions.missingOpen';
const MAX_PICK = 100;

export function SessionSidebar({ selectedId, onOpen, onCollapse }: { selectedId?: string; onOpen: (id: string) => void; onCollapse?: () => void }) {
  useLocale();
  const [q, setQ] = useState('');
  const [sub, setSub] = useState(false);
  const [errors, setErrors] = useState(false);
  const search = useSearch();
  const [skill, setSkill] = useState(() => new URLSearchParams(search).get('skill') ?? '');
  const [signal, setSignal] = useState(() => new URLSearchParams(search).get('signal') ?? '');
  const [src, setSrc] = useState('');
  useEffect(() => {
    const p = new URLSearchParams(search);
    if (p.get('skill')) setSkill(p.get('skill')!);
    if (p.get('signal')) setSignal(p.get('signal')!);
  }, [search]);
  const dq = useDebounced(q, 250);
  const filters = { q: dq, sub, errors, skill: skill || undefined, src: src || undefined, signal: signal || undefined };
  // sessions whose record file is gone (deleted or moved) are listed apart, collapsed, and fetched only when opened
  const { data, isLoading, error } = useSessions({ ...filters, missing: 'exclude' });
  const [showMissing, setShowMissing] = useState(() => {
    try {
      return localStorage.getItem(MISSING_KEY) === '1';
    } catch {
      return false;
    }
  });
  const missingCount = data?.missing ?? 0;
  const missingList = useSessions({ ...filters, missing: 'only' }, showMissing && missingCount > 0);
  // picking sessions for an evaluation set (several at once)
  const [picking, setPicking] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [adding, setAdding] = useState(false);
  const health = useHealth();
  // evaluations replay with Codex
  const canEvaluate = health.data !== undefined && health.data.agent !== 'claude';
  const [, navigate] = useLocation();
  const toggle = (id: string) =>
    setPicked((p) => {
      const n = new Set(p);
      if (n.has(id)) n.delete(id);
      else if (n.size < MAX_PICK) n.add(id);
      return n;
    });
  const [signalKind, ...signalSkill] = signal.split(':');
  // several sources (Codex homes, Claude Code projects): filter and label by source
  const sources = (data?.sources ?? []).filter((x) => x.sessions > 0).sort((a, b) => (b.lastActivity ?? 0) - (a.lastActivity ?? 0));
  const multi = sources.length > 1;
  const usage = useSkillUsage();
  const idx = useIndexStatus();
  const tree = useTree(selectedId);
  const hasTree = (tree.data?.children.length ?? 0) > 0;

  return (
    <div className="flex h-full flex-col bg-white dark:bg-zinc-950">
      <div className="space-y-1.5 border-b border-zinc-200 p-2 dark:border-zinc-800">
        <div className="flex items-center gap-1">
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={tr("搜索标题、首条消息、目录、ID…")}
            className="min-w-0 flex-1 rounded border border-zinc-300 bg-white px-2 py-1 text-[12px] outline-none focus:border-indigo-500 dark:border-zinc-700 dark:bg-zinc-900"
          />
          {onCollapse && (
            <button className="shrink-0 rounded px-1 text-[12px] text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700 dark:hover:bg-zinc-800 dark:hover:text-zinc-200" onClick={onCollapse} title={tr("收起会话列表")}>
              «
            </button>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-zinc-500">
          <label className="flex items-center gap-1">
            <input type="checkbox" checked={sub} onChange={(e) => setSub(e.target.checked)} />{tr("包含子 agent")}</label>
          <label className="flex items-center gap-1">
            <input type="checkbox" checked={errors} onChange={(e) => setErrors(e.target.checked)} />{tr("只看出错")}</label>
          <select value={skill} onChange={(e) => setSkill(e.target.value)} className="max-w-[9rem] rounded border border-zinc-300 bg-white px-1 py-0.5 text-[11px] dark:border-zinc-700 dark:bg-zinc-900">
            <option value="">{tr("用过的 skill…")}</option>
            {usage.data?.map((u) => (
              <option key={u.skill} value={u.skill}>
                {u.skill}（{u.sessions}）
              </option>
            ))}
          </select>
          {multi && (
            <select value={src} onChange={(e) => setSrc(e.target.value)} className="max-w-[10rem] rounded border border-zinc-300 bg-white px-1 py-0.5 text-[11px] dark:border-zinc-700 dark:bg-zinc-900" title={tr("来源")}>
              <option value="">{tr("全部来源（")}{sources.length}）</option>
              {sources.map((x) => (
                <option key={x.id} value={x.id} title={x.home}>
                  {x.label}（{x.sessions}）
                </option>
              ))}
            </select>
          )}
          <span className="ml-auto">{data ? tr`${data.total} 个` : ''}</span>
          {canEvaluate && (
            <button
              className={cx('rounded px-1 text-[11px]', picking ? 'bg-indigo-600 text-white' : 'text-indigo-600 hover:bg-zinc-100 dark:text-indigo-400 dark:hover:bg-zinc-800')}
              onClick={() => {
                setPicking(!picking);
                setPicked(new Set());
              }}
              title={tr("多选会话，加入评测集")}
            >
              {picking ? tr("完成") : tr("多选")}
            </button>
          )}
        </div>
        {signal && (
          <div className="flex items-center gap-1 text-[11px]">
            <Badge tone="amber">{tr("只看：")}{SIGNAL_LABEL[signalKind] ?? signalKind} {signalSkill.join(':')}
            </Badge>
            <button className="text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200" onClick={() => setSignal('')} title={tr("清除")}>
              ×
            </button>
          </div>
        )}
        {idx.data?.running && (
          <div className="text-[10.5px] text-zinc-400">{tr("后台索引")}{idx.data.done}/{idx.data.total}{tr("（用于筛选）")}</div>
        )}
      </div>
      {hasTree && (
        <div className="max-h-[40%] shrink-0 overflow-auto border-b border-zinc-200 py-1 dark:border-zinc-800">
          <div className="px-2 pb-0.5 text-[10px] font-medium uppercase tracking-wide text-zinc-400">{tr("Agent 树")}</div>
          <TreeNode node={tree.data!} depth={0} current={selectedId} onOpen={onOpen} />
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-auto">
        {isLoading && <div className="p-3"><Spinner label={tr("读取会话列表…")} /></div>}
        {error && <ErrorBox error={error} />}
        {data?.sessions.map((s) => (
          <SessionRow
            key={s.id}
            s={s}
            selected={s.id === selectedId || s.id === tree.data?.session.id}
            onOpen={onOpen}
            showSource={multi && !src}
            picked={picking ? { on: picked.has(s.id), toggle: () => toggle(s.id) } : undefined}
          />
        ))}
        {data && data.total > data.sessions.length && (
          <div className="px-3 py-2 text-[11px] text-zinc-400">{tr("只列出最近的")}{data.sessions.length}{tr("个（共")}{data.total}{tr("个）：更早的会话用搜索或筛选查找")}</div>
        )}
        {data && !data.total && !missingCount && <div className="px-3 py-6 text-center text-[12px] text-zinc-400">{tr("没有匹配的会话")}</div>}
        {missingCount > 0 && (
          <div className="border-t border-zinc-200 dark:border-zinc-800">
            <button
              className="flex w-full items-center gap-1.5 px-3 py-2 text-left text-[11.5px] text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-900"
              onClick={() => {
                const next = !showMissing;
                setShowMissing(next);
                try {
                  localStorage.setItem(MISSING_KEY, next ? '1' : '0');
                } catch {
                  // not remembered
                }
              }}
              title={tr("这些会话还在 agent 的索引里，但记录文件已经不在磁盘上（被删除或移走），读取不到内容")}
              aria-expanded={showMissing}
            >
              <span className="w-2.5 text-[9px] text-zinc-400">{showMissing ? '▾' : '▸'}</span>{tr("读取不到的会话")}<span className="font-mono text-zinc-400">{missingCount}</span>
              <span className="flex-1" />
              <span className="text-[10.5px] text-zinc-400">{tr("记录文件已不在")}</span>
            </button>
            {showMissing && missingList.isLoading && (
              <div className="px-3 pb-2">
                <Spinner label={tr("读取…")} />
              </div>
            )}
            {showMissing &&
              missingList.data?.sessions.map((s) => <SessionRow key={s.id} s={s} selected={s.id === selectedId} onOpen={onOpen} showSource={multi && !src} />)}
            {showMissing && missingList.data && missingList.data.total > missingList.data.sessions.length && (
              <div className="px-3 py-2 text-[11px] text-zinc-400">{tr("只列出最近的")}{missingList.data.sessions.length}{tr("个（共")}{missingList.data.total}{tr("个）")}</div>
            )}
          </div>
        )}
      </div>
      {picking && (
        <div className="flex flex-wrap items-center gap-1.5 border-t border-zinc-200 bg-zinc-50 px-2 py-1.5 text-[11.5px] dark:border-zinc-800 dark:bg-zinc-900">
          <span className="text-zinc-600 dark:text-zinc-300">{tr("已选")}{picked.size}</span>
          <button className="text-indigo-600 hover:underline dark:text-indigo-400" onClick={() => setPicked(new Set((data?.sessions ?? []).slice(0, MAX_PICK).map((x) => x.id)))}>{tr("全选")}{(data?.sessions.length ?? 0) > MAX_PICK ? tr`前 ${MAX_PICK} 个` : ''}
          </button>
          {picked.size > 0 && (
            <button className="text-zinc-500 hover:underline" onClick={() => setPicked(new Set())}>{tr("清除")}</button>
          )}
          <span className="flex-1" />
          <Button size="xs" disabled={!picked.size || picked.size > 20} title={picked.size > 20 ? tr("最多 20 个会话") : tr("找出它们共有的做法和反复的澄清，写成新 skill")} onClick={() => navigate(`/skills/new?from=${[...picked].join(',')}`)}>{tr("提炼 skill…")}</Button>
          <Button size="xs" variant="primary" disabled={!picked.size} onClick={() => setAdding(true)}>{tr("加入评测集…")}</Button>
        </div>
      )}
      {adding && (
        <AddToSetDialog
          sessionIds={[...picked]}
          skillHint={signalSkill.join(':') || skill || undefined}
          onClose={() => setAdding(false)}
          onDone={() => {
            setAdding(false);
            setPicking(false);
            setPicked(new Set());
          }}
        />
      )}
    </div>
  );
}

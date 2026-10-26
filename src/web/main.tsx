import { tr } from '../shared/i18n';
import { AGENT_ICON } from '../shared/agent-icons';
import { PRODUCT_ICON, PRODUCT_NAME, PRODUCT_NAME_ZH } from '../shared/brand';
import { AGENT_LABEL, type AgentKind } from '../shared/agents';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { lazy, StrictMode, Suspense, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { Link, Route, Switch, useLocation, useSearch } from 'wouter';
import { DialogHost } from './components/dialogs';
import { Wordmark } from './components/Wordmark';
import { cx, Spinner } from './components/ui';
import { useHealth } from './lib/api';
import { SessionsPage } from './routes/SessionsPage';
import './index.css';
import { LanguageSelect, useLocale } from '../shared/i18n/react';

// the session page opens with the app; the others (editors, diffs …) load when first visited
const CasePage = lazy(() => import('./routes/CasePage').then((m) => ({ default: m.CasePage })));
const CasesPage = lazy(() => import('./routes/CasesPage').then((m) => ({ default: m.CasesPage })));
const DistillPage = lazy(() => import('./routes/DistillPage').then((m) => ({ default: m.DistillPage })));
const EvalReportPage = lazy(() => import('./routes/EvalReportPage').then((m) => ({ default: m.EvalReportPage })));
const EvalSetPage = lazy(() => import('./routes/EvalSetPage').then((m) => ({ default: m.EvalSetPage })));
const EvalsPage = lazy(() => import('./routes/EvalsPage').then((m) => ({ default: m.EvalsPage })));
const SkillsPage = lazy(() => import('./routes/SkillsPage').then((m) => ({ default: m.SkillsPage })));

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } },
});

function NavLink({ href, children }: { href: string; children: React.ReactNode }) {
  useLocale();
  const [loc] = useLocation();
  const active = href === '/' ? loc === '/' || loc.startsWith('/s/') : loc.startsWith(href);
  return (
    <Link href={href} className={cx('rounded px-2 py-1 text-[12.5px] font-medium', active ? 'bg-zinc-200 text-zinc-900 dark:bg-zinc-800 dark:text-zinc-100' : 'text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100')}>
      {children}
    </Link>
  );
}

function ConnectionBadge({ label, agent, kind, sources }: { label: string; agent: string; kind: AgentKind; sources: number }) {
  useLocale();
  const local = label === '本机';
  return (
    <span
      className={cx(
        'flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px]',
        local ? 'border-zinc-200 text-zinc-600 dark:border-zinc-700 dark:text-zinc-300' : 'border-violet-200 bg-violet-50 text-violet-700 dark:border-violet-900 dark:bg-violet-950 dark:text-violet-300',
      )}
      title={sources > 1 ? tr`${sources} 个来源` : undefined}
    >
      <span className={cx('h-1.5 w-1.5 rounded-full', local ? 'bg-emerald-500' : 'bg-violet-500')} />
      {local ? tr('本机') : label} ·
      <img src={AGENT_ICON[kind]} alt="" className="h-3.5 w-3.5" />
      {agent}
    </span>
  );
}

/** Running inside the desktop app's workspace view (Electrobun injects this before page scripts). */
const embedded = typeof window !== 'undefined' && '__electrobunWebviewId' in window;

/**
 * The desktop app restores each tab's page after reconnects and restarts, but
 * Electrobun only reports in-page navigations on popstate/hashchange, not on
 * history.pushState (which wouter uses). Re-announce every route change as a
 * popstate; wouter re-reads the same location, so it is a no-op here.
 */
function useAnnounceRoute() {
  const [location] = useLocation();
  const search = useSearch();
  useEffect(() => {
    if (embedded) window.dispatchEvent(new PopStateEvent('popstate'));
  }, [location, search]);
}

function Shell() {
  const language = useLocale();
  useAnnounceRoute();
  const health = useHealth();
  const label = health.data?.label;
  const agent = health.data ? AGENT_LABEL[health.data.agent] : undefined;
  // replays run where the workspace's server runs (本机, SSH dev machines) and continue a session with the same agent CLI (Codex)
  const debug = !health.data || health.data.agent !== 'claude';
  useEffect(() => {
    if (label && agent) document.title = `${PRODUCT_NAME} · ${label === '本机' ? tr('本机') : label} · ${agent}`;
  }, [label, agent, language]);
  return (
    <div className="flex h-full flex-col">
      <header className="flex h-10 shrink-0 items-center gap-3 border-b border-zinc-200 bg-white px-3 dark:border-zinc-800 dark:bg-zinc-950">
        {!embedded && (
          <div className="flex items-center gap-1.5 text-zinc-900 dark:text-zinc-100" title={`${PRODUCT_NAME} ${PRODUCT_NAME_ZH}`}>
            <img src={PRODUCT_ICON} alt="" className="h-[18px] w-[18px]" draggable={false} />
            <Wordmark height={14} />
          </div>
        )}
        <nav className="flex gap-1">
          <NavLink href="/">{tr("会话")}</NavLink>
          {debug && <NavLink href="/cases">{tr("调试")}</NavLink>}
          {debug && <NavLink href="/evals">{tr("评测")}</NavLink>}
          <NavLink href="/skills">Skills</NavLink>
        </nav>
        <span className="flex-1" />
        {!embedded && <LanguageSelect />}
        {label && agent && !embedded && <ConnectionBadge label={label} agent={agent} kind={health.data!.agent} sources={health.data?.sources ?? 0} />}
        {health.data && embedded && <img src={AGENT_ICON[health.data.agent]} alt="" className="h-3.5 w-3.5" />}
        <span className="text-[11px] text-zinc-500">
          {health.data
            ? tr`${agent} · ${health.data.threads} 个会话${health.data.unreadable ? tr`（${health.data.unreadable} 个读不到）` : ''}${health.data.sources > 1 ? tr` · ${health.data.sources} 个${health.data.agent === 'claude' ? tr("项目") : tr("来源")}` : ''}`
            : health.error
              ? tr("后端未连接")
              : ''}
        </span>
      </header>
      <DialogHost />
      <main className="min-h-0 flex-1">
        <Suspense
          fallback={
            <div className="p-3">
              <Spinner label={tr("加载页面…")} />
            </div>
          }
        >
          <Switch>
            <Route path="/" component={SessionsPage} />
            <Route path="/s/:id" component={SessionsPage} />
            <Route path="/skills" component={SkillsPage} />
            <Route path="/skills/new" component={DistillPage} />
            <Route path="/cases" component={CasesPage} />
            <Route path="/cases/:id" component={CasePage} />
            <Route path="/evals" component={EvalsPage} />
            <Route path="/evals/sets/:id" component={EvalSetPage} />
            <Route path="/evals/:id" component={EvalReportPage} />
            <Route>
              <div className="p-6 text-zinc-500">{tr("页面不存在")}</div>
            </Route>
          </Switch>
        </Suspense>
      </main>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <Shell />
    </QueryClientProvider>
  </StrictMode>,
);

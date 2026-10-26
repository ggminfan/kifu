import { Hono } from 'hono';
import { compress } from 'hono/compress';
import type { HealthResponse } from '../shared/api';
import { PROTOCOL } from '../shared/remote-protocol';
import { authMiddleware, type Auth } from './auth';
import { BUILD_ID, VERSION } from './build-info';
import { config } from './config';
import { analysisRoutes, jobRoutes } from './routes/analysis';
import { agentRoutes, caseRoutes, maintenanceRoutes } from './routes/cases';
import { distillRoutes } from './routes/distill';
import { evalRoutes, evalSetRoutes } from './routes/evals';
import { compareRoutes, evaluationRoutes, runRoutes } from './routes/runs';
import { sessionRoutes } from './routes/sessions';
import { applyRoutes, skillRoutes, variantRoutes } from './routes/skills';
import { askBusy } from './services/askWhy';
import { runnerBusy } from './services/runner';
import { NotFound } from './services/sessions';
import { snapshot, sourceInfos, stateDbOk } from './services/stateDb';
import { currentAgent } from './sources/registry';
import { serveWeb } from './static';

export function createApp(auth: Auth, onActivity?: () => void): Hono {
  const app = new Hono();
  if (process.env.KIFU_LOG_REQUESTS === '1') {
    // Path only (never query strings: they may carry a nonce).
    app.use('*', async (c, next) => {
      const t0 = Date.now();
      await next();
      process.stderr.write(`${new Date().toISOString()} ${c.req.method} ${new URL(c.req.url).pathname} ${c.res.status} ${Date.now() - t0}ms\n`);
    });
  }
  app.use('*', authMiddleware(auth, onActivity));
  // JSON and the web bundle (1.4 MB of JS, a third of that gzipped: it goes through the SSH tunnel); not SSE, not images
  app.use('*', compress());

  app.onError((err, c) => {
    if (err instanceof NotFound) return c.json({ error: err.message }, 404);
    console.error(err);
    return c.json({ error: err.message }, 500);
  });

  app.get('/api/health', (c) => {
    const ok = stateDbOk();
    const body: HealthResponse = {
      agent: currentAgent(),
      sources: sourceInfos().length,
      tmHome: config.tmHome,
      ...(() => {
        if (!ok) return { threads: 0 };
        let threads = 0;
        let unreadable = 0;
        // top-level sessions, like the session list (subagents are listed under their parent)
        for (const s of snapshot().byId.values()) {
          if (s.isSubagent) continue;
          if (s.rolloutExists) threads++;
          else unreadable++;
        }
        return { threads, unreadable };
      })(),
      stateDbOk: ok,
      label: config.label,
      busy: runnerBusy() || askBusy(),
      protocol: PROTOCOL,
      version: VERSION,
      buildId: BUILD_ID,
      instanceId: auth.instanceId,
    };
    return c.json(body);
  });

  app.get('/api/sources', (c) => c.json(sourceInfos()));

  app.route('/api/sessions', sessionRoutes);
  app.route('/api/sessions', analysisRoutes);
  app.route('/api/skills', skillRoutes);
  app.route('/api/variants', variantRoutes);
  app.route('/api/applies', applyRoutes);
  app.route('/api/runs', runRoutes);
  app.route('/api/compare', compareRoutes);
  app.route('/api/evaluations', evaluationRoutes);
  app.route('/api/jobs', jobRoutes);
  app.route('/api/cases', caseRoutes);
  app.route('/api/agent', agentRoutes);
  app.route('/api/maintenance', maintenanceRoutes);
  app.route('/api/eval-sets', evalSetRoutes);
  app.route('/api/evals', evalRoutes);
  app.route('/api/distill', distillRoutes);
  app.all('/api/*', (c) => c.json({ error: 'not found' }, 404));

  if (config.webDir) {
    const web = serveWeb(config.webDir);
    app.get('*', (c) => web(c) ?? c.text('not found', 404));
  }
  return app;
}

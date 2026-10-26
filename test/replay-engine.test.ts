import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { config, configure, ensureDataDirs } from '../src/server/config';
import { Auth } from '../src/server/auth';
import { createApp } from '../src/server/app';
import { createCase, caseFile, getCase, updateCase } from '../src/server/replay/cases';
import { createReplays, estimateTokens } from '../src/server/replay/engine';
import { expiredCases, orphanOverlays, removeCase } from '../src/server/replay/storage';
import { OVERLAY_MARKER, TMP_BASE } from '../src/server/services/overlay';
import { tmDb } from '../src/server/services/tmDb';
import { cancelRun, getRun, listReplays, type ReplayRun } from '../src/server/services/runner';
import { parsedSession } from '../src/server/services/sessions';
import { createVariant } from '../src/server/services/variants';
import { configureSources, refreshSources } from '../src/server/sources/registry';
import { ASK_ID, askHome as makeAskHome, CODEX_ID, codexHome as makeCodexHome } from './fixtures/homes';

/**
 * Replays end to end with a fake agent CLI (test/fixtures/fake-agent.mjs):
 * case snapshot, isolated home, resume with a new id, step limit, checks,
 * fidelity, and that nothing of the user's real files changes.
 */

const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-agent.mjs');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kifu-replay-engine-'));
const saved = { codexBin: config.codexBin, tmHome: config.tmHome, agentsSkillsDir: config.agentsSkillsDir, env: { ...process.env } };
const sha = (f: string) => createHash('sha256').update(fs.readFileSync(f)).digest('hex');

async function finished(runs: ReplayRun[], timeoutMs = 30_000): Promise<ReplayRun[]> {
  const t0 = Date.now();
  for (;;) {
    const now = runs.map((r) => getRun(r.id) as ReplayRun);
    if (now.every((r) => r.status !== 'queued' && r.status !== 'running')) return now;
    if (Date.now() - t0 > timeoutMs) throw new Error(`replays still running: ${now.map((r) => r.status).join(',')}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

const fakeLog = () =>
  JSON.parse(fs.readFileSync(path.join(tmp, 'fake.json'), 'utf8')) as Record<string, unknown> & {
    argv: string[];
    config?: string;
    skills: string[];
    skillMd: Record<string, string | undefined>;
    agentsMd: { home?: string };
    system?: { names: string[]; marker?: string };
    cwdFiles: string[];
  };

beforeAll(() => {
  fs.chmodSync(FAKE, 0o755);
  configure({ dataDir: path.join(tmp, 'data') });
  ensureDataDirs();
  config.codexBin = FAKE;
  // never the user's real ~/.agents/skills
  config.agentsSkillsDir = path.join(tmp, 'agents-skills');
  fs.mkdirSync(config.agentsSkillsDir, { recursive: true });
  process.env.FAKE_LOG = path.join(tmp, 'fake.json');
});

afterAll(() => {
  Object.assign(config, { codexBin: saved.codexBin, tmHome: saved.tmHome, agentsSkillsDir: saved.agentsSkillsDir });
  process.env = saved.env;
  configureSources({ agent: 'codex' });
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('replays', () => {
  let t: ReturnType<typeof makeAskHome>;
  beforeAll(() => {
    t = makeAskHome(tmp);
    configureSources({ agent: 'codex', home: t.home });
    refreshSources();
  });

  it('a case is a clone of the session up to the end of turn K, with checks from what went wrong', async () => {
    const c = await createCase(ASK_ID, 1);
    const original = fs.readFileSync(t.file);
    const copy = fs.readFileSync(caseFile(c));
    expect(original.subarray(0, copy.length).equals(copy)).toBe(true);
    expect(copy.length).toBe(original.length);
    expect(c.meta.prefixBytes).toBeLessThan(copy.length);
    expect(c.prompt).toBe('now summarize a.txt for me');
    expect(c.meta).toMatchObject({ agent: 'codex', model: 'demo-model', originalSteps: 2, turnId: 't2' });
    expect(c.checks).toEqual([{ kind: 'no_failed_commands' }, { kind: 'no_question' }]);
    expect(c.meta.cwd).toBe(tmp);
    await expect(createCase(ASK_ID, 5)).rejects.toThrow(/没有第 6 轮/);
    expect(estimateTokens(c, { arms: [{ label: 'A′', variantIds: [] }], repeats: 2 }).replays).toBe(2);
  });

  it('replays turn K in an isolated home under a new id and leaves the real files alone', async () => {
    const c = await createCase(ASK_ID, 1);
    const before = { session: sha(t.file), toml: sha(path.join(t.home, 'config.toml')) };
    const [r] = await finished(await createReplays(c.id, { arms: [{ label: 'A′', variantIds: [] }], maxSteps: 10 }));
    expect(r.error).toBeUndefined();
    expect(r.status).toBe('completed');
    expect(r.threadId).not.toBe(ASK_ID);
    expect(r.threadId).toHaveLength(ASK_ID.length);
    expect(r.rollout).toContain(path.join(config.tmHome, 'runs', r.id));
    expect(r.result).toMatchObject({ prefixLines: c.meta.startLine, stoppedAtMax: false, steps: 2, exitCode: 0 });
    expect(r.result?.guard.originalUnchanged).toBe(true);
    expect(sha(t.file)).toBe(before.session);
    expect(sha(path.join(t.home, 'config.toml'))).toBe(before.toml);

    // how it ran: resumed the copy, hooks off, MCP servers and notify gone, model of turn K, prompt on stdin
    const log = fakeLog();
    expect(log.argv).toEqual(expect.arrayContaining(['exec', 'resume', r.threadId!, '--disable', 'hooks', '-m', 'demo-model']));
    // the original working directory, read-only
    expect(log.argv.slice(1, 5)).toEqual(['-s', 'read-only', '-C', tmp]);
    expect(log.promptInArgv).toBe(false);
    expect(log.codexHome).not.toBe(t.home);
    expect(String(log.codexHome)).toHaveLength(t.home.length);
    expect(fs.existsSync(String(log.codexHome))).toBe(false); // the isolated home (config copy, login link) is gone
    expect(fs.existsSync(path.join(t.home, 'auth.json'))).toBe(true);
    expect(log.config).toContain('[features]');
    expect(log.config).not.toMatch(/notify|mcp_servers/);
    expect(log.auth).toBe('symlink');

    // the replay's own turn, the copy hidden; what it did; checks; fidelity reconstructed from its transcript
    const replay = await parsedSession(r.threadId!);
    expect(replay.trace.forkPrefix).toEqual({ endLine: c.meta.startLine, kind: 'replay' });
    expect(replay.trace.turns).toHaveLength(1);
    expect(replay.trace.turns[0].input?.preview).toBe(c.prompt);
    expect(r.result?.summary).toMatchObject({ steps: 2, tools: 1, failedCommands: 0, status: 'completed' });
    expect(r.checks?.find((x) => x.def.kind === 'no_failed_commands')?.status).toBe('pass');
    expect(r.checks?.find((x) => x.def.kind === 'no_question')?.status).toBe('pass');
    expect(r.result?.fidelity?.historyCoverage).toBeGreaterThan(0.95);
    expect(r.result?.fidelity?.added.environment).toBeGreaterThan(0);
    expect(listReplays(c.id).map((x) => x.id)).toEqual([r.id]);
  });

  it('stops after the step limit; checks that need the turn to end are not judged', async () => {
    const c = await createCase(ASK_ID, 1);
    process.env.FAKE_STEPS = '8';
    process.env.FAKE_STEP_MS = '600';
    try {
      const [r] = await finished(await createReplays(c.id, { arms: [{ label: 'A′', variantIds: [] }], maxSteps: 2 }));
      expect(r.status).toBe('completed');
      expect(r.result?.stoppedAtMax).toBe(true);
      expect(r.result?.steps).toBeGreaterThanOrEqual(2);
      expect(r.result?.steps).toBeLessThan(9);
      expect(r.result?.summary?.status).toBe('aborted');
      expect(r.checks?.find((x) => x.def.kind === 'no_question')?.status).toBe('na');
    } finally {
      delete process.env.FAKE_STEPS;
      delete process.env.FAKE_STEP_MS;
    }
  });

  it('an arm mounts its skill variants, frozen when queued', async () => {
    const c = await createCase(ASK_ID, 1);
    updateCase(c.id, { checks: [{ kind: 'skill_loaded', skill: 'alpha' }] });
    const v = await createVariant('alpha', { description: 'Alpha reports, summaries of a.txt.' });
    process.env.FAKE_SKILL = 'alpha';
    try {
      const runs = await createReplays(c.id, { arms: [{ label: 'B1', variantIds: [v.id] }] });
      // editing the variant after queueing does not change the run
      fs.writeFileSync(path.join(v.dir, 'SKILL.md'), '---\nname: alpha\ndescription: changed later\n---\n');
      const [r] = await finished(runs);
      expect(r.status).toBe('completed');
      expect(r.options.frozenVariants.map((f) => f.id)).toEqual([v.id]);
      expect(fs.readFileSync(path.join(r.options.frozenVariants[0].dir, 'SKILL.md'), 'utf8')).toContain('summaries of a.txt');
      expect(r.checks?.[0]).toMatchObject({ status: 'pass' });
      expect(r.result?.notes.join()).toMatch(/变体 alpha 挂载/);
    } finally {
      delete process.env.FAKE_SKILL;
    }
  });

  it('a replay that never reaches the model fails with the agent’s message', async () => {
    const c = await createCase(ASK_ID, 1);
    process.env.FAKE_NO_LOGIN = '1';
    try {
      const [r] = await finished(await createReplays(c.id, { arms: [{ label: 'A′', variantIds: [] }] }));
      expect(r.status).toBe('failed');
      expect(r.error).toMatch(/没有调用模型.*not logged in/s);
    } finally {
      delete process.env.FAKE_NO_LOGIN;
    }
    expect(getCase(c.id)).toBeDefined();
  });

  it('a replay cancelled while it gets ready never starts the agent', async () => {
    const c = await createCase(ASK_ID, 1);
    fs.rmSync(path.join(tmp, 'fake.json'), { force: true });
    const runs = await createReplays(c.id, { arms: [{ label: 'A′', variantIds: [] }] });
    // the queue has handed it to the engine, which has not set it running yet
    expect(getRun(runs[0].id)!.status).toBe('queued');
    expect(cancelRun(runs[0].id)).toBe(true);
    const [r] = await finished(runs);
    expect(r.status).toBe('cancelled');
    expect(fs.existsSync(path.join(tmp, 'fake.json'))).toBe(false);
  });
});

describe('replays (Codex)', () => {
  let x: ReturnType<typeof makeCodexHome>;
  beforeAll(() => {
    x = makeCodexHome(tmp);
    configureSources({ agent: 'codex', home: x.home });
    refreshSources();
  });

  it('runs in a same-length CODEX_HOME without notify or MCP, then moves the transcript out', async () => {
    const c = await createCase(CODEX_ID, 1);
    expect(c.meta).toMatchObject({ agent: 'codex', model: 'gpt-demo-2', effort: 'medium' });
    const before = sha(path.join(x.home, 'config.toml'));
    const [r] = await finished(await createReplays(c.id, { arms: [{ label: 'A′', variantIds: [] }], effort: 'high' }));
    expect(r.error).toBeUndefined();
    expect(r.status).toBe('completed');
    const log = fakeLog();
    expect(log.argv).toEqual(expect.arrayContaining(['exec', 'resume', r.threadId!, '--disable', 'hooks', '-m', 'gpt-demo-2', 'model_reasoning_effort="high"']));
    expect(String(log.codexHome)).toHaveLength(x.home.length);
    expect(fs.existsSync(String(log.codexHome))).toBe(false);
    expect(log.config).toContain('model = "gpt-demo"');
    expect(log.config).not.toMatch(/notify|mcp_servers/);
    expect(log.auth).toBe('symlink');
    expect(log.skills).toEqual(['gamma']);
    // the session's directory is not on this machine: an empty one, writable
    expect(log.argv.slice(1, 3)).toEqual(['-s', 'workspace-write']);
    expect(r.result?.notes.join()).toMatch(/原工作目录 \/work\/demo 不在本机/);
    expect(r.rollout).toContain(path.join(config.tmHome, 'runs', r.id, 'sessions'));
    expect(fs.existsSync(r.rollout!)).toBe(true);
    expect(sha(path.join(x.home, 'config.toml'))).toBe(before);
    expect(r.result?.summary).toMatchObject({ steps: 2, tools: 1 });
    expect(r.result?.fidelity?.historyCoverage).toBeGreaterThan(0.95);
    const replay = await parsedSession(r.threadId!);
    expect(replay.trace.turns).toHaveLength(1);
  });

  it('skill variants of the Codex home: catalog, mount, the original disabled', async () => {
    const c = await createCase(CODEX_ID, 1);
    updateCase(c.id, { checks: [{ kind: 'skill_loaded', skill: 'gamma' }] });
    const v = await createVariant('gamma', { description: 'Gamma tool, also for tests.' });
    expect(v.originalPath).toBe(fs.realpathSync(path.join(x.home, 'skills', 'gamma')));
    process.env.FAKE_SKILL = 'gamma';
    try {
      const [r] = await finished(await createReplays(c.id, { arms: [{ label: 'B1', variantIds: [v.id] }] }));
      expect(r.status).toBe('completed');
      const log = fakeLog();
      expect(log.config).toContain('[[skills.config]]');
      expect(log.config).toContain(JSON.stringify(path.join(v.originalPath, 'SKILL.md')));
      expect(r.checks?.[0]).toMatchObject({ status: 'pass' });
      // the replay shows the real path, not the isolated home's
      expect(r.result?.summary?.toolSeq[0]).toContain(path.join(x.home, 'skills', 'gamma').slice(0, 20));
    } finally {
      delete process.env.FAKE_SKILL;
    }
  });
});

describe('cases API', () => {
  it('creates a case, replays it and deletes it over HTTP', async () => {
    configureSources({ agent: 'codex', home: path.join(tmp, 'ask-home') });
    refreshSources();
    const app = createApp(new Auth('t0ken', 'case01'));
    const call = async (p: string, method = 'GET', body?: unknown) => {
      const res = await app.request(`http://127.0.0.1:7788/api${p}`, { method, headers: { host: '127.0.0.1:7788', authorization: 'Bearer t0ken', 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: res.status, body: (await res.json()) as Record<string, unknown> & Array<Record<string, unknown>> };
    };
    expect((await call('/agent')).body).toMatchObject({ agent: 'codex', replayable: true });
    expect((await call('/agent/models')).body.map((m) => m.id)).toEqual(['fake-model']);
    const cuts = (await call(`/sessions/${ASK_ID}/cuts`)).body;
    expect(cuts.map((c) => c.replayable)).toEqual([true, true]);
    expect((await call(`/sessions/${ASK_ID}/problems`)).body.map((p) => p.kind)).toContain('failed_tool');

    expect((await call('/cases', 'POST', { sessionId: ASK_ID })).status).toBe(400);
    const created = await call('/cases', 'POST', { sessionId: ASK_ID, turnIndex: 1 });
    expect(created.status).toBe(200);
    const id = String(created.body.id);
    expect(created.body.original).toMatchObject({ steps: 2, failedCommands: 1 });
    expect((await call(`/cases/${id}/estimate`, 'POST', { arms: [{ label: 'A′' }, { label: 'B1' }], repeats: 2 })).body).toMatchObject({ replays: 4 });
    const runs = (await call(`/cases/${id}/replays`, 'POST', { arms: [{ label: 'A′' }], maxSteps: 5 })).body;
    const [done] = await finished(runs as unknown as ReplayRun[]);
    expect(done.status).toBe('completed');
    const original = (await call(`/cases/${id}/original`)).body as unknown as { checks: Array<{ status: string }> };
    expect(original.checks.map((c) => c.status)).toEqual(['fail', 'fail']);

    // new checks are applied to finished replays too
    const patched = await call(`/cases/${id}`, 'PATCH', { checks: [{ kind: 'max_steps', n: 1 }] });
    expect(patched.body.checks).toEqual([{ kind: 'max_steps', n: 1 }]);
    expect((await call(`/cases/${id}/replays`)).body[0].checks).toEqual([{ def: { kind: 'max_steps', n: 1 }, status: 'fail', detail: '2 步' }]);

    expect((await call(`/cases/${id}`, 'DELETE')).status).toBe(200);
    expect((await call(`/cases/${id}`)).status).toBe(404);
    expect(fs.existsSync(path.join(config.tmHome, 'runs', done.id))).toBe(false);
  });
});

describe('storage', () => {
  it('finds isolated homes whose run is gone, and leaves the rest alone', async () => {
    const made: string[] = [];
    const mk = (marker?: object, home = true) => {
      // named like overlays: kf + lowercase letters and digits
      const d = path.join(TMP_BASE, `kf${Math.random().toString(36).slice(2, 10)}`);
      fs.mkdirSync(d);
      made.push(d);
      if (home) {
        fs.writeFileSync(path.join(d, 'config.toml'), '');
        fs.mkdirSync(path.join(d, 'sessions'));
        fs.mkdirSync(path.join(d, 'skills'));
      }
      if (marker) fs.writeFileSync(path.join(d, OVERLAY_MARKER), JSON.stringify(marker));
      return d;
    };
    try {
      const dead = mk({ pid: 2 ** 22 + 12345, createdAt: Date.now() });
      const mine = mk({ pid: process.pid, createdAt: Date.now() });
      const stale = mk({ pid: process.pid, createdAt: Date.now() - 2 * 86_400_000 });
      const legacyOld = mk();
      const old = new Date(Date.now() - 2 * 3_600_000);
      fs.utimesSync(legacyOld, old, old);
      const legacyNew = mk();
      const notOurs = mk(undefined, false);
      fs.utimesSync(notOurs, old, old);
      const found = new Set(await orphanOverlays());
      expect([dead, mine, stale, legacyOld, legacyNew, notOurs].map((d) => found.has(d))).toEqual([true, false, true, true, false, false]);
    } finally {
      for (const d of made) fs.rmSync(d, { recursive: true, force: true });
    }
  });

  it('unsaved cases expire after two weeks; saved ones stay', async () => {
    const a = await createCase(ASK_ID, 0);
    const b = await createCase(ASK_ID, 0);
    updateCase(b.id, { saved: true });
    tmDb().prepare('update cases set updated_at = ? where id in (?, ?)').run(Date.now() - 15 * 86_400_000, a.id, b.id);
    const expired = expiredCases();
    expect(expired).toContain(a.id);
    expect(expired).not.toContain(b.id);
    await removeCase(a.id);
    expect(getCase(a.id)).toBeUndefined();
    expect(fs.existsSync(caseFile(a))).toBe(false);
  });
});

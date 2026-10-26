import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { config, configure, ensureDataDirs } from '../src/server/config';
import '../src/server/replay/lab';
import { catalog, skillHomeRoot } from '../src/server/services/catalog';
import { getJob, startAsk } from '../src/server/services/askWhy';
import { previewSkill } from '../src/server/services/preview';
import { createRuns, getRun, type LabRun } from '../src/server/services/runner';
import { createVariant } from '../src/server/services/variants';
import { configureSources, refreshSources } from '../src/server/sources/registry';
import { ASK_ID, askHome, codexHome, FAKE_AGENT } from './fixtures/homes';

/**
 * The Skills page's runs with a fake agent CLI: trial runs and listing
 * previews in Codex workspaces, the analyst ("问为什么") in a bare home, and
 * the Claude Code catalog.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kifu-skills-lab-'));
const saved = { codexBin: config.codexBin, tmHome: config.tmHome, agentsSkillsDir: config.agentsSkillsDir, env: { ...process.env } };

async function done(runs: LabRun[], timeoutMs = 30_000): Promise<LabRun[]> {
  const t0 = Date.now();
  for (;;) {
    const now = runs.map((r) => getRun(r.id) as LabRun);
    if (now.every((r) => r.status !== 'queued' && r.status !== 'running')) return now;
    if (Date.now() - t0 > timeoutMs) throw new Error('runs still running');
    await new Promise((r) => setTimeout(r, 100));
  }
}

const log = () => JSON.parse(fs.readFileSync(path.join(tmp, 'fake.json'), 'utf8')) as { argv: string[]; config?: string; promptInArgv: boolean; codexHome?: string };

beforeAll(() => {
  fs.chmodSync(FAKE_AGENT, 0o755);
  configure({ dataDir: path.join(tmp, 'data') });
  ensureDataDirs();
  config.codexBin = FAKE_AGENT;
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

describe('Skills in a Codex workspace', () => {
  beforeAll(() => {
    const t = askHome(tmp);
    configureSources({ agent: 'codex', home: t.home });
    refreshSources();
  });

  it('trial runs: a new session, prompt on stdin, hooks and MCP off, the variant mounted', async () => {
    const v = await createVariant('alpha', { description: 'Alpha reports and summaries.' });
    process.env.FAKE_SKILL = 'alpha';
    try {
      const runs = await done(await createRuns({ skillKey: 'alpha', prompt: 'write the alpha report', testType: 'content', isolation: 'readonly', cwd: tmp }, [undefined, v.id], 1));
      expect(runs.map((r) => r.status)).toEqual(['completed', 'completed']);
      const [base, variant] = runs;
      expect(base.threadId).toBeTruthy();
      expect(fs.existsSync(base.rollout!)).toBe(true);
      expect(base.result?.summary).toMatchObject({ skillLoaded: true, calls: 2 });
      expect(variant.options.frozenVariantDir).toBeTruthy();
      expect(variant.result?.notes.join()).toMatch(/变体 alpha 挂载/);
      const l = log();
      expect(l.promptInArgv).toBe(false);
      expect(l.argv).toEqual(expect.arrayContaining(['exec', '--json', '--disable', 'hooks', '-s', 'read-only', '-']));
      expect(l.argv).not.toContain('resume');
      expect(l.config).not.toMatch(/notify|mcp_servers/);
      expect(variant.result?.budgetParity).toBe(true);
    } finally {
      delete process.env.FAKE_SKILL;
    }
  });

  it('previews the skill list with the agent’s own renderer', async () => {
    const v = await createVariant('alpha', { description: 'Alpha, rewritten.' });
    const res = await previewSkill({ skillKey: 'alpha', baseFull: 'Alpha reports.', variant: v, fullByName: () => undefined });
    expect(res.base.entry?.description).toBe('Alpha reports.');
    expect(res.variant?.entry?.description).toBe('Alpha, rewritten.');
    expect(res.base.snapshot.count).toBe(1);
  });

  it('问为什么 runs the analyst in a bare home with the digest on stdin', async () => {
    const answer = path.join(tmp, 'answer.json');
    fs.writeFileSync(answer, JSON.stringify({ answer: 'the command failed', confidence: 'high', causes: [], skill_findings: [], suggested_edits: [] }));
    process.env.FAKE_ANSWER_FILE = answer;
    process.env.FAKE_ANALYST_LOG = path.join(tmp, 'analyst.json');
    try {
      const job = await startAsk(ASK_ID, 'why did it fail?');
      const t0 = Date.now();
      while (getJob(job.id)?.status === 'running' && Date.now() - t0 < 20_000) await new Promise((r) => setTimeout(r, 100));
      expect(getJob(job.id)).toMatchObject({ status: 'completed', result: { answer: 'the command failed', confidence: 'high' } });
      const a = JSON.parse(fs.readFileSync(process.env.FAKE_ANALYST_LOG, 'utf8')) as { argv: string[]; stdinChars: number; skills: number };
      expect(a.argv).toEqual(expect.arrayContaining(['--ephemeral', '-o', '-s', 'read-only']));
      expect(a.skills).toBe(0);
      expect(a.stdinChars).toBeGreaterThan(200);
    } finally {
      delete process.env.FAKE_ANSWER_FILE;
      delete process.env.FAKE_ANALYST_LOG;
    }
  });
});

describe('Skills of another Codex home', () => {
  beforeAll(() => {
    const x = codexHome(tmp);
    configureSources({ agent: 'codex', home: x.home });
    refreshSources();
  });

  it('the catalog is the Codex home’s, trial runs use codex with a $ mention', async () => {
    expect(catalog(true).map((s) => s.key)).toEqual(['gamma']);
    const v = await createVariant('gamma', { description: 'Gamma, sharper.' });
    const runs = await done(await createRuns({ skillKey: 'gamma', prompt: 'use it', testType: 'content', isolation: 'readonly', cwd: tmp }, [v.id], 1));
    expect(runs[0].status).toBe('completed');
    expect(runs[0].rollout).toContain(path.join(config.tmHome, 'runs', runs[0].id, 'sessions'));
    const l = log();
    expect(l.config).not.toMatch(/notify|mcp_servers/);
    expect(String(l.codexHome)).not.toBe(path.join(tmp, 'codex-home'));
    const res = await previewSkill({ skillKey: 'gamma', baseFull: 'Gamma tool.', variant: v, fullByName: () => undefined });
    expect(res.variant?.entry?.description).toBe('Gamma, sharper.');
  });
});

describe('Skills in a Claude Code workspace', () => {
  it('lists the config dir’s skills and plugin skills (no ~/.agents, no .system)', () => {
    const dir = path.join(tmp, 'claude');
    fs.mkdirSync(path.join(dir, 'projects', '-work-demo'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'projects', '-work-demo', 's1.jsonl'), '');
    fs.mkdirSync(path.join(dir, 'skills', 'delta'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'skills', 'delta', 'SKILL.md'), '---\nname: delta\ndescription: Delta.\n---\n');
    fs.mkdirSync(path.join(dir, 'plugins', 'cache', 'mk', 'tools', '1.0.0', 'skills', 'eps'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'plugins', 'cache', 'mk', 'tools', '1.0.0', 'skills', 'eps', 'SKILL.md'), '---\nname: eps\ndescription: Eps.\n---\n');
    fs.mkdirSync(path.join(config.agentsSkillsDir, 'zeta'), { recursive: true });
    fs.writeFileSync(path.join(config.agentsSkillsDir, 'zeta', 'SKILL.md'), '---\nname: zeta\ndescription: Zeta.\n---\n');
    configureSources({ agent: 'claude', home: dir });
    refreshSources();
    expect(skillHomeRoot()).toBe(dir);
    expect(catalog(true).map((s) => [s.key, s.source, s.writable])).toEqual([
      ['delta', 'user', true],
      ['tools:eps', 'plugin', false],
    ]);
  });
});

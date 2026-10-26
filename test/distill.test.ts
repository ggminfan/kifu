import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { clusterClarifications, commandStep, minePaths, mineSessions, type MineInput } from '../src/core/distill/mine';
import { parseSession } from '../src/core/parse';
import { config, configure, ensureDataDirs } from '../src/server/config';
import '../src/server/replay/engine';
import { getCase } from '../src/server/replay/cases';
import { createEval, evalReport, getEval, setCases } from '../src/server/replay/evals';
import { applyVariant, undoApply } from '../src/server/services/apply';
import { catalog } from '../src/server/services/catalog';
import { checkDraft, checkName, draftJob, draftSet, mine, saveDraft, startDraft } from '../src/server/services/distill';
import { runIndexer } from '../src/server/services/indexer';
import { getVariant, variantDetail } from '../src/server/services/variants';
import { configureSources, refreshSources } from '../src/server/sources/registry';
import { item, RolloutBuilder } from './fixtures/builder';
import { FAKE_AGENT } from './fixtures/homes';

/**
 * Distilling a skill with a fake agent and made-up sessions: three sessions
 * that do the same thing (git log → git diff → a script) and are each asked
 * the same question (Chinese or English?), and one unrelated session. Mining,
 * a draft from the analyst (evidence checked), the listing check, the new
 * skill as a variant, its evaluation set and run, install and undo.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kifu-distill-'));
const saved = { codexBin: config.codexBin, agentsSkillsDir: config.agentsSkillsDir, env: { ...process.env } };
const SOURCES = ['0199dddd-0000-7000-8000-000000000001', '0199dddd-0000-7000-8000-000000000002', '0199dddd-0000-7000-8000-000000000003'];
const OTHER = '0199dddd-0000-7000-8000-000000000009';
let home = '';

function write(dir: string, id: string, b: RolloutBuilder) {
  for (const l of b.lines) if (l.type === 'turn_context') l.payload.cwd = tmp;
  fs.writeFileSync(path.join(dir, `rollout-2026-09-04T00-00-00-${id}.jsonl`), `${b.lines.map((l) => JSON.stringify(l)).join('\n')}\n`);
}

function sourceSession(id: string, ask: string, n: number): RolloutBuilder {
  const b = new RolloutBuilder().meta({ id, cwd: tmp });
  b.taskStarted('t1').append('t1', [item.dev('<skills_instructions>\n## Skills\n### Available skills\n- report-writer: Write weekly reports from git logs.\n</skills_instructions>')]).turnContext('t1').append('t1', [item.user(ask)]);
  const cmds = [`cd repo && git log --oneline -${n}`, 'git diff HEAD~5 --stat | head', 'FOO=1 python3 scripts/notes.py'];
  cmds.forEach((cmd, i) => {
    b.append('t1', [item.call('shell', { command: ['bash', '-lc', cmd] }, `c${i}`)]).tokens(500 + i, 10);
    b.execEnd(`c${i}`, cmd).append('t1', [item.output(`c${i}`, 'ok')]);
  });
  const q = '发版说明要写成中文还是英文？';
  b.append('t1', [item.assistant(q)]).tokens(600, 5).taskComplete('t1', { last_agent_message: q });
  b.taskStarted('t2').turnContext('t2').append('t2', [item.user('中文，按 feat 和 fix 分组')]);
  b.append('t2', [item.assistant('好的，已按中文分组写好。')]).tokens(700, 5).taskComplete('t2', { last_agent_message: '好的，已按中文分组写好。' });
  return b;
}

beforeAll(async () => {
  fs.chmodSync(FAKE_AGENT, 0o755);
  configure({ dataDir: path.join(tmp, 'data') });
  ensureDataDirs();
  config.codexBin = FAKE_AGENT;
  config.agentsSkillsDir = path.join(tmp, 'agents-skills');
  fs.mkdirSync(config.agentsSkillsDir, { recursive: true });
  home = path.join(tmp, 'codex');
  const dir = path.join(home, 'sessions', '2026', '09', '04');
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(path.join(home, 'skills', 'report-writer'), { recursive: true });
  fs.writeFileSync(path.join(home, 'skills', 'report-writer', 'SKILL.md'), '---\nname: report-writer\ndescription: Write weekly reports from git logs.\n---\nSteps.\n');
  fs.writeFileSync(path.join(home, 'config.toml'), 'model = "demo-model"\n');
  fs.writeFileSync(path.join(home, 'auth.json'), '{"fake":"not a real token"}');
  SOURCES.forEach((id, i) => write(dir, id, sourceSession(id, ['把这周的提交整理成发版说明', '帮我写一下这次发版的说明', '整理一下发版说明'][i], 10 + i)));
  const o = new RolloutBuilder().meta({ id: OTHER, cwd: tmp });
  o.taskStarted('t1').turnContext('t1').append('t1', [item.user('fix the typo in NOTES.md')]);
  o.append('t1', [item.assistant('fixed')]).tokens(300, 5).taskComplete('t1', { last_agent_message: 'fixed' });
  write(dir, OTHER, o);
  configureSources({ agent: 'codex', home });
  refreshSources();
  await runIndexer();
});

afterAll(() => {
  Object.assign(config, { codexBin: saved.codexBin, agentsSkillsDir: saved.agentsSkillsDir });
  process.env = saved.env;
  configureSources({ agent: 'codex' });
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('mining (rules)', () => {
  it('reduces commands to what they do', () => {
    expect(commandStep('cd repo && git log --oneline -10')).toBe('git log');
    expect(commandStep('FOO=1 python3 scripts/notes.py')).toBe('python3');
    expect(commandStep('npm test -- --watch=false')).toBe('npm test');
    expect(commandStep('sudo ls -la')).toBe('ls');
  });

  it('finds the path the sessions share and the question asked in each', async () => {
    const inputs: MineInput[] = await Promise.all(
      [...SOURCES, OTHER].map(async (id) => ({ id, trace: (await parseSession(fs.readdirSync(path.join(home, 'sessions', '2026', '09', '04')).map((f) => path.join(home, 'sessions', '2026', '09', '04', f)).find((f) => f.includes(id))!)).trace })),
    );
    const paths = minePaths(inputs);
    expect(paths[0]).toMatchObject({ steps: ['git log', 'git diff', 'python3'], support: 3 });
    expect(paths[0].at.map((a) => a.sessionId)).toEqual(SOURCES);
    const r = mineSessions(inputs, [{ key: 'report-writer', description: 'Write weekly reports from git logs.' }]);
    expect(r.clarifications[0]).toMatchObject({ sessions: 3, label: '中文，按 feat 和 fix 分组' });
    expect(r.clarifications[0].items[0]).toMatchObject({ kind: 'answer', question: '发版说明要写成中文还是英文？', turnIndex: 1, callIndex: expect.any(Number) });
    expect(r.suggestion.mode).toBe('new');
    // one session: a path counts when it happens twice
    expect(minePaths(inputs.slice(0, 1))).toEqual([]);
  });

  it('keeps corrections apart from unrelated follow-ups', () => {
    const c = clusterClarifications([
      { sessionId: 'a', turnIndex: 1, kind: 'correction', reply: '不是这个分支，用 release 分支' },
      { sessionId: 'b', turnIndex: 2, kind: 'correction', reply: '不要用 main，用 release 分支' },
      { sessionId: 'c', turnIndex: 1, kind: 'answer', question: '要不要跑测试？', reply: '跑单元测试就行' },
    ]);
    expect(c.map((x) => x.sessions)).toEqual([2, 1]);
    expect(c[0].terms).toEqual(expect.arrayContaining(['release']));
  });
});

describe('distilling', () => {
  let variantId = '';

  it('mines over HTTP-sized input: titles and the closest skills', async () => {
    const r = await mine(SOURCES);
    expect(r.sessions).toBe(3);
    expect(Object.keys(r.titles)).toEqual(SOURCES);
    expect(r.paths[0].support).toBe(3);
  });

  it('writes a draft with the analyst; evidence is checked against the material', async () => {
    const answer = path.join(tmp, 'draft.json');
    fs.writeFileSync(
      answer,
      JSON.stringify({
        name: 'Release Notes',
        description: '整理发版说明（release notes）：用户说 发版说明、release notes 时使用。不用于周报。',
        triggers: { positive: ['发版说明', 'release notes'], negative: ['周报'] },
        steps: ['git log --oneline 看本次提交', 'git diff --stat 看改动范围', '运行 python3 scripts/notes.py'],
        clarifications: [{ question: '写成中文还是英文？', answer: '中文，按 feat 和 fix 分组' }],
        pitfalls: ['不要漏掉 fix'],
        evidence: [
          { session: 'S1', turn: 2, quote: '中文，按 feat 和 fix 分组' },
          { session: 'S2', turn: 1, quote: '这句话不在材料里' },
          { session: 'S9', turn: 1, quote: '中文' },
        ],
      }),
    );
    process.env.FAKE_ANSWER_FILE = answer;
    try {
      const job = await startDraft(SOURCES, '团队发版前用');
      const t0 = Date.now();
      while (draftJob(job.id)!.status === 'running' && Date.now() - t0 < 20_000) await new Promise((r) => setTimeout(r, 100));
      const d = draftJob(job.id)!;
      expect(d.status).toBe('completed');
      expect(d.draft!.name).toBe('release-notes');
      expect(d.draft!.evidence.map((e) => e.verified)).toEqual([true, false, false]);
      expect(d.draft!.evidence[0].sessionId).toBe(SOURCES[0]);
      expect(d.draft!.body).toContain('## 默认做法（不用再问）\n\n- 写成中文还是英文？ → 中文，按 feat 和 fix 分组');
    } finally {
      delete process.env.FAKE_ANSWER_FILE;
    }
  });

  it('checks the name and how the draft shows in the skill listing', async () => {
    expect(checkName('report-writer')).toMatchObject({ ok: false });
    expect(checkName('Bad Name')).toMatchObject({ ok: false });
    const c = await checkDraft({ name: 'release-notes', description: '整理发版说明（release notes）。不用于周报。', body: '# x\n', triggers: ['发版说明', 'changelog'] });
    expect(c.name.ok).toBe(true);
    expect(c.listing?.visible).toContain('整理发版说明');
    expect(c.listing?.truncated).toBe(false);
    expect(c.triggers).toEqual([
      { text: '发版说明', where: 'visible' },
      { text: 'changelog', where: 'missing' },
    ]);
  });

  it('saves it as a new skill, builds its evaluation set and runs it', async () => {
    const v = await saveDraft({ name: 'release-notes', description: '整理发版说明（release notes）。不用于周报。', body: '# release-notes\n\n1. git log\n' });
    variantId = v.id;
    expect(v).toMatchObject({ skillKey: 'release-notes', originalPath: '' });
    expect(variantDetail(v).baseRaw).toBeUndefined();
    await expect(saveDraft({ name: 'report-writer', description: 'x', body: '' })).rejects.toThrow(/已经有叫 report-writer/);

    const r = await draftSet(v.id, SOURCES, { negatives: 2 });
    const members = setCases(r.set.id);
    expect(members.filter((m) => m.role === 'positive').map((m) => m.case!.threadId).sort()).toEqual([...SOURCES].sort());
    expect(members.filter((m) => m.role === 'negative').map((m) => m.case!.threadId)).toContain(OTHER);
    // positives must also stop asking
    expect(getCase(members[0].caseId)!.checks).toContainEqual({ kind: 'no_question' });
    expect(r.arms).toEqual([
      { label: 'A′', variantIds: [] },
      { label: '+release-notes', variantIds: [v.id] },
    ]);

    // the fake agent loads the new skill for release-note requests once it is mounted, and then does not ask
    Object.assign(process.env, { FAKE_SKILL_WHEN: 'release-notes:发版', FAKE_SKILL_PROMPT: '发版', FAKE_ASK: '1' });
    try {
      const e = await createEval(r.set.id, { arms: r.arms, repeats: 1, options: { maxSteps: 10, workspace: 'readonly', allowMcp: false, judge: false } });
      const t0 = Date.now();
      while (getEval(e.id)!.status === 'running' && Date.now() - t0 < 60_000) await new Promise((x) => setTimeout(x, 100));
      const report = evalReport(e.id);
      expect(report.skill!.perArm['A′']).toMatchObject({ recall: 0 });
      expect(report.skill!.perArm['+release-notes']).toMatchObject({ recall: 1, falseTriggerRate: 0 });
      expect(report.totals['+release-notes'].passRate).toBe(1);
    } finally {
      for (const k of ['FAKE_SKILL_WHEN', 'FAKE_SKILL_PROMPT', 'FAKE_ASK']) delete process.env[k];
    }
  });

  it('installs the new skill into the skills dir, and undoes it', () => {
    const res = applyVariant(variantId);
    expect(res.mode).toBe('applied');
    const target = path.join(home, 'skills', 'release-notes', 'SKILL.md');
    expect(fs.existsSync(target)).toBe(true);
    expect(catalog().some((s) => s.key === 'release-notes')).toBe(true);
    expect(getVariant(variantId)!.originalPath).toBe(path.dirname(target));
    expect(() => applyVariant(variantId)).toThrow();
    undoApply((res as { applyId: string }).applyId);
    expect(fs.existsSync(path.dirname(target))).toBe(false);
    expect(catalog().some((s) => s.key === 'release-notes')).toBe(false);
    expect(getVariant(variantId)!.originalPath).toBe('');
  });
});

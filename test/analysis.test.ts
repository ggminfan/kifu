import { describe, expect, it } from 'vitest';
import { callContext } from '../src/core/analysis/context';
import { anchorValid, buildDigest } from '../src/core/analysis/digest';
import { attribution } from '../src/core/analysis/errors';
import { findEvidence } from '../src/core/analysis/evidence';
import { skillReport, type DiskSkill } from '../src/core/analysis/skills';
import { alignSequences, normalizeSeqToken, seqLabel, seqToken, summarizeTrace } from '../src/core/compare/summary';
import { parseRollout } from '../src/core/parse';
import { updateSkillMd, parseSkillMd } from '../src/core/skills/frontmatter';
import { extractJson } from '../src/server/services/askWhy';
import { RolloutBuilder, item, nested } from './fixtures/builder';

const LISTING = [
  '<skills_instructions>',
  '## Skills',
  '### Available skills',
  '- alpha: Generate quarterly finance reports from the ledger when the user (file: /home/u/.codex/skills/alpha/SKILL.md)',
  '- beta: Lint markdown documents. (file: /home/u/.codex/skills/beta/SKILL.md)',
  '</skills_instructions>',
].join('\n');

const DISK: Record<string, DiskSkill> = {
  '/home/u/.codex/skills/alpha/SKILL.md': {
    path: '/home/u/.codex/skills/alpha/SKILL.md',
    description: 'Generate quarterly finance reports from the ledger when the user asks for revenue dashboards or 季度财报',
    body: 'Run `ledger export --quarter` then render with report-tool.\nAlways cite ledger rows.',
    lines: 40,
  },
  '/home/u/.codex/skills/beta/SKILL.md': { path: '/home/u/.codex/skills/beta/SKILL.md', description: 'Lint markdown documents.', body: 'Use markdownlint.', lines: 5 },
};

async function session() {
  const b = new RolloutBuilder()
    .meta({ id: 'th-a' })
    .taskStarted('t1')
    .append('t1', [item.dev(LISTING), item.user('please build revenue dashboards for 季度财报')])
    .append('t1', [item.exec('x', 'call_1')])
    .execEnd(nested('call_1'), 'npm test', 1)
    .append('t1', [item.output('call_1', 'Script completed')])
    .tokens(1000, 10)
    .append('t1', [item.exec('x', 'call_2')])
    .execEnd(nested('call_2'), 'npm test', 1)
    .append('t1', [item.output('call_2', 'Script completed')])
    .tokens(1200, 10)
    .append('t1', [item.exec('x', 'call_3')])
    .execEnd(nested('call_3'), 'npm test', 1)
    .append('t1', [item.output('call_3', 'Script completed')])
    .tokens(1400, 10)
    .taskComplete('t1')
    .taskStarted('t2')
    .append('t2', [item.user('now lint the docs')])
    .append('t2', [item.call('Skill', { skill: 'beta' }, 'call_4')])
    .append('t2', [item.output('call_4', '<skill><name>beta</name><path>/home/u/.codex/skills/beta/SKILL.md</path>\nUse markdownlint.')])
    .tokens(1500, 10)
    .append('t2', [item.exec('x', 'call_5')])
    .execEnd(nested('call_5'), "sed -n '1,10p' /home/u/.codex/skills/alpha/SKILL.md")
    .append('t2', [item.output('call_5', 'Script completed')])
    .tokens(1600, 10)
    .append('t2', [item.assistant('done')])
    .tokens(1700, 5)
    .taskComplete('t2');
  return (await parseRollout(b.write(), { homeDir: '/home/u' })).trace;
}

describe('skill report', () => {
  it('detects truncation, missed triggers with tail-only words, loads and partial reads', async () => {
    const trace = await session();
    const rep = skillReport(trace, (p) => (p ? DISK[p] : undefined));
    const alpha = rep.rows.find((r) => r.name === 'alpha')!;
    const beta = rep.rows.find((r) => r.name === 'beta')!;
    expect(alpha.truncated).toBe(true);
    expect(alpha.hiddenTail).toBe('asks for revenue dashboards or 季度财报');
    expect(alpha.flags).toEqual(expect.arrayContaining(['maybe_missed', 'trigger_truncated', 'loaded', 'partial_read']));
    expect(alpha.relevance?.tailOnly).toEqual(expect.arrayContaining(['revenue', 'dashboards']));
    expect(beta.truncated).toBe(false);
    expect(beta.flags).toContain('loaded');
    expect(rep.listing).toMatchObject({ format: 'codex', entries: 2, truncatedCount: 1 });
  });
});

describe('attribution', () => {
  it('finds failed commands and repeated command loops', async () => {
    const trace = await session();
    const a = attribution(trace);
    expect(a.failedCommands).toHaveLength(3);
    expect(a.loops).toHaveLength(1);
    expect(a.loops[0]).toMatchObject({ count: 3, signature: 'npm test' });
  });

  it('builds per-call context with composition and new-item flags', async () => {
    const trace = await session();
    const ctx = callContext(trace, 1);
    // The call's own output items are not part of its input.
    expect(ctx.items.map((i) => i.cat)).toEqual(['skills_listing', 'user', 'tool_call', 'tool_output']);
    expect(ctx.newCount).toBe(2);
    expect(ctx.composition.find((r) => r.cat === 'skills_listing')).toBeTruthy();
  });
});

describe('tool sequences', () => {
  const shell = (command: unknown) => ({ kind: 'shell', name: 'shell', argsJson: { command }, args: { preview: '', chars: 0 }, inner: [] }) as unknown as Parameters<typeof seqToken>[0];
  it('take the command a shell call runs, read as a person would; older tokens still line up', () => {
    expect(seqToken(shell(['bash', '-lc', 'rg -n "retry" test src']))).toBe('shell:shell:rg -n');
    expect(seqToken(shell(['/bin/zsh', '-lc', 'pnpm test']))).toBe('shell:shell:pnpm test');
    expect(seqToken(shell(['ls', '-la']))).toBe('shell:shell:ls -la');
    expect(seqToken(shell('git status'))).toBe('shell:shell:git status');
    // runs stored before: the array was joined with commas
    expect(normalizeSeqToken('shell:shell:bash,-lc,rg -n')).toBe('shell:shell:rg -n');
    expect(normalizeSeqToken('shell:shell:/bin/zsh,-lc,pnpm')).toBe('shell:shell:pnpm');
    expect(normalizeSeqToken('patch:apply_patch:retry.ts')).toBe('patch:apply_patch:retry.ts');
    expect(alignSequences(['shell:shell:bash,-lc,rg -n'], ['shell:shell:rg -n']).rows[0].same).toBe(true);
    expect(seqLabel('shell:shell:bash,-lc,rg -n')).toBe('shell · rg -n');
    expect(seqLabel('patch:apply_patch:retry.ts')).toBe('apply_patch（patch） · retry.ts');
    expect(seqLabel('function:lookup')).toBe('lookup');
  });
});

describe('compare', () => {
  it('summarizes executions and aligns tool sequences', async () => {
    const trace = await session();
    const s = summarizeTrace(trace, ['beta']);
    expect(s).toMatchObject({ skillLoaded: true, skillModes: ['tool'], otherSkills: ['alpha'], calls: 6, tools: 5 });
    const al = alignSequences(['a', 'b', 'c', 'd'], ['a', 'x', 'c', 'd', 'e']);
    expect(al.firstDivergence).toBe(1);
    expect(al.rows.filter((r) => r.same)).toHaveLength(3);
  });
});

describe('evidence', () => {
  it('ranks the skill line that contains the executed command first', () => {
    const hits = findEvidence(['ledger', 'export', '--quarter'], [
      { source: 'user', label: 'user', text: 'make me a report' },
      { source: 'skill_file', label: 'alpha', skill: 'alpha', text: 'intro\n\nRun `ledger export --quarter` then render.\nmore' },
    ]);
    expect(hits[0]).toMatchObject({ source: 'skill_file', skill: 'alpha' });
    expect(hits[0].snippet).toContain('ledger export --quarter');
  });
});

describe('ask-why plumbing', () => {
  it('builds a digest with anchors and validates refs', async () => {
    const trace = await session();
    const skills = skillReport(trace, (p) => (p ? DISK[p] : undefined));
    const d = buildDigest({ trace, skills, attribution: attribution(trace), question: 'why?', skillBodies: { alpha: DISK['/home/u/.codex/skills/alpha/SKILL.md'].body! } });
    expect(d.text).toContain('[S:alpha]');
    expect(d.text).toContain('~~asks for revenue dashboards or 季度财报~~');
    expect(anchorValid('C2', d.anchors)).toBe(true);
    expect(anchorValid('T:call_4', d.anchors)).toBe(true);
    expect(anchorValid('L:alpha#L1-2', d.anchors)).toBe(true);
    expect(anchorValid('C99', d.anchors)).toBe(false);
  });

  it('extracts JSON from fenced or chatty answers', () => {
    expect(extractJson('```json\n{"a": [1, 2,],}\n```')).toEqual({ a: [1, 2] });
    expect(extractJson('Sure! {"answer": "x"} hope it helps')).toEqual({ answer: 'x' });
  });
});

describe('frontmatter', () => {
  it('updates the description without disturbing other keys or comments', () => {
    const raw = '---\nname: alpha\n# keep me\ndescription: old text\nmetadata:\n  x: 1\n---\nBody\n';
    const out = updateSkillMd(raw, { description: 'new: text with colon' });
    expect(out).toContain('# keep me');
    expect(parseSkillMd(out)).toMatchObject({ name: 'alpha', description: 'new: text with colon', body: 'Body\n' });
    expect(parseSkillMd(out).data.metadata).toEqual({ x: 1 });
  });
});

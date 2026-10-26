import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, describe, expect, it } from 'vitest';
import { makeSyntheticClaudeHome, makeSyntheticCodexHome, makeSyntheticHomeWithoutDb } from '../scripts/lib/synthetic-homes';
import { parseSession } from '../src/core/parse';
import { discoverAgents, findClaudeHomes, findCodexHomes } from '../src/server/discover';
import { resolveRollout } from '../src/server/services/sessions';
import { getSession, listSessions, sessionTree, sourceIdOf, sourceInfos } from '../src/server/services/stateDb';
import { configureSources, sources } from '../src/server/sources/registry';
import { openReadOnly } from '../src/server/sources/threadsDb';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kifu-sources-'));
const saved = { codex: process.env.CODEX_HOME, claude: process.env.CLAUDE_CONFIG_DIR };

const codexHome = makeSyntheticCodexHome(path.join(tmp, 'codex'));
const codexHome2 = makeSyntheticCodexHome(path.join(tmp, 'more', 'codex-b'), 'e2e-codex-2');
const codexNoDb = makeSyntheticHomeWithoutDb(path.join(tmp, 'more', 'codex-c'), '0198e2e0-0000-7000-8000-000000000003');
const claudeHome = makeSyntheticClaudeHome(path.join(tmp, 'claude'));

afterAll(() => {
  configureSources({ agent: 'codex' });
  if (saved.codex === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = saved.codex;
  if (saved.claude === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = saved.claude;
});

describe('workspace sources', () => {
  it('a Codex workspace lists the sessions of every home under its scan directories', () => {
    configureSources({ agent: 'codex', roots: [tmp] });
    expect(sources().map((s) => s.home).sort()).toEqual([codexHome, codexHome2, codexNoDb].sort());

    const { sessions, total } = listSessions({});
    expect(total).toBe(3);
    expect(new Set(sessions.map((s) => s.sourceId)).size).toBe(3);
    expect(sessions.map((s) => s.id).sort()).toEqual(['0198e2e0-0000-7000-8000-000000000003', 'e2e-codex-1', 'e2e-codex-2']);
    expect(getSession('e2e-codex-2')?.sourceLabel).toContain('codex-b');
    // a home without a thread index is listed from its rollouts
    const scanned = getSession('0198e2e0-0000-7000-8000-000000000003');
    expect(scanned).toMatchObject({ cwd: '/workspace/demo', rolloutExists: true, firstUserMessage: 'hello' });
    expect(resolveRollout('0198e2e0-0000-7000-8000-000000000003')).toMatch(/0198e2e0-0000-7000-8000-000000000003\.jsonl$/);

    const infos = sourceInfos();
    expect(infos.map((s) => s.sessions)).toEqual([1, 1, 1]);
    const one = infos[0].id;
    expect(listSessions({ source: one }).total).toBe(1);
    expect(sourceIdOf(listSessions({ source: one }).sessions[0].id)).toBe(one);
  });

  it('a Codex workspace can read one home', async () => {
    configureSources({ agent: 'codex', home: codexHome });
    expect(sources()).toMatchObject([{ agent: 'codex', kind: 'codex', home: codexHome, dataRoot: codexHome }]);
    expect(listSessions({}).sessions.map((s) => s.id)).toEqual(['e2e-codex-1']);
    const { trace } = await parseSession(resolveRollout('e2e-codex-1')!);
    expect(trace.calls.map((c) => c.usage?.total)).toEqual([930, 1012]);
    expect(trace.tools.call_A.inner).toHaveLength(1);
  });

  it('a Claude Code workspace has one source per project, subagents under their parent', async () => {
    configureSources({ agent: 'claude', home: claudeHome });
    const all = sources();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ agent: 'claude', kind: 'claude' });
    expect(all[0].label).toContain('work/demo');

    expect(listSessions({}).sessions.map((s) => s.id)).toEqual(['e2e-claude-1']);
    expect(listSessions({ includeSubagents: true }).total).toBe(2);
    expect(getSession('e2e-claude-1')).toMatchObject({ title: 'claude demo', firstUserMessage: 'review the change', tokensUsed: 108, childCount: 1 });
    const tree = sessionTree('e2e-claude-1');
    expect(tree?.children.map((c) => c.session.id)).toEqual(['agent-e2e01']);

    const { trace } = await parseSession(resolveRollout('agent-e2e01')!);
    expect(trace.meta.threadId).toBe('agent-e2e01');
    expect(trace.turns[0].trigger).toBe('inter_agent');
  });

  it('discovery scans each agent under its own directories, and only the agents asked for', () => {
    const agents = discoverAgents({ codex: [codexHome], claude: [claudeHome] });
    expect(agents.map((a) => [a.agent, a.sources, a.sessions])).toEqual([
      ['codex', 1, 1],
      ['claude', 1, 1],
    ]);
    expect(agents.find((a) => a.agent === 'codex')?.paths).toEqual([codexHome]);
    expect(discoverAgents({ codex: [tmp] }).map((a) => [a.agent, a.sources, a.sessions])).toEqual([['codex', 3, 3]]);
    expect(discoverAgents({ claude: [] })).toEqual([]);
    // default directories: $CODEX_HOME / $CLAUDE_CONFIG_DIR
    process.env.CODEX_HOME = codexHome;
    process.env.CLAUDE_CONFIG_DIR = claudeHome;
    expect(discoverAgents({ codex: ['$CODEX_HOME'], claude: ['$CLAUDE_CONFIG_DIR', '$KIFU_UNSET_VAR/x'] }).map((a) => a.agent)).toEqual(['codex', 'claude']);
  });

  it('finds Codex homes and Claude Code config dirs, and nothing else', () => {
    expect(findCodexHomes([tmp]).sort()).toEqual([codexHome, codexHome2, codexNoDb].sort());
    // a sessions/ folder that is not Codex's (no year dirs, no thread index)
    fs.mkdirSync(path.join(tmp, 'notes', 'sessions', 'march'), { recursive: true });
    expect(findCodexHomes([path.join(tmp, 'notes')])).toEqual([]);
    expect(findClaudeHomes([tmp])).toEqual([claudeHome]);
    // a projects/ folder that is not Claude Code's
    const other = path.join(tmp, 'work');
    fs.mkdirSync(path.join(other, 'projects', 'website'), { recursive: true });
    expect(findClaudeHomes([other])).toEqual([]);
  });
});

describe('reading other programs’ databases', () => {
  it('reads a WAL database whose -wal/-shm are gone even where no -shm can be created', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kifu-ro-'));
    const file = path.join(dir, 'state_5.sqlite');
    const w = new DatabaseSync(file);
    w.exec("pragma journal_mode=wal; create table threads (id text); insert into threads values ('a'), ('b');");
    w.close(); // a clean close removes -wal and -shm
    fs.chmodSync(dir, 0o555);
    try {
      const db = openReadOnly(file);
      expect((db.prepare('select count(*) as n from threads').get() as { n: number }).n).toBe(2);
      db.close();
    } finally {
      fs.chmodSync(dir, 0o755);
    }
    expect(() => openReadOnly(path.join(dir, 'missing.sqlite'))).toThrow();
  });
});

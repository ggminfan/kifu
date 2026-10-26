import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SessionListResponse } from '../src/shared/api';
import { configure, ensureDataDirs } from '../src/server/config';
import { discoverAgents } from '../src/server/discover';
import { sessionRoutes } from '../src/server/routes/sessions';
import { skillSignals, skillUsage } from '../src/server/services/indexer';
import { sourceInfos } from '../src/server/services/stateDb';
import { tmDb } from '../src/server/services/tmDb';
import { configureSources, refreshSources } from '../src/server/sources/registry';
import { item, RolloutBuilder } from './fixtures/builder';

/**
 * Sessions still in the agent's index whose record file is gone (deleted, or moved by hand):
 * listed apart from the readable ones, left out of counts and of lists built from the index.
 * A file that only moved within sessions/ is still found. Newer indexes have a `name` column.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kifu-unreadable-'));
const KEPT = '0199dddd-0000-7000-8000-00000000000a';
const GONE = '0199dddd-0000-7000-8000-00000000000b';
const MOVED = '0199dddd-0000-7000-8000-00000000000c';

function rollout(dir: string, id: string, ask: string): string {
  fs.mkdirSync(dir, { recursive: true });
  const b = new RolloutBuilder().meta({ id, cwd: '/work/demo' });
  b.taskStarted('t1').turnContext('t1').append('t1', [item.user(ask)]);
  b.append('t1', [item.assistant('done')]).tokens(100, 5).taskComplete('t1');
  const file = path.join(dir, `rollout-2026-10-01T00-00-00-${id}.jsonl`);
  fs.writeFileSync(file, `${b.lines.map((l) => JSON.stringify(l)).join('\n')}\n`);
  return file;
}

beforeAll(() => {
  configure({ dataDir: path.join(tmp, 'data') });
  ensureDataDirs();
  const home = path.join(tmp, 'codex');
  const day = path.join(home, 'sessions', '2026', '10', '01');
  const kept = rollout(day, KEPT, 'keep me');
  const gone = rollout(day, GONE, 'gone');
  // the index says 10/01, the file sits under 10/02
  const moved = path.join(day, `rollout-2026-10-01T00-00-00-${MOVED}.jsonl`);
  rollout(path.join(home, 'sessions', '2026', '10', '02'), MOVED, 'moved');
  fs.rmSync(gone);
  // a newer index: the columns we read, plus `name`
  const db = new DatabaseSync(path.join(home, 'state_5.sqlite'));
  db.exec(`create table threads (id text primary key, rollout_path text, created_at_ms integer, updated_at_ms integer, created_at integer, updated_at integer,
    source text, cwd text, title text, tokens_used integer, archived integer, git_branch text, cli_version text, first_user_message text,
    agent_nickname text, agent_role text, agent_path text, model text, thread_source text, name text, history_mode text);
    create table thread_spawn_edges (parent_thread_id text, child_thread_id text);`);
  const now = Date.now();
  const add = db.prepare('insert into threads (id, rollout_path, created_at_ms, updated_at_ms, source, cwd, title, tokens_used, archived, first_user_message, name, history_mode) values (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)');
  add.run(KEPT, kept, now - 3000, now - 3000, 'cli', '/work/demo', 'keep me', 100, 'keep me', 'Renamed thread', 'paginated');
  add.run(GONE, gone, now - 2000, now - 1000, 'cli', '/work/demo', 'gone', 100, 'gone', null, 'legacy');
  add.run(MOVED, moved, now - 1000, now - 2000, 'cli', '/work/demo', 'moved', 100, 'moved', null, 'legacy');
  db.close();
  configureSources({ agent: 'codex', home });
  refreshSources();
  // the index still has signals of the session whose file is gone
  const signal = tmDb().prepare('insert into skill_signals (thread_id, skill, listed, loaded) values (?, ?, 1, 1)');
  signal.run(KEPT, 'alpha');
  signal.run(GONE, 'alpha');
});

afterAll(() => {
  configureSources({ agent: 'codex' });
  fs.rmSync(tmp, { recursive: true, force: true });
});

const list = async (query: string) => {
  const res = await sessionRoutes.request(`/?q=&sub=0${query}`);
  expect(res.status).toBe(200);
  return (await res.json()) as SessionListResponse;
};

describe('sessions whose record file is gone', () => {
  it('are listed apart from the readable ones (a file moved within sessions/ is still found)', async () => {
    const readable = await list('&missing=exclude');
    expect(readable.sessions.map((s) => s.id).sort()).toEqual([KEPT, MOVED].sort());
    expect(readable).toMatchObject({ total: 2, missing: 1 });
    const gone = await list('&missing=only');
    expect(gone.sessions.map((s) => [s.id, s.rolloutExists])).toEqual([[GONE, false]]);
    // without the parameter: everything, as before
    expect((await list('')).total).toBe(3);
    // a thread's name is its title
    expect(readable.sessions.find((s) => s.id === KEPT)?.title).toBe('Renamed thread');
  });

  it('do not count as sessions, in the list of sources or in a home scan', () => {
    expect(sourceInfos()[0]).toMatchObject({ sessions: 2, missing: 1 });
    // the newest session is the one that is gone: the scan's latest title skips it
    expect(discoverAgents({ codex: [path.join(tmp, 'codex')] })).toMatchObject([{ agent: 'codex', sessions: 2, latestTitle: 'moved' }]);
  });

  it('are left out of what the index offers (related sessions, cases from a skill, usage counts)', () => {
    expect(skillSignals('alpha').sessions.map((s) => s.threadId)).toEqual([KEPT]);
    expect(skillSignals('alpha').counts.loaded).toBe(1);
    expect(skillUsage()).toEqual([]); // no summaries yet: only what was indexed counts
  });
});

/**
 * Made-up agent homes for tests and end-to-end runs (no user data): CODEX_HOMEs
 * with one short session (with or without a thread index), and a Claude Code
 * config dir.
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { CodexRolloutBuilder, codexItem, item, RolloutBuilder } from '../../test/fixtures/builder';
import { ClaudeTranscriptBuilder, block } from '../../test/fixtures/claude';

interface ThreadRow {
  id: string;
  rollout: string;
  title: string;
  tokens: number;
  first: string;
}

/** A minimal state_5.sqlite (the columns Kifu reads; Codex's table is a superset). */
function writeThreadsDb(dataRoot: string, rows: ThreadRow[]): void {
  const db = new DatabaseSync(path.join(dataRoot, 'state_5.sqlite'));
  db.exec(`create table threads (id text primary key, rollout_path text, created_at_ms integer, updated_at_ms integer, created_at integer, updated_at integer,
    source text, cwd text, title text, tokens_used integer, archived integer, git_branch text, cli_version text, first_user_message text,
    agent_nickname text, agent_role text, agent_path text, model text, thread_source text);
    create table thread_spawn_edges (parent_thread_id text, child_thread_id text);`);
  const now = Date.now();
  for (const r of rows) {
    db.prepare('insert into threads (id, rollout_path, created_at_ms, updated_at_ms, source, cwd, title, tokens_used, archived, first_user_message, model) values (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)').run(
      r.id, r.rollout, now - 60_000, now, 'cli', '/workspace/demo', r.title, r.tokens, r.first, 'demo-model',
    );
  }
  db.close();
}

/** A made-up CODEX_HOME with rollouts but no state_5.sqlite yet (listed from the rollouts themselves). */
export function makeSyntheticHomeWithoutDb(h: string, threadId: string): string {
  const sessions = path.join(h, 'sessions', '2026', '09', '01');
  fs.mkdirSync(sessions, { recursive: true });
  const b = new RolloutBuilder()
    .meta({ id: threadId, cwd: '/workspace/demo' })
    .taskStarted('t1')
    // the environment and AGENTS.md come as user messages before the request
    .append('t1', [item.user('<environment_context>\n  <cwd>/workspace/demo</cwd>\n</environment_context>'), item.user('# AGENTS.md instructions for /workspace/demo\n\n<INSTRUCTIONS>\n- keep answers short\n</INSTRUCTIONS>'), item.user('hello')])
    .append('t1', [item.assistant('hi')])
    .tokens(10, 2)
    .taskComplete('t1');
  // the scan finds rollouts by the thread id at the end of the file name
  fs.writeFileSync(path.join(sessions, `rollout-2026-09-01T00-00-00-${threadId}.jsonl`), `${b.lines.map((l) => JSON.stringify(l)).join('\n')}\n`);
  return h;
}

/** A made-up CODEX_HOME: one Codex rollout (response items, usage records) and its thread index. */
export function makeSyntheticCodexHome(home: string, threadId = 'e2e-codex-1'): string {
  const sessions = path.join(home, 'sessions', '2026', '09', '02');
  fs.mkdirSync(sessions, { recursive: true });
  const rollout = new CodexRolloutBuilder()
    .meta({ id: threadId })
    .taskStarted('t1')
    .item('t1', item.user('list the files'), ['user.text'])
    .turnContext('t1')
    .item('t1', item.reasoning('look'))
    .item('t1', codexItem.custom('exec', 'await tools.exec_command({cmd:"ls"})', 'call_A'))
    .usage('t1', 900, 30)
    .command('exec-1', 'ls')
    .item('t1', codexItem.customOutput('call_A', 'Output:\na.txt'))
    .item('t1', item.assistant('There is a.txt'))
    .usage('t1', 1000, 12)
    .taskComplete('t1')
    .write(sessions);
  writeThreadsDb(home, [{ id: threadId, rollout, title: 'codex demo', tokens: 1942, first: 'list the files' }]);
  return home;
}

/** A made-up Claude Code config dir: one project with a session that started a subagent. */
export function makeSyntheticClaudeHome(home: string): string {
  const dir = path.join(home, 'projects', '-work-demo');
  fs.mkdirSync(dir, { recursive: true });
  new ClaudeTranscriptBuilder('e2e-claude-1')
    .plain('custom-title', { customTitle: 'claude demo', sessionId: 'e2e-claude-1' })
    .prompt('review the change')
    .assistant('msg_1', [block.tool('tu_ag', 'Agent', { description: 'Review', prompt: 'review the diff', subagent_type: 'reviewer' })], { input: 40, output: 6 }, 'tool_use')
    .toolResult('tu_ag', 'looks good', { result: { agentId: 'e2e01', status: 'completed' } })
    .assistant('msg_2', [block.text('Reviewed.')], { input: 60, output: 2 }, 'end_turn')
    .write(dir);
  new ClaudeTranscriptBuilder('e2e-claude-1', 'e2e01')
    .prompt('review the diff')
    .assistant('msg_c1', [block.text('looks good')], { input: 30, output: 3 }, 'end_turn')
    .write(dir, { agentType: 'reviewer', description: 'Review', toolUseId: 'tu_ag', spawnDepth: 1 });
  return home;
}

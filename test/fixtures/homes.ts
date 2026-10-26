import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CodexRolloutBuilder, item, RolloutBuilder } from './builder';

/**
 * Made-up agent homes for replay, Lab and evaluation tests (no user data): a
 * CODEX_HOME with one two-turn session whose second turn fails a command and
 * asks back, and one with a two-turn session in the newer record format; each
 * with one skill, MCP servers and a notify program in the config, and a fake
 * login.
 */

export const FAKE_AGENT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fake-agent.mjs');

export const ASK_ID = '0199aaaa-0000-7000-8000-000000000001';
export const CODEX_ID = '0199bbbb-0000-7000-8000-000000000002';

/** A CODEX_HOME whose session's second turn fails a command and asks back. */
export function askHome(tmp: string): { home: string; file: string } {
  const home = path.join(tmp, 'ask-home');
  const dir = path.join(home, 'sessions', '2026', '09', '01');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(home, 'config.toml'), 'model = "demo-model"\nnotify = ["notifier", "--done"]\n\n[mcp_servers.demo]\ncommand = "demo-mcp"\n\n[features]\nx = true\n');
  fs.writeFileSync(path.join(home, 'auth.json'), '{"fake":"not a real token"}');
  fs.mkdirSync(path.join(home, 'skills', 'alpha'), { recursive: true });
  fs.writeFileSync(path.join(home, 'skills', 'alpha', 'SKILL.md'), '---\nname: alpha\ndescription: Alpha reports.\n---\nRun `alpha-report`.\n');
  const b = new RolloutBuilder().meta({ id: ASK_ID, cwd: tmp });
  b.taskStarted('t1').append('t1', [item.dev('<permissions instructions>\nread only\n</permissions instructions>')]).turnContext('t1').append('t1', [item.user('list the files')]);
  b.append('t1', [item.call('shell', { command: ['ls'] }, 'call_1')]).tokens(100, 10);
  b.execEnd('call_1', 'ls').append('t1', [item.output('call_1', 'a.txt')]);
  b.append('t1', [item.assistant('a.txt')]).tokens(120, 5).taskComplete('t1');
  b.taskStarted('t2').turnContext('t2').append('t2', [item.user('now summarize a.txt for me')]);
  b.append('t2', [item.call('shell', { command: ['cat', 'a.txt'] }, 'call_2')]).tokens(140, 4);
  b.execEnd('call_2', 'cat a.txt', 1).append('t2', [item.output('call_2', 'boom')]);
  b.append('t2', [item.assistant('你希望我总结哪一部分？')]).tokens(160, 6).taskComplete('t2', { last_agent_message: '你希望我总结哪一部分？' });
  // the turns ran in a directory that exists here
  for (const l of b.lines) if (l.type === 'turn_context') l.payload.cwd = tmp;
  const file = path.join(dir, `rollout-2026-09-01T00-00-00-${ASK_ID}.jsonl`);
  fs.writeFileSync(file, `${b.lines.map((l) => JSON.stringify(l)).join('\n')}\n`);
  return { home, file };
}

export function codexHome(tmp: string): { home: string; file: string } {
  const home = path.join(tmp, 'codex-home');
  const dir = path.join(home, 'sessions', '2026', '09', '02');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(home, 'config.toml'), 'model = "gpt-demo"\nnotify = ["notifier", "--done"]\n\n[mcp_servers.docs]\ncommand = "docs-mcp"\n\n[features]\nhooks = true\n');
  fs.writeFileSync(path.join(home, 'auth.json'), '{"fake":"not a real token"}');
  fs.writeFileSync(path.join(home, 'AGENTS.md'), '# rules\n');
  fs.mkdirSync(path.join(home, 'skills', 'gamma'), { recursive: true });
  fs.writeFileSync(path.join(home, 'skills', 'gamma', 'SKILL.md'), '---\nname: gamma\ndescription: Gamma tool.\n---\nUse gamma.\n');
  const b = new CodexRolloutBuilder().meta({ id: CODEX_ID });
  b.taskStarted('t1').turnContext('t1').item('t1', item.user('run the build'), ['user.text']);
  b.item('t1', item.call('exec_command', { cmd: 'make' }, 'call_A')).usage('t1', 1000, 50).command('exec-1', 'make').item('t1', { type: 'function_call_output', call_id: 'call_A', output: 'ok' }).tokenCount();
  b.item('t1', item.assistant('built')).usage('t1', 1100, 20).tokenCount().taskComplete('t1');
  b.taskStarted('t2').turnContext('t2', 'gpt-demo-2').item('t2', item.user('now run the tests'), ['user.text']);
  b.item('t2', item.assistant('tests pass')).usage('t2', 1200, 20).tokenCount().taskComplete('t2');
  const file = path.join(dir, `rollout-2026-09-02T00-00-00-${CODEX_ID}.jsonl`);
  fs.writeFileSync(file, `${b.lines.map((l) => JSON.stringify(l)).join('\n')}\n`);
  return { home, file };
}

export const EVAL_IDS = {
  loaded: '0199eeee-0000-7000-8000-000000000001',
  missed: '0199eeee-0000-7000-8000-000000000002',
  unrelated: '0199eeee-0000-7000-8000-000000000003',
  neighbour: '0199eeee-0000-7000-8000-000000000004',
};

/**
 * A CODEX_HOME for evaluation tests: two skills with overlapping descriptions
 * (report-writer, git-helper) in the listing of four one-turn sessions — one
 * loads report-writer, one asks for a weekly report without loading it, one
 * is unrelated, one loads git-helper.
 */
export function evalHome(tmp: string): { home: string } {
  const home = path.join(tmp, 'eval-codex');
  const dir = path.join(home, 'sessions', '2026', '09', '03');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(home, 'config.toml'), 'model = "demo-model"\n');
  fs.writeFileSync(path.join(home, 'auth.json'), '{"fake":"not a real token"}');
  const skill = (name: string, description: string) => {
    fs.mkdirSync(path.join(home, 'skills', name), { recursive: true });
    fs.writeFileSync(path.join(home, 'skills', name, 'SKILL.md'), `---\nname: ${name}\ndescription: ${JSON.stringify(description)}\n---\nSteps for ${name}.\n`);
  };
  skill('report-writer', 'Write weekly reports from git logs and commit history.');
  skill('git-helper', 'Git log helper: commits, branches and history.');
  const listing = [
    '<skills_instructions>',
    '## Skills',
    '### Available skills',
    `- report-writer: Write weekly reports from git logs and commit history. (file: ${path.join(home, 'skills', 'report-writer', 'SKILL.md')})`,
    `- git-helper: Git log helper: commits, branches and history. (file: ${path.join(home, 'skills', 'git-helper', 'SKILL.md')})`,
    '</skills_instructions>',
  ].join('\n');
  const session = (id: string, ask: string, read?: string) => {
    const b = new RolloutBuilder().meta({ id, cwd: tmp });
    b.taskStarted('t1').append('t1', [item.dev(listing)]).turnContext('t1').append('t1', [item.user(ask)]);
    if (read) {
      const file = path.join(home, 'skills', read, 'SKILL.md');
      b.append('t1', [item.call('shell', { command: ['cat', file] }, 'c1')]).tokens(500, 10);
      b.execEnd('c1', `cat ${file}`).append('t1', [item.output('c1', `Steps for ${read}.`)]);
    }
    b.append('t1', [item.assistant('done')]).tokens(600, 5).taskComplete('t1', { last_agent_message: 'done' });
    for (const l of b.lines) if (l.type === 'turn_context') l.payload.cwd = tmp;
    fs.writeFileSync(path.join(dir, `rollout-2026-09-03T00-00-00-${id}.jsonl`), `${b.lines.map((l) => JSON.stringify(l)).join('\n')}\n`);
  };
  session(EVAL_IDS.loaded, 'write the weekly report from the git logs of this week', 'report-writer');
  session(EVAL_IDS.missed, 'please write my weekly report from git commit history', undefined);
  session(EVAL_IDS.unrelated, 'list the files in this folder', undefined);
  session(EVAL_IDS.neighbour, 'show the git branches and recent commits', 'git-helper');
  return { home };
}

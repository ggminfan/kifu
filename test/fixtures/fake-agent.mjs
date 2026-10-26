#!/usr/bin/env node
/**
 * A stand-in for the codex CLI in tests (no model calls). Implements what
 * replays, trial runs, previews and analysts use:
 *   --version | debug models
 *   debug prompt-input <prompt>       the skill list of the home it is given (no model)
 *   exec [-s S] [-C DIR] resume <id> --json … [-m M] [-c k=v]… -   (prompt on stdin)
 *   exec … -                          a new session
 *   exec … --ephemeral -o <file> -    an analyst: writes $FAKE_ANSWER_FILE (or {}) to <file>
 * Replays find the session by the id in its file name under $CODEX_HOME/sessions;
 * a turn is appended in Codex's format and `--json` events are printed.
 *
 * Behaviour knobs (env): FAKE_STEPS (tool steps, default 1), FAKE_STEP_MS
 * (pause per step), FAKE_FAIL_CMD=1 (commands exit 1), FAKE_ASK=1 (the answer
 * asks the user), FAKE_SKILL=<name> (step 1 reads that skill's SKILL.md),
 * FAKE_SKILL_WHEN=<name>:<word>[,…] (same, but only when that SKILL.md mentions the word:
 * a variant that adds it makes the replay load the skill; then it neither fails
 * nor asks back), FAKE_SKILL_PROMPT=<regex> (with FAKE_SKILL_WHEN: and only for
 * prompts it matches),
 * FAKE_NO_LOGIN=1 (fail before any model call), FAKE_LOG=<file> (argv, the
 * homes and whether the prompt was in argv, as JSON).
 */
import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const env = process.env;

if (argv[0] === '--version') {
  console.log('codex-cli 0.0.0-fake');
  process.exit(0);
}
if (argv[0] === 'debug' && argv[1] === 'models') {
  console.log(JSON.stringify({ models: [{ slug: 'fake-model', display_name: 'Fake', default_reasoning_level: 'low', supported_reasoning_levels: [{ effort: 'low' }, { effort: 'high' }], visibility: 'list' }] }));
  process.exit(0);
}

const opt = (flag) => {
  const i = argv.indexOf(flag);
  return i === -1 ? undefined : argv[i + 1];
};
const skillsDir = path.join(env.CODEX_HOME ?? '', 'skills');

/** The skills of the home, as the agent would list them (name, description, file). */
function listing() {
  const lines = [];
  let dirs = [];
  try {
    dirs = fs.readdirSync(skillsDir).filter((n) => !n.startsWith('.'));
  } catch {
    // no skills
  }
  for (const n of dirs.sort()) {
    let raw = '';
    try {
      raw = fs.readFileSync(path.join(skillsDir, n, 'SKILL.md'), 'utf8');
    } catch {
      continue;
    }
    const desc = /^description:\s*(.*)$/m.exec(raw)?.[1]?.trim() ?? '';
    const name = /^name:\s*(.*)$/m.exec(raw)?.[1]?.trim() ?? n;
    lines.push(`- ${name}: ${desc} (file: ${path.join(skillsDir, n, 'SKILL.md')})`);
  }
  return ['<skills_instructions>', '## Skills', 'A skill is a set of local instructions to follow that is stored in a `SKILL.md` file.', '### Available skills', ...lines, '</skills_instructions>'].join('\n');
}

if (argv[0] === 'debug' && argv[1] === 'prompt-input') {
  const items = [
    { type: 'message', role: 'developer', content: [{ type: 'input_text', text: listing() }] },
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: argv[2] ?? '' }] },
  ];
  console.log(JSON.stringify(items));
  process.exit(0);
}
if (argv[0] !== 'exec') {
  console.error(`fake-agent: unsupported ${argv.join(' ')}`);
  process.exit(2);
}
if (argv.includes('--ephemeral')) {
  // an analyst: no session, the answer in -o
  const stdin = fs.readFileSync(0, 'utf8');
  const answer = env.FAKE_ANSWER_FILE ? fs.readFileSync(env.FAKE_ANSWER_FILE, 'utf8') : '{}';
  if (env.FAKE_ANALYST_LOG) fs.writeFileSync(env.FAKE_ANALYST_LOG, JSON.stringify({ argv, stdinChars: stdin.length, stdinHead: stdin.slice(0, 200), skills: listing().split('\n').filter((l) => l.startsWith('- ')).length }));
  const out = opt('-o');
  if (out) fs.writeFileSync(out, answer);
  process.stdout.write(`${JSON.stringify({ type: 'item.completed', item: { id: 'a', type: 'agent_message', text: answer } })}\n`);
  process.stdout.write(`${JSON.stringify({ type: 'turn.completed', usage: { input_tokens: stdin.length, output_tokens: answer.length } })}\n`);
  process.exit(0);
}
const resumeAt = argv.indexOf('resume');
const fresh = resumeAt === -1;
const newUuid = () => {
  const h = [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-7${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
};
const id = fresh ? newUuid() : argv[resumeAt + 1];
const cwd = opt('-C') ?? process.cwd();
const model = opt('-m') ?? 'fake-model';
const effort = argv.flatMap((a, i) => (argv[i - 1] === '-c' && a.startsWith('model_reasoning_effort=') ? [a.split('=')[1].replace(/"/g, '')] : []))[0] ?? 'medium';
const prompt = fs.readFileSync(0, 'utf8');

if (env.FAKE_LOG) {
  const homeDir = env.CODEX_HOME;
  const read = (f) => {
    try {
      return fs.readFileSync(f, 'utf8');
    } catch {
      return undefined;
    }
  };
  const lstat = (f) => {
    try {
      return fs.lstatSync(f).isSymbolicLink() ? 'symlink' : 'file';
    } catch {
      return 'missing';
    }
  };
  fs.writeFileSync(
    env.FAKE_LOG,
    JSON.stringify({
      argv,
      cwd,
      model,
      effort,
      codexHome: env.CODEX_HOME,
      promptInArgv: argv.some((a) => a.includes(prompt.trim()) && prompt.trim().length > 3),
      config: read(path.join(homeDir ?? '', 'config.toml')),
      auth: lstat(path.join(env.CODEX_HOME ?? '', 'auth.json')),
      skills: (() => {
        try {
          return fs.readdirSync(path.join(homeDir ?? '', 'skills')).filter((n) => !n.startsWith('.'));
        } catch {
          return [];
        }
      })(),
      // what steers the agent, as it would read it
      skillMd: (() => {
        const out = {};
        try {
          for (const n of fs.readdirSync(path.join(homeDir ?? '', 'skills'))) out[n] = read(path.join(homeDir ?? '', 'skills', n, 'SKILL.md'));
        } catch {
          // no skills
        }
        return out;
      })(),
      agentsMd: { home: read(path.join(homeDir ?? '', 'AGENTS.md')) },
      // the agent's own system skills and the marker it checks them by
      system: (() => {
        const dir = path.join(homeDir ?? '', 'skills', '.system');
        try {
          const all = fs.readdirSync(dir);
          const marker = all.find((n) => /^\..*system-skills\.marker$/.test(n));
          return { names: all.filter((n) => !n.startsWith('.')).sort(), marker: marker ? read(path.join(dir, marker)) : undefined };
        } catch {
          return undefined;
        }
      })(),
      cwdFiles: (() => {
        try {
          return fs.readdirSync(cwd).sort();
        } catch {
          return [];
        }
      })(),
    }),
  );
}
if (env.FAKE_NO_LOGIN === '1') {
  console.error('Error: not logged in');
  process.exit(1);
}
// FAKE_RATE_LIMIT_FILE: a counter of calls to refuse with a 429 before any model call
if (env.FAKE_RATE_LIMIT_FILE && fs.existsSync(env.FAKE_RATE_LIMIT_FILE)) {
  const left = Number(fs.readFileSync(env.FAKE_RATE_LIMIT_FILE, 'utf8')) || 0;
  if (left > 0) {
    fs.writeFileSync(env.FAKE_RATE_LIMIT_FILE, String(left - 1));
    console.error('Error: 429 Too Many Requests (rate limit exceeded)');
    process.exit(1);
  }
}

function walk(dir) {
  try {
    return fs.readdirSync(dir, { recursive: true }).map((f) => path.join(dir, f));
  } catch {
    return [];
  }
}
const root = path.join(env.CODEX_HOME ?? '', 'sessions');
let file = walk(root).find((f) => path.basename(f).includes(id) && f.endsWith('.jsonl'));
if (fresh) {
  // a new session: its meta first
  file = path.join(root, '2026', '10', '06', `rollout-2026-10-06T00-00-00-${id}.jsonl`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const at = '2026-10-06T00:00:00.000Z';
  const meta = { session_id: id, id, timestamp: at, cwd: opt('-C') ?? process.cwd(), originator: 'codex_exec', cli_version: '0.0.0-fake', source: 'exec', model_provider: 'openai', base_instructions: { text: 'You are a coding agent.' } };
  fs.writeFileSync(file, `${JSON.stringify({ timestamp: at, ordinal: 0, type: 'session_meta', payload: meta })}\n`);
}
if (!file) {
  console.error(`fake-agent: no session ${id} under ${root}`);
  process.exit(1);
}

const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
let ordinal = lines.reduce((m, l) => Math.max(m, l.ordinal ?? -1), -1);
let t = Date.parse('2026-10-06T00:00:00.000Z');
const ts = () => new Date((t += 1000)).toISOString();
const write = (type, payload) => fs.appendFileSync(file, `${JSON.stringify({ timestamp: ts(), ordinal: ++ordinal, type, payload })}\n`);
const out = (ev) => process.stdout.write(`${JSON.stringify(ev)}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const turnId = `replay-turn-${Date.now().toString(36)}`;
let total = 0;

const items = (list) => {
  for (const it of list) write('response_item', { ...it, internal_chat_message_metadata_passthrough: { turn_id: turnId } });
};
const usage = (input, output) => {
  total += input + output;
  const last = { input_tokens: input, cached_input_tokens: 0, output_tokens: output, reasoning_output_tokens: 0, total_tokens: input + output };
  write('token_usage_record', { turn_id: turnId, response_id: `resp-${total}`, usage: { ...last, cache_write_input_tokens: 0 } });
  write('event_msg', { type: 'token_count', info: { total_token_usage: { ...last, total_tokens: total }, last_token_usage: last, model_context_window: 200000 }, rate_limits: null });
};

let interrupted = false;
process.on('SIGINT', () => {
  interrupted = true;
  write('event_msg', { type: 'turn_aborted', turn_id: turnId, reason: 'interrupted' });
  process.exit(130);
});

out({ type: 'thread.started', thread_id: id });
out({ type: 'turn.started' });
write('event_msg', { type: 'task_started', turn_id: turnId, started_at: t / 1000, model_context_window: 200000 });
write('turn_context', { turn_id: turnId, cwd, model, effort });
items([
  { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>\n  <current_date>2026-10-06</current_date>\n</environment_context>' }] },
  { type: 'message', role: 'user', content: [{ type: 'input_text', text: prompt }] },
]);

const steps = Number(env.FAKE_STEPS ?? 1);
const skillsRoot = skillsDir;
let skill = env.FAKE_SKILL;
// several rules: "<name>:<word>,<name>:<word>" (the first skill that qualifies loads)
for (const rule of skill ? [] : (env.FAKE_SKILL_WHEN ?? '').split(',').filter(Boolean)) {
  const [name, word] = rule.split(':');
  try {
    const related = !env.FAKE_SKILL_PROMPT || new RegExp(env.FAKE_SKILL_PROMPT, 'i').test(prompt);
    if (related && fs.readFileSync(path.join(skillsRoot, name, 'SKILL.md'), 'utf8').includes(word)) {
      skill = name;
      break;
    }
  } catch {
    // no such skill here
  }
}
for (let i = 1; i <= steps && !interrupted; i++) {
  const callId = `fake_call_${i}`;
  const cmd = i === 1 && skill ? `cat ${path.join(skillsRoot, skill, 'SKILL.md')}` : `ls step-${i}`;
  items([{ type: 'function_call', name: 'exec_command', arguments: JSON.stringify({ cmd }), call_id: callId }]);
  usage(1000 + i, 10);
  const code = env.FAKE_FAIL_CMD === '1' && !(env.FAKE_SKILL_WHEN && skill) ? 1 : 0;
  write('event_msg', { type: 'item_completed', thread_id: id, turn_id: turnId, item: { type: 'CommandExecution', id: callId, command: ['/bin/zsh', '-lc', cmd], cwd, aggregated_output: code ? 'boom' : 'ok', exit_code: code, duration: { secs: 0, nanos: 1000 }, status: code ? 'failed' : 'completed', parsed_cmd: [{ type: 'unknown', cmd }] } });
  items([{ type: 'function_call_output', call_id: callId, output: code ? 'boom' : 'ok' }]);
  out({ type: 'item.completed', item: { id: `item_${i}`, type: 'command_execution', command: cmd, status: 'completed' } });
  if (env.FAKE_STEP_MS) await sleep(Number(env.FAKE_STEP_MS));
}

const answer = env.FAKE_ASK === '1' && !(env.FAKE_SKILL_WHEN && skill) ? '我需要先确认一下：你希望改哪个文件？' : `done: ${prompt.trim().slice(0, 40)}`;
items([{ type: 'message', role: 'assistant', id: 'msg_fake', phase: 'final_answer', content: [{ type: 'output_text', text: answer }] }]);
usage(1100 + steps, 20);
write('event_msg', { type: 'task_complete', turn_id: turnId, last_agent_message: answer, duration_ms: 1000 });
out({ type: 'item.completed', item: { id: 'item_final', type: 'agent_message', text: answer } });
out({ type: 'turn.completed', usage: { input_tokens: total, output_tokens: 0 } });

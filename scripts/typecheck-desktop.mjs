// Typecheck desktop/ with its own tsconfig. Electrobun ships its API as .ts
// sources that do not typecheck cleanly; only errors in our files count.
import { spawnSync } from 'node:child_process';

const r = spawnSync('node_modules/.bin/tsc', ['--noEmit', '--pretty', 'false', '-p', 'desktop'], { encoding: 'utf8' });
if (r.error || r.signal || r.status === null) {
  console.error('desktop typecheck could not run:', r.error ?? r.signal ?? 'unknown exit status');
  process.exit(1);
}
const lines = `${r.stdout}${r.stderr}`.split('\n');
const own = [];
let keep = false;
for (const line of lines) {
  if (/error TS\d+/.test(line)) keep = !line.startsWith('node_modules/');
  else if (!line.startsWith(' ')) keep = false;
  if (keep) own.push(line);
}
if (own.length) {
  console.log(own.join('\n'));
  process.exit(1);
}
if (r.status !== 0 && !lines.some((line) => /^node_modules\/.*error TS\d+/.test(line))) {
  console.error(`desktop typecheck failed (${r.status}):\n${lines.join('\n')}`);
  process.exit(1);
}
console.log('desktop: no type errors (Electrobun sources excluded)');

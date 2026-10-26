import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { baseAssignment } from '../desktop/src/bun/remote/platform';
import { legacyHome, migrateLegacyDb, migrateLegacyHome } from '../src/shared/legacy-home';

const tmpDirs: string[] = [];
function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'kifu-legacy-test-'));
  tmpDirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function put(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

const read = (file: string) => fs.readFileSync(file, 'utf8');

describe('data from before the rename', () => {
  it('does nothing without the old directory', () => {
    const home = tmp();
    expect(legacyHome(home)).toBeUndefined();
    expect(migrateLegacyHome(home)).toBeUndefined();
    expect(fs.existsSync(path.join(home, '.kifu'))).toBe(false);
  });

  it('moves the whole directory when ~/.kifu does not exist yet', () => {
    const home = tmp();
    const old = path.join(home, '.trace-monitor');
    put(path.join(old, 'desktop', 'connections.json'), '{"connections":[]}');
    put(path.join(old, 'runs', 'r1', 'transcript.jsonl'), 'x');
    fs.symlinkSync('/nonexistent/target', path.join(old, 'link'));
    expect(migrateLegacyHome(home)).toEqual({ moved: ['.'], left: [] });
    const now = path.join(home, '.kifu');
    expect(fs.existsSync(old)).toBe(false);
    expect(read(path.join(now, 'desktop', 'connections.json'))).toBe('{"connections":[]}');
    expect(read(path.join(now, 'runs', 'r1', 'transcript.jsonl'))).toBe('x');
    expect(fs.readlinkSync(path.join(now, 'link'))).toBe('/nonexistent/target');
    expect(fs.statSync(now).mode & 0o777).toBe(0o700);
    // a second start finds nothing left to do
    expect(migrateLegacyHome(home)).toBeUndefined();
  });

  it('merges into an existing ~/.kifu entry by entry and never overwrites', () => {
    const home = tmp();
    const old = path.join(home, '.trace-monitor');
    const now = path.join(home, '.kifu');
    put(path.join(old, 'desktop', 'connections.json'), 'old connections');
    put(path.join(old, 'desktop', 'logs', 'app.log'), 'old log');
    put(path.join(old, 'desktop', 'logs', 'ssh-dev.log'), 'old ssh log');
    put(path.join(old, 'tm.sqlite'), 'db');
    put(path.join(old, 'skills', 'v1', 'SKILL.md'), 'variant');
    put(path.join(now, 'desktop', 'logs', 'app.log'), 'new log');
    put(path.join(now, 'e2e-cm', 'keep'), '');

    const m = migrateLegacyHome(home);
    expect(m?.left).toEqual(['desktop/logs/app.log']);
    expect(m?.moved.sort()).toEqual(['desktop/connections.json', 'desktop/logs/ssh-dev.log', 'skills', 'tm.sqlite']);
    expect(read(path.join(now, 'desktop', 'connections.json'))).toBe('old connections');
    expect(read(path.join(now, 'desktop', 'logs', 'ssh-dev.log'))).toBe('old ssh log');
    expect(read(path.join(now, 'skills', 'v1', 'SKILL.md'))).toBe('variant');
    expect(fs.existsSync(path.join(now, 'e2e-cm', 'keep'))).toBe(true);
    // both had it: each keeps its own
    expect(read(path.join(now, 'desktop', 'logs', 'app.log'))).toBe('new log');
    expect(read(path.join(old, 'desktop', 'logs', 'app.log'))).toBe('old log');
    // emptied directories go, the one with what was left stays
    expect(fs.readdirSync(old)).toEqual(['desktop']);
    expect(fs.readdirSync(path.join(old, 'desktop'))).toEqual(['logs']);
  });

  it('a file where ~/.kifu has a directory (or the other way round) stays where it was', () => {
    const home = tmp();
    put(path.join(home, '.trace-monitor', 'run'), 'a file');
    put(path.join(home, '.kifu', 'run', 'x.sock'), '');
    expect(migrateLegacyHome(home)).toEqual({ moved: [], left: ['run'] });
    expect(read(path.join(home, '.trace-monitor', 'run'))).toBe('a file');
  });

  it('renames the database with its WAL before it is opened, and keeps its rows', () => {
    const dir = tmp();
    const old = new DatabaseSync(path.join(dir, 'tm.sqlite'));
    old.exec("PRAGMA journal_mode=WAL; CREATE TABLE t (v TEXT); INSERT INTO t VALUES ('kept')");
    // the WAL is still there while the connection is open
    expect(fs.existsSync(path.join(dir, 'tm.sqlite-wal'))).toBe(true);
    fs.copyFileSync(path.join(dir, 'tm.sqlite'), path.join(dir, 'copy.sqlite'));
    fs.copyFileSync(path.join(dir, 'tm.sqlite-wal'), path.join(dir, 'copy.sqlite-wal'));
    old.close();
    // as if the old build had died without a checkpoint
    fs.renameSync(path.join(dir, 'copy.sqlite'), path.join(dir, 'tm.sqlite'));
    fs.renameSync(path.join(dir, 'copy.sqlite-wal'), path.join(dir, 'tm.sqlite-wal'));

    const file = path.join(dir, 'kifu.sqlite');
    migrateLegacyDb(file);
    expect(fs.existsSync(path.join(dir, 'tm.sqlite'))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'tm.sqlite-wal'))).toBe(false);
    const db = new DatabaseSync(file);
    expect(db.prepare('SELECT v FROM t').all()).toEqual([{ v: 'kept' }]);
    db.close();
  });

  it('leaves the old database alone when the new one exists', () => {
    const dir = tmp();
    put(path.join(dir, 'tm.sqlite'), 'old');
    put(path.join(dir, 'kifu.sqlite'), 'new');
    migrateLegacyDb(path.join(dir, 'kifu.sqlite'));
    expect(read(path.join(dir, 'tm.sqlite'))).toBe('old');
    expect(read(path.join(dir, 'kifu.sqlite'))).toBe('new');
  });

  describe('on a remote (the shell before every remote command)', () => {
    const run = (home: string) => execFileSync('/bin/sh', ['-c', `set -e; ${baseAssignment()}; echo "$b"`], { env: { HOME: home, PATH: '/usr/bin:/bin' }, encoding: 'utf8' }).trim();

    it('moves ~/.trace-monitor when ~/.kifu does not exist', () => {
      const home = tmp();
      put(path.join(home, '.trace-monitor', 'remote', 'versions', 'b1', 'manifest.json'), '{}');
      expect(run(home)).toBe(path.join(home, '.kifu'));
      expect(fs.existsSync(path.join(home, '.kifu', 'remote', 'versions', 'b1', 'manifest.json'))).toBe(true);
      expect(fs.existsSync(path.join(home, '.trace-monitor'))).toBe(false);
    });

    it('leaves both alone when ~/.kifu exists, and does nothing on a fresh remote', () => {
      const home = tmp();
      put(path.join(home, '.trace-monitor', 'a'), '');
      put(path.join(home, '.kifu', 'b'), '');
      expect(run(home)).toBe(path.join(home, '.kifu'));
      expect(fs.readdirSync(path.join(home, '.trace-monitor'))).toEqual(['a']);
      expect(fs.readdirSync(path.join(home, '.kifu'))).toEqual(['b']);

      const fresh = tmp();
      expect(run(fresh)).toBe(path.join(fresh, '.kifu'));
      expect(fs.readdirSync(fresh)).toEqual([]);
    });

    it('a given base is used as it is', () => {
      expect(baseAssignment('/data/k')).toBe('b=/data/k');
    });
  });
});

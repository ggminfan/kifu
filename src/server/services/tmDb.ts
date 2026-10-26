import { DatabaseSync } from 'node:sqlite';
import { migrateLegacyDb } from '../../shared/legacy-home';
import { dataPaths, ensureDataDirs } from '../config';

/**
 * Our own read-write database (~/.kifu/kifu.sqlite).
 *
 * Schema changes are numbered steps recorded in `pragma user_version`; each
 * runs once. A step that shipped is never edited — add a new one. Steps only
 * add (tables, nullable or defaulted columns), so an older server sharing the
 * file keeps working.
 */

let db: DatabaseSync | undefined;

const V1 = [
  `create table if not exists session_index (
     thread_id text primary key,
     rollout text not null,
     file_key text not null,
     parser_version integer not null,
     calls integer not null,
     tools integer not null,
     tool_errors integer not null,
     turns integer not null,
     duration_ms integer not null,
     skills text not null,
     listing_hash text,
     truncated integer not null default 0,
     indexed_at integer not null
   )`,
  `create table if not exists variants (
     id text primary key,
     skill_key text not null,
     skill_name text not null,
     original_path text,
     base_hash text not null,
     label text,
     note text,
     created_at integer not null,
     updated_at integer not null
   )`,
  `create table if not exists runs (
     id text primary key,
     experiment text not null,
     variant_id text,
     label text not null,
     status text not null,
     prompt text not null,
     options text not null,
     thread_id text,
     rollout text,
     bundle text,
     result text,
     error text,
     created_at integer not null,
     finished_at integer
   )`,
  `create table if not exists evaluations (
     id text primary key,
     left_run text not null,
     right_run text not null,
     verdict text not null,
     note text,
     created_at integer not null,
     updated_at integer not null
   )`,
  `create table if not exists applies (
     id text primary key,
     variant_id text not null,
     target_path text not null,
     backup_path text not null,
     before_hash text not null,
     after_hash text not null,
     created_at integer not null,
     undone_at integer
   )`,
];

/** Replays: a case is turn K of a session (its history up to K and the turn itself); replays are runs of it. */
const V2 = [
  `create table if not exists cases (
     id text primary key,
     agent text not null,
     thread_id text not null,
     turn_index integer not null,
     title text,
     prompt text not null,
     meta text not null,
     checks text not null default '[]',
     saved integer not null default 0,
     created_at integer not null,
     updated_at integer not null
   )`,
  `alter table runs add column kind text not null default 'lab'`,
  `alter table runs add column case_id text`,
  `alter table runs add column arm text`,
  `alter table runs add column rep integer`,
  `alter table runs add column eval_id text`,
  `alter table runs add column checks text`,
  `create index if not exists runs_case on runs (case_id)`,
];

/**
 * Batch evaluation: each indexed session's skill signals (listed, loaded,
 * maybe missed, trigger cut off), sets of cases with a role, evaluations (a
 * matrix of cases × groups of changes × repeats; its cells are replay runs),
 * and model-graded scores.
 */
const V3 = [
  `create table if not exists skill_signals (
     thread_id text not null,
     skill text not null,
     listed integer not null default 0,
     loaded integer not null default 0,
     maybe_missed integer not null default 0,
     truncated integer not null default 0,
     turn_index integer,
     relevance real,
     primary key (thread_id, skill)
   )`,
  `create index if not exists skill_signals_skill on skill_signals (skill)`,
  `alter table session_index add column signals integer not null default 0`,
  `create table if not exists eval_sets (
     id text primary key,
     name text not null,
     skill text,
     note text,
     created_at integer not null,
     updated_at integer not null
   )`,
  `create table if not exists eval_set_cases (
     set_id text not null,
     case_id text not null,
     role text not null default 'positive',
     added_at integer not null,
     primary key (set_id, case_id)
   )`,
  `create table if not exists evals (
     id text primary key,
     set_id text not null,
     name text,
     status text not null,
     arms text not null,
     repeats integer not null,
     options text not null,
     rubric text,
     estimate text,
     created_at integer not null,
     finished_at integer
   )`,
  `create index if not exists runs_eval on runs (eval_id)`,
  `create table if not exists judgments (
     run_id text not null,
     rubric_hash text not null,
     scores text not null,
     rationale text,
     source text not null,
     created_at integer not null,
     updated_at integer not null,
     primary key (run_id, rubric_hash)
   )`,
];

export const MIGRATIONS: string[][] = [V1, V2, V3];

export function migrate(d: DatabaseSync): void {
  // several servers may open the file at once: one migrates, the others wait and see the new version
  d.exec('begin immediate');
  try {
    const version = (d.prepare('pragma user_version').get() as { user_version: number }).user_version;
    for (let v = version; v < MIGRATIONS.length; v++) for (const sql of MIGRATIONS[v]) d.exec(sql);
    if (version < MIGRATIONS.length) d.exec(`pragma user_version = ${MIGRATIONS.length}`);
    d.exec('commit');
  } catch (e) {
    d.exec('rollback');
    throw e;
  }
}

export function tmDb(): DatabaseSync {
  if (!db) {
    ensureDataDirs();
    migrateLegacyDb(dataPaths.db);
    const d = new DatabaseSync(dataPaths.db);
    // the browser dev server and desktop servers may share this file
    d.exec('pragma busy_timeout = 5000');
    d.exec('pragma journal_mode = wal');
    migrate(d);
    db = d;
  }
  return db;
}

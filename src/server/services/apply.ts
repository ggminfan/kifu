import fs from 'node:fs';
import path from 'node:path';
import { createTwoFilesPatch } from 'diff';
import { dataPaths } from '../config';
import { catalog, findCatalogSkill, sha256, skillHomeRoot } from './catalog';
import { tmDb } from './tmDb';
import { getVariant, mountName, type Variant } from './variants';

/**
 * Writing a variant back to the real skill. Only SKILL.md is applied, only when
 * the real file still matches the variant's base, always with a backup and an
 * atomic rename, and every apply can be undone.
 */

export class ApplyConflict extends Error {
  constructor(
    message: string,
    readonly current: string,
  ) {
    super(message);
  }
}

export type ApplyResult =
  | { mode: 'applied'; applyId: string; target: string; backup: string }
  | { mode: 'patch'; reason: string; patch: string };

function atomicWrite(file: string, content: string): void {
  const tmp = `${file}.kifu-tmp-${process.pid}`;
  const mode = fs.existsSync(file) ? fs.statSync(file).mode & 0o777 : 0o644;
  fs.writeFileSync(tmp, content, { mode });
  fs.renameSync(tmp, file);
}

/** A brand-new skill goes into the agent's skills dir (undo removes it again). */
function installVariant(v: Variant): ApplyResult {
  const dir = path.join(skillHomeRoot(), 'skills', mountName(v));
  if (fs.existsSync(dir)) throw new ApplyConflict(`skills 目录里已经有 ${mountName(v)}`, '');
  const raw = fs.readFileSync(path.join(v.dir, 'SKILL.md'), 'utf8');
  fs.mkdirSync(dir, { recursive: true });
  for (const f of fs.readdirSync(v.dir)) fs.cpSync(path.join(v.dir, f), path.join(dir, f), { recursive: true });
  const target = path.join(dir, 'SKILL.md');
  const applyId = `a${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
  const now = Date.now();
  // no backup: there was nothing there before (before_hash '')
  tmDb()
    .prepare('insert into applies (id, variant_id, target_path, backup_path, before_hash, after_hash, created_at) values (?, ?, ?, ?, ?, ?, ?)')
    .run(applyId, v.id, target, '', '', sha256(raw), now);
  tmDb().prepare('update variants set original_path = ?, base_hash = ?, updated_at = ? where id = ?').run(dir, sha256(raw), now, v.id);
  catalog(true);
  return { mode: 'applied', applyId, target, backup: '' };
}

export function applyVariant(id: string): ApplyResult {
  const v = getVariant(id);
  if (!v) throw new Error('变体不存在');
  if (!v.originalPath) return installVariant(v);
  const target = path.join(v.originalPath, 'SKILL.md');
  const variantRaw = fs.readFileSync(path.join(v.dir, 'SKILL.md'), 'utf8');
  const current = fs.readFileSync(target, 'utf8');
  const skill = findCatalogSkill(v.skillKey);
  if (!skill?.writable) {
    return {
      mode: 'patch',
      reason: '插件 / 系统 skill 由 agent 自己管理（更新插件会覆盖缓存），这里只导出补丁，请提交到插件源码',
      patch: createTwoFilesPatch(`a/${v.skillKey}/SKILL.md`, `b/${v.skillKey}/SKILL.md`, current, variantRaw),
    };
  }
  if (current === variantRaw) throw new Error('真实 SKILL.md 已经和这个变体一样，不需要应用');
  if (sha256(current) !== v.baseHash) throw new ApplyConflict('原 SKILL.md 在创建变体之后被修改过，请先确认差异', current);
  const applyId = `a${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
  const backupDir = path.join(dataPaths.backups, `${new Date().toISOString().replace(/[:.]/g, '-')}-${v.skillKey.replace(/[^\w.-]+/g, '_')}`);
  fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
  const backup = path.join(backupDir, 'SKILL.md');
  fs.writeFileSync(backup, current, { mode: 0o600 });
  atomicWrite(target, variantRaw);
  const now = Date.now();
  tmDb()
    .prepare('insert into applies (id, variant_id, target_path, backup_path, before_hash, after_hash, created_at) values (?, ?, ?, ?, ?, ?, ?)')
    .run(applyId, id, target, backup, sha256(current), sha256(variantRaw), now);
  tmDb().prepare('update variants set base_hash = ?, updated_at = ? where id = ?').run(sha256(variantRaw), now, id);
  return { mode: 'applied', applyId, target, backup };
}

export function undoApply(applyId: string): { target: string } {
  const row = tmDb().prepare('select * from applies where id = ?').get(applyId) as
    | { id: string; variant_id: string; target_path: string; backup_path: string; before_hash: string; after_hash: string; undone_at: number | null }
    | undefined;
  if (!row) throw new Error('记录不存在');
  if (row.undone_at) throw new Error('已经撤销过');
  const current = fs.readFileSync(row.target_path, 'utf8');
  if (sha256(current) !== row.after_hash) throw new ApplyConflict('应用之后 SKILL.md 又被修改过，无法自动撤销', current);
  if (!row.before_hash) {
    // an installed new skill: take it out again (the directory too, once empty)
    fs.rmSync(row.target_path);
    try {
      fs.rmdirSync(path.dirname(row.target_path));
    } catch {
      // other files were added since: leave them
    }
    tmDb().prepare('update applies set undone_at = ? where id = ?').run(Date.now(), applyId);
    tmDb().prepare('update variants set original_path = null, base_hash = ?, updated_at = ? where id = ?').run('', Date.now(), row.variant_id);
    catalog(true);
    return { target: row.target_path };
  }
  atomicWrite(row.target_path, fs.readFileSync(row.backup_path, 'utf8'));
  tmDb().prepare('update applies set undone_at = ? where id = ?').run(Date.now(), applyId);
  tmDb().prepare('update variants set base_hash = ?, updated_at = ? where id = ?').run(row.before_hash, Date.now(), row.variant_id);
  return { target: row.target_path };
}

export function listApplies(variantId: string): Array<{ id: string; createdAt: number; undoneAt?: number; target: string }> {
  return (
    tmDb().prepare('select id, created_at, undone_at, target_path from applies where variant_id = ? order by created_at desc').all(variantId) as Array<{
      id: string;
      created_at: number;
      undone_at: number | null;
      target_path: string;
    }>
  ).map((r) => ({ id: r.id, createdAt: r.created_at, undoneAt: r.undone_at ?? undefined, target: r.target_path }));
}

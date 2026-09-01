import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { FTS_TOKENIZER, recreateClaimsFts, searchClaimsFts } from '../../src/main/brain/fts';
import { FTS_TRIGGERS_SQL } from '../../src/main/brain/schema';

const files: string[] = [];

afterEach(() => {
  for (const f of files) {
    try {
      rmSync(f, { force: true });
    } catch {
      /* lock */
    }
  }
});

describe('FTS 中文召回', () => {
  it('trigram 能用「主栈」命中「后端主栈是 Go」', () => {
    expect(FTS_TOKENIZER).toBe('trigram');
    const file = join(mkdtempSync(join(tmpdir(), 'sd-fts-')), 't.db');
    files.push(file);
    const db = new Database(file);
    db.exec(`CREATE TABLE claims (id TEXT PRIMARY KEY, text TEXT, object_id TEXT, predicate TEXT)`);
    db.prepare('INSERT INTO claims (id, text, object_id, predicate) VALUES (?,?,?,?)').run(
      'c1',
      '验收组织后端主栈是 Go。',
      'org-1',
      '后端主栈',
    );
    recreateClaimsFts(db);
    const shortHits = searchClaimsFts(db, 'org-1', '主栈');
    expect(shortHits.length).toBeGreaterThan(0);
    const longHits = searchClaimsFts(db, 'org-1', '后端主');
    expect(longHits.length).toBeGreaterThan(0);
    expect(shortHits[0]?.text).toContain('Go');
    db.close();
  });

  it('显式按 bm25 排序，并用 rowid 稳定打破同分', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'sd-fts-')), 't.db');
    files.push(file);
    const db = new Database(file);
    db.exec(`CREATE TABLE claims (id TEXT PRIMARY KEY, text TEXT, object_id TEXT, predicate TEXT)`);
    const insert = db.prepare(
      'INSERT INTO claims (id, text, object_id, predicate) VALUES (?,?,?,?)',
    );
    insert.run('c1', '镜川项目采用 MIT 许可证。', 'project-1', '许可证');
    insert.run('c2', '镜川项目采用 MIT 许可证。', 'project-1', '许可证');
    insert.run('c3', '镜川项目许可证另有说明。', 'project-1', '许可证');
    recreateClaimsFts(db);

    const hits = searchClaimsFts(db, 'project-1', 'MIT 许可证');

    expect(hits.slice(0, 2).map((hit) => hit.rowid)).toEqual([1, 2]);
    db.close();
  });

  it('claims 表 UPDATE 不改 rowid（TEXT 主键、无 INTEGER PK 别名）', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'sd-fts-')), 't.db');
    files.push(file);
    const db = new Database(file);
    db.exec(`CREATE TABLE claims (id TEXT PRIMARY KEY, text TEXT, object_id TEXT, predicate TEXT)`);
    db.prepare('INSERT INTO claims (id, text, object_id, predicate) VALUES (?,?,?,?)').run(
      'c-rowid',
      '验收组织后端主栈是 Go。',
      'org-1',
      '后端主栈',
    );
    const before = db.prepare('SELECT rowid AS rid FROM claims WHERE id = ?').get('c-rowid') as {
      rid: number;
    };
    db.prepare('UPDATE claims SET text = ? WHERE id = ?').run(
      '验收组织后端主栈其实是 Rust。',
      'c-rowid',
    );
    const after = db.prepare('SELECT rowid AS rid FROM claims WHERE id = ?').get('c-rowid') as {
      rid: number;
    };
    expect(after.rid).toBe(before.rid);
    db.close();
  });

  it('直接 UPDATE claims 后 FTS 立即反映，不经 persist 重建', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'sd-fts-')), 't.db');
    files.push(file);
    const db = new Database(file);
    db.exec(`CREATE TABLE claims (id TEXT PRIMARY KEY, text TEXT, object_id TEXT, predicate TEXT)`);
    db.exec(`
      CREATE VIRTUAL TABLE claims_fts USING fts5(
        text,
        object_id UNINDEXED,
        predicate UNINDEXED,
        tokenize='trigram'
      )
    `);
    db.exec(FTS_TRIGGERS_SQL);
    db.prepare('INSERT INTO claims (id, text, object_id, predicate) VALUES (?,?,?,?)').run(
      'c1',
      '验收组织后端主栈是 Go。',
      'org-1',
      '后端主栈',
    );
    const match = db.prepare('SELECT text FROM claims_fts WHERE claims_fts MATCH ?');
    expect(match.all('后端主栈').length).toBeGreaterThan(0);

    db.prepare('UPDATE claims SET text = ? WHERE id = ?').run(
      '验收组织正在评估量子计算路线。',
      'c1',
    );
    expect(match.all('量子计算').length).toBeGreaterThan(0);
    expect(match.all('后端主栈')).toEqual([]);
    db.close();
  });
});

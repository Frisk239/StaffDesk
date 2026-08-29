import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { FTS_TOKENIZER, recreateClaimsFts, searchClaimsFts } from '../../src/main/brain/fts';

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
});

import type Database from 'better-sqlite3';
import type { Claim } from '@shared/types';

/** 0042：中文召回用 trigram；unicode61 按字空白切分，对无空格中文几乎搜不到。 */
export const FTS_TOKENIZER = 'trigram' as const;

export function recreateClaimsFts(db: Database.Database): void {
  db.exec(`DROP TABLE IF EXISTS claims_fts`);
  db.exec(`
    CREATE VIRTUAL TABLE claims_fts USING fts5(
      text,
      object_id UNINDEXED,
      predicate UNINDEXED,
      tokenize='${FTS_TOKENIZER}'
    )
  `);
  db.exec(
    `INSERT INTO claims_fts(rowid, text, object_id, predicate)
     SELECT rowid, text, object_id, predicate FROM claims`,
  );
}

export function searchClaimsFts(
  db: Database.Database,
  objectId: string,
  query: string,
  limit = 8,
): { rowid: number; text: string; predicate: string }[] {
  const q = query.trim();
  if (!q) return [];
  const match = q.replace(/['"]/g, ' ').slice(0, 80);
  try {
    const hits = db
      .prepare(
        `SELECT rowid, text, predicate FROM claims_fts
         WHERE object_id = ? AND claims_fts MATCH ?
         ORDER BY bm25(claims_fts), rowid
         LIMIT ?`,
      )
      .all(objectId, match, limit) as { rowid: number; text: string; predicate: string }[];
    if (hits.length > 0) return hits;
  } catch {
    /* MATCH 语法失败则走片段包含 */
  }
  // trigram 对不足 3 字的中文查询常为空，退回原文包含（仍限定当前对象）。
  return db
    .prepare(
      `SELECT rowid, text, predicate FROM claims
       WHERE object_id = ? AND text LIKE ? ESCAPE '\\'
       LIMIT ?`,
    )
    .all(objectId, `%${q.replace(/[%_]/g, '\\$&')}%`, limit) as {
    rowid: number;
    text: string;
    predicate: string;
  }[];
}

/** 把 FTS 命中对回账本主张：优先片段包含，否则 text 相等。 */
export function resolveFtsHits(claims: Claim[], hits: { text: string }[]): Claim[] {
  const out: Claim[] = [];
  for (const hit of hits) {
    const found = claims.find((c) => c.text === hit.text && c.status !== '过时');
    if (found && !out.some((c) => c.id === found.id)) out.push(found);
  }
  return out;
}

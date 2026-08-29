import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import { SCHEMA_SQL, SCHEMA_VERSION } from './schema';
import { seedPresets } from './presets';
import { recreateClaimsFts } from './fts';

export function nowIso(): string {
  return new Date().toISOString();
}

/** 打开大脑文件：空文件建表+预设包；已有文件只跑未应用的迁移。 */
export function openDatabase(filePath: string): Database.Database {
  mkdirSync(dirname(filePath), { recursive: true });
  const db = new Database(filePath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  migrate(db);
  return db;
}

export function migrate(db: Database.Database): void {
  db.exec(SCHEMA_SQL);
  const row = db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get() as {
    v: number | null;
  };
  const current = row.v ?? 0;
  if (current < 2) {
    recreateClaimsFts(db);
  }
  if (current < SCHEMA_VERSION) {
    db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(
      SCHEMA_VERSION,
      nowIso(),
    );
  }
  seedPresets(db);
}

export function listUserTables(db: Database.Database): string[] {
  const rows = db
    .prepare(
      `SELECT name FROM sqlite_master
       WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%'
       ORDER BY name`,
    )
    .all() as { name: string }[];
  return rows.map((r) => r.name);
}

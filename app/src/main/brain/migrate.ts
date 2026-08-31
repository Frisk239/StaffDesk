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
  if (current < 3) {
    migrateToV3(db);
  }
  if (current < 4) {
    migrateToV4(db);
  }
  if (current < 6) {
    migrateToV6(db);
  }
  if (current < 7) {
    migrateToV7(db);
  }
  if (current < SCHEMA_VERSION) {
    db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(
      SCHEMA_VERSION,
      nowIso(),
    );
  }
  seedPresets(db);
}

function migrateToV3(db: Database.Database): void {
  addColumn(db, 'sources', 'origin_json', 'TEXT');
  addColumn(db, 'sources', 'segments_json', 'TEXT');
  addColumn(db, 'sources', 'content_hash', 'TEXT');
  addColumn(db, 'sources', 'fetched_at', 'TEXT');
  addColumn(db, 'claims', 'source_start', 'INTEGER');
  addColumn(db, 'claims', 'source_end', 'INTEGER');
  addColumn(db, 'claims', 'source_locator', 'TEXT');
}

function migrateToV4(db: Database.Database): void {
  addColumn(db, 'tasks', 'query', 'TEXT');
  addColumn(db, 'tasks', 'interval_days', 'INTEGER');
  addColumn(db, 'tasks', 'next_due_at', 'TEXT');
  addColumn(db, 'tasks', 'last_run_at', 'TEXT');
  addColumn(db, 'tasks', 'parent_task_id', 'TEXT');
  addColumn(db, 'tasks', 'due_at', 'TEXT');
}

/** 0054：禁写双路的结构化列。旧行留 NULL——原句路（text 子串）继续兜历史禁写。 */
function migrateToV6(db: Database.Database): void {
  addColumn(db, 'memories', 'banned_object_id', 'TEXT');
  addColumn(db, 'memories', 'banned_predicate', 'TEXT');
  addColumn(db, 'memories', 'banned_value', 'TEXT');
}

/** v7：operations(action) 索引——listDeletedSourceRecoveries 每次 snapshot 双跑 WHERE action=? ORDER BY created_at。
 *  只进迁移门次、不进 SCHEMA_SQL：CREATE INDEX IF NOT EXISTS 幂等，空库与旧库都经 migrate() 应用。 */
function migrateToV7(db: Database.Database): void {
  db.exec('CREATE INDEX IF NOT EXISTS idx_operations_action ON operations(action)');
}

function addColumn(db: Database.Database, table: string, column: string, definition: string): void {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (rows.some((row) => row.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
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

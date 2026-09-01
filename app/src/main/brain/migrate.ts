import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import { FTS_TRIGGERS_SQL, SCHEMA_SQL, SCHEMA_VERSION } from './schema';
import { seedPresets, seedScenarioTemplates } from './presets';
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
  if (current < 8) {
    migrateToV8(db);
  }
  if (current < 9) {
    migrateToV9(db);
  }
  if (current < 10) {
    migrateToV10(db);
  }
  if (current < SCHEMA_VERSION) {
    db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(
      SCHEMA_VERSION,
      nowIso(),
    );
  }
  // 先 DROP 再挂：IF NOT EXISTS 不会替换已有触发器体（旧稿用了 content= 的 delete 命令）。
  db.exec(`
    DROP TRIGGER IF EXISTS claims_ai;
    DROP TRIGGER IF EXISTS claims_ad;
    DROP TRIGGER IF EXISTS claims_au;
  `);
  db.exec(FTS_TRIGGERS_SQL);
  seedPresets(db);
  seedScenarioTemplates(db);
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

/**
 * v8（0058）：场景升为数据行，一个门次全做、整事务——
 * 重建 workspaces 去掉 scenario 枚举 CHECK（new→copy→drop→rename，SQLite 不能 ALTER CHECK）；
 * DROP scenario_brief_specs 死表（从未被运行时读过）；scenario_templates 建表不走门次，
 * 由 migrate() 开头的 SCHEMA_SQL（CREATE TABLE IF NOT EXISTS）对空库与旧库统一生效。
 * REQUIRED_TABLES 同步：删 scenario_brief_specs、加 scenario_templates——漏一处备份恢复全线炸。
 */
function migrateToV8(db: Database.Database): void {
  const tx = db.transaction(() => {
    db.exec(`
      CREATE TABLE workspaces_v8 (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        scenario TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
    db.exec(
      `INSERT INTO workspaces_v8 (id, name, scenario, created_at)
       SELECT id, name, scenario, created_at FROM workspaces`,
    );
    db.exec('DROP TABLE workspaces');
    db.exec('ALTER TABLE workspaces_v8 RENAME TO workspaces');
    db.exec('DROP TABLE IF EXISTS scenario_brief_specs');
  });
  tx();
}

function addColumn(db: Database.Database, table: string, column: string, definition: string): void {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (rows.some((row) => row.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

/**
 * v9（M27，0051/0058）：write_queue 重建——kind CHECK 放开收「场景」（SQLite 不能
 * ALTER CHECK，走 new→copy→drop→rename，对齐 v8 workspaces 重建），并加 template_json 草稿列
 * （旧行 NULL：历史库没有场景写卡）。空库经 SCHEMA_SQL 已是新形状，本门次复制空表后原样重建，幂等无害。
 */
function migrateToV9(db: Database.Database): void {
  const tx = db.transaction(() => {
    db.exec(`
      CREATE TABLE write_queue_v9 (
        id TEXT PRIMARY KEY,
        object_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('晋升', '纠正', '整理', '绑定', '批量晋升', '批量回退', '场景')),
        task_id TEXT,
        headline TEXT NOT NULL,
        evidence TEXT NOT NULL,
        claim_id TEXT,
        claim_ids TEXT,
        source_id TEXT,
        object_ids TEXT,
        target_predicate TEXT,
        outbound INTEGER,
        template_json TEXT,
        position INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );
    `);
    db.exec(`
      INSERT INTO write_queue_v9 (id, object_id, kind, task_id, headline, evidence, claim_id,
                                  claim_ids, source_id, object_ids, target_predicate, outbound,
                                  template_json, position, created_at)
      SELECT id, object_id, kind, task_id, headline, evidence, claim_id,
             claim_ids, source_id, object_ids, target_predicate, outbound,
             NULL, position, created_at
      FROM write_queue
    `);
    db.exec('DROP TABLE write_queue');
    db.exec('ALTER TABLE write_queue_v9 RENAME TO write_queue');
  });
  tx();
}

/**
 * v10（M28）：task_audit 重建加 PRIMARY KEY (task_id, seq)（SQLite 不能 ALTER 加主键）；
 * 撞键合并 = 同一 (task_id, seq) 保留 ts 最新，ts 相同保留后写入（rowid 更大）的一行；
 * 另建 task_id 索引。tasks 重建把 stop_reason CHECK 放开收「费用触顶」（0059，对齐 v8/v9
 * new→copy→drop→rename）。FTS 触发器由 migrate() 末尾 IF NOT EXISTS 统一挂上。
 */
function migrateToV10(db: Database.Database): void {
  const tx = db.transaction(() => {
    db.exec(`
      CREATE TABLE task_audit_v10 (
        task_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        kind TEXT NOT NULL,
        payload TEXT NOT NULL,
        ts TEXT NOT NULL,
        PRIMARY KEY (task_id, seq)
      );
    `);
    db.exec(`
      INSERT INTO task_audit_v10 (task_id, seq, kind, payload, ts)
      SELECT t.task_id, t.seq, t.kind, t.payload, t.ts
      FROM task_audit t
      WHERE t.rowid = (
        SELECT t2.rowid FROM task_audit t2
        WHERE t2.task_id = t.task_id AND t2.seq = t.seq
        ORDER BY t2.ts DESC, t2.rowid DESC
        LIMIT 1
      )
    `);
    db.exec('DROP TABLE task_audit');
    db.exec('ALTER TABLE task_audit_v10 RENAME TO task_audit');
    db.exec('CREATE INDEX IF NOT EXISTS idx_task_audit_task_id ON task_audit(task_id)');

    db.exec(`
      CREATE TABLE tasks_v10 (
        id TEXT PRIMARY KEY,
        object_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('调研', '出简报', '再搜一轮', '周期性雷达')),
        status TEXT NOT NULL CHECK (status IN ('待启动', '进行中', '已完成', '已停止')),
        stop_reason TEXT CHECK (stop_reason IN ('手动', '触顶', '失败', '费用触顶')),
        budget_gear TEXT CHECK (budget_gear IN ('快搜', '深挖')),
        query TEXT,
        interval_days INTEGER,
        next_due_at TEXT,
        last_run_at TEXT,
        parent_task_id TEXT,
        due_at TEXT,
        created_at TEXT NOT NULL,
        finished_at TEXT
      );
    `);
    db.exec(`
      INSERT INTO tasks_v10 (id, object_id, kind, status, stop_reason, budget_gear, query,
                             interval_days, next_due_at, last_run_at, parent_task_id, due_at,
                             created_at, finished_at)
      SELECT id, object_id, kind, status, stop_reason, budget_gear, query,
             interval_days, next_due_at, last_run_at, parent_task_id, due_at,
             created_at, finished_at
      FROM tasks
    `);
    db.exec('DROP TABLE tasks');
    db.exec('ALTER TABLE tasks_v10 RENAME TO tasks');
  });
  tx();
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

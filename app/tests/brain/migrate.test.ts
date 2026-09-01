import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import {
  builtinScenarioTemplates,
  DEFAULT_SLOT_DEFS,
  SCENARIO_HINTS,
  BRIEF_SPECS,
} from '@shared/scenario';
import { CUSTOM_BASELINE_PLAYBOOK } from '@shared/playbook';
import {
  ftsExists,
  listSlotDefs,
  openBrain,
  tableNames,
  REQUIRED_TABLES,
} from '../../src/main/brain';
import { createMemorySecrets } from '../../src/main/keychain';
import { createMemoryModelSettingsStore } from '../../src/main/llm/settings';

const dirs: string[] = [];

function tmpBrain() {
  const dir = mkdtempSync(join(tmpdir(), 'staffdesk-brain-'));
  dirs.push(dir);
  return join(dir, 'brain.db');
}

afterEach(() => {
  while (dirs.length) {
    const dir = dirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe('建库与迁移', () => {
  it('空文件迁移后表与 schema_migrations 存在，且有 claims_fts', () => {
    const brain = openBrain(tmpBrain());
    const names = tableNames(brain);
    for (const table of REQUIRED_TABLES) {
      expect(names, `缺少表 ${table}`).toContain(table);
    }
    expect(names).toContain('schema_migrations');
    expect(ftsExists(brain)).toBe(true);
    const row = brain.db.prepare('SELECT version FROM schema_migrations').get() as {
      version: number;
    };
    expect(row.version).toBeGreaterThanOrEqual(1);
    brain.close();
  });

  it('v3 迁移提供真实导入与定位字段', () => {
    const brain = openBrain(tmpBrain());
    const tables = tableNames(brain);
    expect(tables).toContain('ingest_jobs');
    const sourceColumns = columnNames(brain.db, 'sources');
    expect(sourceColumns).toEqual(
      expect.arrayContaining(['origin_json', 'segments_json', 'content_hash']),
    );
    const claimColumns = columnNames(brain.db, 'claims');
    expect(claimColumns).toEqual(
      expect.arrayContaining(['source_start', 'source_end', 'source_locator']),
    );
    const row = brain.db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get() as {
      version: number;
    };
    expect(row.version).toBeGreaterThanOrEqual(3);
    brain.close();
  });

  it('v4 迁移提供周期性雷达计划字段', () => {
    const brain = openBrain(tmpBrain());
    const taskColumns = columnNames(brain.db, 'tasks');
    expect(taskColumns).toEqual(
      expect.arrayContaining([
        'query',
        'interval_days',
        'next_due_at',
        'last_run_at',
        'parent_task_id',
        'due_at',
      ]),
    );
    const row = brain.db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get() as {
      version: number;
    };
    expect(row.version).toBeGreaterThanOrEqual(4);
    brain.close();
  });

  it('v5 迁移提供待确认写提议队列表', () => {
    const brain = openBrain(tmpBrain());
    const tables = tableNames(brain);
    expect(tables).toContain('write_queue');
    const writeColumns = columnNames(brain.db, 'write_queue');
    expect(writeColumns).toEqual(
      expect.arrayContaining([
        'object_id',
        'kind',
        'task_id',
        'claim_ids',
        'object_ids',
        'target_predicate',
        'outbound',
        'position',
      ]),
    );
    const row = brain.db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get() as {
      version: number;
    };
    expect(row.version).toBeGreaterThanOrEqual(5);
    brain.close();
  });

  it('v6 迁移为禁写补结构化三列，旧行 NULL 读回不炸且不误拦（0054）', () => {
    const brain = openBrain(tmpBrain());
    const columns = columnNames(brain.db, 'memories');
    expect(columns).toEqual(
      expect.arrayContaining(['banned_object_id', 'banned_predicate', 'banned_value']),
    );
    // 旧行路径：迁移前的禁写只有 text，三列 NULL；loadLedger 读回不带 banned 字段，
    // 原句路（text 子串）继续兜住它——升级不得静默解除历史禁写。
    brain.db
      .prepare(
        `INSERT INTO memories (id, scope, kind, text, created_at)
         VALUES ('mem-legacy', '全局', '禁写', '出站不得再写：「团队主栈是 Go」（关闭原因：世界已变）', '2026-08-30')`,
      )
      .run();
    const st = brain.snapshot();
    const legacy = st.memories.find((m) => m.id === 'mem-legacy');
    expect(legacy).toBeDefined();
    expect(legacy?.bannedObjectId).toBeUndefined();
    expect(legacy?.bannedPredicate).toBeUndefined();
    expect(legacy?.bannedValue).toBeUndefined();
    const row = brain.db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get() as {
      version: number;
    };
    expect(row.version).toBeGreaterThanOrEqual(6);
    brain.close();
  });

  it('v7 迁移为 operations.action 建索引，旧库重开同样补齐', () => {
    const file = tmpBrain();
    const fresh = openBrain(file);
    expect(indexNames(fresh.db)).toContain('idx_operations_action');
    const freshRow = fresh.db
      .prepare('SELECT MAX(version) AS version FROM schema_migrations')
      .get() as {
      version: number;
    };
    expect(freshRow.version).toBeGreaterThanOrEqual(7);
    fresh.close();

    // 旧库路径：先开成 v7，再人工回退成 v6（撤索引、改版本行），重开必须经门次迁移补回索引。
    const legacy = openBrain(file);
    legacy.db.exec('DROP INDEX idx_operations_action');
    legacy.db.exec('DELETE FROM schema_migrations WHERE version >= 7');
    legacy.db
      .prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (6, ?)')
      .run('2026-08-31T00:00:00.000Z');
    legacy.close();

    const upgraded = openBrain(file);
    expect(indexNames(upgraded.db)).toContain('idx_operations_action');
    const row = upgraded.db
      .prepare('SELECT MAX(version) AS version FROM schema_migrations')
      .get() as { version: number };
    expect(row.version).toBeGreaterThanOrEqual(7);
    upgraded.close();
  });

  it('旧版 unparsed 来源迁移后保留但不会被绑定抽取', () => {
    const brain = openBrain(tmpBrain());
    brain.dispatch({ type: 'ADD_WORKSPACE', name: '旧库', scenario: '求职面试' });
    brain.dispatch({ type: 'ADD_OBJECT', kind: '组织', name: '旧组织' });
    brain.db
      .prepare(
        `INSERT INTO sources (id, title, body, path, workspace_id, unparsed, created_at)
         VALUES (?, ?, ?, '手给', ?, 1, ?)`,
      )
      .run(
        'legacy-unparsed-pdf',
        '旧 PDF',
        'binary placeholder',
        brain.snapshot().currentWorkspaceId,
        '2026-08-30T00:00:00.000Z',
      );
    const state = brain.snapshot();
    const source = state.sources.find((item) => !item.virtual);
    const object = state.objects[0];
    if (!source || !object) throw new Error('setup failed');
    brain.dispatch({ type: 'BIND_CONFIRMED', sourceId: source.id, objectIds: [object.id] });

    const next = brain.snapshot();
    expect(next.sources.find((item) => item.id === source.id)?.boundObjectIds).toEqual([]);
    expect(next.extractJobs).toHaveLength(0);
    brain.close();
  });

  it('v8 迁移拆除 workspaces 的 scenario 枚举 CHECK，死表退役、模板表就位（0058）', () => {
    const file = tmpBrain();
    // 手工搭 v7 形态旧库：workspaces 带枚举 CHECK + 存量行 + 死表 + 版本行 7。
    const legacy = new Database(file);
    legacy.pragma('journal_mode = WAL');
    legacy.exec(`
      CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
      CREATE TABLE workspaces (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        scenario TEXT NOT NULL CHECK (scenario IN ('求职面试', '求学申请', '技术选型', '尽调研究', '自定义')),
        created_at TEXT NOT NULL
      );
      CREATE TABLE scenario_brief_specs (scenario TEXT PRIMARY KEY, spec TEXT NOT NULL);
      CREATE TABLE app_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `);
    legacy
      .prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (7, '2026-08-31')")
      .run();
    legacy
      .prepare("INSERT INTO workspaces VALUES ('ws-1', '旧区', '求职面试', '2026-08-01')")
      .run();
    legacy.prepare("INSERT INTO scenario_brief_specs VALUES ('求职面试', '[]')").run();
    legacy.prepare("INSERT INTO app_meta VALUES ('presets_seeded', '1')").run();
    legacy.close();

    const brain = openBrain(file);
    // 重建保行：存量工作区一行不少，CHECK 拆除。
    const rows = brain.db
      .prepare('SELECT id, name, scenario FROM workspaces ORDER BY id')
      .all() as { id: string; scenario: string }[];
    expect(rows).toEqual([{ id: 'ws-1', name: '旧区', scenario: '求职面试' }]);
    const ddl = brain.db
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'workspaces'")
      .get() as { sql: string };
    expect(ddl.sql).not.toContain('CHECK');
    const tables = tableNames(brain);
    expect(tables).not.toContain('scenario_brief_specs');
    expect(tables).toContain('scenario_templates');
    // 既有库路径：presets_seeded='1' 不挡模板新键，五行种子照种。
    expect(templateCount(brain.db)).toBe(5);
    // 自定义场景名现在合法：插入并重开读回。
    brain.db
      .prepare(
        `INSERT INTO workspaces (id, name, scenario, created_at)
         VALUES ('ws-custom', '自定义场景区', '慈善尽调', '2026-09-01T00:00:00.000Z')`,
      )
      .run();
    const version = brain.db
      .prepare('SELECT MAX(version) AS version FROM schema_migrations')
      .get() as { version: number };
    expect(version.version).toBeGreaterThanOrEqual(8);
    brain.close();

    const again = openBrain(file);
    const row = again.db
      .prepare('SELECT scenario FROM workspaces WHERE id = ?')
      .get('ws-custom') as { scenario: string };
    expect(row.scenario).toBe('慈善尽调');
    again.close();
  });

  it('v9 迁移放开 write_queue 的 kind CHECK 收「场景」并补 template_json 列（M27）', () => {
    const file = tmpBrain();
    // 手工搭 v8 形态旧库：write_queue 带旧 CHECK + 一条存量行 + 版本行 8。
    const legacy = new Database(file);
    legacy.pragma('journal_mode = WAL');
    legacy.exec(`
      CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
      CREATE TABLE write_queue (
        id TEXT PRIMARY KEY,
        object_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('晋升', '纠正', '整理', '绑定', '批量晋升', '批量回退')),
        task_id TEXT,
        headline TEXT NOT NULL,
        evidence TEXT NOT NULL,
        claim_id TEXT,
        claim_ids TEXT,
        source_id TEXT,
        object_ids TEXT,
        target_predicate TEXT,
        outbound INTEGER,
        position INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );
      CREATE TABLE app_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `);
    legacy
      .prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (8, '2026-09-01')")
      .run();
    legacy
      .prepare(
        `INSERT INTO write_queue (id, object_id, kind, headline, evidence, position, created_at)
         VALUES ('wr-1', 'obj-1', '晋升', '旧队列行', '旧证据', 0, '2026-09-01')`,
      )
      .run();
    legacy.prepare("INSERT INTO app_meta VALUES ('presets_seeded', '1')").run();
    legacy.close();

    const brain = openBrain(file);
    // 重建保行：存量写卡一行不少；新列就位。
    const rows = brain.db
      .prepare('SELECT id, kind, template_json FROM write_queue ORDER BY id')
      .all() as { id: string; kind: string; template_json: string | null }[];
    expect(rows).toEqual([{ id: 'wr-1', kind: '晋升', template_json: null }]);
    const ddl = brain.db
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'write_queue'")
      .get() as { sql: string };
    expect(ddl.sql).toContain('场景');
    // 场景写卡可直插（kind CHECK 放开）且读回走 loadLedger。
    brain.db
      .prepare(
        `INSERT INTO write_queue (id, object_id, kind, headline, evidence, template_json,
                                  position, created_at)
         VALUES ('wr-sc', 'obj-1', '场景', '起草场景模板「供应商尽调」', '盯风险', ?, 1, '2026-09-01')`,
      )
      .run(
        JSON.stringify({
          name: '供应商尽调',
          builtin: false,
          hint: '盯一个供应商',
          playbook: '',
          briefSpec: [],
        }),
      );
    expect(brain.snapshot().writeQueue.find((w) => w.id === 'wr-sc')?.template?.name).toBe(
      '供应商尽调',
    );
    const version = brain.db
      .prepare('SELECT MAX(version) AS version FROM schema_migrations')
      .get() as { version: number };
    expect(version.version).toBeGreaterThanOrEqual(9);
    brain.close();
  });

  it('v10 迁移给 task_audit 加主键与索引、去重撞键行，并放开 tasks.stop_reason 收「费用触顶」', () => {
    const file = tmpBrain();
    const legacy = new Database(file);
    legacy.pragma('journal_mode = WAL');
    legacy.exec(`
      CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY,
        object_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('调研', '出简报', '再搜一轮', '周期性雷达')),
        status TEXT NOT NULL CHECK (status IN ('待启动', '进行中', '已完成', '已停止')),
        stop_reason TEXT CHECK (stop_reason IN ('手动', '触顶', '失败')),
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
      CREATE TABLE task_audit (
        task_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        kind TEXT NOT NULL,
        payload TEXT NOT NULL,
        ts TEXT NOT NULL
      );
      CREATE TABLE app_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `);
    legacy
      .prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (9, '2026-09-01')")
      .run();
    legacy
      .prepare(
        `INSERT INTO tasks (id, object_id, kind, status, stop_reason, created_at)
         VALUES ('task-1', 'obj-1', '调研', '已停止', '触顶', '2026-09-01')`,
      )
      .run();
    // 撞主键：同一 (task_id, seq) 两行。合并规则 = ts 最新；ts 相同取后写入（rowid 更大）。
    legacy
      .prepare(
        `INSERT INTO task_audit (task_id, seq, kind, payload, ts)
         VALUES ('task-1', 1, '搜索', '{"keep":false}', '2026-09-01T00:00:00.000Z')`,
      )
      .run();
    legacy
      .prepare(
        `INSERT INTO task_audit (task_id, seq, kind, payload, ts)
         VALUES ('task-1', 1, '搜索', '{"keep":true}', '2026-09-01T01:00:00.000Z')`,
      )
      .run();
    legacy
      .prepare(
        `INSERT INTO task_audit (task_id, seq, kind, payload, ts)
         VALUES ('task-2', 1, '开始', '{"n":1}', '2026-09-01T00:00:00.000Z')`,
      )
      .run();
    legacy
      .prepare(
        `INSERT INTO task_audit (task_id, seq, kind, payload, ts)
         VALUES ('task-2', 1, '开始', '{"n":2}', '2026-09-01T00:00:00.000Z')`,
      )
      .run();
    legacy
      .prepare(
        `INSERT INTO task_audit (task_id, seq, kind, payload, ts)
         VALUES ('task-1', 2, '触顶', '{}', '2026-09-01T02:00:00.000Z')`,
      )
      .run();
    legacy.prepare("INSERT INTO app_meta VALUES ('presets_seeded', '1')").run();
    legacy.close();

    const brain = openBrain(file);
    const pk = brain.db.prepare('PRAGMA table_info(task_audit)').all() as {
      name: string;
      pk: number;
    }[];
    expect(pk.find((col) => col.name === 'task_id')?.pk).toBeGreaterThan(0);
    expect(pk.find((col) => col.name === 'seq')?.pk).toBeGreaterThan(0);
    expect(indexNames(brain.db)).toContain('idx_task_audit_task_id');

    const audits = brain.db
      .prepare('SELECT task_id, seq, payload FROM task_audit ORDER BY task_id, seq')
      .all() as { task_id: string; seq: number; payload: string }[];
    expect(audits).toEqual([
      { task_id: 'task-1', seq: 1, payload: '{"keep":true}' },
      { task_id: 'task-1', seq: 2, payload: '{}' },
      { task_id: 'task-2', seq: 1, payload: '{"n":2}' },
    ]);

    const ddl = brain.db
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'tasks'")
      .get() as { sql: string };
    expect(ddl.sql).toContain('费用触顶');
    brain.db
      .prepare(
        `INSERT INTO tasks (id, object_id, kind, status, stop_reason, created_at)
         VALUES ('task-fee', 'obj-1', '调研', '已停止', '费用触顶', '2026-09-01')`,
      )
      .run();
    const fee = brain.db.prepare('SELECT stop_reason FROM tasks WHERE id = ?').get('task-fee') as {
      stop_reason: string;
    };
    expect(fee.stop_reason).toBe('费用触顶');

    const triggers = (
      brain.db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'claims'")
        .all() as { name: string }[]
    ).map((row) => row.name);
    expect(triggers).toEqual(expect.arrayContaining(['claims_ai', 'claims_ad', 'claims_au']));

    const version = brain.db
      .prepare('SELECT MAX(version) AS version FROM schema_migrations')
      .get() as { version: number };
    expect(version.version).toBeGreaterThanOrEqual(10);
    brain.close();
  });

  it('首启后槽名与 DEFAULT_SLOT_DEFS 一致、场景模板与种子源四件套一致，且对象/来源/主张计数为 0', () => {
    const brain = openBrain(tmpBrain());
    const snap = brain.snapshot();
    expect(snap.objects).toHaveLength(0);
    expect(snap.sources.filter((s) => !s.virtual)).toHaveLength(0);
    expect(snap.claims).toHaveLength(0);
    expect(snap.workspaces).toHaveLength(0);
    expect(snap.providers).toHaveLength(0);
    expect(snap.activeProviderId).toBe('');
    expect(snap.activeModelId).toBe('');

    const slots = listSlotDefs(brain.db);
    expect(slots.map((s) => `${s.kind}:${s.name}`).sort()).toEqual(
      DEFAULT_SLOT_DEFS.map((s) => `${s.kind}:${s.name}`).sort(),
    );
    for (const def of DEFAULT_SLOT_DEFS) {
      const hit = slots.find((s) => s.name === def.name && s.kind === def.kind);
      expect(hit?.arity).toBe(def.arity);
      expect(hit?.scenarios).toEqual(def.scenarios);
    }

    // 0058：种子模板 = 四内置 + 「自定义」空白基线，全部 builtin；四件套（hint/playbook/briefSpec）
    // 与种子常量逐字一致，内存快照与库内行同源。
    expect(snap.scenarioTemplates.map((t) => t.name)).toEqual([
      '求职面试',
      '求学申请',
      '技术选型',
      '尽调研究',
      '自定义',
    ]);
    expect(snap.scenarioTemplates.every((t) => t.builtin)).toBe(true);
    expect(snap.scenarioTemplates).toEqual(builtinScenarioTemplates());
    for (const template of snap.scenarioTemplates) {
      expect(template.hint).toBe(SCENARIO_HINTS[template.name]);
      expect(template.briefSpec).toEqual(BRIEF_SPECS[template.name]);
    }
    expect(snap.scenarioTemplates.find((t) => t.name === '自定义')?.playbook).toBe(
      CUSTOM_BASELINE_PLAYBOOK,
    );
    const rowCount = brain.db.prepare('SELECT COUNT(*) AS n FROM scenario_templates').get() as {
      n: number;
    };
    expect(rowCount.n).toBe(5);

    const dump = JSON.stringify(snap);
    expect(dump).not.toMatch(/栈桥科技|周若水|NordStream|LuftData/);
    brain.close();
  });

  it('旧业务库的真实模型配置迁移到产品级设置，并删除库内副本', () => {
    const file = tmpBrain();
    const legacy = openBrain(file);
    legacy.db.prepare('INSERT INTO app_meta (key, value) VALUES (?, ?)').run(
      'providers',
      JSON.stringify([
        {
          id: 'p-real',
          name: '真实端点',
          baseUrl: 'https://models.example.test/v1',
          apiKey: '',
          enabled: true,
          models: [{ id: 'model-a', name: 'model-a', contextWindow: 128000, maxOutput: 8192 }],
        },
      ]),
    );
    legacy.db
      .prepare('INSERT INTO app_meta (key, value) VALUES (?, ?)')
      .run('activeProviderId', 'p-real');
    legacy.db
      .prepare('INSERT INTO app_meta (key, value) VALUES (?, ?)')
      .run('activeModelId', 'model-a');
    legacy.db
      .prepare('INSERT INTO app_meta (key, value) VALUES (?, ?)')
      .run('thinkingEffort', '高');
    legacy.close();

    const secrets = createMemorySecrets();
    secrets.set('p-real', 'secret-for-test');
    const settings = createMemoryModelSettingsStore();
    const migrated = openBrain(file, secrets, settings);
    const snap = migrated.snapshot();
    expect(snap.providers).toHaveLength(1);
    expect(snap.providers[0]?.apiKey).toBe('secret-for-test');
    expect(snap.activeProviderId).toBe('p-real');
    expect(snap.activeModelId).toBe('model-a');
    expect(snap.thinkingEffort).toBe('高');
    const remaining = migrated.db
      .prepare(
        "SELECT key FROM app_meta WHERE key IN ('providers','activeProviderId','activeModelId','thinkingEffort')",
      )
      .all();
    expect(remaining).toEqual([]);
    expect(settings.load()?.providers[0]?.apiKey).toBe('');
    migrated.close();
  });

  it('既有库（表非空、无标记）打开后补写种子标记，不重复播种（0057）', () => {
    const file = tmpBrain();
    const first = openBrain(file);
    const seeded = slotCount(first.db);
    expect(seeded).toBe(DEFAULT_SLOT_DEFS.length);
    // 模拟标记缺失的既有库：清掉标记后重开，槽表已非空——只补标记，不得再插一份默认槽。
    first.db.prepare("DELETE FROM app_meta WHERE key = 'presets_seeded'").run();
    first.close();

    const again = openBrain(file);
    expect(slotCount(again.db)).toBe(seeded);
    const marker = again.db
      .prepare("SELECT value FROM app_meta WHERE key = 'presets_seeded'")
      .get() as { value: string } | undefined;
    expect(marker?.value).toBe('1');
    again.close();
  });

  it('场景模板种子用独立新键：既有库补键不重播，删空模板表重启不复活（0058）', () => {
    const file = tmpBrain();
    const first = openBrain(file);
    // 首启种五行并写新键；键与 presets_seeded 各管各的表，互不复用。
    expect(templateCount(first.db)).toBe(5);
    expect(templateMarker(first.db)).toBe('1');
    // 模拟 v7 升级而来的既有库：键被清掉但表非空——只补键，不得重播成十行。
    first.db.prepare("DELETE FROM app_meta WHERE key = 'scenario_templates_seeded'").run();
    first.close();

    const again = openBrain(file);
    expect(templateCount(again.db)).toBe(5);
    expect(templateMarker(again.db)).toBe('1');
    // 删空模板表后重启不得复活（0057 删空不复活纪律沿用）；内置模板也照删不救。
    again.db.exec('DELETE FROM scenario_templates');
    again.close();

    const third = openBrain(file);
    expect(templateCount(third.db)).toBe(0);
    expect(third.snapshot().scenarioTemplates).toEqual([]);
    third.close();
  });

  it('删空槽表与简报说明表后重开不被默认种子复活（0057 首启标记）', () => {
    const file = tmpBrain();
    const first = openBrain(file);
    expect(slotCount(first.db)).toBeGreaterThan(0);
    first.db.exec('DELETE FROM slot_defs');
    first.close();

    const again = openBrain(file);
    expect(slotCount(again.db)).toBe(0);
    again.close();
  });
});

function templateCount(db: import('better-sqlite3').Database): number {
  const row = db.prepare('SELECT COUNT(*) AS n FROM scenario_templates').get() as { n: number };
  return row.n;
}

function templateMarker(db: import('better-sqlite3').Database): string | undefined {
  const row = db
    .prepare("SELECT value FROM app_meta WHERE key = 'scenario_templates_seeded'")
    .get() as { value: string } | undefined;
  return row?.value;
}

function slotCount(db: import('better-sqlite3').Database): number {
  const row = db.prepare('SELECT COUNT(*) AS n FROM slot_defs').get() as { n: number };
  return row.n;
}

function columnNames(db: import('better-sqlite3').Database, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(
    (row) => row.name,
  );
}

function indexNames(db: import('better-sqlite3').Database): string[] {
  return (
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as { name: string }[]
  ).map((row) => row.name);
}

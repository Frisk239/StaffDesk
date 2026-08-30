import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { BRIEF_SPECS, DEFAULT_SLOT_DEFS } from '@shared/scenario';
import {
  ftsExists,
  listBriefSpecs,
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

  it('首启后槽名/简报说明与 DEFAULT_SLOT_DEFS/BRIEF_SPECS 一致，且对象/来源/主张计数为 0', () => {
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

    const specs = listBriefSpecs(brain.db);
    expect(Object.keys(specs).sort()).toEqual(Object.keys(BRIEF_SPECS).sort());
    for (const key of Object.keys(BRIEF_SPECS) as (keyof typeof BRIEF_SPECS)[]) {
      expect(specs[key]).toEqual(BRIEF_SPECS[key]);
    }

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
});

function columnNames(db: import('better-sqlite3').Database, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(
    (row) => row.name,
  );
}

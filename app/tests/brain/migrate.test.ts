import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { BRIEF_SPECS, DEFAULT_SLOT_DEFS } from '@shared/scenario';
import { ftsExists, listBriefSpecs, listSlotDefs, openBrain, tableNames, REQUIRED_TABLES } from '../../src/main/brain';

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
    const row = brain.db.prepare('SELECT version FROM schema_migrations').get() as { version: number };
    expect(row.version).toBeGreaterThanOrEqual(1);
    brain.close();
  });

  it('首启后槽名/简报说明与 DEFAULT_SLOT_DEFS/BRIEF_SPECS 一致，且对象/来源/主张计数为 0', () => {
    const brain = openBrain(tmpBrain());
    const snap = brain.snapshot();
    expect(snap.objects).toHaveLength(0);
    expect(snap.sources.filter((s) => !s.virtual)).toHaveLength(0);
    expect(snap.claims).toHaveLength(0);
    expect(snap.workspaces).toHaveLength(0);

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
});

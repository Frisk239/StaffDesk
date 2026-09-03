import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openBrain, type Brain } from '../../src/main/brain';
import { pruneOperations as pruneOperationsInDb } from '../../src/main/brain/persist';
import {
  OPERATIONS_RETENTION_LIMIT,
  pruneOperations,
  type OperationRow,
} from '../../src/main/brain/operationsRetention';

// 0063：operations 保留策略——纯函数不变量 + persist 落库 + dispatch 接线（集成烟雾碰库）。

function op(id: string, action: string, createdAt: string): OperationRow {
  return { id, action, createdAt };
}

function ts(n: number): string {
  return new Date(Date.parse('2026-08-30T00:00:00.000Z') + n * 1000).toISOString();
}

const dirs: string[] = [];
const brains: Brain[] = [];

function tmpBrain() {
  const dir = mkdtempSync(join(tmpdir(), 'staffdesk-operations-retention-'));
  dirs.push(dir);
  return join(dir, 'brain.db');
}

afterEach(() => {
  vi.restoreAllMocks();
  while (brains.length) {
    try {
      brains.pop()?.close();
    } catch {
      /* already closed */
    }
  }
  while (dirs.length) {
    const dir = dirs.pop();
    if (dir) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* windows lock */
      }
    }
  }
});

describe('operations 保留策略（纯函数）', () => {
  it('未达上限不动：返回空数组', () => {
    const rows = [op('a', 'SET_VIEW', ts(1)), op('b', 'TOAST', ts(2))];
    expect(pruneOperations(rows, 5)).toEqual([]);
  });

  it('恰好等于上限不动：返回空数组', () => {
    const rows = [op('a', 'SET_VIEW', ts(1)), op('b', 'TOAST', ts(2)), op('c', 'SET_VIEW', ts(3))];
    expect(pruneOperations(rows, 3)).toEqual([]);
  });

  it('超限裁非豁免中最旧的 (created_at, id)，较新的行留下', () => {
    const rows = [
      op('a', 'SET_VIEW', ts(3)),
      op('b', 'TOAST', ts(1)),
      op('c', 'SET_VIEW', ts(2)),
      op('d', 'TOAST', ts(4)),
    ];
    expect(pruneOperations(rows, 2)).toEqual([op('b', 'TOAST', ts(1)), op('c', 'SET_VIEW', ts(2))]);
  });

  it('created_at 同值按 id 字典序破平', () => {
    const same = ts(5);
    const rows = [op('c', 'TOAST', same), op('a', 'TOAST', same), op('b', 'TOAST', same)];
    expect(pruneOperations(rows, 1)).toEqual([op('a', 'TOAST', same), op('b', 'TOAST', same)]);
  });

  it('三类豁免行永不进结果集：即使它们最旧', () => {
    const rows = [
      op('r1', 'DELETE_SOURCE', ts(1)),
      op('r2', 'CORRECT_CLAIM', ts(2)),
      op('r3', 'SET_SOURCE_ROLE', ts(3)),
      op('n1', 'SET_VIEW', ts(4)),
      op('n2', 'TOAST', ts(5)),
    ];
    const doomed = pruneOperations(rows, 2);
    expect(doomed.map((row) => row.id)).toEqual(['n1', 'n2']);
  });

  it('非豁免行不足超出量时只裁到有为止：豁免集合优先于行数上限', () => {
    const rows = [
      op('r1', 'DELETE_SOURCE', ts(1)),
      op('n1', 'SET_VIEW', ts(2)),
      op('n2', 'TOAST', ts(3)),
    ];
    const doomed = pruneOperations(rows, 0);
    expect(doomed.map((row) => row.id)).toEqual(['n1', 'n2']);
  });
});

describe('operations 保留策略（persist 落库）', () => {
  it('COUNT 探底：未超限不触发行 SELECT，也不发 DELETE', () => {
    const brain = openBrain(tmpBrain());
    brains.push(brain);
    const db = brain.db;
    const prepare = vi.spyOn(db, 'prepare');
    pruneOperationsInDb(db);
    const sqls = prepare.mock.calls.map(([sql]) => String(sql));
    expect(sqls).toContain('SELECT COUNT(*) AS n FROM operations');
    expect(sqls.some((sql) => sql.startsWith('SELECT id, action, created_at'))).toBe(false);
    expect(sqls.some((sql) => sql.startsWith('DELETE FROM operations'))).toBe(false);
    expect(db.prepare('SELECT COUNT(*) AS n FROM operations').get()).toEqual({
      n: 0,
    });
  });

  it('超限裁库内非豁免最旧行，豁免行保住，行数回落到上限', () => {
    const brain = openBrain(tmpBrain());
    brains.push(brain);
    const db = brain.db;
    // 直接灌行绕过 dispatch：这里只验 persist 落库，接线由下一组测试守。
    const insert = db.prepare(
      'INSERT INTO operations (id, action, payload, undo_of, chat_ref, created_at) VALUES (?, ?, ?, NULL, NULL, ?)',
    );
    db.transaction(() => {
      insert.run('old-exempt', 'DELETE_SOURCE', '{}', '2026-01-01T00:00:00.000Z');
      insert.run('old-exempt-2', 'CORRECT_CLAIM', '{}', '2026-01-02T00:00:00.000Z');
      insert.run('old-exempt-3', 'SET_SOURCE_ROLE', '{}', '2026-01-03T00:00:00.000Z');
      for (let i = 0; i < OPERATIONS_RETENTION_LIMIT + 1; i += 1) {
        insert.run(`op-${i}`, 'SET_VIEW', '{}', new Date(2026, 1, 1 + (i % 300)).toISOString());
      }
    })();

    pruneOperationsInDb(db);

    const surviving = db.prepare('SELECT id, action FROM operations').all() as {
      id: string;
      action: string;
    }[];
    expect(surviving.length).toBe(OPERATIONS_RETENTION_LIMIT);
    // 豁免三行全在；被裁掉的是非豁免中最旧的 op-0。
    const ids = new Set(surviving.map((row) => row.id));
    expect(ids.has('old-exempt')).toBe(true);
    expect(ids.has('old-exempt-2')).toBe(true);
    expect(ids.has('old-exempt-3')).toBe(true);
    expect(ids.has('op-0')).toBe(false);
  });
});

describe('operations 保留策略（dispatch 接线）', () => {
  it('dispatch 后 operations 行数有界：超限存量被裁，豁免留痕仍在', () => {
    const brain = openBrain(tmpBrain());
    brains.push(brain);
    const db = brain.db;
    const insert = db.prepare(
      'INSERT INTO operations (id, action, payload, undo_of, chat_ref, created_at) VALUES (?, ?, ?, NULL, NULL, ?)',
    );
    db.transaction(() => {
      insert.run('keep-delete', 'DELETE_SOURCE', '{}', '2026-01-01T00:00:00.000Z');
      for (let i = 0; i < OPERATIONS_RETENTION_LIMIT + 50; i += 1) {
        insert.run(`op-${i}`, 'SET_VIEW', '{}', new Date(2026, 1, 1 + (i % 300)).toISOString());
      }
    })();

    brain.dispatch({ type: 'TOAST', text: '接线验收' });

    const surviving = db.prepare('SELECT id FROM operations').all() as { id: string }[];
    // dispatch 内部 append 后即裁：新写入的一行也计入了上限内，行数恰好回落到上限。
    expect(surviving.length).toBe(OPERATIONS_RETENTION_LIMIT);
    const ids = new Set(surviving.map((row) => row.id));
    expect(ids.has('keep-delete')).toBe(true);
  });
});
describe('operations 保留策略（审计五轮 P2-1 排序键盲区）', () => {
  it('真实库路径按 created_at 裁旧——id 字典序与时间序分歧时以时间序为准', () => {
    const brain = openBrain(tmpBrain());
    brains.push(brain);
    const db = brain.db;
    const insert = db.prepare(
      'INSERT INTO operations (id, action, payload, undo_of, chat_ref, created_at) VALUES (?, ?, ?, NULL, NULL, ?)',
    );
    // 盲区构造：id 字典序最旧的行时间最新、id 序最新的行时间最旧——别名修复前
    // createdAt 恒 undefined，排序退化成 id 序会裁错行；修复后必须裁时间最旧者。
    db.transaction(() => {
      insert.run('op-a', 'SET_VIEW', '{}', '2026-08-30T00:00:10.000Z');
      insert.run('op-b', 'SET_VIEW', '{}', '2026-08-30T00:00:09.000Z');
      insert.run('op-c', 'SET_VIEW', '{}', '2026-08-30T00:00:08.000Z');
      insert.run('keep-role', 'SET_SOURCE_ROLE', '{}', '2026-08-30T00:00:01.000Z');
    })();

    pruneOperationsInDb(db, 3);

    const surviving = db.prepare('SELECT id FROM operations').all() as { id: string }[];
    const ids = new Set(surviving.map((row) => row.id));
    // 时间最旧的 op-c 被裁；id 字典序同样不占优的豁免行 keep-role 留存。
    expect(ids.has('op-c')).toBe(false);
    expect(ids.has('op-a')).toBe(true);
    expect(ids.has('op-b')).toBe(true);
    expect(ids.has('keep-role')).toBe(true);
  });
});

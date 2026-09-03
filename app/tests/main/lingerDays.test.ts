import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createJsonLingerDaysStore,
  DEFAULT_LINGER_DAYS,
  normalizeLingerDays,
} from '../../src/main/lingerDays';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('滞留天数设置 0064', () => {
  it('缺文件或损坏回落默认 7', () => {
    const dir = mkdtempSync(join(tmpdir(), 'staffdesk-linger-days-'));
    dirs.push(dir);
    const file = join(dir, 'linger-days.json');
    const store = createJsonLingerDaysStore(file);
    expect(store.load()).toBe(DEFAULT_LINGER_DAYS);
    writeFileSync(file, '{ 不是 JSON', 'utf8');
    expect(store.load()).toBe(DEFAULT_LINGER_DAYS);
  });

  it('N=0 被 normalize 拒绝回落 7；1 和 90 接受；91 钳到 90', () => {
    expect(normalizeLingerDays(0)).toBe(7);
    expect(normalizeLingerDays(-3)).toBe(7);
    expect(normalizeLingerDays(Number.NaN)).toBe(7);
    expect(normalizeLingerDays(undefined)).toBe(7);
    expect(normalizeLingerDays(1)).toBe(1);
    expect(normalizeLingerDays(90)).toBe(90);
    expect(normalizeLingerDays(91)).toBe(90);
    expect(normalizeLingerDays(7.4)).toBe(7);
  });

  it('保存后读回是钳制过的整数，不进别的文件', () => {
    const dir = mkdtempSync(join(tmpdir(), 'staffdesk-linger-days-'));
    dirs.push(dir);
    const file = join(dir, 'linger-days.json');
    const store = createJsonLingerDaysStore(file);
    expect(store.save(91)).toBe(90);
    expect(store.load()).toBe(90);
    expect(store.save(0)).toBe(7);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ version: 1, lingerDays: 7 });
  });
});

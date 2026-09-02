import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createFileLogStore, mergeLogFiles } from '../../src/main/logging';

const dirs: string[] = [];

function tmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'sd-logging-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('主进程持久日志（F3）', () => {
  it('warn 与 error 各落一行到按天命名的文件', () => {
    const dir = tmpDir();
    const store = createFileLogStore({ dir, now: () => new Date('2026-09-02T08:00:00Z') });
    store.logWarn('security', 'webview blocked by runtime policy');
    store.logError('llm', new Error('chat failed'));
    const body = readFileSync(join(dir, 'main-2026-09-02.log'), 'utf8');
    const lines = body.split('\n');
    expect(lines[0]).toContain('2026-09-02T08:00:00.000Z WARN [security] webview blocked');
    expect(lines[1]).toContain('ERROR [llm] chat failed');
    expect(body.endsWith('\n')).toBe(true);
    expect(lines).toHaveLength(3); // 两行日志 + 尾随换行切出的空串
  });

  it('写入口强制掩码密钥（0040）：sk- 与 Bearer 不落盘', () => {
    const dir = tmpDir();
    const store = createFileLogStore({ dir, now: () => new Date('2026-09-02T08:00:00Z') });
    store.logWarn('llm', 'request failed with key sk-supersecret123 and Bearer abcdef');
    store.logError('llm', new Error('boom sk-anothersecret'));
    const body = readFileSync(join(dir, 'main-2026-09-02.log'), 'utf8');
    expect(body).not.toContain('sk-supersecret123');
    expect(body).not.toContain('sk-anothersecret');
    expect(body).not.toContain('Bearer abcdef');
    expect(body).toContain('sk-***');
    expect(body).toContain('Bearer ***');
  });

  it('detail 内的换行折成空格，一条日志只占一行', () => {
    const dir = tmpDir();
    const store = createFileLogStore({ dir, now: () => new Date('2026-09-02T08:00:00Z') });
    store.logWarn('adapters', 'multi\r\nline\ndetail');
    const lines = readFileSync(join(dir, 'main-2026-09-02.log'), 'utf8').trimEnd().split('\n');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('multi line detail');
  });

  it('跨天滚动到新文件，且清理超过保留期的旧日志', () => {
    const dir = tmpDir();
    writeFileSync(join(dir, 'main-2026-01-01.log'), 'ancient\n', 'utf8');
    writeFileSync(join(dir, 'main-2026-01-01.log.1'), 'ancient-rotated\n', 'utf8');
    writeFileSync(join(dir, 'main-2026-08-20.log'), 'recent-enough\n', 'utf8');
    writeFileSync(join(dir, 'unrelated.txt'), 'keep me\n', 'utf8');

    let current = new Date('2026-09-01T10:00:00Z');
    const store = createFileLogStore({ dir, now: () => current });
    store.logWarn('security', 'day one');
    current = new Date('2026-09-02T10:00:00Z');
    store.logWarn('security', 'day two');

    expect(existsSync(join(dir, 'main-2026-09-01.log'))).toBe(true);
    expect(existsSync(join(dir, 'main-2026-09-02.log'))).toBe(true);
    expect(readFileSync(join(dir, 'main-2026-09-02.log'), 'utf8')).toContain('day two');
    // 保留期 30 天：2026-01-01 距 2026-09-02 已超期被清；2026-08-20（含 unrelated.txt）保留。
    expect(existsSync(join(dir, 'main-2026-01-01.log'))).toBe(false);
    expect(existsSync(join(dir, 'main-2026-01-01.log.1'))).toBe(false);
    expect(existsSync(join(dir, 'main-2026-08-20.log'))).toBe(true);
    expect(existsSync(join(dir, 'unrelated.txt'))).toBe(true);
  });

  it('单文件超过上限轮转到 .1，旧 .1 被替换，总量有界', () => {
    const dir = tmpDir();
    const store = createFileLogStore({
      dir,
      now: () => new Date('2026-09-02T08:00:00Z'),
      maxFileBytes: 120,
    });
    store.logWarn('adapters', 'reach fetch failed');
    store.logWarn('adapters', 'reach fetch failed again');
    store.logWarn('adapters', 'reach fetch failed third');
    const current = join(dir, 'main-2026-09-02.log');
    const rotated = `${current}.1`;
    expect(existsSync(rotated)).toBe(true);
    expect(readFileSync(current, 'utf8')).toContain('reach fetch failed third');
    expect(readFileSync(rotated, 'utf8')).toContain('reach fetch failed');
    expect(readFileSync(rotated, 'utf8')).not.toContain('third');
  });

  it('诊断导出按日期合并成单文件，同日 .1 排在前', () => {
    const dir = tmpDir();
    writeFileSync(join(dir, 'main-2026-09-01.log'), 'older-day\n', 'utf8');
    writeFileSync(join(dir, 'main-2026-09-02.log'), 'current\n', 'utf8');
    writeFileSync(join(dir, 'main-2026-09-02.log.1'), 'rotated-older-part\n', 'utf8');
    writeFileSync(join(dir, 'not-a-log.txt'), 'ignored\n', 'utf8');
    const merged = mergeLogFiles(dir);
    const sections = merged.split('===== ');
    expect(sections).toHaveLength(4);
    const firstDay = merged.indexOf('main-2026-09-01.log =====');
    const rotatedPart = merged.indexOf('main-2026-09-02.log.1 =====');
    const currentPart = merged.indexOf('main-2026-09-02.log =====');
    expect(firstDay).toBeLessThan(rotatedPart);
    expect(rotatedPart).toBeLessThan(currentPart);
    expect(merged).toContain('rotated-older-part');
    expect(merged).not.toContain('ignored');
  });

  it('目录不存在时诊断导出返回空串、日志写入不抛', () => {
    const dir = join(tmpDir(), 'missing-subdir');
    expect(mergeLogFiles(dir)).toBe('');
    const store = createFileLogStore({ dir, now: () => new Date('2026-09-02T08:00:00Z') });
    expect(() => store.logWarn('security', 'after auto mkdir')).not.toThrow();
    expect(existsSync(join(dir, 'main-2026-09-02.log'))).toBe(true);
  });

  it('目录内容非日志文件不参与保留期清理', () => {
    const dir = tmpDir();
    writeFileSync(join(dir, 'main-2026-01-01.log'), 'ancient\n', 'utf8');
    writeFileSync(join(dir, 'keep.txt'), 'not a log\n', 'utf8');
    const store = createFileLogStore({ dir, now: () => new Date('2026-09-02T08:00:00Z') });
    store.logWarn('security', 'trigger sweep');
    expect(readdirSync(dir)).toContain('keep.txt');
  });
});

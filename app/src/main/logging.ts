import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs';
import { join } from 'node:path';
import { maskSecret, safeDetail } from './redact';

// 0040 红线：API 密钥不入日志。本模块是主进程日志唯一落盘出口——detail 在写入口统一
// 强制掩码（调用方即使传了原文也不许把 sk-…/Bearer … 写进盘上文件），且只记掩码后
// detail、不记请求原文。F3（审计 2026-09-02）：手写 fs 按天滚动，不引日志框架。

const LOG_FILE_PATTERN = /^main-(\d{4}-\d{2}-\d{2})\.log(\.1)?$/;
const DEFAULT_MAX_FILE_BYTES = 5 * 1024 * 1024;
const DEFAULT_RETENTION_DAYS = 30;

export interface FileLogStore {
  logWarn(scope: string, detail: string): void;
  logError(scope: string, error: unknown): void;
}

export function createFileLogStore(options: {
  dir: string;
  now?: () => Date;
  maxFileBytes?: number;
  retentionDays?: number;
}): FileLogStore {
  const now = options.now ?? (() => new Date());
  const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const retentionDays = options.retentionDays ?? DEFAULT_RETENTION_DAYS;
  let lastDay = '';

  const write = (level: 'WARN' | 'ERROR', scope: string, detail: string): void => {
    // 日志自身失败绝不外抛：写日志的路径抛错只会制造新的未处理异常（F2 的教训）。
    try {
      // 只在跨天/首写时建目录与清扫（评审 M33：不必每行一次 mkdirSync）。
      const stamp = now();
      const day = stamp.toISOString().slice(0, 10);
      if (day !== lastDay) {
        lastDay = day;
        mkdirSync(options.dir, { recursive: true });
        sweepExpiredLogs(options.dir, day, retentionDays);
      }
      const fileName = `main-${day}.log`;
      const filePath = join(options.dir, fileName);
      // 轮转 .1：单文件超上限即挪走重新起笔，一天最多两份（当前 + .1），总量有界。
      if (existsSync(filePath) && statSync(filePath).size >= maxFileBytes) {
        const rotated = `${filePath}.1`;
        if (existsSync(rotated)) rmSync(rotated, { force: true });
        renameSync(filePath, rotated);
      }
      const masked = maskSecret(detail).replace(/[\r\n]+/g, ' ');
      // scope 不走掩码：只允许调用方传固定字面量（'startup'/'uncaught' 等）；动态拼的内容必须放 detail（评审 M33）。
      appendFileSync(filePath, `${stamp.toISOString()} ${level} [${scope}] ${masked}\n`, 'utf8');
    } catch {
      /* 同上：吞掉，不再抛 */
    }
  };

  return {
    logWarn: (scope, detail) => write('WARN', scope, detail),
    logError: (scope, error) => write('ERROR', scope, safeDetail(error, 2000)),
  };
}

/** 启动期清掉超过保留期的按天日志（含 .1 轮转）；文件名日期字典序即时间序。 */
function sweepExpiredLogs(dir: string, today: string, retentionDays: number): void {
  const cutoff = new Date(Date.parse(`${today}T00:00:00Z`) - retentionDays * 86_400_000)
    .toISOString()
    .slice(0, 10);
  for (const name of readdirSync(dir)) {
    const match = name.match(LOG_FILE_PATTERN);
    if (match && (match[1] ?? '') < cutoff) rmSync(join(dir, name), { force: true });
  }
}

let defaultStore: FileLogStore | null = null;
let defaultDir: string | null = null;

/** 主进程启动时挂接（index.ts）；未初始化前日志调用静默丢弃，绝不抛。 */
export function initLogging(dir: string): void {
  defaultDir = dir;
  defaultStore = createFileLogStore({ dir });
}

/** 单测隔离用：还原到未初始化状态。 */
export function resetLogging(): void {
  defaultStore = null;
  defaultDir = null;
}

export function logWarn(scope: string, detail: string): void {
  defaultStore?.logWarn(scope, detail);
}

export function logError(scope: string, error: unknown): void {
  defaultStore?.logError(scope, error);
}

/** 设置页与诊断导出用：日志目录；未初始化返回 null。 */
export function loggingDir(): string | null {
  return defaultDir;
}

/** 诊断导出：logs 目录内按天日志合并成单文件文本（文件名分节、按日期排序，同日 .1 在前=旧的在前）。 */
export function mergeLogFiles(dir: string): string {
  if (!existsSync(dir)) return '';
  const names = readdirSync(dir).filter((name) => LOG_FILE_PATTERN.test(name));
  const rank = (name: string): [string, number] => {
    const match = name.match(LOG_FILE_PATTERN);
    return [match?.[1] ?? '', match?.[2] === '.1' ? 0 : 1];
  };
  names.sort((a, b) => {
    const [dayA, passA] = rank(a);
    const [dayB, passB] = rank(b);
    if (dayA !== dayB) return dayA < dayB ? -1 : 1;
    return passA - passB;
  });
  const sections = names.map(
    (name) => `===== ${name} =====\n${readFileSync(join(dir, name), 'utf8')}`,
  );
  return sections.length > 0 ? `${sections.join('\n')}\n` : '';
}

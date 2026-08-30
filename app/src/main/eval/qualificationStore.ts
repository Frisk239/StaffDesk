import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { QualityQualificationRecord } from '@shared/types';

interface QualificationHistoryFile {
  version: 1;
  records: QualityQualificationRecord[];
}

export interface QualificationStore {
  list: () => QualityQualificationRecord[];
  find: (fingerprint: string) => QualityQualificationRecord | null;
  save: (record: QualityQualificationRecord) => void;
}

export function createJsonQualificationStore(filePath: string): QualificationStore {
  const load = (): QualificationHistoryFile => {
    if (!existsSync(filePath)) return { version: 1, records: [] };
    try {
      const parsed: unknown = JSON.parse(readFileSync(filePath, 'utf8'));
      return parseHistory(parsed);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`资格记录无法读取：${safeDetail(detail)}`);
    }
  };
  return {
    list: () => structuredClone(load().records),
    find(fingerprint) {
      const found = load().records.find((record) => record.fingerprint === fingerprint);
      return found ? structuredClone(found) : null;
    },
    save(record) {
      mkdirSync(dirname(filePath), { recursive: true });
      const previous = load().records.filter((item) => item.fingerprint !== record.fingerprint);
      const history: QualificationHistoryFile = {
        version: 1,
        records: [sanitizeRecord(record), ...previous].slice(0, 20),
      };
      const temporaryPath = `${filePath}.tmp`;
      writeFileSync(temporaryPath, `${JSON.stringify(history, null, 2)}\n`, {
        encoding: 'utf8',
        mode: 0o600,
      });
      renameSync(temporaryPath, filePath);
    },
  };
}

export function createMemoryQualificationStore(
  initial: readonly QualityQualificationRecord[] = [],
): QualificationStore {
  let records = initial.map(sanitizeRecord);
  return {
    list: () => structuredClone(records),
    find: (fingerprint) => {
      const found = records.find((record) => record.fingerprint === fingerprint);
      return found ? structuredClone(found) : null;
    },
    save(record) {
      records = [
        sanitizeRecord(record),
        ...records.filter((item) => item.fingerprint !== record.fingerprint),
      ].slice(0, 20);
    },
  };
}

function parseHistory(value: unknown): QualificationHistoryFile {
  if (!isRecord(value) || !Array.isArray(value.records)) return { version: 1, records: [] };
  return {
    version: 1,
    records: value.records.filter(isQualificationRecord).map(sanitizeRecord).slice(0, 20),
  };
}

function isQualificationRecord(value: unknown): value is QualityQualificationRecord {
  return (
    isRecord(value) &&
    typeof value.fingerprint === 'string' &&
    typeof value.endpointIdentity === 'string' &&
    typeof value.modelId === 'string' &&
    typeof value.suiteVersion === 'string' &&
    typeof value.completedAt === 'string' &&
    isCheck(value.connect) &&
    isCheck(value.capability)
  );
}

function isCheck(value: unknown): boolean {
  return (
    isRecord(value) &&
    (value.status === '通过' || value.status === '失败') &&
    typeof value.detail === 'string'
  );
}

function sanitizeRecord(record: QualityQualificationRecord): QualityQualificationRecord {
  return {
    fingerprint: record.fingerprint.slice(0, 128),
    endpointIdentity: record.endpointIdentity.slice(0, 160),
    modelId: record.modelId.slice(0, 160),
    suiteVersion: record.suiteVersion.slice(0, 80),
    completedAt: record.completedAt,
    connect: { status: record.connect.status, detail: safeDetail(record.connect.detail) },
    capability: { status: record.capability.status, detail: safeDetail(record.capability.detail) },
    ...(record.report ? { report: structuredClone(record.report) } : {}),
    ...(record.detail ? { detail: safeDetail(record.detail) } : {}),
  };
}

function safeDetail(raw: string): string {
  return raw
    .replace(/Bearer\s+\S+/gi, 'Bearer ***')
    .replace(/sk-[A-Za-z0-9_-]+/g, 'sk-***')
    .slice(0, 180);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

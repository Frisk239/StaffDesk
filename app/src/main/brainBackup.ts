import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import Database from 'better-sqlite3';
import type { Brain } from './brain';
import { REQUIRED_TABLES, SCHEMA_VERSION } from './brain/schema';
import type { BrainBackupInfo } from '@shared/api';

const ZIP_LOCAL_FILE_HEADER = 0x04034b50;
const ZIP_CENTRAL_DIRECTORY_HEADER = 0x02014b50;
const ZIP_END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const SQLITE_HEADER = 'SQLite format 3\u0000';

export const BRAIN_BACKUP_DATABASE_ENTRY = 'brain.db';
export const BRAIN_BACKUP_MANIFEST_ENTRY = 'manifest.json';

export interface BrainBackupManifest {
  product: 'StaffDesk';
  kind: 'brain-backup';
  formatVersion: 1;
  createdAt: string;
  schemaVersion: number;
  database: {
    path: typeof BRAIN_BACKUP_DATABASE_ENTRY;
    sizeBytes: number;
    sha256: string;
  };
  includes: [typeof BRAIN_BACKUP_DATABASE_ENTRY];
  excludes: ['apiKeys', 'modelSettings', 'qualityQualification', 'runtimeCaches', 'buildArtifacts'];
}

export interface BrainBackupArchive {
  buffer: Buffer;
  manifest: BrainBackupManifest;
}

export interface RestoredBrainArchive {
  database: Buffer;
  manifest: BrainBackupManifest;
}

export async function createBrainBackupArchive(
  brain: Brain,
  options: { createdAt?: string | undefined } = {},
): Promise<BrainBackupArchive> {
  const dir = mkdtempSync(join(tmpdir(), 'staffdesk-brain-backup-'));
  const dbPath = join(dir, BRAIN_BACKUP_DATABASE_ENTRY);
  try {
    await brain.db.backup(dbPath);
    const database = readFileSync(dbPath);
    const manifest = createBrainBackupManifest(
      database,
      options.createdAt ?? new Date().toISOString(),
    );
    const manifestJson = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    return {
      buffer: zipStoredEntries([
        { name: BRAIN_BACKUP_MANIFEST_ENTRY, data: manifestJson },
        { name: BRAIN_BACKUP_DATABASE_ENTRY, data: database },
      ]),
      manifest,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function readBrainBackupArchive(archive: Buffer): RestoredBrainArchive {
  const entries = readStoredZipEntries(archive);
  assertExpectedBackupEntries(entries);
  const manifest = parseBrainBackupManifest(entries.get(BRAIN_BACKUP_MANIFEST_ENTRY)!);
  const database = entries.get(BRAIN_BACKUP_DATABASE_ENTRY)!;
  if (database.length !== manifest.database.sizeBytes) {
    throw new Error('备份中的大脑文件大小与清单不一致');
  }
  if (sha256(database) !== manifest.database.sha256) {
    throw new Error('备份中的大脑文件校验失败');
  }
  validateBrainDatabaseBuffer(database);
  return { database, manifest };
}

export function backupInfoFromManifest(manifest: BrainBackupManifest): BrainBackupInfo {
  return {
    createdAt: manifest.createdAt,
    schemaVersion: manifest.schemaVersion,
    sizeBytes: manifest.database.sizeBytes,
    sha256: manifest.database.sha256,
  };
}

export function writeBrainBackupFile(
  filePath: string,
  archive: BrainBackupArchive,
): BrainBackupInfo {
  writeFileSync(filePath, archive.buffer);
  return backupInfoFromManifest(archive.manifest);
}

export function replaceBrainDatabaseFile(targetPath: string, database: Buffer): void {
  validateBrainDatabaseBuffer(database);

  const dir = dirname(targetPath);
  const id = `${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
  const base = basename(targetPath);
  const incomingPath = join(dir, `.${base}.restore-${id}.tmp`);
  const rollbackPath = join(dir, `.${base}.restore-${id}.rollback`);
  let rollbackReady = false;

  writeFileSync(incomingPath, database, { mode: 0o600 });
  try {
    removeSqliteSidecars(targetPath);
    if (existsSync(targetPath)) {
      renameSync(targetPath, rollbackPath);
      rollbackReady = true;
    }
    renameSync(incomingPath, targetPath);
    if (rollbackReady && existsSync(rollbackPath)) rmSync(rollbackPath, { force: true });
    removeSqliteSidecars(targetPath);
  } catch (error) {
    if (!existsSync(targetPath) && rollbackReady && existsSync(rollbackPath)) {
      renameSync(rollbackPath, targetPath);
    }
    throw new Error(`恢复大脑文件失败：${safeErrorMessage(error)}`);
  } finally {
    if (existsSync(incomingPath)) rmSync(incomingPath, { force: true });
  }
}

export function zipStoredEntries(entries: { name: string; data: Buffer }[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    assertSafeBackupEntryName(entry.name);
    const name = Buffer.from(entry.name, 'utf8');
    const crc = crc32(entry.data);
    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(ZIP_LOCAL_FILE_HEADER, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(entry.data.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    name.copy(local, 30);
    locals.push(local, entry.data);

    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(ZIP_CENTRAL_DIRECTORY_HEADER, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(entry.data.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    name.copy(central, 46);
    centrals.push(central);

    offset += local.length + entry.data.length;
  }

  const centralOffset = offset;
  const centralDirectory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(ZIP_END_OF_CENTRAL_DIRECTORY, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(centralOffset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...locals, centralDirectory, end]);
}

export function readStoredZipEntries(archive: Buffer): Map<string, Buffer> {
  const end = findEndOfCentralDirectory(archive);
  const entryCount = archive.readUInt16LE(end + 10);
  const centralSize = archive.readUInt32LE(end + 12);
  const centralOffset = archive.readUInt32LE(end + 16);
  if (centralOffset + centralSize > archive.length) throw new Error('备份 zip 中央目录越界');

  const entries = new Map<string, Buffer>();
  let cursor = centralOffset;
  for (let i = 0; i < entryCount; i += 1) {
    if (archive.readUInt32LE(cursor) !== ZIP_CENTRAL_DIRECTORY_HEADER) {
      throw new Error('备份 zip 中央目录损坏');
    }
    const flags = archive.readUInt16LE(cursor + 8);
    const method = archive.readUInt16LE(cursor + 10);
    const crc = archive.readUInt32LE(cursor + 16);
    const compressedSize = archive.readUInt32LE(cursor + 20);
    const uncompressedSize = archive.readUInt32LE(cursor + 24);
    const nameLength = archive.readUInt16LE(cursor + 28);
    const extraLength = archive.readUInt16LE(cursor + 30);
    const commentLength = archive.readUInt16LE(cursor + 32);
    const localOffset = archive.readUInt32LE(cursor + 42);
    if (flags !== 0 || method !== 0 || compressedSize !== uncompressedSize) {
      throw new Error('备份 zip 只接受未压缩的 StaffDesk 条目');
    }
    const nameStart = cursor + 46;
    const name = archive.toString('utf8', nameStart, nameStart + nameLength);
    assertSafeBackupEntryName(name);
    if (archive.readUInt32LE(localOffset) !== ZIP_LOCAL_FILE_HEADER) {
      throw new Error('备份 zip 本地文件头损坏');
    }
    const localNameLength = archive.readUInt16LE(localOffset + 26);
    const localExtraLength = archive.readUInt16LE(localOffset + 28);
    const localNameStart = localOffset + 30;
    const localName = archive.toString('utf8', localNameStart, localNameStart + localNameLength);
    if (localName !== name) throw new Error('备份 zip 条目名不一致');
    const dataStart = localNameStart + localNameLength + localExtraLength;
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > archive.length) throw new Error('备份 zip 条目越界');
    const data = Buffer.from(archive.subarray(dataStart, dataEnd));
    if (crc32(data) !== crc) throw new Error('备份 zip 条目校验失败');
    entries.set(name, data);
    cursor = nameStart + nameLength + extraLength + commentLength;
  }
  if (cursor !== centralOffset + centralSize) throw new Error('备份 zip 中央目录长度不一致');
  return entries;
}

export function validateBrainDatabaseBuffer(database: Buffer): void {
  if (database.length < SQLITE_HEADER.length) throw new Error('备份中的大脑文件不是 SQLite 数据库');
  if (database.toString('latin1', 0, SQLITE_HEADER.length) !== SQLITE_HEADER) {
    throw new Error('备份中的大脑文件不是 SQLite 数据库');
  }

  const dir = mkdtempSync(join(tmpdir(), 'staffdesk-brain-validate-'));
  const dbPath = join(dir, BRAIN_BACKUP_DATABASE_ENTRY);
  try {
    writeFileSync(dbPath, database);
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    try {
      const integrity = db.pragma('integrity_check', { simple: true }) as string;
      if (integrity !== 'ok') throw new Error('备份中的大脑文件完整性检查失败');
      const tableRows = db
        .prepare(
          `SELECT name FROM sqlite_master
           WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%'`,
        )
        .all() as { name: string }[];
      const tables = new Set(tableRows.map((row) => row.name));
      const missing = REQUIRED_TABLES.filter((table) => !tables.has(table));
      if (missing.length > 0) {
        throw new Error(`备份中的大脑文件缺少表：${missing.join('、')}`);
      }
    } finally {
      db.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function createBrainBackupManifest(database: Buffer, createdAt: string): BrainBackupManifest {
  return {
    product: 'StaffDesk',
    kind: 'brain-backup',
    formatVersion: 1,
    createdAt,
    schemaVersion: SCHEMA_VERSION,
    database: {
      path: BRAIN_BACKUP_DATABASE_ENTRY,
      sizeBytes: database.length,
      sha256: sha256(database),
    },
    includes: [BRAIN_BACKUP_DATABASE_ENTRY],
    excludes: [
      'apiKeys',
      'modelSettings',
      'qualityQualification',
      'runtimeCaches',
      'buildArtifacts',
    ],
  };
}

function parseBrainBackupManifest(data: Buffer): BrainBackupManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data.toString('utf8')) as unknown;
  } catch {
    throw new Error('备份清单不是合法 JSON');
  }
  if (!isRecord(parsed)) throw new Error('备份清单格式不正确');
  if (parsed.product !== 'StaffDesk' || parsed.kind !== 'brain-backup') {
    throw new Error('不是 StaffDesk 大脑备份');
  }
  if (parsed.formatVersion !== 1) throw new Error('不支持的 StaffDesk 大脑备份版本');
  if (typeof parsed.createdAt !== 'string' || !parsed.createdAt.trim()) {
    throw new Error('备份清单缺少创建时间');
  }
  if (typeof parsed.schemaVersion !== 'number' || !Number.isInteger(parsed.schemaVersion)) {
    throw new Error('备份清单缺少 schemaVersion');
  }
  if (!isRecord(parsed.database)) throw new Error('备份清单缺少大脑文件信息');
  if (parsed.database.path !== BRAIN_BACKUP_DATABASE_ENTRY) {
    throw new Error('备份清单指向了未知大脑文件');
  }
  if (typeof parsed.database.sizeBytes !== 'number' || parsed.database.sizeBytes <= 0) {
    throw new Error('备份清单中的大脑文件大小不正确');
  }
  if (
    typeof parsed.database.sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(parsed.database.sha256)
  ) {
    throw new Error('备份清单中的大脑文件校验值不正确');
  }
  return {
    product: 'StaffDesk',
    kind: 'brain-backup',
    formatVersion: 1,
    createdAt: parsed.createdAt,
    schemaVersion: parsed.schemaVersion,
    database: {
      path: BRAIN_BACKUP_DATABASE_ENTRY,
      sizeBytes: parsed.database.sizeBytes,
      sha256: parsed.database.sha256,
    },
    includes: [BRAIN_BACKUP_DATABASE_ENTRY],
    excludes: [
      'apiKeys',
      'modelSettings',
      'qualityQualification',
      'runtimeCaches',
      'buildArtifacts',
    ],
  };
}

function assertExpectedBackupEntries(entries: Map<string, Buffer>): void {
  const names = [...entries.keys()].sort();
  const expected = [BRAIN_BACKUP_DATABASE_ENTRY, BRAIN_BACKUP_MANIFEST_ENTRY].sort();
  if (names.length !== expected.length || names.some((name, index) => name !== expected[index])) {
    throw new Error('备份 zip 只能包含 StaffDesk 清单和大脑文件');
  }
}

function assertSafeBackupEntryName(name: string): void {
  if (
    !name ||
    name.includes('\\') ||
    name.includes('/') ||
    name.includes(':') ||
    name === '.' ||
    name === '..'
  ) {
    throw new Error('备份 zip 包含不安全的文件名');
  }
}

function findEndOfCentralDirectory(archive: Buffer): number {
  const min = Math.max(0, archive.length - 22 - 0xffff);
  for (let cursor = archive.length - 22; cursor >= min; cursor -= 1) {
    if (archive.readUInt32LE(cursor) === ZIP_END_OF_CENTRAL_DIRECTORY) return cursor;
  }
  throw new Error('备份文件不是可识别的 zip');
}

function removeSqliteSidecars(dbPath: string): void {
  for (const filePath of [`${dbPath}-wal`, `${dbPath}-shm`]) {
    if (existsSync(filePath)) rmSync(filePath, { force: true });
  }
}

function safeErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw
    .replace(/Bearer\s+\S+/gi, 'Bearer ***')
    .replace(/sk-[A-Za-z0-9_-]+/g, 'sk-***')
    .slice(0, 160);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sha256(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

function crc32(buf: Buffer): number {
  let crc = ~0;
  for (let i = 0; i < buf.length; i += 1) {
    crc ^= buf[i] ?? 0;
    for (let j = 0; j < 8; j += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return ~crc >>> 0;
}

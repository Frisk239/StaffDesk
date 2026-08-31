import type Database from 'better-sqlite3';
import type {
  Brief,
  ChatMessage,
  Claim,
  DeletedSourceRecovery,
  DeskObject,
  DeskTask,
  IngestJob,
  Memory,
  Proposal,
  SlotDef,
  Source,
  State,
  TaskAudit,
  WriteProposal,
  Workspace,
} from '@shared/types';

function metaSet(db: Database.Database, key: string, value: string): void {
  db.prepare(
    `INSERT INTO app_meta (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(key, value);
}

const LEGACY_MODEL_META_KEYS = [
  'providers',
  'activeProviderId',
  'activeModelId',
  'thinkingEffort',
] as const;
const MODEL_SETTINGS_ACTIONS = [
  'UPSERT_PROVIDER',
  'REMOVE_PROVIDER',
  'SET_ACTIVE_PROVIDER',
  'SET_ACTIVE_MODEL',
  'SET_THINKING',
] as const;

/** 模型配置已经提升为产品级设置；迁移完成后移除业务库中的旧副本。 */
export function clearLegacyModelMeta(db: Database.Database): void {
  const remove = db.prepare('DELETE FROM app_meta WHERE key = ?');
  db.transaction(() => {
    for (const key of LEGACY_MODEL_META_KEYS) remove.run(key);
  })();
}

/** 模型配置是产品级设置（0043/0048），历史上误进 brain 操作日志的配置动作要清掉。 */
export function clearModelSettingsOperations(db: Database.Database): void {
  const remove = db.prepare('DELETE FROM operations WHERE action = ?');
  db.transaction(() => {
    for (const action of MODEL_SETTINGS_ACTIONS) remove.run(action);
  })();
}

export function interruptActiveIngestJobs(db: Database.Database): void {
  const now = new Date().toISOString();
  db.prepare(
    `UPDATE ingest_jobs
     SET status = '失败',
         failure_kind = 'interrupted',
         detail = '上次导入中断，可重试',
         updated_at = ?
     WHERE status IN ('排队', '获取中', '解析中', '提交中')`,
  ).run(now);
}

/** 0056：写路径模式——'diff' 按脏表差异写入（dispatch 默认），'full' 全量重写（修复与等价对照通道）。 */
export type PersistMode = 'diff' | 'full';

/** persist 层可写的行值类型：账本 schema 只用 TEXT/INTEGER（0040：密钥不落库）。 */
type PersistValue = string | number | null;
type PersistRow = Record<string, PersistValue>;

/**
 * 0056：persist 写射程内单表的行构造器。全量重写与差异写入共用同一份代码，防两路漂移；
 * operations、certs、scenario_brief_specs、schema_migrations 不在射程（约束二）。
 */
interface PersistTable {
  table: string;
  /** 列序即 persist 的 INSERT 列序；行构造器必须为每列都给出值（缺位写 null）。 */
  columns: string[];
  primaryKey: string[];
  /** 判脏 fast-path（0056）：prev/next 该集合引用相同则必未变（不可变性审计），整表跳过。 */
  collection: (state: State) => unknown;
  rows: (state: State) => PersistRow[];
}

/** 虚拟来源（user-stmt）是快照派生的落点，永不落库：sources 与 source_bindings 共用此 skip 规则。 */
function isPersistentSource(s: Source): boolean {
  return !s.virtual && s.id !== 'user-stmt';
}

const PERSIST_TABLES: readonly PersistTable[] = [
  {
    table: 'workspaces',
    columns: ['id', 'name', 'scenario', 'created_at'],
    primaryKey: ['id'],
    collection: (state) => state.workspaces,
    rows: (state) =>
      state.workspaces.map((w) => ({
        id: w.id,
        name: w.name,
        scenario: w.scenario,
        created_at: stateStamp(state),
      })),
  },
  {
    table: 'objects',
    columns: ['id', 'kind', 'name', 'note', 'workspace_id', 'archived', 'created_at'],
    primaryKey: ['id'],
    collection: (state) => state.objects,
    rows: (state) =>
      state.objects.map((o) => ({
        id: o.id,
        kind: o.kind,
        name: o.name,
        note: o.note ?? null,
        workspace_id: o.workspaceId,
        archived: o.archived ? 1 : 0,
        created_at: stateStamp(state),
      })),
  },
  {
    // 0056：子表跟随父集合引用判脏；relationIds 数组序即行序（reducer 不重排的不变量）。
    table: 'object_relations',
    columns: ['from_id', 'to_id'],
    primaryKey: ['from_id', 'to_id'],
    collection: (state) => state.objects,
    rows: (state) => {
      const rows: PersistRow[] = [];
      for (const o of state.objects) {
        for (const to of o.relationIds) {
          rows.push({ from_id: o.id, to_id: to });
        }
      }
      return rows;
    },
  },
  {
    table: 'sources',
    columns: [
      'id',
      'title',
      'body',
      'path',
      'role',
      'workspace_id',
      'unparsed',
      'origin_json',
      'segments_json',
      'content_hash',
      'fetched_at',
      'created_at',
    ],
    primaryKey: ['id'],
    collection: (state) => state.sources,
    rows: (state) => {
      const rows: PersistRow[] = [];
      for (const s of state.sources) {
        if (!isPersistentSource(s)) continue;
        rows.push({
          id: s.id,
          title: s.title,
          body: s.body,
          path: s.path,
          role: s.role ?? null,
          workspace_id: s.workspaceId ?? null,
          unparsed: s.unparsed ? 1 : 0,
          origin_json: s.origin ? JSON.stringify(s.origin) : null,
          segments_json: s.segments ? JSON.stringify(s.segments) : null,
          content_hash: s.contentHash ?? s.origin?.contentHash ?? null,
          fetched_at: s.fetchedAt ?? s.origin?.fetchedAt ?? null,
          created_at: stateStamp(state),
        });
      }
      return rows;
    },
  },
  {
    table: 'source_bindings',
    columns: ['source_id', 'object_id'],
    primaryKey: ['source_id', 'object_id'],
    collection: (state) => state.sources,
    rows: (state) => {
      const rows: PersistRow[] = [];
      for (const s of state.sources) {
        if (!isPersistentSource(s)) continue;
        for (const oid of s.boundObjectIds) {
          rows.push({ source_id: s.id, object_id: oid });
        }
      }
      return rows;
    },
  },
  {
    table: 'slot_defs',
    columns: ['id', 'name', 'kind', 'arity', 'scenarios', 'created_at'],
    primaryKey: ['id'],
    collection: (state) => state.slotDefs,
    rows: (state) =>
      state.slotDefs.map((slot, i) => ({
        id: `slot-${String(i + 1).padStart(3, '0')}-${slot.kind}`,
        name: slot.name,
        kind: slot.kind,
        arity: slot.arity,
        scenarios: JSON.stringify(slot.scenarios),
        created_at: stateStamp(state),
      })),
  },
  {
    table: 'claims',
    columns: [
      'id',
      'object_id',
      'predicate',
      'text',
      'status',
      'unverified',
      'valid_from',
      'valid_to',
      'close_reason',
      'source_id',
      'span',
      'source_start',
      'source_end',
      'source_locator',
      'superseded_by',
      'created_at',
    ],
    primaryKey: ['id'],
    collection: (state) => state.claims,
    rows: (state) =>
      state.claims.map((c) => ({
        id: c.id,
        object_id: c.objectId,
        predicate: c.predicate,
        text: c.text,
        status: c.status,
        unverified: c.unverified ? 1 : 0,
        valid_from: c.validFrom ?? null,
        valid_to: c.validTo ?? null,
        close_reason: c.closeReason ?? null,
        source_id: c.sourceId,
        span: c.span ?? null,
        source_start: c.sourceStart ?? null,
        source_end: c.sourceEnd ?? null,
        source_locator: c.sourceLocator ? JSON.stringify(c.sourceLocator) : null,
        superseded_by: c.supersededBy ?? null,
        created_at: c.createdAt,
      })),
  },
  {
    table: 'memories',
    columns: [
      'id',
      'scope',
      'object_id',
      'kind',
      'text',
      'created_at',
      'banned_object_id',
      'banned_predicate',
      'banned_value',
    ],
    primaryKey: ['id'],
    collection: (state) => state.memories,
    rows: (state) =>
      state.memories.map((m) => ({
        id: m.id,
        scope: m.scope,
        object_id: m.objectId ?? null,
        kind: m.kind,
        text: m.text,
        created_at: m.createdAt,
        // 0054：禁写结构化路三列；非禁写与历史行 NULL。
        banned_object_id: m.bannedObjectId ?? null,
        banned_predicate: m.bannedPredicate ?? null,
        banned_value: m.bannedValue ?? null,
      })),
  },
  {
    table: 'proposals',
    columns: ['id', 'type', 'payload', 'pending', 'decision', 'created_at', 'title', 'detail'],
    primaryKey: ['id'],
    collection: (state) => state.proposals,
    rows: (state) =>
      state.proposals.map((p) => ({
        id: p.id,
        type: p.type,
        payload: JSON.stringify(p.payload),
        pending: p.pending ? 1 : 0,
        decision: p.decision ?? null,
        created_at: stateStamp(state),
        title: p.title,
        detail: p.detail,
      })),
  },
  {
    table: 'write_queue',
    columns: [
      'id',
      'object_id',
      'kind',
      'task_id',
      'headline',
      'evidence',
      'claim_id',
      'claim_ids',
      'source_id',
      'object_ids',
      'target_predicate',
      'outbound',
      'position',
      'created_at',
    ],
    primaryKey: ['id'],
    collection: (state) => state.writeQueue,
    rows: (state) => {
      const rows: PersistRow[] = [];
      state.writeQueue.forEach((write, position) => {
        rows.push({
          id: write.id,
          object_id: write.objectId,
          kind: write.kind,
          task_id: write.taskId ?? null,
          headline: write.headline,
          evidence: write.evidence,
          claim_id: write.claimId ?? null,
          claim_ids: write.claimIds ? JSON.stringify(write.claimIds) : null,
          source_id: write.sourceId ?? null,
          object_ids: write.objectIds ? JSON.stringify(write.objectIds) : null,
          target_predicate: write.targetPredicate ?? null,
          outbound: typeof write.outbound === 'boolean' ? (write.outbound ? 1 : 0) : null,
          // 0056 约束一例外：position 跟随数组下标重排，必须进 UPDATE 写集与脏判。
          position,
          created_at: stateStamp(state),
        });
      });
      return rows;
    },
  },
  {
    table: 'tasks',
    columns: [
      'id',
      'object_id',
      'kind',
      'status',
      'stop_reason',
      'budget_gear',
      'query',
      'interval_days',
      'next_due_at',
      'last_run_at',
      'parent_task_id',
      'due_at',
      'created_at',
      'finished_at',
    ],
    primaryKey: ['id'],
    collection: (state) => state.tasks,
    rows: (state) =>
      state.tasks.map((t) => ({
        id: t.id,
        object_id: t.objectId,
        kind: t.kind,
        status: t.status,
        stop_reason: t.stopReason ?? null,
        budget_gear: t.budgetGear ?? null,
        query: t.query ?? null,
        interval_days: t.intervalDays ?? null,
        next_due_at: t.nextDueAt ?? null,
        last_run_at: t.lastRunAt ?? null,
        parent_task_id: t.parentTaskId ?? null,
        due_at: t.dueAt ?? null,
        created_at: t.createdAt,
        finished_at: t.status === '已完成' || t.status === '已停止' ? t.createdAt : null,
      })),
  },
  {
    table: 'task_audit',
    columns: ['task_id', 'seq', 'kind', 'payload', 'ts'],
    primaryKey: ['task_id', 'seq'],
    collection: (state) => state.taskAudits,
    rows: (state) =>
      (state.taskAudits ?? []).map((a) => ({
        task_id: a.taskId,
        seq: a.seq,
        kind: a.kind,
        payload: JSON.stringify(a.payload),
        ts: a.ts,
      })),
  },
  {
    table: 'briefs',
    columns: ['id', 'object_id', 'task_id', 'blocks', 'created_at'],
    primaryKey: ['id'],
    collection: (state) => state.briefs,
    rows: (state) =>
      state.briefs.map((b) => ({
        id: b.id,
        object_id: b.objectId,
        task_id: b.taskId,
        blocks: JSON.stringify(b.blocks),
        created_at: b.createdAt,
      })),
  },
  {
    table: 'ingest_jobs',
    columns: [
      'id',
      'input_kind',
      'input_json',
      'status',
      'title',
      'locator',
      'source_id',
      'failure_kind',
      'detail',
      'attempt',
      'workspace_id',
      'created_at',
      'updated_at',
    ],
    primaryKey: ['id'],
    collection: (state) => state.ingestJobs,
    rows: (state) =>
      state.ingestJobs.map((job) => ({
        id: job.id,
        input_kind: job.inputKind,
        input_json: job.input ? JSON.stringify(job.input) : null,
        status: job.status,
        title: job.title ?? null,
        locator: job.locator ?? null,
        source_id: job.sourceId ?? null,
        failure_kind: job.failureKind ?? null,
        detail: job.detail ?? null,
        attempt: job.attempt,
        workspace_id: job.workspaceId ?? null,
        created_at: job.createdAt,
        updated_at: job.updatedAt,
      })),
  },
  {
    table: 'chat_messages',
    columns: ['id', 'object_id', 'role', 'text', 'claim_refs', 'card', 'created_at', 'seq'],
    primaryKey: ['id'],
    collection: (state) => state.chatByObject,
    rows: (state) => {
      // 全局 seq 重排保持在行构造器内（0056：两路共用）；seq 进 UPDATE 写集，不特判。
      const rows: PersistRow[] = [];
      let seq = 0;
      for (const [objectId, msgs] of Object.entries(state.chatByObject)) {
        for (const m of msgs) {
          seq += 1;
          rows.push({
            id: m.id,
            object_id: objectId,
            role: m.role,
            text: m.text,
            claim_refs: m.claimRefs ? JSON.stringify(m.claimRefs) : null,
            card: m.card ? JSON.stringify(m.card) : null,
            created_at: stateStamp(state),
            seq,
          });
        }
      }
      return rows;
    },
  },
];

function insertSql(table: PersistTable): string {
  const placeholders = table.columns.map(() => '?').join(', ');
  return `INSERT INTO ${table.table} (${table.columns.join(', ')}) VALUES (${placeholders})`;
}

function writeMeta(db: Database.Database, state: State): void {
  metaSet(db, 'seq', String(state.seq));
  metaSet(db, 'currentWorkspaceId', state.currentWorkspaceId);
  metaSet(db, 'themePreference', state.themePreference);
  metaSet(db, 'onboardingDone', state.onboardingDone ? '1' : '0');
}

function bindValues(table: PersistTable, row: PersistRow): PersistValue[] {
  return table.columns.map((column) => row[column] ?? null);
}

/** 把出荷状态全量写入大脑文件（0056：保留为修复与等价对照通道）。账本真相源是 SQLite，不是内存。 */
export function persistLedger(db: Database.Database, state: State): void {
  const tx = db.transaction(() => {
    db.exec(`
      DELETE FROM object_relations;
      DELETE FROM source_bindings;
      DELETE FROM chat_messages;
      DELETE FROM claims;
      DELETE FROM memories;
      DELETE FROM proposals;
      DELETE FROM write_queue;
      DELETE FROM tasks;
      DELETE FROM task_audit;
      DELETE FROM briefs;
      DELETE FROM ingest_jobs;
      DELETE FROM objects;
      DELETE FROM sources;
      DELETE FROM workspaces;
      DELETE FROM slot_defs;
    `);

    for (const table of PERSIST_TABLES) {
      const insert = db.prepare(insertSql(table));
      for (const row of table.rows(state)) {
        insert.run(...bindValues(table, row));
      }
    }

    writeMeta(db, state);
  });
  tx();
  rebuildFts(db);
}

/**
 * 按表差异写入（0056）。prev 必须是本次 dispatch 起点从库现读的快照：
 * 单写漏斗（dispatch → persist*）保证 diff(prev,next) ≡ diff(DB,next)。
 * 引用相同整表跳过；引用不等才按主键三分自愈——presets 种子的旧格式槽 id 与迁移外直写行
 * 会在首次触达该表时收敛为行构造器的规范形态。
 */
export function persistLedgerDiff(db: Database.Database, prev: State, next: State): void {
  const claimsDirty = prev.claims !== next.claims;
  const tx = db.transaction(() => {
    for (const table of PERSIST_TABLES) {
      if (table.collection(prev) === table.collection(next)) continue;
      syncTable(db, table, table.rows(next));
    }
    // 0056：app_meta 的 4 键 upsert 每 dispatch 照写，不在判脏射程。
    writeMeta(db, next);
    // 0056 约束三：FTS 只在 claims 脏时重建，首版全量 rebuildFts 并移入同一事务收窄崩溃窗口。
    if (claimsDirty) rebuildFts(db);
  });
  tx();
}

function rowKey(table: PersistTable, row: PersistRow): string {
  return JSON.stringify(table.primaryKey.map((column) => row[column] ?? null));
}

/** 行级主键三分（0056）：库有 next 无→DELETE；next 有库无→INSERT；两侧都有但脏→UPDATE。 */
function syncTable(db: Database.Database, table: PersistTable, wanted: PersistRow[]): void {
  const stored = db
    .prepare(`SELECT ${table.columns.join(', ')} FROM ${table.table}`)
    .all() as PersistRow[];
  const storedByKey = new Map<string, PersistRow>();
  for (const row of stored) {
    storedByKey.set(rowKey(table, row), row);
  }
  const wantedByKey = new Map<string, PersistRow>();
  for (const row of wanted) {
    wantedByKey.set(rowKey(table, row), row);
  }

  const keyWhere = table.primaryKey.map((column) => `${column} = ?`).join(' AND ');
  const del = db.prepare(`DELETE FROM ${table.table} WHERE ${keyWhere}`);
  for (const [key, row] of storedByKey) {
    if (wantedByKey.has(key)) continue;
    del.run(...table.primaryKey.map((column) => row[column] ?? null));
  }

  // 0056 约束一：created_at 语义是「首次落库时间」——UPDATE 写除它外的全部非主键列，
  // 脏判也必须忽略它，否则 stateStamp 会让每次触达都全表假脏。
  const dataColumns = table.columns.filter(
    (column) => column !== 'created_at' && !table.primaryKey.includes(column),
  );
  // 关联表（object_relations / source_bindings）主键即全部列，dataColumns 为空：同键行必等，
  // 只需补 INSERT，无 UPDATE 可言。
  const upd =
    dataColumns.length === 0
      ? null
      : db.prepare(
          `UPDATE ${table.table} SET ${dataColumns.map((column) => `${column} = ?`).join(', ')} WHERE ${keyWhere}`,
        );
  const ins = db.prepare(insertSql(table));
  for (const [key, row] of wantedByKey) {
    const existing = storedByKey.get(key);
    if (!existing) {
      ins.run(...bindValues(table, row));
      continue;
    }
    if (upd && dataColumns.some((column) => existing[column] !== row[column])) {
      upd.run(
        ...dataColumns.map((column) => row[column] ?? null),
        ...table.primaryKey.map((column) => row[column] ?? null),
      );
    }
  }
}

function rebuildFts(db: Database.Database): void {
  try {
    db.exec(`INSERT INTO claims_fts(claims_fts) VALUES('delete-all')`);
  } catch {
    db.exec(`DELETE FROM claims_fts`);
  }
  const count = db.prepare('SELECT COUNT(*) AS n FROM claims').get() as { n: number };
  if (count.n === 0) return;
  db.exec(
    `INSERT INTO claims_fts(rowid, text, object_id, predicate)
     SELECT rowid, text, object_id, predicate FROM claims`,
  );
}

export function appendOperation(
  db: Database.Database,
  action: string,
  payload: unknown,
  undoOf?: string | null,
): void {
  db.prepare(
    `INSERT INTO operations (id, action, payload, undo_of, chat_ref, created_at)
     VALUES (?, ?, ?, ?, NULL, ?)`,
  ).run(
    `op-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
    action,
    redactSecrets(payload),
    undoOf ?? null,
    new Date().toISOString(),
  );
}

// 与 redact.ts 不合并：这里是 operations 载荷的结构性脱敏（整字段清空，DELETE_SOURCE 恢复等
// 依赖 JSON 结构可解析回读），Bearer/sk- 文本掩码替代不了「apiKey 置空」；且 0040 要求密钥值
// 在落库前就不可还原，不能只盖展示层掩码。
function redactSecrets(payload: unknown): string {
  return JSON.stringify(payload).replace(/"apiKey"\s*:\s*"[^"]*"/g, '"apiKey":""');
}

export function listOperations(
  db: Database.Database,
): { action: string; undo_of: string | null }[] {
  return db.prepare('SELECT action, undo_of FROM operations ORDER BY created_at').all() as {
    action: string;
    undo_of: string | null;
  }[];
}

export function listDeletedSourceRecoveries(
  db: Database.Database,
  liveSources: Source[],
): DeletedSourceRecovery[] {
  const liveIds = new Set(
    liveSources.filter((source) => !source.virtual).map((source) => source.id),
  );
  const rows = db
    .prepare('SELECT payload FROM operations WHERE action = ? ORDER BY created_at')
    .all('DELETE_SOURCE') as { payload: string }[];
  const bySource = new Map<string, DeletedSourceRecovery>();
  for (const row of rows) {
    try {
      const recovery = recoveryFromPayload(JSON.parse(row.payload) as unknown);
      if (recovery && !liveIds.has(recovery.source.id)) bySource.set(recovery.source.id, recovery);
    } catch {
      // Older or corrupt operation payloads are ignored; they cannot safely drive recovery.
    }
  }
  return [...bySource.values()];
}

function recoveryFromPayload(payload: unknown): DeletedSourceRecovery | null {
  if (!payload || typeof payload !== 'object') return null;
  const recovery = (payload as { recovery?: unknown }).recovery;
  if (!recovery || typeof recovery !== 'object') return null;
  const source = (recovery as { source?: unknown }).source;
  const claims = (recovery as { claims?: unknown }).claims;
  const deletedAt = (recovery as { deletedAt?: unknown }).deletedAt;
  if (
    !source ||
    typeof source !== 'object' ||
    !Array.isArray(claims) ||
    typeof deletedAt !== 'string'
  ) {
    return null;
  }
  const candidate = source as Source;
  if (
    typeof candidate.id !== 'string' ||
    typeof candidate.title !== 'string' ||
    typeof candidate.body !== 'string' ||
    !Array.isArray(candidate.boundObjectIds)
  ) {
    return null;
  }
  return { source: candidate, claims: claims as Claim[], deletedAt };
}

function stateStamp(_state: State): string {
  return new Date().toISOString();
}

function parseJson<T>(value: string | null): T | undefined {
  if (!value) return undefined;
  try {
    return JSON.parse(value) as T;
  } catch {
    return undefined;
  }
}

export type LedgerRows = {
  workspaces: Workspace[];
  objects: DeskObject[];
  sources: Source[];
  ingestJobs: IngestJob[];
  slotDefs: SlotDef[];
  claims: Claim[];
  memories: Memory[];
  proposals: Proposal[];
  writeQueue: WriteProposal[];
  tasks: DeskTask[];
  taskAudits: TaskAudit[];
  briefs: Brief[];
  chatByObject: Record<string, ChatMessage[]>;
  seq: number;
  currentWorkspaceId: string;
  themePreference: State['themePreference'];
  activeProviderId: string;
  activeModelId: string;
  thinkingEffort: State['thinkingEffort'];
  onboardingDone: boolean;
  providersJson: string;
};

export function loadLedger(db: Database.Database): LedgerRows {
  const workspaces = (
    db.prepare('SELECT id, name, scenario FROM workspaces ORDER BY created_at').all() as {
      id: string;
      name: string;
      scenario: Workspace['scenario'];
    }[]
  ).map((w) => ({ id: w.id, name: w.name, scenario: w.scenario }));

  const rels = db.prepare('SELECT from_id, to_id FROM object_relations').all() as {
    from_id: string;
    to_id: string;
  }[];
  const relMap = new Map<string, string[]>();
  for (const r of rels) {
    const list = relMap.get(r.from_id) ?? [];
    list.push(r.to_id);
    relMap.set(r.from_id, list);
  }
  const objects = (
    db
      .prepare(
        'SELECT id, kind, name, note, workspace_id, archived FROM objects ORDER BY created_at',
      )
      .all() as {
      id: string;
      kind: DeskObject['kind'];
      name: string;
      note: string | null;
      workspace_id: string;
      archived: number;
    }[]
  ).map((o) => {
    const obj: DeskObject = {
      id: o.id,
      kind: o.kind,
      name: o.name,
      relationIds: relMap.get(o.id) ?? [],
      workspaceId: o.workspace_id ?? '',
    };
    if (o.note) obj.note = o.note;
    if (o.archived) obj.archived = true;
    return obj;
  });

  const binds = db.prepare('SELECT source_id, object_id FROM source_bindings').all() as {
    source_id: string;
    object_id: string;
  }[];
  const bindMap = new Map<string, string[]>();
  for (const b of binds) {
    const list = bindMap.get(b.source_id) ?? [];
    list.push(b.object_id);
    bindMap.set(b.source_id, list);
  }
  const sources = (
    db
      .prepare(
        `SELECT id, title, body, path, role, workspace_id, unparsed,
                origin_json, segments_json, content_hash, fetched_at
         FROM sources ORDER BY created_at`,
      )
      .all() as {
      id: string;
      title: string;
      body: string;
      path: Source['path'];
      role: Source['role'] | null;
      workspace_id: string | null;
      unparsed: number;
      origin_json: string | null;
      segments_json: string | null;
      content_hash: string | null;
      fetched_at: string | null;
    }[]
  ).map((s) => {
    const src: Source = {
      id: s.id,
      title: s.title,
      body: s.body,
      path: s.path,
      boundObjectIds: bindMap.get(s.id) ?? [],
    };
    if (s.role) src.role = s.role;
    if (s.workspace_id) src.workspaceId = s.workspace_id;
    if (s.unparsed) src.unparsed = true;
    const origin = parseJson<Source['origin']>(s.origin_json);
    const segments = parseJson<Source['segments']>(s.segments_json);
    if (origin) src.origin = origin;
    if (segments) src.segments = segments;
    if (s.content_hash) src.contentHash = s.content_hash;
    if (s.fetched_at) src.fetchedAt = s.fetched_at;
    return src;
  });

  const slotDefs = (
    db.prepare('SELECT name, kind, arity, scenarios FROM slot_defs ORDER BY id').all() as {
      name: string;
      kind: SlotDef['kind'];
      arity: SlotDef['arity'];
      scenarios: string;
    }[]
  ).map((s) => ({
    name: s.name,
    kind: s.kind,
    arity: s.arity,
    scenarios: JSON.parse(s.scenarios) as SlotDef['scenarios'],
  }));

  const claims = (
    db.prepare('SELECT * FROM claims ORDER BY created_at, id').all() as {
      id: string;
      object_id: string;
      predicate: string;
      text: string;
      status: Claim['status'];
      unverified: number;
      valid_from: string | null;
      valid_to: string | null;
      close_reason: Claim['closeReason'] | null;
      source_id: string;
      span: string | null;
      source_start: number | null;
      source_end: number | null;
      source_locator: string | null;
      superseded_by: string | null;
      created_at: string;
    }[]
  ).map((c) => {
    const claim: Claim = {
      id: c.id,
      objectId: c.object_id,
      predicate: c.predicate,
      text: c.text,
      status: c.status,
      unverified: c.unverified === 1,
      sourceId: c.source_id,
      createdAt: c.created_at,
    };
    if (c.valid_from) claim.validFrom = c.valid_from;
    if (c.valid_to) claim.validTo = c.valid_to;
    if (c.close_reason) claim.closeReason = c.close_reason;
    if (c.span) claim.span = c.span;
    if (typeof c.source_start === 'number') claim.sourceStart = c.source_start;
    if (typeof c.source_end === 'number') claim.sourceEnd = c.source_end;
    const locator = parseJson<Claim['sourceLocator']>(c.source_locator);
    if (locator) claim.sourceLocator = locator;
    if (c.superseded_by) claim.supersededBy = c.superseded_by;
    return claim;
  });

  const memories = (
    db.prepare('SELECT * FROM memories ORDER BY created_at').all() as {
      id: string;
      scope: Memory['scope'];
      object_id: string | null;
      kind: Memory['kind'];
      text: string;
      created_at: string;
      banned_object_id: string | null;
      banned_predicate: string | null;
      banned_value: string | null;
    }[]
  ).map((m) => {
    const mem: Memory = {
      id: m.id,
      scope: m.scope,
      kind: m.kind,
      text: m.text,
      createdAt: m.created_at,
    };
    if (m.object_id) mem.objectId = m.object_id;
    // 0054：历史禁写行结构化列为 NULL，读回即 undefined，原句路由 text 兜住。
    if (m.banned_object_id) mem.bannedObjectId = m.banned_object_id;
    if (m.banned_predicate) mem.bannedPredicate = m.banned_predicate;
    if (m.banned_value) mem.bannedValue = m.banned_value;
    return mem;
  });

  const proposals = (
    db.prepare('SELECT * FROM proposals ORDER BY created_at').all() as {
      id: string;
      type: Proposal['type'];
      payload: string;
      pending: number;
      decision: Proposal['decision'] | null;
      title: string;
      detail: string;
    }[]
  ).map((p) => {
    const prop: Proposal = {
      id: p.id,
      type: p.type,
      title: p.title,
      detail: p.detail,
      payload: JSON.parse(p.payload) as Proposal['payload'],
      pending: p.pending === 1,
    };
    if (p.decision) prop.decision = p.decision;
    return prop;
  });

  const writeQueue = (
    db
      .prepare(
        `SELECT id, object_id, kind, task_id, headline, evidence, claim_id, claim_ids,
                source_id, object_ids, target_predicate, outbound
         FROM write_queue ORDER BY position, created_at, id`,
      )
      .all() as {
      id: string;
      object_id: string;
      kind: WriteProposal['kind'];
      task_id: string | null;
      headline: string;
      evidence: string;
      claim_id: string | null;
      claim_ids: string | null;
      source_id: string | null;
      object_ids: string | null;
      target_predicate: string | null;
      outbound: number | null;
    }[]
  ).map((row) => {
    const write: WriteProposal = {
      id: row.id,
      objectId: row.object_id,
      kind: row.kind,
      headline: row.headline,
      evidence: row.evidence,
    };
    if (row.task_id) write.taskId = row.task_id;
    if (row.claim_id) write.claimId = row.claim_id;
    const claimIds = parseJson<string[]>(row.claim_ids);
    if (claimIds) write.claimIds = claimIds;
    if (row.source_id) write.sourceId = row.source_id;
    const objectIds = parseJson<string[]>(row.object_ids);
    if (objectIds) write.objectIds = objectIds;
    if (row.target_predicate) write.targetPredicate = row.target_predicate;
    if (typeof row.outbound === 'number') write.outbound = row.outbound === 1;
    return write;
  });

  const tasks = (
    db.prepare('SELECT * FROM tasks ORDER BY created_at').all() as {
      id: string;
      object_id: string;
      kind: DeskTask['kind'];
      status: DeskTask['status'];
      stop_reason: DeskTask['stopReason'] | null;
      budget_gear: DeskTask['budgetGear'] | null;
      query: string | null;
      interval_days: number | null;
      next_due_at: string | null;
      last_run_at: string | null;
      parent_task_id: string | null;
      due_at: string | null;
      created_at: string;
    }[]
  ).map((t) => {
    const task: DeskTask = {
      id: t.id,
      objectId: t.object_id,
      kind: t.kind,
      status: t.status,
      createdAt: t.created_at,
    };
    if (t.stop_reason) task.stopReason = t.stop_reason;
    if (t.budget_gear) task.budgetGear = t.budget_gear;
    if (t.query) task.query = t.query;
    if (typeof t.interval_days === 'number') task.intervalDays = t.interval_days;
    if (t.next_due_at) task.nextDueAt = t.next_due_at;
    if (t.last_run_at) task.lastRunAt = t.last_run_at;
    if (t.parent_task_id) task.parentTaskId = t.parent_task_id;
    if (t.due_at) task.dueAt = t.due_at;
    return task;
  });

  const taskAudits = (
    db.prepare('SELECT task_id, seq, kind, payload, ts FROM task_audit ORDER BY ts, seq').all() as {
      task_id: string;
      seq: number;
      kind: string;
      payload: string;
      ts: string;
    }[]
  ).map((a) => ({
    taskId: a.task_id,
    seq: a.seq,
    kind: a.kind,
    payload: JSON.parse(a.payload) as unknown,
    ts: a.ts,
  }));

  const briefs = (
    db.prepare('SELECT * FROM briefs ORDER BY created_at').all() as {
      id: string;
      object_id: string;
      task_id: string;
      blocks: string;
      created_at: string;
    }[]
  ).map((b) => ({
    id: b.id,
    objectId: b.object_id,
    taskId: b.task_id,
    createdAt: b.created_at,
    blocks: JSON.parse(b.blocks) as Brief['blocks'],
  }));

  const ingestJobs = (
    db
      .prepare(
        `SELECT id, input_kind, input_json, status, title, locator, source_id,
                failure_kind, detail, attempt, workspace_id, created_at, updated_at
         FROM ingest_jobs ORDER BY created_at, id`,
      )
      .all() as {
      id: string;
      input_kind: IngestJob['inputKind'];
      input_json: string | null;
      status: IngestJob['status'];
      title: string | null;
      locator: string | null;
      source_id: string | null;
      failure_kind: IngestJob['failureKind'] | null;
      detail: string | null;
      attempt: number;
      workspace_id: string | null;
      created_at: string;
      updated_at: string;
    }[]
  ).map((row) => {
    const job: IngestJob = {
      id: row.id,
      inputKind: row.input_kind,
      status: row.status,
      attempt: row.attempt,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
    const input = parseJson<IngestJob['input']>(row.input_json);
    if (input) job.input = input;
    if (row.title) job.title = row.title;
    if (row.locator) job.locator = row.locator;
    if (row.source_id) job.sourceId = row.source_id;
    if (row.failure_kind) job.failureKind = row.failure_kind;
    if (row.detail) job.detail = row.detail;
    if (row.workspace_id) job.workspaceId = row.workspace_id;
    return job;
  });

  const msgs = db
    .prepare(
      'SELECT id, object_id, role, text, claim_refs, card FROM chat_messages ORDER BY seq, created_at',
    )
    .all() as {
    id: string;
    object_id: string;
    role: ChatMessage['role'];
    text: string;
    claim_refs: string | null;
    card: string | null;
  }[];
  const chatByObject: Record<string, ChatMessage[]> = {};
  for (const m of msgs) {
    const msg: ChatMessage = { id: m.id, role: m.role, text: m.text };
    if (m.claim_refs) msg.claimRefs = JSON.parse(m.claim_refs) as string[];
    if (m.card) msg.card = JSON.parse(m.card) as ChatMessage['card'];
    const list = chatByObject[m.object_id] ?? [];
    list.push(msg);
    chatByObject[m.object_id] = list;
  }

  const meta = new Map(
    (db.prepare('SELECT key, value FROM app_meta').all() as { key: string; value: string }[]).map(
      (r) => [r.key, r.value],
    ),
  );

  return {
    workspaces,
    objects,
    sources,
    ingestJobs,
    slotDefs,
    claims,
    memories,
    proposals,
    writeQueue,
    tasks,
    taskAudits,
    briefs,
    chatByObject,
    seq: Number(meta.get('seq') ?? '1') || 1,
    currentWorkspaceId: meta.get('currentWorkspaceId') ?? workspaces[0]?.id ?? '',
    themePreference:
      (meta.get('themePreference') as State['themePreference'] | undefined) ?? 'system',
    activeProviderId: meta.get('activeProviderId') ?? '',
    activeModelId: meta.get('activeModelId') ?? '',
    thinkingEffort: (meta.get('thinkingEffort') as State['thinkingEffort'] | undefined) ?? '中',
    onboardingDone: meta.get('onboardingDone') === '1',
    providersJson: meta.get('providers') ?? '',
  };
}

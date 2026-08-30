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

/** 模型配置已经提升为产品级设置；迁移完成后移除业务库中的旧副本。 */
export function clearLegacyModelMeta(db: Database.Database): void {
  const remove = db.prepare('DELETE FROM app_meta WHERE key = ?');
  db.transaction(() => {
    for (const key of LEGACY_MODEL_META_KEYS) remove.run(key);
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

/** 把出荷状态写入大脑文件。账本真相源是 SQLite，不是内存。 */
export function persistLedger(db: Database.Database, state: State): void {
  const tx = db.transaction(() => {
    db.exec(`
      DELETE FROM object_relations;
      DELETE FROM source_bindings;
      DELETE FROM chat_messages;
      DELETE FROM claims;
      DELETE FROM memories;
      DELETE FROM proposals;
      DELETE FROM tasks;
      DELETE FROM task_audit;
      DELETE FROM briefs;
      DELETE FROM ingest_jobs;
      DELETE FROM objects;
      DELETE FROM sources;
      DELETE FROM workspaces;
      DELETE FROM slot_defs;
    `);

    const insWs = db.prepare(
      `INSERT INTO workspaces (id, name, scenario, created_at) VALUES (?, ?, ?, ?)`,
    );
    for (const w of state.workspaces) {
      insWs.run(w.id, w.name, w.scenario, stateStamp(state));
    }

    const insObj = db.prepare(
      `INSERT INTO objects (id, kind, name, note, workspace_id, archived, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    const insRel = db.prepare(`INSERT INTO object_relations (from_id, to_id) VALUES (?, ?)`);
    for (const o of state.objects) {
      insObj.run(
        o.id,
        o.kind,
        o.name,
        o.note ?? null,
        o.workspaceId,
        o.archived ? 1 : 0,
        stateStamp(state),
      );
      for (const to of o.relationIds) {
        insRel.run(o.id, to);
      }
    }

    const insSrc = db.prepare(
      `INSERT INTO sources (
        id, title, body, path, role, workspace_id, unparsed,
        origin_json, segments_json, content_hash, fetched_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insBind = db.prepare(`INSERT INTO source_bindings (source_id, object_id) VALUES (?, ?)`);
    for (const s of state.sources) {
      if (s.virtual || s.id === 'user-stmt') continue;
      insSrc.run(
        s.id,
        s.title,
        s.body,
        s.path,
        s.role ?? null,
        s.workspaceId ?? null,
        s.unparsed ? 1 : 0,
        s.origin ? JSON.stringify(s.origin) : null,
        s.segments ? JSON.stringify(s.segments) : null,
        s.contentHash ?? s.origin?.contentHash ?? null,
        s.fetchedAt ?? s.origin?.fetchedAt ?? null,
        stateStamp(state),
      );
      for (const oid of s.boundObjectIds) {
        insBind.run(s.id, oid);
      }
    }

    const insSlot = db.prepare(
      `INSERT INTO slot_defs (id, name, kind, arity, scenarios, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    state.slotDefs.forEach((slot, i) => {
      insSlot.run(
        `slot-${String(i + 1).padStart(3, '0')}-${slot.kind}`,
        slot.name,
        slot.kind,
        slot.arity,
        JSON.stringify(slot.scenarios),
        stateStamp(state),
      );
    });

    const insClaim = db.prepare(
      `INSERT INTO claims (
        id, object_id, predicate, text, status, unverified, valid_from, valid_to,
        close_reason, source_id, span, source_start, source_end, source_locator,
        superseded_by, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const c of state.claims) {
      insClaim.run(
        c.id,
        c.objectId,
        c.predicate,
        c.text,
        c.status,
        c.unverified ? 1 : 0,
        c.validFrom ?? null,
        c.validTo ?? null,
        c.closeReason ?? null,
        c.sourceId,
        c.span ?? null,
        c.sourceStart ?? null,
        c.sourceEnd ?? null,
        c.sourceLocator ? JSON.stringify(c.sourceLocator) : null,
        c.supersededBy ?? null,
        c.createdAt,
      );
    }

    const insMem = db.prepare(
      `INSERT INTO memories (id, scope, object_id, kind, text, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    for (const m of state.memories) {
      insMem.run(m.id, m.scope, m.objectId ?? null, m.kind, m.text, m.createdAt);
    }

    const insProp = db.prepare(
      `INSERT INTO proposals (id, type, payload, pending, decision, created_at, title, detail)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const p of state.proposals) {
      insProp.run(
        p.id,
        p.type,
        JSON.stringify(p.payload),
        p.pending ? 1 : 0,
        p.decision ?? null,
        stateStamp(state),
        p.title,
        p.detail,
      );
    }

    const insTask = db.prepare(
      `INSERT INTO tasks (
        id, object_id, kind, status, stop_reason, budget_gear, query, interval_days,
        next_due_at, last_run_at, parent_task_id, due_at, created_at, finished_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const t of state.tasks) {
      insTask.run(
        t.id,
        t.objectId,
        t.kind,
        t.status,
        t.stopReason ?? null,
        t.budgetGear ?? null,
        t.query ?? null,
        t.intervalDays ?? null,
        t.nextDueAt ?? null,
        t.lastRunAt ?? null,
        t.parentTaskId ?? null,
        t.dueAt ?? null,
        t.createdAt,
        t.status === '已完成' || t.status === '已停止' ? t.createdAt : null,
      );
    }

    const insAudit = db.prepare(
      `INSERT INTO task_audit (task_id, seq, kind, payload, ts) VALUES (?, ?, ?, ?, ?)`,
    );
    for (const a of state.taskAudits ?? []) {
      insAudit.run(a.taskId, a.seq, a.kind, JSON.stringify(a.payload), a.ts);
    }

    const insBrief = db.prepare(
      `INSERT INTO briefs (id, object_id, task_id, blocks, created_at) VALUES (?, ?, ?, ?, ?)`,
    );
    for (const b of state.briefs) {
      insBrief.run(b.id, b.objectId, b.taskId, JSON.stringify(b.blocks), b.createdAt);
    }

    const insIngest = db.prepare(
      `INSERT INTO ingest_jobs (
        id, input_kind, input_json, status, title, locator, source_id,
        failure_kind, detail, attempt, workspace_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const job of state.ingestJobs) {
      insIngest.run(
        job.id,
        job.inputKind,
        job.input ? JSON.stringify(job.input) : null,
        job.status,
        job.title ?? null,
        job.locator ?? null,
        job.sourceId ?? null,
        job.failureKind ?? null,
        job.detail ?? null,
        job.attempt,
        job.workspaceId ?? null,
        job.createdAt,
        job.updatedAt,
      );
    }

    const insMsg = db.prepare(
      `INSERT INTO chat_messages (id, object_id, role, text, claim_refs, card, created_at, seq)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    let seq = 0;
    for (const [objectId, msgs] of Object.entries(state.chatByObject)) {
      for (const m of msgs) {
        seq += 1;
        insMsg.run(
          m.id,
          objectId,
          m.role,
          m.text,
          m.claimRefs ? JSON.stringify(m.claimRefs) : null,
          m.card ? JSON.stringify(m.card) : null,
          stateStamp(state),
          seq,
        );
      }
    }

    metaSet(db, 'seq', String(state.seq));
    metaSet(db, 'currentWorkspaceId', state.currentWorkspaceId);
    metaSet(db, 'themePreference', state.themePreference);
    metaSet(db, 'onboardingDone', state.onboardingDone ? '1' : '0');
  });
  tx();
  rebuildFts(db);
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

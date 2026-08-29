import type Database from 'better-sqlite3';
import type {
  Brief,
  ChatMessage,
  Claim,
  DeskObject,
  DeskTask,
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
      insObj.run(o.id, o.kind, o.name, o.note ?? null, o.workspaceId, o.archived ? 1 : 0, stateStamp(state));
      for (const to of o.relationIds) {
        insRel.run(o.id, to);
      }
    }

    const insSrc = db.prepare(
      `INSERT INTO sources (id, title, body, path, role, workspace_id, unparsed, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
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
        close_reason, source_id, span, superseded_by, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      `INSERT INTO tasks (id, object_id, kind, status, stop_reason, budget_gear, created_at, finished_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const t of state.tasks) {
      insTask.run(
        t.id,
        t.objectId,
        t.kind,
        t.status,
        t.stopReason ?? null,
        t.budgetGear ?? null,
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
    metaSet(db, 'activeProviderId', state.activeProviderId);
    metaSet(db, 'activeModelId', state.activeModelId);
    metaSet(db, 'thinkingEffort', state.thinkingEffort);
    metaSet(db, 'onboardingDone', state.onboardingDone ? '1' : '0');
    metaSet(
      db,
      'providers',
      JSON.stringify(
        state.providers.map((p) => ({
          ...p,
          apiKey: '',
        })),
      ),
    );
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

export function listOperations(db: Database.Database): { action: string; undo_of: string | null }[] {
  return db
    .prepare('SELECT action, undo_of FROM operations ORDER BY created_at')
    .all() as { action: string; undo_of: string | null }[];
}

function stateStamp(_state: State): string {
  return new Date().toISOString();
}

export type LedgerRows = {
  workspaces: Workspace[];
  objects: DeskObject[];
  sources: Source[];
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
      .prepare('SELECT id, kind, name, note, workspace_id, archived FROM objects ORDER BY created_at')
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
        'SELECT id, title, body, path, role, workspace_id, unparsed FROM sources ORDER BY created_at',
      )
      .all() as {
      id: string;
      title: string;
      body: string;
      path: Source['path'];
      role: Source['role'] | null;
      workspace_id: string | null;
      unparsed: number;
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
    themePreference: (meta.get('themePreference') as State['themePreference'] | undefined) ?? 'system',
    activeProviderId: meta.get('activeProviderId') ?? 'p-deepseek',
    activeModelId: meta.get('activeModelId') ?? 'deepseek-chat',
    thinkingEffort: (meta.get('thinkingEffort') as State['thinkingEffort'] | undefined) ?? '中',
    onboardingDone: meta.get('onboardingDone') === '1',
    providersJson: meta.get('providers') ?? '',
  };
}

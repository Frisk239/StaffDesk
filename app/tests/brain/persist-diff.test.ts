import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type Database from 'better-sqlite3';
import type { Action } from '../../src/shared/actions';
import type { DeskTask, Source } from '../../src/shared/types';
import { openBrain, type Brain } from '../../src/main/brain';
import {
  loadLedger,
  listOperations,
  takeSyncTableStats,
  type LedgerRows,
} from '../../src/main/brain/persist';
import { searchClaimsFts } from '../../src/main/brain/fts';
import { completeExtraction } from '../helpers/extraction';

// 0056 验收核心：同一动作剧本在冻结时钟下分别灌「全量重写库」与「按脏表差异写入库」，
// 断言两库账本逐字段深相等、操作日志序列相等、FTS 语义相等，并钉死 diff 路径的写量趋零。

// 抽取的 claim id 走 draftsToClaims → randomUUID；冻结时钟只锁时间戳，锁不住随机数。
// 用可重放的计数器替换 randomUUID，配合 extractBoth 的「回卷」让两颗 Brain 消费同一段 id，
// 既保证跨库逐位相等，又保证跨多次抽取全局唯一（否则主键碰撞）。
const uuid = vi.hoisted(() => ({ n: 0 }));
vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  return {
    ...actual,
    default: actual,
    randomUUID: () => `mock-uuid-${uuid.n++}`,
  };
});

const dirs: string[] = [];
const brains: Brain[] = [];

function track(brain: Brain): Brain {
  brains.push(brain);
  return brain;
}

function brainFile(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'sd-pdiff-'));
  dirs.push(dir);
  return join(dir, name);
}

beforeEach(() => {
  // 只冻结 Date：stateStamp、域时间戳、op id 时间部分在两条路径下逐位相等。
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-08-25T08:00:00.000Z'));
});

afterEach(() => {
  while (brains.length) {
    try {
      brains.pop()?.close();
    } catch {
      /* 已关闭 */
    }
  }
  for (const dir of dirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* 文件锁 */
    }
  }
  vi.useRealTimers();
});

function openPair(): { full: Brain; diff: Brain } {
  const full = track(
    openBrain(brainFile('full.db'), undefined, undefined, undefined, { persistMode: 'full' }),
  );
  const diff = track(openBrain(brainFile('diff.db')));
  expect(diff.persistMode).toBe('diff');
  return { full, diff };
}

interface ScriptHandles {
  objId: string;
  jdId: string;
  sourceAId: string;
}

function researchSource(task: DeskTask, workspaceId: string, index: number, body: string): Source {
  const id = `src-res-${task.id}-${index}`;
  return {
    id,
    title: `调研来源 ${index}`,
    body,
    path: '调研',
    boundObjectIds: [task.objectId],
    workspaceId,
    origin: {
      kind: 'research',
      taskId: task.id,
      locator: `https://example.test/${index}`,
      finalUrl: `https://example.test/${index}`,
      contentHash: `hash-${index}`,
      fetchedAt: '2026-08-25T08:30:00.000Z',
    },
    segments: [{ id: 'body', start: 0, end: body.length, label: `调研来源 ${index}` }],
    contentHash: `hash-${index}`,
    fetchedAt: '2026-08-25T08:30:00.000Z',
  };
}

/** 两颗 Brain 交替吃同一动作：冻结时钟保证两条路径的派生 id、时间戳逐位一致。 */
function playScript(full: Brain, diff: Brain): ScriptHandles {
  const act = (action: Action): void => {
    full.dispatch(action);
    diff.dispatch(action);
  };
  const snap = () => full.snapshot();
  const must = <T>(value: T | undefined, what: string): T => {
    if (value === undefined) throw new Error(`动作剧本走不通：缺少${what}`);
    return value;
  };
  const extractBoth = (
    sourceId: string,
    drafts: { predicate: string; text: string; span: string }[],
  ): void => {
    // 两颗 Brain 从同一段 mock uuid 消费：full 跑完回卷计数器再跑 diff，id 逐位相等；
    // 计数器不回零，跨多次抽取的全局唯一性仍成立。
    const before = uuid.n;
    completeExtraction(full, sourceId, drafts);
    uuid.n = before;
    completeExtraction(diff, sourceId, drafts);
  };
  const chatOf = (objectId: string) => snap().chatByObject[objectId] ?? [];

  // ── 手给材料：建区、建对象、绑定、抽取（含单值槽冲突与未编目） ──
  act({ type: 'ADD_WORKSPACE', name: '区甲', scenario: '求职面试' });
  act({ type: 'ADD_OBJECT', kind: '组织', name: '甲组织' });
  const obj = must(snap().objects[0], '甲组织');
  act({
    type: 'ADD_SOURCE',
    title: 'JD',
    body: '该公司在招后端实习。团队主栈是 Go。团队也在评估 Java 方向。内部在推进平台化建设。',
  });
  const jd = must(
    snap().sources.find((s) => !s.virtual),
    'JD 来源',
  );
  act({ type: 'BIND_CONFIRMED', sourceId: jd.id, objectIds: [obj.id] });
  extractBoth(jd.id, [
    { predicate: '在招岗位', text: '该公司在招后端实习', span: '该公司在招后端实习' },
    { predicate: '后端主栈', text: '团队主栈是 Go', span: '团队主栈是 Go' },
    { predicate: '后端主栈', text: '团队也在评估 Java 方向', span: '团队也在评估 Java 方向' },
    { predicate: '未编目', text: '内部在推进平台化建设', span: '内部在推进平台化建设' },
  ]);
  const firstClaim = must(
    snap().claims.find((c) => c.predicate === '在招岗位'),
    '在招岗位主张',
  );
  expect(snap().claims.length).toBeGreaterThanOrEqual(4);

  // ── 建槽（触发 slot_defs 自愈收敛）+ 卡片 UI 读操作 ──
  vi.advanceTimersByTime(20 * 60_000);
  act({ type: 'ADD_SLOT', name: '自定义槽', kind: '组织', arity: '单值' });
  act({ type: 'ADD_SLOT', name: '', kind: '组织', arity: '单值' });
  act({ type: 'ADD_SLOT', name: '未编目', kind: '组织', arity: '单值' });
  act({ type: 'ADD_SLOT', name: '自定义槽', kind: '组织', arity: '单值' });
  act({ type: 'OPEN_AUDIT_CARD', claimId: firstClaim.id });
  act({ type: 'SELECT_CLAIM', claimId: firstClaim.id });
  act({ type: 'FOCUS_SOURCE', sourceId: jd.id });
  act({ type: 'OPEN_RIGHT_TAB', objectId: obj.id, kind: '档案' });
  act({ type: 'OPEN_RIGHT_TAB', objectId: obj.id, kind: '来源' });
  const tab = snap().rightTabsByObject[obj.id]?.[0];
  if (tab) {
    act({ type: 'FOCUS_RIGHT_TAB', objectId: obj.id, id: tab.id });
    act({ type: 'CLOSE_RIGHT_TAB', objectId: obj.id, id: tab.id });
  }

  // ── 晋升→撤销→晋升→纠正（旧主张关窗 + 新主张 + 禁写记忆）→移除禁写 ──
  vi.advanceTimersByTime(15 * 60_000);
  act({ type: 'PROMOTE_CLAIM', claimId: firstClaim.id });
  const promoteCard = must(
    chatOf(obj.id).find((m) => m.card?.result === '晋升' && m.card.undo),
    '晋升撤销卡',
  );
  act({ type: 'UNDO_RESULT', objectId: obj.id, messageId: promoteCard.id });
  expect(
    must(
      snap().claims.find((c) => c.id === firstClaim.id),
      '原主张',
    ).unverified,
  ).toBe(true);
  act({ type: 'PROMOTE_CLAIM', claimId: firstClaim.id });
  act({ type: 'OPEN_CORRECT_CARD', claimId: firstClaim.id });
  const correctWrite = must(
    snap().writeQueue.find((w) => w.kind === '纠正'),
    '纠正提议',
  );
  act({
    type: 'CONFIRM_WRITE',
    writeId: correctWrite.id,
    closeReason: '从未成立',
    newText: '主栈其实是 Rust。',
  });
  expect(
    must(
      snap().claims.find((c) => c.id === firstClaim.id),
      '原主张',
    ).status,
  ).toBe('过时');
  const banMemory = must(
    snap().memories.find((m) => m.kind === '禁写'),
    '禁写记忆',
  );
  act({ type: 'REMOVE_MEMORY', id: banMemory.id });

  // ── 会话（含 turn 字段——不落库的 UI 状态）+ 简报 ──
  vi.advanceTimersByTime(10 * 60_000);
  act({ type: 'CHAT_SEND', objectId: obj.id, text: '记下来：简报用条目' });
  act({ type: 'CHAT_SEND', objectId: obj.id, text: '这句不对' });
  act({ type: 'GENERATE_BRIEF_START', objectId: obj.id });
  act({ type: 'GENERATE_BRIEF_DONE' });
  expect(snap().briefs.length).toBeGreaterThan(0);

  // ── 调研：任务 + 审计 + 两条来源，逐条绑定抽取，任务末批量晋升→撤销→批量回退 ──
  vi.advanceTimersByTime(30 * 60_000);
  const task: DeskTask = {
    id: 'task-pdiff-review',
    objectId: obj.id,
    kind: '调研',
    status: '已完成',
    createdAt: '2026-08-25 08:00',
    budgetGear: '快搜',
    query: '甲组织 官方',
  };
  const sourceA = researchSource(task, obj.workspaceId, 1, '官网称甲组织在做数据平台。');
  const sourceB = researchSource(task, obj.workspaceId, 2, '招聘页称后端主栈是 Rust。');
  act({
    type: 'APPLY_RESEARCH',
    task,
    audits: [
      {
        taskId: task.id,
        seq: 1,
        kind: '打开',
        payload: { url: 'https://example.test/a' },
        ts: '2026-08-25T08:30:01.000Z',
      },
    ],
    sources: [sourceA, sourceB],
  });
  act({ type: 'BIND_CONFIRMED', sourceId: sourceA.id, objectIds: [obj.id] });
  extractBoth(sourceA.id, [
    { predicate: '主营业务', text: '甲组织在做数据平台', span: '甲组织在做数据平台' },
  ]);
  act({ type: 'BIND_CONFIRMED', sourceId: sourceB.id, objectIds: [obj.id] });
  extractBoth(sourceB.id, [
    { predicate: '后端主栈', text: '后端主栈是 Rust', span: '后端主栈是 Rust' },
  ]);
  const batch = must(
    snap().writeQueue.find((w) => w.kind === '批量晋升' && w.taskId === task.id),
    '任务末批量晋升',
  );
  act({ type: 'CONFIRM_WRITE', writeId: batch.id });
  const batchCard = must(
    chatOf(obj.id).find((m) => m.card?.result === '批量晋升' && m.card.undo),
    '批量晋升撤销卡',
  );
  act({ type: 'UNDO_RESULT', objectId: obj.id, messageId: batchCard.id });
  const rollback = must(
    snap().writeQueue.find((w) => w.kind === '批量回退'),
    '批量回退提议',
  );
  act({ type: 'CONFIRM_WRITE', writeId: rollback.id });

  // ── 写队列头部/中段移除：position 必须跟随数组下标重排（0056 约束一例外） ──
  vi.advanceTimersByTime(20 * 60_000);
  const live = snap().claims.filter((c) => c.status === '成立' && c.unverified);
  expect(live.length).toBeGreaterThanOrEqual(2);
  const enqueue = (claimId: string | undefined, headline: string) =>
    act({
      type: 'ENQUEUE_WRITE',
      draft: {
        objectId: obj.id,
        kind: '晋升',
        ...(claimId ? { claimId } : {}),
        headline,
        evidence: headline,
      },
    });
  enqueue(live[0]?.id, '队首晋升');
  enqueue(undefined, '占位空晋升');
  enqueue(live[1]?.id, '队中晋升');
  const queue = snap().writeQueue;
  act({ type: 'REJECT_WRITE', writeId: must(queue[1], '队中提议').id });
  act({ type: 'CONFIRM_WRITE', writeId: must(queue[0], '队首提议').id });

  // ── 来源解绑 → 删除（withRecoveryPayload 深拷贝）→ 恢复 ──
  vi.advanceTimersByTime(15 * 60_000);
  act({ type: 'UNBIND_SOURCE', sourceId: sourceB.id, objectId: obj.id });
  act({ type: 'DELETE_SOURCE', sourceId: sourceA.id });
  const recovery = must(
    snap().deletedSourceRecoveries.find((r) => r.source.id === sourceA.id),
    '来源恢复快照',
  );
  act({ type: 'RESTORE_DELETED_SOURCE', recovery });

  // ── 任务在跑审计：幂等追加 + 手动停止不被最终写回覆盖（对照 actions.test 敏感时序） ──
  vi.advanceTimersByTime(10 * 60_000);
  const liveTask: DeskTask = {
    id: 'task-pdiff-live',
    objectId: obj.id,
    kind: '调研',
    status: '进行中',
    createdAt: '2026-08-25 09:00',
    budgetGear: '快搜',
    query: '甲组织 官方',
  };
  const searchAudit = {
    taskId: liveTask.id,
    seq: 1,
    kind: '搜索',
    payload: { query: liveTask.query },
    ts: '2026-08-25T09:00:01.000Z',
  };
  const stopAudit = {
    taskId: liveTask.id,
    seq: 2,
    kind: '停止',
    payload: { reason: '手动', opened: 0, failed: 0 },
    ts: '2026-08-25T09:00:02.000Z',
  };
  act({ type: 'TASK_RUN_STARTED', task: liveTask });
  act({ type: 'TASK_AUDIT_APPENDED', taskId: liveTask.id, audits: [searchAudit] });
  act({ type: 'TASK_AUDIT_APPENDED', taskId: liveTask.id, audits: [searchAudit] });
  act({ type: 'TASK_STOP_REQUESTED', taskId: liveTask.id });
  act({ type: 'TASK_AUDIT_APPENDED', taskId: liveTask.id, audits: [searchAudit, stopAudit] });
  act({ type: 'SET_VIEW', view: { kind: 'replay', taskId: liveTask.id } });
  act({
    type: 'APPLY_RESEARCH',
    task: { ...liveTask, status: '已完成' },
    audits: [searchAudit, stopAudit],
    sources: [],
  });
  const savedTask = must(
    snap().tasks.find((t) => t.id === liveTask.id),
    '在跑任务',
  );
  expect(savedTask.status).toBe('已停止');
  expect(savedTask.stopReason).toBe('手动');

  // ── 对象/工作区生命周期 ──
  vi.advanceTimersByTime(20 * 60_000);
  act({ type: 'ADD_WORKSPACE', name: '区乙', scenario: '技术选型' });
  const wsB = must(
    snap().workspaces.find((w) => w.name === '区乙'),
    '区乙',
  );
  act({ type: 'SWITCH_WORKSPACE', id: wsB.id });
  act({ type: 'ADD_OBJECT', kind: '项目', name: '选型项目' });
  const proj = must(
    snap().objects.find((o) => o.name === '选型项目'),
    '选型项目',
  );
  act({ type: 'ARCHIVE_OBJECT', id: proj.id });
  act({ type: 'UNARCHIVE_OBJECT', id: proj.id });
  act({ type: 'ARCHIVE_OBJECT', id: proj.id });
  act({ type: 'DELETE_OBJECT', id: proj.id });
  expect(snap().objects.some((o) => o.id === proj.id)).toBe(false);
  act({ type: 'ADD_OBJECT', kind: '人', name: '联系人' });
  const person = must(
    snap().objects.find((o) => o.name === '联系人'),
    '联系人',
  );
  act({ type: 'ARCHIVE_OBJECT', id: person.id });
  act({ type: 'RESTORE_OBJECT', id: person.id });
  act({ type: 'SWITCH_WORKSPACE', id: obj.workspaceId });
  act({ type: 'REMOVE_WORKSPACE', id: wsB.id });

  // ── 导入作业 → 真实来源；雷达任务 + 迟跑一轮 ──
  vi.advanceTimersByTime(15 * 60_000);
  act({
    type: 'INGEST_STARTED',
    job: {
      id: 'ing-pdiff-1',
      inputKind: 'url',
      status: '获取中',
      locator: 'https://example.test/p',
      attempt: 1,
      createdAt: '2026-08-25T09:30:00.000Z',
      updatedAt: '2026-08-25T09:30:00.000Z',
    },
  });
  act({
    type: 'INGEST_SUCCEEDED',
    jobId: 'ing-pdiff-1',
    title: '导入件',
    body: '办公地点在杭州。',
    origin: {
      kind: 'url',
      locator: 'https://example.test/p',
      finalUrl: 'https://example.test/p',
      contentHash: 'hash-ing-pdiff',
      fetchedAt: '2026-08-25T09:30:01.000Z',
    },
    segments: [{ id: 'body', start: 0, end: 8, label: '全文' }],
    contentHash: 'hash-ing-pdiff',
  });
  act({ type: 'CREATE_RADAR', objectId: obj.id, query: '甲组织 官方' });
  const radar = must(
    snap().tasks.find((t) => t.kind === '周期性雷达'),
    '雷达任务',
  );
  const runAt = must(radar.nextDueAt, '雷达下次到期');
  act({
    type: 'APPLY_RESEARCH',
    task: {
      id: 'task-pdiff-radar-run',
      objectId: obj.id,
      kind: '再搜一轮',
      status: '已完成',
      createdAt: runAt,
      budgetGear: '快搜',
      parentTaskId: radar.id,
      dueAt: runAt,
      query: radar.query,
    },
    audits: [
      {
        taskId: 'task-pdiff-radar-run',
        seq: 1,
        kind: '迟跑',
        payload: { parentTaskId: radar.id },
        ts: '2026-08-25T10:00:00.000Z',
      },
    ],
    sources: [],
  });

  // ── 0057/0058 槽编辑与场景模板 CRUD：新表 scenario_templates 与新动作进等价射程 ──
  // 模板新建→改名（previousName）→删槽级联撤简报块；槽改名/切值/场景标记/删除全走 reducer 级联。
  vi.advanceTimersByTime(10 * 60_000);
  act({
    type: 'UPSERT_SCENARIO_TEMPLATE',
    template: {
      name: '尽调跟踪',
      builtin: false,
      hint: '盯一个标的',
      playbook: '出站纪律：只根据账本里已有主张回答。',
      briefSpec: [
        { title: '关键事实', kind: 'background' },
        { title: '标的信号', kind: 'slots', predicates: ['自定义槽'] },
      ],
    },
  });
  act({
    type: 'UPSERT_SCENARIO_TEMPLATE',
    template: {
      name: '尽调深挖',
      builtin: false,
      hint: '盯一个标的并盯供应链',
      playbook: '出站纪律：只根据账本里已有主张回答。',
      briefSpec: [
        { title: '关键事实', kind: 'background' },
        { title: '标的信号', kind: 'slots', predicates: ['自定义槽'] },
      ],
    },
    previousName: '尽调跟踪',
  });
  // ── M27（0051/0058）：kind「场景」写卡携 template_json 草稿入队且保持挂起──
  // v9 新列的读写由此进等价射程；确认路径由 scenario-template.test 单独罩着。
  vi.advanceTimersByTime(5 * 60_000);
  act({
    type: 'ENQUEUE_WRITE',
    draft: {
      objectId: obj.id,
      kind: '场景',
      headline: '起草场景：AI 起草区',
      evidence: '按用户口述起草，槽只取受控表现有槽',
      template: {
        name: 'AI 起草区',
        builtin: false,
        hint: '盯一摊事',
        playbook: '出站纪律：只根据账本里已有主张回答。',
        briefSpec: [{ title: '关键事实', kind: 'background' }],
      },
    },
  });
  // 槽改名 + 单值→多值 + 场景适用标记：主张谓词与模板 briefSpec 谓词同步重写都在 diff 射程内。
  act({
    type: 'UPDATE_SLOT',
    name: '自定义槽',
    kind: '组织',
    next: { name: '自定义槽二', arity: '多值', scenarios: ['尽调深挖'] },
  });
  // 删模板级联剔除槽的场景适用名（F1），数组剔空即该槽退化通用。
  act({ type: 'REMOVE_SCENARIO_TEMPLATE', name: '尽调深挖' });
  act({ type: 'ADD_SLOT', name: '抛弃槽', kind: '组织', arity: '单值' });
  act({ type: 'REMOVE_SLOT', name: '抛弃槽', kind: '组织' });

  // ── 模型设置（不落业务库）+ 偏好 + 绑定撤销 + 杂项 UI ──
  vi.advanceTimersByTime(10 * 60_000);
  act({
    type: 'UPSERT_PROVIDER',
    provider: {
      id: 'p-pdiff',
      name: '自建',
      baseUrl: 'http://localhost:1234/v1',
      apiKey: '',
      enabled: true,
      models: [{ id: 'local', name: 'local', contextWindow: 8, maxOutput: 8 }],
    },
  });
  act({ type: 'SET_ACTIVE_PROVIDER', id: 'p-pdiff' });
  act({ type: 'SET_ACTIVE_MODEL', providerId: 'p-pdiff', modelId: 'local' });
  act({ type: 'SET_THINKING', effort: '高' });
  act({ type: 'REMOVE_PROVIDER', id: 'p-pdiff' });
  act({ type: 'SET_THEME', preference: 'dark' });
  act({ type: 'SET_ONBOARDING', done: true });
  const bindCard = chatOf(obj.id).find((m) => m.card?.undo?.kind === '绑定');
  if (bindCard) act({ type: 'UNDO_RESULT', objectId: obj.id, messageId: bindCard.id });
  const firstMsg = chatOf(obj.id)[0];
  if (firstMsg) act({ type: 'DISMISS_CARD', objectId: obj.id, messageId: firstMsg.id });
  act({ type: 'TOAST', text: '剧本收尾' });
  act({ type: 'TOAST', text: null });
  vi.advanceTimersByTime(5 * 60_000);

  return { objId: obj.id, jdId: jd.id, sourceAId: sourceA.id };
}

/**
 * 比较前把 slot_defs 按 (kind,name) 归一：presets 种子 id（slot-001）与全量重写归一化 id
 * （slot-001-人）是已知合法分叉，两库仅在「触达该表」时各自收敛，行序不得依赖 id 字符串。
 */
function comparableLedger(ledger: LedgerRows): LedgerRows {
  const slotDefs = [...ledger.slotDefs].sort((x, y) => {
    const a = `${x.kind}\u0000${x.name}`;
    const b = `${y.kind}\u0000${y.name}`;
    return a < b ? -1 : a > b ? 1 : 0;
  });
  return { ...ledger, slotDefs };
}

const BUSINESS_TABLES = [
  'workspaces',
  'objects',
  'object_relations',
  'sources',
  'source_bindings',
  'slot_defs',
  'scenario_templates',
  'claims',
  'memories',
  'proposals',
  'write_queue',
  'tasks',
  'task_audit',
  'briefs',
  'ingest_jobs',
  'chat_messages',
] as const;

/** 从 SQL 提取业务表写语句键（app_meta upsert、operations、claims_fts 不在计数射程）。 */
function businessWriteKeys(sql: string): string[] {
  const keys: string[] = [];
  for (const chunk of sql.split(';')) {
    const match =
      /^\s*(INSERT|UPDATE|DELETE)\s+(?:OR\s+\w+\s+)?(?:INTO\s+|FROM\s+)?([A-Za-z_][A-Za-z0-9_]*)/i.exec(
        chunk,
      );
    const verb = match?.[1]?.toUpperCase();
    const table = match?.[2]?.toLowerCase();
    if (!verb || !table) continue;
    if ((BUSINESS_TABLES as readonly string[]).includes(table)) keys.push(`${verb} ${table}`);
  }
  return keys;
}

interface WriteProbe {
  tally: Map<string, number>;
  restore: () => void;
}

/** 按「实际执行」计数：prepared-未-run 的写语句不算（diff 同步会备语句但可能一行不写）。 */
function instrumentBusinessWrites(db: Database.Database): WriteProbe {
  const tally = new Map<string, number>();
  const record = (sql: string): void => {
    for (const key of businessWriteKeys(sql)) {
      tally.set(key, (tally.get(key) ?? 0) + 1);
    }
  };
  const originalPrepare = db.prepare;
  const originalExec = db.exec;
  db.prepare = ((source: string) => {
    const statement = originalPrepare.call(db, source);
    if (businessWriteKeys(source).length > 0) {
      const originalRun = statement.run as unknown as (...args: unknown[]) => unknown;
      statement.run = ((...args: unknown[]) => {
        record(source);
        return originalRun.apply(statement, args);
      }) as unknown as typeof statement.run;
    }
    return statement;
  }) as unknown as typeof db.prepare;
  db.exec = ((source: string) => {
    record(source);
    return originalExec.call(db, source);
  }) as unknown as typeof db.exec;
  return {
    tally,
    restore: () => {
      db.prepare = originalPrepare;
      db.exec = originalExec;
    },
  };
}

/** FTS 命中对回 claim id：rowid 两库不同，只比 id 集。 */
function ftsClaimIds(db: Database.Database, objectId: string, query: string): string[] {
  const byRowid = db.prepare('SELECT id FROM claims WHERE rowid = ?');
  return searchClaimsFts(db, objectId, query, 8).map(
    (hit) => (byRowid.get(hit.rowid) as { id: string } | undefined)?.id ?? `absent-${hit.rowid}`,
  );
}

// 超时余量：剧本双库灌库是 tmpdir SQLite 密集 IO，本机（Windows）并行负载下贴着默认 5s 跑，
// 断言语义不变，只放宽时限防抖红。
describe('按脏表差异写入与全量重写等价（0056）', { timeout: 20_000 }, () => {
  it('同一动作剧本灌两颗 Brain 后：两库账本深相等、操作日志序列相等、FTS 语义相等', () => {
    const { full, diff } = openPair();
    const handles = playScript(full, diff);

    expect(comparableLedger(loadLedger(full.db))).toEqual(comparableLedger(loadLedger(diff.db)));

    // 剧本必须真的灌出多表数据，否则上面的深相等是空对空。
    const ledger = loadLedger(diff.db);
    expect(ledger.workspaces.length).toBeGreaterThanOrEqual(1);
    expect(ledger.objects.length).toBeGreaterThanOrEqual(1);
    expect(ledger.sources.length).toBeGreaterThanOrEqual(2);
    expect(ledger.claims.length).toBeGreaterThan(0);
    expect(ledger.briefs.length).toBeGreaterThanOrEqual(1);
    expect(ledger.tasks.length).toBeGreaterThanOrEqual(2);
    expect(ledger.taskAudits.length).toBeGreaterThanOrEqual(2);
    expect(ledger.ingestJobs.length).toBeGreaterThan(0);
    // 0058 新表必须真有行（内置 5 行种子），否则深相等对新表是空对空。
    expect(ledger.scenarioTemplates.length).toBeGreaterThanOrEqual(5);
    expect(ledger.slotDefs.some((d) => d.name === '自定义槽二' && d.scenarios.length === 0)).toBe(
      true,
    );
    expect((ledger.chatByObject[handles.objId] ?? []).length).toBeGreaterThan(0);
    expect(ledger.seq).toBeGreaterThan(10);
    expect(ledger.themePreference).toBe('dark');
    expect(ledger.onboardingDone).toBe(true);

    // slot_defs 自愈：diff 库首次触达后与全量库逐位同形（不再残留 presets 的旧格式槽 id）。
    const slotIds = (db: Database.Database): string[] =>
      (db.prepare('SELECT id FROM slot_defs ORDER BY id').all() as { id: string }[]).map(
        (row) => row.id,
      );
    expect(slotIds(diff.db)).toEqual(slotIds(full.db));
    expect(slotIds(diff.db).every((id) => /^slot-\d{3}-(人|组织|项目)$/.test(id))).toBe(true);

    // operations：不比 id（随机后缀），只比 action/undo_of 逐行序列与行数。
    expect(listOperations(full.db)).toEqual(listOperations(diff.db));
    expect(listOperations(diff.db).length).toBeGreaterThan(40);

    // FTS 语义：存活主张命中集相等且非空。
    const aliveIds = ftsClaimIds(diff.db, handles.objId, '数据平台');
    expect(aliveIds.length).toBeGreaterThan(0);
    expect(ftsClaimIds(full.db, handles.objId, '数据平台')).toEqual(aliveIds);

    // 绑定撤销删掉的主张不得残留在任一库的 FTS 里（全量库走修复重建，diff 库走 claims 触发器）。
    expect(ftsClaimIds(full.db, handles.objId, '在招后端实习')).toEqual([]);
    expect(ftsClaimIds(diff.db, handles.objId, '在招后端实习')).toEqual([]);
  });

  it('纯 UI 动作：diff 路径业务表零写语句，全量路径每表照写', () => {
    const { full, diff } = openPair();
    const handles = playScript(full, diff);
    const userMsg = (diff.snapshot().chatByObject[handles.objId] ?? []).find(
      (m) => m.role === 'user',
    );
    const uiActions: Action[] = [
      { type: 'SET_VIEW', view: { kind: 'object', objectId: handles.objId } },
      { type: 'SET_VIEW', view: { kind: 'inbox' } },
      { type: 'TOAST', text: '脏表证明' },
      { type: 'TOAST', text: null },
      { type: 'MARK_TURN_PLAYED', objectId: handles.objId, messageId: userMsg?.id ?? 'absent' },
    ];
    const fullProbe = instrumentBusinessWrites(full.db);
    const diffProbe = instrumentBusinessWrites(diff.db);
    try {
      for (const action of uiActions) {
        full.dispatch(action);
        diff.dispatch(action);
      }
    } finally {
      fullProbe.restore();
      diffProbe.restore();
    }

    expect([...diffProbe.tally.entries()]).toEqual([]);
    for (const table of BUSINESS_TABLES) {
      expect(fullProbe.tally.get(`DELETE ${table}`) ?? 0).toBe(uiActions.length);
      const rowCount = (
        full.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as {
          n: number;
        }
      ).n;
      if (rowCount > 0) {
        expect(fullProbe.tally.get(`INSERT ${table}`) ?? 0).toBeGreaterThan(0);
      }
    }

    // 写了个寂寞：纯 UI 动作轮之后两库仍逐字段相等。
    expect(comparableLedger(loadLedger(full.db))).toEqual(comparableLedger(loadLedger(diff.db)));
  });

  it('关掉再打开同一文件：两库仍深相等；重开后继续写仍等价（数组序==首写序）', () => {
    const fileFull = brainFile('full.db');
    const fileDiff = brainFile('diff.db');
    const full = track(
      openBrain(fileFull, undefined, undefined, undefined, { persistMode: 'full' }),
    );
    const diff = track(openBrain(fileDiff));
    playScript(full, diff);
    const beforeFull = comparableLedger(loadLedger(full.db));
    const beforeDiff = comparableLedger(loadLedger(diff.db));
    expect(beforeFull).toEqual(beforeDiff);

    full.close();
    diff.close();
    const reopenedFull = track(
      openBrain(fileFull, undefined, undefined, undefined, { persistMode: 'full' }),
    );
    const reopenedDiff = track(openBrain(fileDiff));
    expect(comparableLedger(loadLedger(reopenedFull.db))).toEqual(
      comparableLedger(loadLedger(reopenedDiff.db)),
    );
    expect(comparableLedger(loadLedger(reopenedDiff.db))).toEqual(beforeDiff);

    // 重开后继续写：diff 库的 created_at 保持首写、全量库每次刷新，输出仍须逐字段相等。
    const act = (action: Action): void => {
      reopenedFull.dispatch(action);
      reopenedDiff.dispatch(action);
    };
    const obj = reopenedDiff.snapshot().objects.find((o) => o.name === '甲组织');
    if (!obj) throw new Error('动作剧本走不通：缺少甲组织');
    vi.advanceTimersByTime(60 * 60_000);
    act({ type: 'ADD_SOURCE', title: '重启材料', body: '重启后新增来源与排序验证。' });
    const restartSource = reopenedDiff
      .snapshot()
      .sources.find((s) => s.title === '重启材料' && !s.virtual);
    if (!restartSource) throw new Error('动作剧本走不通：缺少重启材料');
    act({ type: 'BIND_CONFIRMED', sourceId: restartSource.id, objectIds: [obj.id] });
    const drafts = [{ predicate: '主营业务', text: '重启后新增来源', span: '重启后新增来源' }];
    const beforeReopenUuid = uuid.n;
    completeExtraction(reopenedFull, restartSource.id, drafts);
    uuid.n = beforeReopenUuid;
    completeExtraction(reopenedDiff, restartSource.id, drafts);
    act({ type: 'CHAT_SEND', objectId: obj.id, text: '重启后再说一句' });
    act({ type: 'SET_VIEW', view: { kind: 'object', objectId: obj.id } });

    expect(comparableLedger(loadLedger(reopenedFull.db))).toEqual(
      comparableLedger(loadLedger(reopenedDiff.db)),
    );
    expect(listOperations(reopenedFull.db)).toEqual(listOperations(reopenedDiff.db));
  });

  it('syncTable 按内存主键集读行：全列查询行数不超过内存行，库内多余行仍自愈删除', () => {
    const diff = track(openBrain(brainFile('inc.db')));
    diff.dispatch({ type: 'ADD_WORKSPACE', name: '区甲', scenario: '求职面试' });
    diff.dispatch({
      type: 'ADD_SOURCE',
      title: '材料',
      body: '短正文，用来脏 sources 表。',
    });
    diff.db
      .prepare(
        `INSERT INTO sources (id, title, body, path, created_at)
         VALUES ('user-stmt', '不该落库', ?, '手给', '2026-01-01T00:00:00.000Z')`,
      )
      .run('x'.repeat(50_000));

    takeSyncTableStats();
    diff.dispatch({ type: 'ADD_SOURCE', title: '第二份', body: '另一段短正文。' });
    const stats = takeSyncTableStats();
    const sourceStats = stats.filter((row) => row.table === 'sources');
    expect(sourceStats.length).toBeGreaterThan(0);
    for (const row of sourceStats) {
      expect(row.fullRowReads).toBeLessThanOrEqual(row.wantedRows);
    }
    expect(diff.db.prepare("SELECT id FROM sources WHERE id = 'user-stmt'").get()).toBeUndefined();
  });
});

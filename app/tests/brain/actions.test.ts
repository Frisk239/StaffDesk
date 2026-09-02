import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  closedClaims,
  conflictsOf,
  isExtracting,
  openBrain,
  type Brain,
} from '../../src/main/brain';
import { listUserTables } from '../../src/main/brain/migrate';
import type { DeskTask, Source } from '../../src/shared/types';
import { completeExtraction } from '../helpers/extraction';

const dirs: string[] = [];
const brains: Brain[] = [];

function tmpBrain() {
  const dir = mkdtempSync(join(tmpdir(), 'staffdesk-act-'));
  dirs.push(dir);
  return join(dir, 'brain.db');
}

function track(brain: Brain): Brain {
  brains.push(brain);
  return brain;
}

afterEach(() => {
  while (brains.length) {
    try {
      brains.pop()?.close();
    } catch {
      /* closed */
    }
  }
  while (dirs.length) {
    const dir = dirs.pop();
    if (dir) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* lock */
      }
    }
  }
});

function setup() {
  const brain = track(openBrain(tmpBrain()));
  brain.dispatch({ type: 'ADD_WORKSPACE', name: '区甲', scenario: '求职面试' });
  brain.dispatch({ type: 'ADD_OBJECT', kind: '组织', name: '甲组织' });
  const obj = brain.snapshot().objects[0];
  if (!obj) throw new Error('无对象');
  brain.dispatch({
    type: 'ADD_SOURCE',
    title: 'JD',
    body: '该公司在招后端实习。团队主栈是 Go。团队也在评估 Java 方向。内部在推进平台化建设。办公地点未写。',
  });
  const source = brain.snapshot().sources.find((s) => !s.virtual);
  if (!source) throw new Error('无来源');
  brain.dispatch({ type: 'BIND_CONFIRMED', sourceId: source.id, objectIds: [obj.id] });
  expect(isExtracting(brain.snapshot(), obj.id)).toBe(true);
  completeExtraction(brain, source.id, [
    { predicate: '在招岗位', text: '该公司在招后端实习', span: '该公司在招后端实习' },
    { predicate: '后端主栈', text: '团队主栈是 Go', span: '团队主栈是 Go' },
    { predicate: '后端主栈', text: '团队也在评估 Java 方向', span: '团队也在评估 Java 方向' },
    { predicate: '未编目', text: '内部在推进平台化建设', span: '内部在推进平台化建设' },
  ]);
  return { brain, obj, source };
}

describe('账本动作覆盖', () => {
  it('走完对象生命周期、槽、简报、晋升撤销、纠正、记忆', () => {
    const { brain, obj, source } = setup();
    let st = brain.snapshot();
    expect(st.claims.length).toBeGreaterThan(0);
    expect(isExtracting(st, obj.id)).toBe(false);

    const claim = st.claims[0];
    if (!claim) throw new Error('无主张');
    brain.dispatch({ type: 'OPEN_AUDIT_CARD', claimId: claim.id });
    brain.dispatch({ type: 'SELECT_CLAIM', claimId: claim.id });
    brain.dispatch({ type: 'FOCUS_SOURCE', sourceId: source.id });
    brain.dispatch({ type: 'OPEN_RIGHT_TAB', objectId: obj.id, kind: '档案' });
    brain.dispatch({ type: 'OPEN_RIGHT_TAB', objectId: obj.id, kind: '来源' });
    const tab = brain.snapshot().rightTabsByObject[obj.id]?.[0];
    if (tab) {
      brain.dispatch({ type: 'FOCUS_RIGHT_TAB', objectId: obj.id, id: tab.id });
      brain.dispatch({ type: 'CLOSE_RIGHT_TAB', objectId: obj.id, id: tab.id });
    }

    brain.dispatch({ type: 'PROMOTE_CLAIM', claimId: claim.id });
    expect(brain.snapshot().claims.find((c) => c.id === claim.id)?.unverified).toBe(false);
    const promoteCard = (brain.snapshot().chatByObject[obj.id] ?? []).find(
      (m) => m.card?.result === '晋升' && m.card.undo,
    );
    if (!promoteCard) throw new Error('无晋升卡');
    brain.dispatch({ type: 'UNDO_RESULT', objectId: obj.id, messageId: promoteCard.id });
    expect(brain.snapshot().claims.find((c) => c.id === claim.id)?.unverified).toBe(true);

    brain.dispatch({ type: 'PROMOTE_CLAIM', claimId: claim.id });
    brain.dispatch({ type: 'OPEN_CORRECT_CARD', claimId: claim.id });
    const write = brain.snapshot().writeQueue[0];
    if (!write) throw new Error('无纠正提议');
    brain.dispatch({
      type: 'CONFIRM_WRITE',
      writeId: write.id,
      closeReason: '从未成立',
      newText: '主栈其实是 Rust。',
    });
    st = brain.snapshot();
    expect(st.claims.find((c) => c.id === claim.id)?.status).toBe('过时');
    expect(closedClaims(st, obj.id).length).toBeGreaterThan(0);
    expect(st.memories.some((m) => m.kind === '禁写')).toBe(true);
    const other = st.claims.find((c) => c.id !== claim.id && c.status === '成立');
    if (other) {
      expect(conflictsOf(st, other.id).every((c) => c.id !== claim.id)).toBe(true);
    }

    const mem = st.memories.find((m) => m.kind === '禁写');
    if (mem) brain.dispatch({ type: 'REMOVE_MEMORY', id: mem.id });

    brain.dispatch({ type: 'CHAT_SEND', objectId: obj.id, text: '记下来：简报用条目' });
    expect(brain.snapshot().memories.some((m) => m.text.includes('简报用条目'))).toBe(true);

    brain.dispatch({ type: 'CHAT_SEND', objectId: obj.id, text: '这句不对' });
    brain.dispatch({ type: 'GENERATE_BRIEF_START', objectId: obj.id });
    brain.dispatch({ type: 'GENERATE_BRIEF_DONE' });
    expect(brain.snapshot().briefs.length).toBeGreaterThan(0);

    const remaining = brain.snapshot().claims.filter((c) => c.unverified && c.status === '成立');
    if (remaining.length > 0) {
      const batch = brain.snapshot().writeQueue.find((w) => w.kind === '批量晋升');
      if (batch) {
        brain.dispatch({ type: 'CONFIRM_WRITE', writeId: batch.id });
        const batchCard = (brain.snapshot().chatByObject[obj.id] ?? []).find(
          (m) => m.card?.result === '批量晋升' && m.card.undo,
        );
        if (batchCard) {
          brain.dispatch({ type: 'UNDO_RESULT', objectId: obj.id, messageId: batchCard.id });
          const back = brain.snapshot().writeQueue.find((w) => w.kind === '批量回退');
          if (back) brain.dispatch({ type: 'CONFIRM_WRITE', writeId: back.id });
        }
      }
    }

    brain.dispatch({ type: 'ADD_SLOT', name: '自定义槽', kind: '组织', arity: '单值' });
    expect(brain.snapshot().slotDefs.some((s) => s.name === '自定义槽')).toBe(true);
    brain.dispatch({ type: 'ADD_SLOT', name: '', kind: '组织', arity: '单值' });
    brain.dispatch({ type: 'ADD_SLOT', name: '未编目', kind: '组织', arity: '单值' });
    brain.dispatch({ type: 'ADD_SLOT', name: '自定义槽', kind: '组织', arity: '单值' });

    brain.dispatch({
      type: 'ADD_SOURCE',
      title: 'url',
      body: 'https://example.com/jd',
      fromUrl: true,
    });
    brain.dispatch({ type: 'ADD_SOURCE', title: 'pdf', body: 'binary', unparsed: true });
    brain.dispatch({ type: 'ADD_SOURCE', title: '', body: '   ' });

    brain.dispatch({ type: 'SET_VIEW', view: { kind: 'inbox' } });
    brain.dispatch({ type: 'SET_VIEW', view: { kind: 'object', objectId: obj.id } });
    brain.dispatch({ type: 'SET_THEME', preference: 'dark' });
    brain.dispatch({ type: 'SET_THINKING', effort: '高' });
    brain.dispatch({ type: 'TOAST', text: 'hello' });
    brain.dispatch({ type: 'TOAST', text: null });

    brain.dispatch({
      type: 'UPSERT_PROVIDER',
      provider: {
        id: 'p-custom',
        name: '自建',
        baseUrl: 'http://localhost:1234/v1',
        apiKey: '',
        enabled: true,
        models: [{ id: 'local', name: 'local', contextWindow: 8, maxOutput: 8 }],
      },
    });
    brain.dispatch({ type: 'SET_ACTIVE_PROVIDER', id: 'p-custom' });
    brain.dispatch({ type: 'SET_ACTIVE_MODEL', providerId: 'p-custom', modelId: 'local' });
    brain.dispatch({
      type: 'UPSERT_PROVIDER',
      provider: {
        id: 'p-custom',
        name: '自建改',
        baseUrl: 'http://localhost:1234/v1',
        apiKey: '',
        enabled: true,
        models: [{ id: 'local', name: 'local', contextWindow: 8, maxOutput: 8 }],
      },
    });
    brain.dispatch({ type: 'REMOVE_PROVIDER', id: 'p-custom' });

    brain.dispatch({ type: 'ADD_WORKSPACE', name: '区乙', scenario: '技术选型' });
    const wsB = brain.snapshot().workspaces.find((w) => w.name === '区乙');
    if (!wsB) throw new Error('无区乙');
    brain.dispatch({ type: 'SWITCH_WORKSPACE', id: wsB.id });
    brain.dispatch({ type: 'ADD_OBJECT', kind: '项目', name: '选型项目' });
    brain.dispatch({ type: 'ADD_OBJECT', kind: '人', name: '联系人' });
    const extra = brain.snapshot().objects.find((o) => o.name === '选型项目');
    if (!extra) throw new Error('无项目');
    brain.dispatch({ type: 'ARCHIVE_OBJECT', id: extra.id });
    brain.dispatch({ type: 'UNARCHIVE_OBJECT', id: extra.id });
    brain.dispatch({ type: 'ARCHIVE_OBJECT', id: extra.id });
    brain.dispatch({ type: 'DELETE_OBJECT', id: extra.id });
    expect(brain.snapshot().objects.some((o) => o.id === extra.id)).toBe(false);

    const person = brain.snapshot().objects.find((o) => o.kind === '人');
    if (person) {
      brain.dispatch({ type: 'ARCHIVE_OBJECT', id: person.id });
      brain.dispatch({ type: 'RESTORE_OBJECT', id: person.id });
    }

    brain.dispatch({ type: 'REMOVE_WORKSPACE', id: wsB.id });
    brain.dispatch({ type: 'ADD_WORKSPACE', name: '', scenario: '自定义' });
    brain.dispatch({ type: 'SWITCH_WORKSPACE', id: 'no-such' });
    brain.dispatch({ type: 'ADD_OBJECT', kind: '组织', name: '' });

    const card = (brain.snapshot().chatByObject[obj.id] ?? [])[0];
    if (card) brain.dispatch({ type: 'DISMISS_CARD', objectId: obj.id, messageId: card.id });

    brain.dispatch({
      type: 'ENQUEUE_WRITE',
      draft: {
        objectId: obj.id,
        kind: '晋升',
        headline: '空',
        evidence: 'x',
      },
    });
    const queued = brain.snapshot().writeQueue.find((w) => w.kind === '晋升');
    if (queued) brain.dispatch({ type: 'REJECT_WRITE', writeId: queued.id });

    const live = brain.snapshot().claims.find((c) => c.status === '成立' && c.unverified);
    if (live) {
      brain.dispatch({
        type: 'ENQUEUE_WRITE',
        draft: {
          objectId: obj.id,
          kind: '晋升',
          claimId: live.id,
          headline: `晋升「${live.text}」`,
          evidence: live.text,
        },
      });
      const wr = brain.snapshot().writeQueue.find((w) => w.claimId === live.id);
      if (wr) brain.dispatch({ type: 'CONFIRM_WRITE', writeId: wr.id });
    }

    brain.dispatch({
      type: 'APPLY_RESEARCH',
      task: {
        id: 'task-test',
        objectId: obj.id,
        kind: '调研',
        status: '已完成',
        createdAt: '2026-08-29',
        budgetGear: '快搜',
      },
      audits: [
        { taskId: 'task-test', seq: 1, kind: '搜索', payload: { query: 'x' }, ts: '2026-08-29' },
      ],
      sources: [],
    });
    brain.dispatch({ type: 'SET_VIEW', view: { kind: 'replay', taskId: 'task-test' } });
    expect(brain.snapshot().taskAudits.length).toBeGreaterThan(0);

    brain.dispatch({ type: 'CREATE_RADAR', objectId: obj.id, query: '甲组织 官方' });
    const radar = brain.snapshot().tasks.find((t) => t.kind === '周期性雷达');
    expect(radar?.nextDueAt).toBeTruthy();
    if (radar?.nextDueAt) {
      const runAt = radar.nextDueAt;
      brain.dispatch({
        type: 'APPLY_RESEARCH',
        task: {
          id: 'task-radar-run',
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
            taskId: 'task-radar-run',
            seq: 1,
            kind: '迟跑',
            payload: { parentTaskId: radar.id },
            ts: '2026-08-31',
          },
        ],
        sources: [],
      });
      const updatedRadar = brain.snapshot().tasks.find((t) => t.id === radar.id);
      expect(updatedRadar?.lastRunAt).toBe(runAt);
      expect(updatedRadar?.nextDueAt).not.toBe(radar.nextDueAt);
    }
    expect(listUserTables(brain.db).length).toBeGreaterThan(5);
  });

  it('调研任务先落账，审计增量追加，手动停止不被最终写回覆盖', () => {
    const { brain, obj } = setup();
    const task = {
      id: 'task-live',
      objectId: obj.id,
      kind: '调研' as const,
      status: '进行中' as const,
      createdAt: '2026-08-30 12:00',
      budgetGear: '快搜' as const,
      query: '甲组织 官方',
    };
    const searchAudit = {
      taskId: task.id,
      seq: 1,
      kind: '搜索',
      payload: { query: task.query },
      ts: '2026-08-30T12:00:01.000Z',
    };
    const stopAudit = {
      taskId: task.id,
      seq: 2,
      kind: '停止',
      payload: { reason: '手动', opened: 0, failed: 0 },
      ts: '2026-08-30T12:00:02.000Z',
    };

    brain.dispatch({ type: 'TASK_RUN_STARTED', task });
    brain.dispatch({ type: 'TASK_AUDIT_APPENDED', taskId: task.id, audits: [searchAudit] });
    brain.dispatch({ type: 'TASK_AUDIT_APPENDED', taskId: task.id, audits: [searchAudit] });
    brain.dispatch({ type: 'TASK_STOP_REQUESTED', taskId: task.id });
    brain.dispatch({ type: 'SET_VIEW', view: { kind: 'replay', taskId: task.id } });
    brain.dispatch({
      type: 'APPLY_RESEARCH',
      task: { ...task, status: '已完成' },
      audits: [searchAudit, stopAudit],
      sources: [],
    });

    const snapshot = brain.snapshot();
    const saved = snapshot.tasks.find((item) => item.id === task.id);
    expect(saved?.status).toBe('已停止');
    expect(saved?.stopReason).toBe('手动');
    expect(snapshot.taskAudits.filter((audit) => audit.taskId === task.id)).toHaveLength(2);
    expect(snapshot.view).toEqual({ kind: 'replay', taskId: task.id });
  });

  it('任务写入路径应用审计保留：超限裁旧但豁免行留下', () => {
    const { brain, obj } = setup();
    const task = {
      id: 'task-retain',
      objectId: obj.id,
      kind: '调研' as const,
      status: '进行中' as const,
      createdAt: '2026-08-30 12:00',
      budgetGear: '快搜' as const,
      query: '甲组织 官方',
    };
    const audits = Array.from({ length: 510 }, (_, i) => ({
      taskId: task.id,
      seq: i + 1,
      kind: i === 0 ? '触顶' : '搜索',
      payload: {},
      ts: new Date(Date.parse('2026-08-30T12:00:00.000Z') + i * 1000).toISOString(),
    }));
    brain.dispatch({ type: 'TASK_RUN_STARTED', task });
    brain.dispatch({
      type: 'APPLY_RESEARCH',
      task: { ...task, status: '已完成' },
      audits,
      sources: [],
    });
    const kept = brain.snapshot().taskAudits.filter((row) => row.taskId === task.id);
    expect(kept).toHaveLength(500);
    expect(kept.some((row) => row.kind === '触顶' && row.seq === 1)).toBe(true);
    const stored = brain.db
      .prepare('SELECT COUNT(*) AS n FROM task_audit WHERE task_id = ?')
      .get(task.id) as { n: number };
    expect(stored.n).toBe(500);
  });

  it('调研来源全部抽取结束后，只对本任务未核生成批量决策', () => {
    const brain = track(openBrain(tmpBrain()));
    brain.dispatch({ type: 'ADD_WORKSPACE', name: '批量决策区', scenario: '求职面试' });
    brain.dispatch({ type: 'ADD_OBJECT', kind: '组织', name: '乙组织' });
    const obj = brain.snapshot().objects.find((item) => item.name === '乙组织');
    if (!obj) throw new Error('无对象');

    brain.dispatch({
      type: 'ADD_SOURCE',
      title: '手给材料',
      body: '办公地点在上海。',
    });
    const manualSource = brain.snapshot().sources.find((item) => item.title === '手给材料');
    if (!manualSource) throw new Error('无手给来源');
    brain.dispatch({ type: 'BIND_CONFIRMED', sourceId: manualSource.id, objectIds: [obj.id] });
    const manualClaims = completeExtraction(brain, manualSource.id, [
      { predicate: '办公地点', text: '办公地点在上海', span: '办公地点在上海' },
    ]);
    const manualClaim = manualClaims[0];

    const task: DeskTask = {
      id: 'task-review',
      objectId: obj.id,
      kind: '调研',
      status: '已完成',
      createdAt: '2026-08-30 16:00',
      budgetGear: '快搜',
      query: '乙组织 官方',
    };
    const sourceA = researchSource(task, obj.workspaceId, 1, '官网称乙组织在做数据平台。');
    const sourceB = researchSource(task, obj.workspaceId, 2, '招聘页称主栈是 Rust。');
    brain.dispatch({
      type: 'APPLY_RESEARCH',
      task,
      audits: [
        {
          taskId: task.id,
          seq: 1,
          kind: '打开',
          payload: { url: 'https://example.test/a' },
          ts: '2026-08-30T16:00:01.000Z',
        },
      ],
      sources: [sourceA, sourceB],
    });

    brain.dispatch({ type: 'BIND_CONFIRMED', sourceId: sourceA.id, objectIds: [obj.id] });
    const claimA = completeExtraction(brain, sourceA.id, [
      { predicate: '主营业务', text: '乙组织在做数据平台', span: '乙组织在做数据平台' },
    ])[0];
    expect(brain.snapshot().writeQueue.some((write) => write.taskId === task.id)).toBe(false);

    brain.dispatch({ type: 'BIND_CONFIRMED', sourceId: sourceB.id, objectIds: [obj.id] });
    const claimB = completeExtraction(brain, sourceB.id, [
      { predicate: '使用技术', text: '主栈是 Rust', span: '主栈是 Rust' },
    ])[0];
    if (!claimA || !claimB || !manualClaim) throw new Error('测试抽取失败');

    const batch = brain
      .snapshot()
      .writeQueue.find((write) => write.kind === '批量晋升' && write.taskId === task.id);
    expect(batch?.claimIds).toEqual([claimA.id, claimB.id]);
    expect(batch?.claimIds).not.toContain(manualClaim.id);

    if (!batch) throw new Error('无批量决策');
    brain.dispatch({ type: 'REJECT_WRITE', writeId: batch.id });
    const afterKeep = brain.snapshot();
    expect(afterKeep.claims.find((claim) => claim.id === claimA.id)?.unverified).toBe(true);
    expect(afterKeep.claims.find((claim) => claim.id === claimB.id)?.unverified).toBe(true);
    expect(afterKeep.claims.find((claim) => claim.id === manualClaim.id)?.unverified).toBe(true);
    expect(
      (afterKeep.chatByObject[obj.id] ?? []).some((msg) => msg.text === '已全部保持未核 2 条'),
    ).toBe(true);
  });

  it('单来源调研抽取完成后也生成任务末批量决策', () => {
    const brain = track(openBrain(tmpBrain()));
    brain.dispatch({ type: 'ADD_WORKSPACE', name: '单来源区', scenario: '求职面试' });
    brain.dispatch({ type: 'ADD_OBJECT', kind: '组织', name: '丙组织' });
    const obj = brain.snapshot().objects.find((item) => item.name === '丙组织');
    if (!obj) throw new Error('无对象');
    const task: DeskTask = {
      id: 'task-single-review',
      objectId: obj.id,
      kind: '调研',
      status: '已完成',
      createdAt: '2026-08-30 17:00',
      budgetGear: '快搜',
      query: '丙组织 官方',
    };
    const source = researchSource(task, obj.workspaceId, 1, '官网称丙组织在做 AI 工具。');
    brain.dispatch({
      type: 'APPLY_RESEARCH',
      task,
      audits: [
        {
          taskId: task.id,
          seq: 1,
          kind: '打开',
          payload: { url: 'https://example.test/single' },
          ts: '2026-08-30T17:00:01.000Z',
        },
      ],
      sources: [source],
    });
    brain.dispatch({ type: 'BIND_CONFIRMED', sourceId: source.id, objectIds: [obj.id] });
    const claim = completeExtraction(brain, source.id, [
      { predicate: '主营业务', text: '丙组织在做 AI 工具', span: '丙组织在做 AI 工具' },
    ])[0];
    if (!claim) throw new Error('测试抽取失败');

    const batch = brain
      .snapshot()
      .writeQueue.find((write) => write.kind === '批量晋升' && write.taskId === task.id);
    expect(batch?.claimIds).toEqual([claim.id]);
  });

  it('抽取终态即使没有事先抽取作业也会记下作业并入队任务末决策', () => {
    const brain = track(openBrain(tmpBrain()));
    brain.dispatch({ type: 'ADD_WORKSPACE', name: '迟到抽取区', scenario: '求职面试' });
    brain.dispatch({ type: 'ADD_OBJECT', kind: '组织', name: '丁组织' });
    const obj = brain.snapshot().objects.find((item) => item.name === '丁组织');
    if (!obj) throw new Error('无对象');
    const task: DeskTask = {
      id: 'task-late-extract',
      objectId: obj.id,
      kind: '调研',
      status: '已完成',
      createdAt: '2026-08-30 18:00',
      budgetGear: '快搜',
      query: '丁组织 官方',
    };
    const source = researchSource(task, obj.workspaceId, 1, '官网称丁组织在做工具。');
    brain.dispatch({
      type: 'APPLY_RESEARCH',
      task,
      audits: [
        {
          taskId: task.id,
          seq: 1,
          kind: '打开',
          payload: { url: 'https://example.test/late' },
          ts: '2026-08-30T18:00:01.000Z',
        },
      ],
      sources: [source],
    });
    const claim = completeExtraction(brain, source.id, [
      { predicate: '主营业务', text: '丁组织在做工具', span: '丁组织在做工具' },
    ])[0];
    if (!claim) throw new Error('测试抽取失败');

    const snapshot = brain.snapshot();
    expect(snapshot.extractJobs.find((job) => job.sourceId === source.id)?.status).toBe('完成');
    expect(
      snapshot.writeQueue.find((write) => write.kind === '批量晋升' && write.taskId === task.id)
        ?.claimIds,
    ).toEqual([claim.id]);
  });

  it('整理提议并入与丢弃、候选记忆、解绑撤销', () => {
    const { brain, obj } = setup();
    const uncat = brain.snapshot().claims.find((c) => c.predicate === '未编目');
    const claimId = uncat?.id ?? brain.snapshot().claims[0]?.id;
    if (!claimId) throw new Error('无主张');
    brain.db
      .prepare(
        `INSERT INTO proposals (id, type, payload, pending, decision, created_at, title, detail)
         VALUES (?, '整理', ?, 1, NULL, ?, '编目', '并入使用技术')`,
      )
      .run(
        'prop-tidy',
        JSON.stringify({ kind: '整理', claimId, targetPredicate: '使用技术' }),
        new Date().toISOString(),
      );
    brain.dispatch({ type: 'OPEN_PROPOSAL_CARD', proposalId: 'prop-tidy' });
    const wr = brain.snapshot().writeQueue.find((w) => w.kind === '整理');
    if (wr) brain.dispatch({ type: 'CONFIRM_WRITE', writeId: wr.id });

    brain.db
      .prepare(
        `INSERT INTO proposals (id, type, payload, pending, decision, created_at, title, detail)
         VALUES (?, '整理', ?, 1, NULL, ?, '丢弃', '丢弃未核')`,
      )
      .run(
        'prop-drop',
        JSON.stringify({
          kind: '丢弃未核',
          claimIds: [brain.snapshot().claims[0]?.id ?? claimId],
        }),
        new Date().toISOString(),
      );
    brain.dispatch({
      type: 'PROPOSAL_DECIDE',
      proposalId: 'prop-drop',
      decision: 'accept-drop',
    });

    brain.db
      .prepare(
        `INSERT INTO proposals (id, type, payload, pending, decision, created_at, title, detail)
         VALUES (?, '候选记忆', ?, 1, NULL, ?, '偏好', '短回复')`,
      )
      .run(
        'prop-mem',
        JSON.stringify({
          kind: '候选记忆',
          text: '回复偏短',
          memoryKind: '偏好',
          fromObjectId: obj.id,
          fromMessageIds: ['msg-old'],
          sourceExcerpt: '回复偏短',
          scope: '全局',
        }),
        new Date().toISOString(),
      );
    brain.dispatch({ type: 'PROPOSAL_DECIDE', proposalId: 'prop-mem', decision: 'accept-merge' });
    brain.db
      .prepare(
        `INSERT INTO proposals (id, type, payload, pending, decision, created_at, title, detail)
         VALUES (?, '候选记忆', ?, 1, NULL, ?, '偏好2', '驳回')`,
      )
      .run(
        'prop-mem2',
        JSON.stringify({
          kind: '候选记忆',
          text: '另一条',
          memoryKind: '偏好',
          fromObjectId: obj.id,
          fromMessageIds: ['msg-old-2'],
          sourceExcerpt: '另一条',
          scope: '对象',
        }),
        new Date().toISOString(),
      );
    brain.dispatch({ type: 'PROPOSAL_DECIDE', proposalId: 'prop-mem2', decision: 'reject' });

    const bindCard = (brain.snapshot().chatByObject[obj.id] ?? []).find(
      (m) => m.card?.undo?.kind === '绑定',
    );
    if (bindCard) {
      brain.dispatch({ type: 'UNDO_RESULT', objectId: obj.id, messageId: bindCard.id });
    }

    brain.dispatch({ type: 'CHAT_SEND', objectId: obj.id, text: '删掉这个对象' });
    brain.dispatch({ type: 'MARK_TURN_PLAYED', objectId: obj.id, messageId: 'nope' });
  });

  it('移除记忆的提示按被删记忆的种类出文案（F7）', () => {
    const { brain, obj } = setup();

    // 偏好：全局「记下来」立即写记忆（0006/0022）。
    brain.dispatch({ type: 'CHAT_SEND', objectId: obj.id, text: '记下来：沟通走邮件' });
    const preference = brain.snapshot().memories.find((m) => m.text.includes('沟通走邮件'));
    if (!preference) throw new Error('无偏好记忆');
    expect(preference.kind).toBe('偏好');
    brain.dispatch({ type: 'REMOVE_MEMORY', id: preference.id });
    expect(brain.snapshot().toast?.text).toBe('已移除这条偏好');
    expect(brain.snapshot().memories.some((m) => m.id === preference.id)).toBe(false);

    // 禁写：纠正（晋升后关窗）写入，移除时文案点名禁写（0034 的显式回退入口）。
    const claim = brain.snapshot().claims[0];
    if (!claim) throw new Error('无主张');
    brain.dispatch({ type: 'PROMOTE_CLAIM', claimId: claim.id });
    brain.dispatch({ type: 'OPEN_CORRECT_CARD', claimId: claim.id });
    const write = brain.snapshot().writeQueue[0];
    if (!write) throw new Error('无纠正提议');
    brain.dispatch({
      type: 'CONFIRM_WRITE',
      writeId: write.id,
      closeReason: '从未成立',
      newText: '主栈其实是 Rust。',
    });
    const ban = brain.snapshot().memories.find((m) => m.kind === '禁写');
    if (!ban) throw new Error('无禁写记忆');
    brain.dispatch({ type: 'REMOVE_MEMORY', id: ban.id });
    expect(brain.snapshot().toast?.text).toBe('已移除这条禁写');

    // 删不存在的 id：不炸，文案回落到「记忆」。
    brain.dispatch({ type: 'REMOVE_MEMORY', id: 'mem-nope' });
    expect(brain.snapshot().toast?.text).toBe('已移除这条记忆');
  });
});

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
      fetchedAt: '2026-08-30T16:00:00.000Z',
    },
    segments: [{ id: 'body', start: 0, end: body.length, label: `调研来源 ${index}` }],
    contentHash: `hash-${index}`,
    fetchedAt: '2026-08-30T16:00:00.000Z',
  };
}

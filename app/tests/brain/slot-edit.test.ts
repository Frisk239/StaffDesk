import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { bannedHit, buildBrief } from '@shared/brief';
import { deriveConflicts } from '@shared/scenario';
import { openBrain, type Brain } from '../../src/main/brain';
import { proposeCatalogUncataloged } from '../../src/main/loops/tidy';
import { completeExtraction } from '../helpers/extraction';

// 0057：谓词表编辑刀——改名四重级联、删除降级语义、种子防复活。
// 0058：M25「内置简报引用禁改禁删」保护解除，改断言级联改写——
// 槽改名重写各模板 briefSpec 谓词；删槽从块内剔除谓词、空块整块撤下。
// 全程真临时 brain（undo-restart 模式），不 mock、不出网。

const dirs: string[] = [];
const brains: Brain[] = [];

function tmpBrain() {
  const dir = mkdtempSync(join(tmpdir(), 'staffdesk-slot-edit-'));
  dirs.push(dir);
  return join(dir, 'brain.db');
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

function setupPerson() {
  const brain = openBrain(tmpBrain());
  brains.push(brain);
  brain.dispatch({ type: 'ADD_WORKSPACE', name: '求职区', scenario: '求职面试' });
  brain.dispatch({ type: 'ADD_OBJECT', kind: '人', name: '王某' });
  const obj = brain.snapshot().objects[0];
  if (!obj) throw new Error('无对象');
  brain.dispatch({
    type: 'ADD_SOURCE',
    title: '履历',
    body: '教育背景为计算机硕士。教育背景另说是电子工程。教育背景还提到在职博士。公开观点支持静态类型。公开观点也谈过工程实践。',
  });
  const source = brain.snapshot().sources.find((s) => !s.virtual);
  if (!source) throw new Error('无来源');
  brain.dispatch({ type: 'BIND_CONFIRMED', sourceId: source.id, objectIds: [obj.id] });
  return { brain, obj, source };
}

/** 求职面试区里带「后端主栈」主张的组织对象：简报说明「技术信号」块引用该槽。 */
function setupOrgWithBackendSlot() {
  const brain = openBrain(tmpBrain());
  brains.push(brain);
  brain.dispatch({ type: 'ADD_WORKSPACE', name: '技术区', scenario: '求职面试' });
  brain.dispatch({ type: 'ADD_OBJECT', kind: '组织', name: '某司' });
  const obj = brain.snapshot().objects[0];
  if (!obj) throw new Error('无对象');
  brain.dispatch({
    type: 'ADD_SOURCE',
    title: '技术资料',
    body: '后端主栈是 Go。',
  });
  const source = brain.snapshot().sources.find((s) => !s.virtual);
  if (!source) throw new Error('无来源');
  brain.dispatch({ type: 'BIND_CONFIRMED', sourceId: source.id, objectIds: [obj.id] });
  completeExtraction(brain, source.id, [
    { predicate: '后端主栈', text: '后端主栈是 Go', span: '后端主栈是 Go' },
  ]);
  return { brain, obj, source };
}

/** 直接落一行挂起的整理（编目）提议：当前 UI 流不产 targetPredicate，注入老格式行验证撤卡匹配面。 */
function injectPendingTidyProposal(brain: Brain, id: string, payload: unknown): void {
  brain.db
    .prepare(
      `INSERT INTO proposals (id, type, payload, pending, decision, created_at, title, detail)
       VALUES (?, '整理', ?, 1, NULL, '2026-08-31T00:00:00.000Z', '建议为未编目主张编目', '· 测试注入')`,
    )
    .run(id, JSON.stringify(payload));
}

describe('槽编辑：改名级联（0057）', () => {
  it('改名同步重写槽行、全部主张谓词与禁写结构化列，指向旧名的挂起整理提议一并撤下', () => {
    const { brain, source } = setupPerson();
    completeExtraction(brain, source.id, [
      { predicate: '教育背景', text: '教育背景为计算机硕士', span: '教育背景为计算机硕士' },
      { predicate: '教育背景', text: '教育背景另说是电子工程', span: '教育背景另说是电子工程' },
      { predicate: '公开观点', text: '公开观点支持静态类型', span: '公开观点支持静态类型' },
    ]);
    const st0 = brain.snapshot();
    const master = st0.claims.find(
      (c) => c.predicate === '教育背景' && c.text.includes('计算机硕士'),
    );
    if (!master) throw new Error('主张未落账');
    brain.dispatch({ type: 'PROMOTE_CLAIM', claimId: master.id });
    brain.dispatch({ type: 'CORRECT_CLAIM', claimId: master.id, closeReason: '从未成立' });

    const live = brain
      .snapshot()
      .claims.find((c) => c.predicate === '教育背景' && c.status === '成立');
    if (!live) throw new Error('无成立主张');
    injectPendingTidyProposal(brain, 'prop-slot-live', { kind: '整理', claimId: live.id });
    injectPendingTidyProposal(brain, 'prop-slot-target', {
      kind: '整理',
      claimId: 'cl-不存在的老主张',
      targetPredicate: '教育背景',
    });

    brain.dispatch({
      type: 'UPDATE_SLOT',
      name: '教育背景',
      kind: '人',
      next: { name: '教育履历' },
    });

    const st = brain.snapshot();
    expect(
      st.slotDefs.some((d) => d.name === '教育履历' && d.kind === '人' && d.arity === '单值'),
    ).toBe(true);
    expect(st.slotDefs.some((d) => d.name === '教育背景')).toBe(false);
    // 成立与已关窗主张全部重写（投影/冲突派生/简报槽块都以槽名为键）。
    expect(st.claims.filter((c) => c.predicate === '教育背景')).toHaveLength(0);
    expect(st.claims.filter((c) => c.predicate === '教育履历')).toHaveLength(2);
    expect(st.claims.find((c) => c.id === live.id)?.predicate).toBe('教育履历');
    // 其他槽不受牵连。
    expect(st.claims.some((c) => c.predicate === '公开观点')).toBe(true);
    // 禁写结构化谓词列同步重写：bannedHit 对新名主张仍拦。
    const ban = st.memories.find((m) => m.kind === '禁写');
    expect(ban?.bannedPredicate).toBe('教育履历');
    const renamed = st.claims.find((c) => c.id === master.id);
    if (!renamed) throw new Error('被纠正主张丢失');
    expect(bannedHit(st, renamed)).toBe(true);
    // 挂起整理（编目）提议撤下，不留确认必报错的死卡。
    const withdrawnLive = st.proposals.find((p) => p.id === 'prop-slot-live');
    const withdrawnTarget = st.proposals.find((p) => p.id === 'prop-slot-target');
    expect(withdrawnLive?.pending).toBe(false);
    expect(withdrawnLive?.decision).toBe('reject');
    expect(withdrawnTarget?.pending).toBe(false);
    expect(withdrawnTarget?.decision).toBe('reject');
    expect(st.toast?.text).toContain('已改名「教育背景」→「教育履历」');
  });

  it('改名后关掉再打开，槽名与主张谓词持久化不回弹', () => {
    const { brain, obj, source } = setupPerson();
    completeExtraction(brain, source.id, [
      { predicate: '教育背景', text: '教育背景为计算机硕士', span: '教育背景为计算机硕士' },
    ]);
    brain.dispatch({
      type: 'UPDATE_SLOT',
      name: '教育背景',
      kind: '人',
      next: { name: '教育履历' },
    });
    const file = brain.filePath;
    brain.close();

    const again = openBrain(file);
    brains.push(again);
    const st = again.snapshot();
    expect(st.slotDefs.some((d) => d.name === '教育履历' && d.kind === '人')).toBe(true);
    expect(st.slotDefs.some((d) => d.name === '教育背景')).toBe(false);
    expect(
      st.claims.filter((c) => c.objectId === obj.id && c.predicate === '教育履历'),
    ).toHaveLength(1);
  });
});

describe('槽编辑：内置简报引用的级联改写（0058，M25 保护解除）', () => {
  it('改名被引用槽不再拒绝：各模板简报说明的谓词同步换名，简报槽块跟新名走', () => {
    const { brain, obj } = setupOrgWithBackendSlot();
    brain.dispatch({
      type: 'UPDATE_SLOT',
      name: '后端主栈',
      kind: '组织',
      next: { name: '后端技术栈' },
    });

    const st = brain.snapshot();
    expect(st.toast?.text).toBe('已改名「后端主栈」→「后端技术栈」');
    expect(st.slotDefs.some((d) => d.name === '后端技术栈' && d.kind === '组织')).toBe(true);
    // 全部模板的 briefSpec 不再出现旧名；求职面试模板的「技术信号」块谓词换成新名。
    for (const template of st.scenarioTemplates) {
      for (const block of template.briefSpec) {
        expect(block.predicates ?? []).not.toContain('后端主栈');
      }
    }
    const jobTemplate = st.scenarioTemplates.find((t) => t.name === '求职面试');
    const techBlock = jobTemplate?.briefSpec.find((b) => b.title === '技术信号');
    expect(techBlock?.predicates).toEqual(['后端技术栈', '使用技术']);
    // 简报以模板为准：主张已随改名重写，装进「技术信号」块，不落 unknown。
    const brief = buildBrief(st, obj.id);
    const block = brief.blocks.find((b) => b.title === '技术信号');
    expect(block).toBeDefined();
    expect(block?.sentences.some((s) => s.claimIds.length > 0)).toBe(true);
    expect(
      brief.blocks.some(
        (b) => b.title === '技术信号' && b.sentences.every((s) => s.kind === 'unknown'),
      ),
    ).toBe(false);
    // 持久化：重开后模板 briefSpec 的改写不回弹。
    const file = brain.filePath;
    brain.close();
    const again = openBrain(file);
    brains.push(again);
    const reopened = again.snapshot().scenarioTemplates.find((t) => t.name === '求职面试');
    expect(reopened?.briefSpec.find((b) => b.title === '技术信号')?.predicates).toEqual([
      '后端技术栈',
      '使用技术',
    ]);
  });

  it('删除被引用槽不再拒绝：块内剔除该谓词，谓词清空的 slots 块整块撤下并在 toast 说明', () => {
    const { brain } = setupOrgWithBackendSlot();
    // 「风险信号」被两块引用：尽调研究「风险与冲突」（单谓词，将清空撤下）、
    // 技术选型「风险与依赖」（双谓词，剔除后保留另一谓词）。
    brain.dispatch({ type: 'REMOVE_SLOT', name: '风险信号', kind: '组织' });

    const st = brain.snapshot();
    expect(st.toast?.text).toBe('已删除槽「风险信号」，并从简报说明撤下 1 个空块');
    const dueDiligence = st.scenarioTemplates.find((t) => t.name === '尽调研究');
    expect(dueDiligence?.briefSpec.some((b) => b.title === '风险与冲突')).toBe(false);
    const selection = st.scenarioTemplates.find((t) => t.name === '技术选型');
    expect(selection?.briefSpec.find((b) => b.title === '风险与依赖')?.predicates).toEqual([
      '性能口径',
    ]);
    for (const template of st.scenarioTemplates) {
      for (const block of template.briefSpec) {
        expect(block.predicates ?? []).not.toContain('风险信号');
      }
    }
  });
});

describe('槽编辑：守卫（0057）', () => {
  it('next 全缺省原样返回：seq 不动、槽表与 toast 不变', () => {
    const { brain } = setupPerson();
    const before = brain.snapshot();
    brain.dispatch({ type: 'UPDATE_SLOT', name: '教育背景', kind: '人', next: {} });
    const after = brain.snapshot();
    expect(after.slotDefs).toEqual(before.slotDefs);
    expect(after.seq).toBe(before.seq);
    expect(after.toast?.text).toBe(before.toast?.text);
  });

  it('空名、保留值、同种类撞名、槽不存在一律拒绝', () => {
    const { brain } = setupPerson();
    brain.dispatch({ type: 'UPDATE_SLOT', name: '教育背景', kind: '人', next: { name: '   ' } });
    expect(brain.snapshot().toast?.text).toBe('槽名不能为空');

    brain.dispatch({ type: 'UPDATE_SLOT', name: '教育背景', kind: '人', next: { name: '未编目' } });
    expect(brain.snapshot().toast?.text).toBe('「未编目」是保留值');

    brain.dispatch({
      type: 'UPDATE_SLOT',
      name: '教育背景',
      kind: '人',
      next: { name: '公开观点' },
    });
    expect(brain.snapshot().toast?.text).toBe('该种类下已有同名槽');

    brain.dispatch({ type: 'UPDATE_SLOT', name: '不存在槽', kind: '人', next: { arity: '多值' } });
    expect(brain.snapshot().toast?.text).toBe('没有这个槽');

    brain.dispatch({ type: 'REMOVE_SLOT', name: '不存在槽', kind: '人' });
    expect(brain.snapshot().toast?.text).toBe('没有这个槽');

    // (名,种类) 是槽的地址：同名槽在其他分区不可寻址，也不触发级联改写。
    brain.dispatch({ type: 'REMOVE_SLOT', name: '后端主栈', kind: '项目' });
    expect(brain.snapshot().toast?.text).toBe('没有这个槽');
  });
});

describe('槽编辑：单值切换（0057 / 0029）', () => {
  it('多值切单值按归一化取值报冲突处数，派生冲突即时生效且不自动关任何主张', () => {
    const { brain, source } = setupPerson();
    completeExtraction(brain, source.id, [
      { predicate: '公开观点', text: '公开观点支持静态类型', span: '公开观点支持静态类型' },
      { predicate: '公开观点', text: '公开观点也谈过工程实践', span: '公开观点也谈过工程实践' },
    ]);
    const st0 = brain.snapshot();
    expect(deriveConflicts(st0.claims, st0.slotDefs)).toHaveLength(0);

    brain.dispatch({
      type: 'UPDATE_SLOT',
      name: '公开观点',
      kind: '人',
      next: { arity: '单值' },
    });
    const st = brain.snapshot();
    expect(st.toast?.text).toContain('已切换为单值：标记 1 处冲突待消解');
    expect(st.slotDefs.find((d) => d.name === '公开观点')?.arity).toBe('单值');
    const pairs = deriveConflicts(st.claims, st.slotDefs).filter((pair) => {
      const a = st.claims.find((c) => c.id === pair.claimIdA);
      return a?.predicate === '公开观点';
    });
    expect(pairs).toHaveLength(1);
    expect(st.claims.every((c) => c.status === '成立')).toBe(true);
  });
});

describe('槽编辑：删除降级（0057）', () => {
  it('成立主张转未编目：不建冲突、简报降级句、整理出编目卡；已关窗主张保留旧名作历史', () => {
    const { brain, obj, source } = setupPerson();
    completeExtraction(brain, source.id, [
      { predicate: '教育背景', text: '教育背景为计算机硕士', span: '教育背景为计算机硕士' },
      { predicate: '教育背景', text: '教育背景另说是电子工程', span: '教育背景另说是电子工程' },
      { predicate: '教育背景', text: '教育背景还提到在职博士', span: '教育背景还提到在职博士' },
    ]);
    const st0 = brain.snapshot();
    const master = st0.claims.find(
      (c) => c.predicate === '教育背景' && c.text.includes('计算机硕士'),
    );
    const liveIds = st0.claims.filter((c) => c.id !== master?.id).map((c) => c.id);
    if (!master || liveIds.length !== 2) throw new Error('主张未落账');
    brain.dispatch({ type: 'PROMOTE_CLAIM', claimId: master.id });
    brain.dispatch({ type: 'CORRECT_CLAIM', claimId: master.id, closeReason: '从未成立' });
    // 删除前：单值槽下两条成立主张互斥，冲突已在。
    expect(deriveConflicts(brain.snapshot().claims, brain.snapshot().slotDefs)).toHaveLength(1);
    const survivorId = liveIds[0]!;
    injectPendingTidyProposal(brain, 'prop-slot-remove', {
      kind: '整理',
      claimId: survivorId,
      targetPredicate: '教育背景',
    });

    brain.dispatch({ type: 'REMOVE_SLOT', name: '教育背景', kind: '人' });

    const st = brain.snapshot();
    expect(st.slotDefs.some((d) => d.name === '教育背景' && d.kind === '人')).toBe(false);
    expect(
      st.claims
        .filter((c) => c.predicate === '未编目')
        .map((c) => c.id)
        .sort(),
    ).toEqual([...liveIds].sort());
    // 已关窗主张保留旧名作历史。
    expect(st.claims.find((c) => c.id === master.id)?.predicate).toBe('教育背景');
    expect(st.toast?.text).toBe('已删除槽「教育背景」：2 条主张转入未编目');
    // 未编目不建冲突（0037）。
    expect(deriveConflicts(st.claims, st.slotDefs)).toHaveLength(0);
    // 简报降级：材料提到、不作定论。
    const brief = buildBrief(st, obj.id);
    const downgradedIds = brief.blocks
      .flatMap((b) => b.sentences)
      .filter((s) => s.flag === '未编目·不作定论')
      .flatMap((s) => s.claimIds)
      .sort();
    expect(downgradedIds).toEqual([...liveIds].sort());
    // 整理出编目卡：人选拖槽（0025）回收这批未编目。
    const catalogProposals = proposeCatalogUncataloged(st, obj.id, st.seq);
    for (const id of liveIds) {
      expect(
        catalogProposals.some((p) => p.payload.kind === '整理' && p.payload.claimId === id),
      ).toBe(true);
    }
    // 指向被删槽的挂起提议撤下。
    const withdrawn = st.proposals.find((p) => p.id === 'prop-slot-remove');
    expect(withdrawn?.pending).toBe(false);
    expect(withdrawn?.decision).toBe('reject');
  });

  it('无主张的槽删除不带转入计数后缀；全部槽可改可删，删光谓词表重启不被种子复活（0058）', () => {
    const { brain } = setupPerson();
    brain.dispatch({ type: 'REMOVE_SLOT', name: '岗位要点', kind: '项目' });
    expect(brain.snapshot().toast?.text).toBe('已删除槽「岗位要点」');

    // M25 保护已解除：连内置简报引用的槽也可删——级联改写由 reducer 兜住。
    const all = brain.snapshot().slotDefs.map((d) => ({ name: d.name, kind: d.kind }));
    for (const { name, kind } of all) {
      brain.dispatch({ type: 'REMOVE_SLOT', name, kind });
    }
    const stripped = brain.snapshot().slotDefs;
    expect(stripped).toHaveLength(0);
    // 引用槽全删光：各模板 briefSpec 的 slots 块全部撤下，只剩 background/synthesis/gaps。
    for (const template of brain.snapshot().scenarioTemplates) {
      for (const block of template.briefSpec) {
        expect(block.kind === 'slots').toBe(false);
      }
    }

    const file = brain.filePath;
    brain.close();
    const again = openBrain(file);
    brains.push(again);
    const st = again.snapshot();
    expect(st.slotDefs.length).toBe(0);
    const marker = again.db
      .prepare("SELECT value FROM app_meta WHERE key = 'presets_seeded'")
      .get() as { value: string } | undefined;
    expect(marker?.value).toBe('1');
  });
});

describe('槽编辑：撤销口径（0057）', () => {
  it('编辑与删除都不写结果卡，operations 自动留痕', () => {
    const brain = openBrain(tmpBrain());
    brains.push(brain);
    brain.dispatch({
      type: 'UPDATE_SLOT',
      name: '教育背景',
      kind: '人',
      next: { name: '教育履历' },
    });
    brain.dispatch({ type: 'REMOVE_SLOT', name: '教育履历', kind: '人' });
    const st = brain.snapshot();
    expect(Object.values(st.chatByObject).flat()).toHaveLength(0);
    const ops = brain.db
      .prepare('SELECT action FROM operations WHERE action IN (?, ?) ORDER BY created_at')
      .all('UPDATE_SLOT', 'REMOVE_SLOT') as { action: string }[];
    expect(ops.map((o) => o.action)).toEqual(['UPDATE_SLOT', 'REMOVE_SLOT']);
  });
});

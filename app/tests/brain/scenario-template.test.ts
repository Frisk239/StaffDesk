import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildBrief } from '@shared/brief';
import { builtinScenarioTemplates, DEFAULT_SLOT_DEFS, slotsForScene } from '@shared/scenario';
import { CUSTOM_BASELINE_PLAYBOOK } from '@shared/playbook';
import { emptyUiFields } from '@shared/defaults';
import type { BriefSpecBlock, ScenarioTemplate, State } from '@shared/types';
import { openBrain, type Brain } from '../../src/main/brain';

// 0058：场景模板 CRUD 刀——UPSERT 守卫全集、REMOVE 引用/内置拒、建区校验、
// buildBrief 缺模板回落、持久化往返。全程真临时 brain，不 mock、不出网。

const dirs: string[] = [];
const brains: Brain[] = [];

function tmpBrain() {
  const dir = mkdtempSync(join(tmpdir(), 'staffdesk-scenario-template-'));
  dirs.push(dir);
  return join(dir, 'brain.db');
}

function openTmpBrain(): Brain {
  const brain = openBrain(tmpBrain());
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

function customTemplate(name: string, overrides: Partial<ScenarioTemplate> = {}): ScenarioTemplate {
  return {
    name,
    builtin: false,
    hint: '盯一个标的',
    playbook: '出站纪律：只根据账本里已有主张回答。',
    briefSpec: [{ title: '关键事实', kind: 'background' }],
    ...overrides,
  };
}

/** 纯函数用最小 State（buildBrief 只读 workspaces/objects/claims/memories/slotDefs/模板）。 */
function stateWith(templates: ScenarioTemplate[], scenario = '求职面试'): State {
  return {
    ...emptyUiFields(),
    workspaces: [{ id: 'ws', name: '区', scenario }],
    currentWorkspaceId: 'ws',
    objects: [{ id: 'o1', kind: '组织', name: '甲', relationIds: [], workspaceId: 'ws' }],
    sources: [],
    claims: [],
    slotDefs: DEFAULT_SLOT_DEFS,
    scenarioTemplates: templates,
    briefs: [],
    memories: [],
    inbox: [],
    proposals: [],
    tasks: [],
    taskAudits: [],
    chatByObject: {},
    seq: 1,
    onboardingDone: true,
  };
}

describe('场景模板：UPSERT 守卫（0058）', () => {
  it('模板名空白拒绝', () => {
    const brain = openTmpBrain();
    brain.dispatch({ type: 'UPSERT_SCENARIO_TEMPLATE', template: customTemplate('   ') });
    expect(brain.snapshot().toast?.text).toBe('模板名不能为空');
    expect(brain.snapshot().scenarioTemplates).toHaveLength(5);
  });

  it('改名撞其它模板名拒绝；同名保存（自己）不误伤', () => {
    const brain = openTmpBrain();
    brain.dispatch({ type: 'UPSERT_SCENARIO_TEMPLATE', template: customTemplate('投标跟踪') });
    brain.dispatch({
      type: 'UPSERT_SCENARIO_TEMPLATE',
      template: customTemplate('技术选型'),
      previousName: '投标跟踪',
    });
    expect(brain.snapshot().toast?.text).toBe('已有同名场景模板「技术选型」');
    expect(brain.snapshot().scenarioTemplates.some((t) => t.name === '投标跟踪')).toBe(true);

    // 同名 upsert 是编辑自己：不进撞名分支。
    brain.dispatch({
      type: 'UPSERT_SCENARIO_TEMPLATE',
      template: customTemplate('投标跟踪', { hint: '改' }),
    });
    expect(brain.snapshot().scenarioTemplates.find((t) => t.name === '投标跟踪')?.hint).toBe('改');
  });

  it('briefSpec 引用表外字段拒绝（0025 不许自开槽）', () => {
    const brain = openTmpBrain();
    brain.dispatch({
      type: 'UPSERT_SCENARIO_TEMPLATE',
      template: customTemplate('投标跟踪', {
        briefSpec: [
          { title: '关键事实', kind: 'background' },
          { title: '标的信号', kind: 'slots', predicates: ['表外字段'] },
        ],
      }),
    });
    expect(brain.snapshot().toast?.text).toBe(
      '简报说明引用了表外字段「表外字段」，请先在谓词表建槽',
    );
    expect(brain.snapshot().scenarioTemplates).toHaveLength(5);
  });

  it('块标题空白拒绝；块类型不合法拒绝（IPC 边界自校验）', () => {
    const brain = openTmpBrain();
    brain.dispatch({
      type: 'UPSERT_SCENARIO_TEMPLATE',
      template: customTemplate('投标跟踪', {
        briefSpec: [{ title: '  ', kind: 'background' }],
      }),
    });
    expect(brain.snapshot().toast?.text).toBe('简报说明块的标题不能为空');

    // 模拟 IPC 送来的越界 kind：TS 类型在此刻说一次谎，运行时守卫必须接住。
    const forged = {
      ...customTemplate('投标跟踪'),
      briefSpec: [{ title: '块', kind: 'nonsense' }] as unknown as BriefSpecBlock[],
    };
    brain.dispatch({ type: 'UPSERT_SCENARIO_TEMPLATE', template: forged });
    expect(brain.snapshot().toast?.text).toBe('简报说明块的类型不合法：nonsense');
  });

  it('内置模板可改内容不可改名；builtin 标记按库内行裁定，不可自封', () => {
    const brain = openTmpBrain();
    const before = brain.snapshot().scenarioTemplates.find((t) => t.name === '求职面试');
    if (!before) throw new Error('内置模板缺失');

    // 改名拒：回落锚点按名字寻址。
    brain.dispatch({
      type: 'UPSERT_SCENARIO_TEMPLATE',
      template: customTemplate('面试准备', { builtin: true }),
      previousName: '求职面试',
    });
    expect(brain.snapshot().toast?.text).toBe('内置模板不能改名，只能编辑内容');
    expect(brain.snapshot().scenarioTemplates.some((t) => t.name === '面试准备')).toBe(false);

    // 内容可改：同名词典更新，hint/playbook/briefSpec 全换。
    brain.dispatch({
      type: 'UPSERT_SCENARIO_TEMPLATE',
      template: {
        name: '求职面试',
        builtin: false, // 载荷自带 false 也不得把内置身份摘掉
        hint: '  改后的引导  ',
        playbook: '  改后的说明书  ',
        briefSpec: [{ title: '新块', kind: 'background' }],
      },
    });
    const st = brain.snapshot();
    const edited = st.scenarioTemplates.find((t) => t.name === '求职面试');
    expect(edited?.builtin).toBe(true);
    expect(edited?.hint).toBe('改后的引导');
    expect(edited?.playbook).toBe('改后的说明书');
    expect(edited?.briefSpec).toEqual([{ title: '新块', kind: 'background' }]);
    expect(st.toast?.text).toBe('已保存场景模板「求职面试」');

    // 新模板不可自封内置。
    brain.dispatch({
      type: 'UPSERT_SCENARIO_TEMPLATE',
      template: customTemplate('仿冒', { builtin: true }),
    });
    expect(brain.snapshot().toast?.text).toBe('内置模板只随首启种子写入，不能手工新建');
  });

  it('改自定义模板名级联工作区引用与槽的场景适用标记，不留悬挂引用', () => {
    const brain = openTmpBrain();
    brain.dispatch({ type: 'UPSERT_SCENARIO_TEMPLATE', template: customTemplate('投标跟踪') });
    brain.dispatch({ type: 'ADD_WORKSPACE', name: '投标区', scenario: '投标跟踪' });
    brain.dispatch({
      type: 'ADD_SLOT',
      name: '标的信息',
      kind: '组织',
      arity: '单值',
    });
    brain.dispatch({
      type: 'UPDATE_SLOT',
      name: '标的信息',
      kind: '组织',
      next: { scenarios: ['投标跟踪'] },
    });

    brain.dispatch({
      type: 'UPSERT_SCENARIO_TEMPLATE',
      template: customTemplate('投标尽调'),
      previousName: '投标跟踪',
    });
    const st = brain.snapshot();
    expect(st.toast?.text).toBe('已改名场景模板「投标跟踪」→「投标尽调」');
    expect(st.scenarioTemplates.some((t) => t.name === '投标跟踪')).toBe(false);
    expect(st.workspaces.find((w) => w.name === '投标区')?.scenario).toBe('投标尽调');
    expect(st.slotDefs.find((d) => d.name === '标的信息')?.scenarios).toEqual(['投标尽调']);
  });
});

describe('场景模板：REMOVE（0058）', () => {
  it('内置模板（含「自定义」基线）禁删——回落语义的锚点', () => {
    const brain = openTmpBrain();
    brain.dispatch({ type: 'REMOVE_SCENARIO_TEMPLATE', name: '自定义' });
    expect(brain.snapshot().toast?.text).toBe('内置模板不能删除');
    brain.dispatch({ type: 'REMOVE_SCENARIO_TEMPLATE', name: '求职面试' });
    expect(brain.snapshot().toast?.text).toBe('内置模板不能删除');
    brain.dispatch({ type: 'REMOVE_SCENARIO_TEMPLATE', name: '不存在模板' });
    expect(brain.snapshot().toast?.text).toBe('没有这个场景模板');
    expect(brain.snapshot().scenarioTemplates).toHaveLength(5);
  });

  it('被工作区引用的模板拒绝删除并列出引用数', () => {
    const brain = openTmpBrain();
    brain.dispatch({ type: 'UPSERT_SCENARIO_TEMPLATE', template: customTemplate('投标跟踪') });
    brain.dispatch({ type: 'ADD_WORKSPACE', name: '投标区一', scenario: '投标跟踪' });
    brain.dispatch({ type: 'ADD_WORKSPACE', name: '投标区二', scenario: '投标跟踪' });

    brain.dispatch({ type: 'REMOVE_SCENARIO_TEMPLATE', name: '投标跟踪' });
    const st = brain.snapshot();
    expect(st.toast?.text).toBe('有 2 个工作区正在使用「投标跟踪」，先移除或改区再删');
    expect(st.scenarioTemplates.some((t) => t.name === '投标跟踪')).toBe(true);
  });

  it('无引用的自定义模板删除成功', () => {
    const brain = openTmpBrain();
    brain.dispatch({ type: 'UPSERT_SCENARIO_TEMPLATE', template: customTemplate('投标跟踪') });
    brain.dispatch({ type: 'REMOVE_SCENARIO_TEMPLATE', name: '投标跟踪' });
    const st = brain.snapshot();
    expect(st.toast?.text).toBe('已删除场景模板「投标跟踪」');
    expect(st.scenarioTemplates).toHaveLength(5);
  });

  it('删除级联剔除槽的场景适用名：剔空的槽恢复通用可见，重开持久化一致（F1）', () => {
    const brain = openTmpBrain();
    brain.dispatch({ type: 'UPSERT_SCENARIO_TEMPLATE', template: customTemplate('投标跟踪') });
    brain.dispatch({ type: 'ADD_SLOT', name: '标的信息', kind: '组织', arity: '单值' });
    brain.dispatch({ type: 'ADD_SLOT', name: '风险信号', kind: '组织', arity: '多值' });
    brain.dispatch({
      type: 'UPDATE_SLOT',
      name: '标的信息',
      kind: '组织',
      next: { scenarios: ['投标跟踪'] },
    });
    brain.dispatch({
      type: 'UPDATE_SLOT',
      name: '风险信号',
      kind: '组织',
      next: { scenarios: ['投标跟踪', '技术选型'] },
    });
    // 删除前：只勾了该场景的槽在其它场景（求职面试）下不可见——悬挂引用正是要堵的静默消失面。
    const before = brain.snapshot();
    expect(slotsForScene(before.slotDefs, '组织', '投标跟踪')).toContain('标的信息');
    expect(slotsForScene(before.slotDefs, '组织', '求职面试')).not.toContain('标的信息');

    brain.dispatch({ type: 'REMOVE_SCENARIO_TEMPLATE', name: '投标跟踪' });
    const st = brain.snapshot();
    expect(st.toast?.text).toBe('已删除场景模板「投标跟踪」，并从 2 个字段的场景适用中移除');
    // 单勾该场景的槽清名后退化通用（全部场景可见）；多勾的只剔该名。
    expect(st.slotDefs.find((d) => d.name === '标的信息')?.scenarios).toEqual([]);
    expect(st.slotDefs.find((d) => d.name === '风险信号')?.scenarios).toEqual(['技术选型']);
    expect(slotsForScene(st.slotDefs, '组织', '求职面试')).toContain('标的信息');
    expect(slotsForScene(st.slotDefs, '组织', '技术选型')).toContain('风险信号');
    expect(slotsForScene(st.slotDefs, '组织', '求职面试')).not.toContain('风险信号');

    // 级联结果落库：重开读回不回潮。
    const file = brain.filePath;
    brain.close();
    const again = openBrain(file);
    brains.push(again);
    const read = again.snapshot();
    expect(read.slotDefs.find((d) => d.name === '标的信息')?.scenarios).toEqual([]);
    expect(read.slotDefs.find((d) => d.name === '风险信号')?.scenarios).toEqual(['技术选型']);
  });
});

describe('建区校验（0058）', () => {
  it('ADD_WORKSPACE 引用不存在的模板名拒绝，模板存在才建区', () => {
    const brain = openTmpBrain();
    brain.dispatch({ type: 'ADD_WORKSPACE', name: '无模板区', scenario: '不存在的场景' });
    expect(brain.snapshot().toast?.text).toBe('场景模板「不存在的场景」不存在，无法创建工作区');
    expect(brain.snapshot().workspaces).toHaveLength(0);

    brain.dispatch({
      type: 'UPSERT_SCENARIO_TEMPLATE',
      template: customTemplate('投标跟踪'),
    });
    brain.dispatch({ type: 'ADD_WORKSPACE', name: '投标区', scenario: '投标跟踪' });
    expect(brain.snapshot().workspaces[0]?.scenario).toBe('投标跟踪');
  });
});

describe('简报说明回落（0058）', () => {
  it('删光模板（scenarioTemplates 空）后简报仍出，用空 spec（零块）', () => {
    const state = stateWith([]);
    const brief = buildBrief(state, 'o1');
    expect(brief.blocks).toEqual([]);
    expect(brief.objectId).toBe('o1');
  });

  it('缺该场景的模板时回落「自定义」基线模板的 spec', () => {
    const baseline = builtinScenarioTemplates().find((t) => t.name === '自定义');
    if (!baseline) throw new Error('基线缺失');
    const state = stateWith([baseline]);
    const brief = buildBrief(state, 'o1');
    expect(brief.blocks.map((b) => b.title)).toEqual(['关键事实', '材料缺口']);
  });
});

describe('会话说明书与持久化往返（0058）', () => {
  it('自定义模板经 dispatch 落库，重开读回四件套与 builtin 标记不丢', () => {
    const brain = openTmpBrain();
    const template = customTemplate('投标跟踪', {
      briefSpec: [
        { title: '关键事实', kind: 'background' },
        { title: '标的信号', kind: 'slots', predicates: ['主营业务'] },
      ],
    });
    brain.dispatch({ type: 'UPSERT_SCENARIO_TEMPLATE', template });
    const file = brain.filePath;
    brain.close();

    const again = openBrain(file);
    brains.push(again);
    const read = again.snapshot().scenarioTemplates.find((t) => t.name === '投标跟踪');
    expect(read?.builtin).toBe(false);
    expect(read?.hint).toBe(template.hint);
    expect(read?.playbook).toBe(template.playbook);
    expect(read?.briefSpec).toEqual(template.briefSpec);
    // 内置行 builtin=1 落库读回仍是 true，四件套与种子一致。
    const builtin = again.snapshot().scenarioTemplates.find((t) => t.name === '求职面试');
    expect(builtin?.builtin).toBe(true);
    expect(builtin?.playbook).not.toBe(CUSTOM_BASELINE_PLAYBOOK);
  });
});

// F2（审计 2026-09-01）：槽改名/删除的级联面必须含挂起的「整理」写卡（0051 写队列也是账本状态），
// 且 CONFIRM_WRITE 找不到提议的回退分支要有受控表校验——不校验会把主张写回旧/已删谓词名。
describe('槽编辑级联挂起整理写卡（0057/F2）', () => {
  /** 造一颗带未编目主张的脑；驳回抽取自动产的编目提议，让确认走 CONFIRM_WRITE 回退分支。 */
  function brainWithUncatalogedClaim(
    claimId: string,
    objectKind: '组织' | '项目',
    claimText: string,
  ): { brain: Brain; objectId: string } {
    const brain = openTmpBrain();
    brain.dispatch({ type: 'ADD_WORKSPACE', name: '级联验收区', scenario: '求职面试' });
    brain.dispatch({ type: 'ADD_OBJECT', kind: objectKind, name: `级联对象${claimId}` });
    const objectId = brain.snapshot().objects[0]?.id ?? '';
    brain.dispatch({ type: 'ADD_SOURCE', title: '级联材料', body: `${claimText}。` });
    const source = brain.snapshot().sources.find((s) => !s.virtual);
    if (!source) throw new Error('missing source');
    brain.dispatch({ type: 'BIND_CONFIRMED', sourceId: source.id, objectIds: [objectId] });
    brain.dispatch({
      type: 'EXTRACT_DONE',
      sourceId: source.id,
      claims: [
        {
          id: claimId,
          objectId,
          predicate: '未编目',
          text: claimText,
          status: '成立',
          unverified: true,
          sourceId: source.id,
          span: claimText,
          createdAt: '2026-09-01',
        },
      ],
    });
    const uncat = brain.snapshot().proposals.find((p) => p.pending && p.payload.kind === '整理');
    if (!uncat) throw new Error('missing uncat proposal');
    brain.dispatch({ type: 'PROPOSAL_DECIDE', proposalId: uncat.id, decision: 'reject' });
    return { brain, objectId };
  }

  it('槽改名级联写卡谓词：确认时落新谓词，不写回旧名', () => {
    const { brain, objectId } = brainWithUncatalogedClaim(
      'cl-f2-rename',
      '组织',
      '内部在推进平台化',
    );
    brain.dispatch({ type: 'ADD_SLOT', name: '标的行业', kind: '组织', arity: '单值' });
    brain.dispatch({
      type: 'ENQUEUE_WRITE',
      draft: {
        objectId,
        kind: '整理',
        claimId: 'cl-f2-rename',
        targetPredicate: '标的行业',
        headline: '并入「标的行业」',
        evidence: '内部在推进平台化',
      },
    });
    brain.dispatch({
      type: 'UPDATE_SLOT',
      name: '标的行业',
      kind: '组织',
      next: { name: '所属行业' },
    });
    const row = brain.snapshot().writeQueue.find((w) => w.kind === '整理');
    expect(row?.targetPredicate).toBe('所属行业');

    brain.dispatch({ type: 'CONFIRM_WRITE', writeId: row?.id ?? '' });
    const st = brain.snapshot();
    expect(st.claims.find((c) => c.id === 'cl-f2-rename')?.predicate).toBe('所属行业');
    expect(st.writeQueue).toHaveLength(0);
  });

  it('删槽把挂起整理写卡一并撤下：确认旧 id 无账本写入', () => {
    const { brain, objectId } = brainWithUncatalogedClaim(
      'cl-f2-remove',
      '组织',
      '内部在推进合规化',
    );
    brain.dispatch({ type: 'ADD_SLOT', name: '临时槽', kind: '组织', arity: '单值' });
    brain.dispatch({
      type: 'ENQUEUE_WRITE',
      draft: {
        objectId,
        kind: '整理',
        claimId: 'cl-f2-remove',
        targetPredicate: '临时槽',
        headline: '并入「临时槽」',
        evidence: '内部在推进合规化',
      },
    });
    const writeId = brain.snapshot().writeQueue.find((w) => w.kind === '整理')?.id;
    if (!writeId) throw new Error('missing write row');

    brain.dispatch({ type: 'REMOVE_SLOT', name: '临时槽', kind: '组织' });
    expect(brain.snapshot().writeQueue).toHaveLength(0);

    // 行已不在队列：确认是 no-op，主张仍留在未编目。
    brain.dispatch({ type: 'CONFIRM_WRITE', writeId });
    const st = brain.snapshot();
    expect(st.claims.find((c) => c.id === 'cl-f2-remove')?.predicate).toBe('未编目');
    expect(st.writeQueue).toHaveLength(0);
  });

  it('只删了别种种类的同名槽：写卡留守但确认被兜底拒绝，不写死谓词名', () => {
    const { brain, objectId } = brainWithUncatalogedClaim('cl-f2-cross', '项目', '平台在推进选型');
    brain.dispatch({ type: 'ADD_SLOT', name: '专属槽', kind: '组织', arity: '单值' });
    brain.dispatch({
      type: 'ENQUEUE_WRITE',
      draft: {
        objectId,
        kind: '整理',
        claimId: 'cl-f2-cross',
        targetPredicate: '专属槽',
        headline: '并入「专属槽」',
        evidence: '平台在推进选型',
      },
    });
    // 主张挂在项目对象：组织分区的删槽不撤它——但受控表已无此槽名，确认走回退分支必须被拒。
    brain.dispatch({ type: 'REMOVE_SLOT', name: '专属槽', kind: '组织' });
    const row = brain.snapshot().writeQueue.find((w) => w.kind === '整理');
    expect(row).toBeDefined();

    brain.dispatch({ type: 'CONFIRM_WRITE', writeId: row?.id ?? '' });
    const st = brain.snapshot();
    expect(st.toast?.text).toBe('该槽已不存在，请重新并入');
    expect(st.claims.find((c) => c.id === 'cl-f2-cross')?.predicate).toBe('未编目');
    // 行保留待人工撤下重并，且不改账本。
    expect(st.writeQueue).toHaveLength(1);
  });
});

// M27：AI 提议起草场景——chat 写意图走起草循环，ENQUEUE_WRITE kind '场景' 进 takeover；
// 确认复用 UPSERT 守卫（0025 兜底），免 undo（0058/0057 口径）；驳回即弃。
describe('场景草稿确认（M27）', () => {
  function enqueueScenarioDraft(
    brain: Brain,
    objectId: string,
    template: ScenarioTemplate,
  ): string {
    brain.dispatch({
      type: 'ENQUEUE_WRITE',
      draft: {
        objectId,
        kind: '场景',
        headline: `起草场景模板「${template.name}」`,
        evidence: `起草场景「${template.name}」，盯风险`,
        template,
      },
    });
    const row = brain.snapshot().writeQueue.find((w) => w.kind === '场景');
    if (!row) throw new Error('missing scenario write row');
    return row.id;
  }

  function brainWithObject(): { brain: Brain; objectId: string } {
    const brain = openTmpBrain();
    brain.dispatch({ type: 'ADD_WORKSPACE', name: '起草验收区', scenario: '求职面试' });
    brain.dispatch({ type: 'ADD_OBJECT', kind: '组织', name: '起草对象' });
    return { brain, objectId: brain.snapshot().objects[0]?.id ?? '' };
  }

  it('确认建模板：builtin false、结果卡「已创建场景模板」无 undo、队列清空、重开读回', () => {
    const { brain, objectId } = brainWithObject();
    const writeId = enqueueScenarioDraft(
      brain,
      objectId,
      customTemplate('供应商尽调', {
        briefSpec: [
          { title: '关键事实', kind: 'background' },
          { title: '风险与冲突', kind: 'slots', predicates: ['风险信号'] },
        ],
      }),
    );
    brain.dispatch({ type: 'CONFIRM_WRITE', writeId });
    const st = brain.snapshot();
    const created = st.scenarioTemplates.find((t) => t.name === '供应商尽调');
    expect(created?.builtin).toBe(false);
    expect(created?.briefSpec).toEqual([
      { title: '关键事实', kind: 'background' },
      { title: '风险与冲突', kind: 'slots', predicates: ['风险信号'] },
    ]);
    expect(st.writeQueue).toHaveLength(0);
    const card = (st.chatByObject[objectId] ?? []).find((m) => m.card?.result === '整理');
    expect(card?.text).toBe('已创建场景模板「供应商尽调」');
    expect(card?.card?.undo).toBeUndefined();

    const file = brain.filePath;
    brain.close();
    const again = openBrain(file);
    brains.push(again);
    expect(again.snapshot().scenarioTemplates.some((t) => t.name === '供应商尽调')).toBe(true);
  });

  it('守卫拒绝路径：草稿谓词引用的槽随后被删——确认 toast 拒、模板不建、队列行保留', () => {
    const { brain, objectId } = brainWithObject();
    brain.dispatch({ type: 'ADD_SLOT', name: '履约信号', kind: '组织', arity: '多值' });
    const writeId = enqueueScenarioDraft(
      brain,
      objectId,
      customTemplate('履约跟踪', {
        briefSpec: [
          { title: '关键事实', kind: 'background' },
          { title: '履约信号', kind: 'slots', predicates: ['履约信号'] },
        ],
      }),
    );
    brain.dispatch({ type: 'REMOVE_SLOT', name: '履约信号', kind: '组织' });

    brain.dispatch({ type: 'CONFIRM_WRITE', writeId });
    const st = brain.snapshot();
    expect(st.toast?.text).toBe('简报说明引用了表外字段「履约信号」，请先在谓词表建槽');
    expect(st.scenarioTemplates.some((t) => t.name === '履约跟踪')).toBe(false);
    expect(st.writeQueue).toHaveLength(1);
  });

  it('同名既有模板：确认拒建不覆写，队列行保留', () => {
    const { brain, objectId } = brainWithObject();
    const builtinBefore = brain.snapshot().scenarioTemplates.find((t) => t.name === '技术选型');
    if (!builtinBefore) throw new Error('missing builtin template');
    const writeId = enqueueScenarioDraft(
      brain,
      objectId,
      customTemplate('技术选型', {
        hint: 'AI 起草的仿冒',
        briefSpec: [{ title: '关键事实', kind: 'background' }],
      }),
    );
    brain.dispatch({ type: 'CONFIRM_WRITE', writeId });
    const st = brain.snapshot();
    expect(st.toast?.text).toContain('已有同名场景模板「技术选型」');
    expect(st.scenarioTemplates.find((t) => t.name === '技术选型')?.briefSpec).toEqual(
      builtinBefore.briefSpec,
    );
    expect(st.writeQueue).toHaveLength(1);
  });

  it('驳回即弃：队列清空、结果卡 result 拒绝、模板不建', () => {
    const { brain, objectId } = brainWithObject();
    const writeId = enqueueScenarioDraft(brain, objectId, customTemplate('供应商尽调'));
    brain.dispatch({ type: 'REJECT_WRITE', writeId });
    const st = brain.snapshot();
    expect(st.writeQueue).toHaveLength(0);
    expect(st.scenarioTemplates.some((t) => t.name === '供应商尽调')).toBe(false);
    const card = (st.chatByObject[objectId] ?? []).find((m) => m.card?.result === '拒绝');
    expect(card?.text).toBe('已拒绝这条提议');
  });

  it('草稿挂队列重开读回：template_json 四件套不丢（v9）', () => {
    const { brain, objectId } = brainWithObject();
    const draft = customTemplate('供应商尽调', {
      briefSpec: [{ title: '风险与冲突', kind: 'slots', predicates: ['风险信号'] }],
    });
    enqueueScenarioDraft(brain, objectId, draft);
    const file = brain.filePath;
    brain.close();

    const again = openBrain(file);
    brains.push(again);
    const row = again.snapshot().writeQueue.find((w) => w.kind === '场景');
    expect(row?.template).toEqual(draft);
  });
});

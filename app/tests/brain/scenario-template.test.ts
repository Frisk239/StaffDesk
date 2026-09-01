import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildBrief } from '@shared/brief';
import { builtinScenarioTemplates, DEFAULT_SLOT_DEFS } from '@shared/scenario';
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

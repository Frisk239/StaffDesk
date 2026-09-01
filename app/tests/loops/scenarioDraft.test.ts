import { describe, expect, it } from 'vitest';
import { emptyUiFields } from '@shared/defaults';
import { builtinScenarioTemplates, DEFAULT_SLOT_DEFS } from '@shared/scenario';
import type { State } from '@shared/types';
import { draftScenarioTemplate } from '../../src/main/loops/scenarioDraft';

// M27：场景模板起草循环——注入 complete 造假模型边界（照 memoryExtract.test 模式），不出网。
// 只钉：成功归一（表外谓词过滤、builtin 恒 false）与三态失败返回。

function baseState(): State {
  return {
    ...emptyUiFields(),
    workspaces: [{ id: 'ws-1', name: '区', scenario: '求职面试' }],
    currentWorkspaceId: 'ws-1',
    objects: [
      { id: 'org-1', kind: '组织', name: '验收组织', relationIds: [], workspaceId: 'ws-1' },
    ],
    sources: [],
    claims: [],
    slotDefs: DEFAULT_SLOT_DEFS,
    scenarioTemplates: builtinScenarioTemplates(),
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

const DRAFT_JSON = {
  name: ' 供应商尽调 ',
  hint: ' 盯一个供应商：履约、账期、风险 ',
  playbook:
    '出站纪律：只根据账本里已有主张回答，每句能指回主张。\n未知占位：材料不够就说未知，不准用常识编。',
  blocks: [
    { title: ' 关键事实 ', kind: 'background', predicates: [] },
    { title: '风险与冲突', kind: 'slots', predicates: ['风险信号', ' 表外谓词 ', '风险信号'] },
    { title: '编造的槽', kind: 'slots', predicates: ['完全不在表里的槽'] },
    { title: '材料缺口', kind: 'gaps', predicates: [] },
    { title: '  ', kind: 'synthesis', predicates: [] },
  ],
};

describe('场景模板起草循环', () => {
  it('成功：表外谓词剔除去重、空标题块弃、slots 块剔空整块弃、builtin 恒 false', async () => {
    const result = await draftScenarioTemplate({
      state: baseState(),
      userText: '起草场景「供应商尽调」，盯履约风险',
      complete: async () => ({ content: JSON.stringify(DRAFT_JSON), toolCalls: [] }),
    });
    expect(result.status).toBe('success');
    if (result.status !== 'success') return;
    expect(result.template.name).toBe('供应商尽调');
    expect(result.template.hint).toBe('盯一个供应商：履约、账期、风险');
    expect(result.template.builtin).toBe(false);
    expect(result.template.briefSpec).toEqual([
      { title: '关键事实', kind: 'background' },
      { title: '风险与冲突', kind: 'slots', predicates: ['风险信号'] },
      { title: '材料缺口', kind: 'gaps' },
    ]);
  });

  it('提示里带当前槽名清单与已有模板名（引导 0025 与防重名）', async () => {
    let system = '';
    await draftScenarioTemplate({
      state: baseState(),
      userText: '起草场景「供应商尽调」',
      complete: async (request) => {
        system = request.messages[0]?.content ?? '';
        return { content: JSON.stringify({ name: '供应商尽调' }), toolCalls: [] };
      },
    });
    expect(system).toContain('风险信号');
    expect(system).toContain('后端主栈');
    expect(system).toContain('已有场景模板不要重名');
  });

  it('invalid-output：非 JSON 与结构不符各返回可读说明', async () => {
    const notJson = await draftScenarioTemplate({
      state: baseState(),
      userText: '起草场景「X」',
      complete: async () => ({ content: '这不是 JSON', toolCalls: [] }),
    });
    expect(notJson.status).toBe('invalid-output');
    if (notJson.status === 'invalid-output') expect(notJson.detail).toContain('JSON');

    const badShape = await draftScenarioTemplate({
      state: baseState(),
      userText: '起草场景「X」',
      complete: async () => ({
        content: '{"name":"Y","blocks":[{"title":"b","kind":"nonsense"}]}',
        toolCalls: [],
      }),
    });
    expect(badShape.status).toBe('invalid-output');

    const emptyName = await draftScenarioTemplate({
      state: baseState(),
      userText: '起草场景「X」',
      complete: async () => ({ content: JSON.stringify({ name: '  ' }), toolCalls: [] }),
    });
    expect(emptyName.status).toBe('invalid-output');
    if (emptyName.status === 'invalid-output') expect(emptyName.detail).toContain('场景名');
  });

  it('unconfigured：未配置模型不伪造草稿，返回设置引导', async () => {
    const result = await draftScenarioTemplate({
      state: baseState(),
      userText: '起草场景「供应商尽调」',
    });
    expect(result.status).toBe('unconfigured');
    if (result.status === 'unconfigured') {
      expect(result.detail).toBe('起草场景需要先在设置里配置模型');
    }
  });

  it('failed：模型调用抛错返回脱敏说明', async () => {
    const result = await draftScenarioTemplate({
      state: baseState(),
      userText: '起草场景「供应商尽调」',
      complete: async () => {
        throw new Error('上游 502 Authorization: Bearer sk-secret123');
      },
    });
    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.detail).not.toContain('sk-secret123');
    }
  });
});

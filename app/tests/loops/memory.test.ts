import { describe, expect, it } from 'vitest';
import { emptyUiFields } from '@shared/defaults';
import { builtinScenarioTemplates, DEFAULT_SLOT_DEFS } from '@shared/scenario';
import type { Proposal, State } from '@shared/types';
import {
  extractCandidateMemories,
  shouldConsiderMemoryCandidate,
} from '../../src/main/loops/memoryExtract';
import { dreamMemoryProposals } from '../../src/main/loops/memoryDream';
import { applyAction } from '../../src/main/brain/applyAction';

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
    // 0058：场景模板是账本数据——用种子基线构造（断言依赖内置 spec 的场景必须带内置模板）。
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

describe('候选记忆抽取与 dream', () => {
  it('闲聊和明确记下来不进入候选抽取', async () => {
    expect(shouldConsiderMemoryCandidate('你好')).toBe(false);
    expect(shouldConsiderMemoryCandidate('记下来：简报用条目')).toBe(false);
    expect(shouldConsiderMemoryCandidate('以后回答短一点')).toBe(true);

    const skipped = await extractCandidateMemories({
      state: baseState(),
      objectId: 'org-1',
      userMessages: [{ id: 'msg-1', role: 'user', text: '你好' }],
    });
    expect(skipped.status).toBe('skipped');
    expect(skipped.candidates).toEqual([]);
  });

  it('无模型时不产候选，并返回可展示说明', async () => {
    const result = await extractCandidateMemories({
      state: baseState(),
      objectId: 'org-1',
      userMessages: [{ id: 'msg-1', role: 'user', text: '以后回答短一点' }],
    });
    expect(result.status).toBe('unconfigured');
    expect(result.candidates).toEqual([]);
    expect(result.detail).toMatch(/未配置模型/);
  });

  it('模型候选必须能追溯到用户消息摘录', async () => {
    const result = await extractCandidateMemories({
      state: baseState(),
      objectId: 'org-1',
      userMessages: [{ id: 'msg-7', role: 'user', text: '以后回答短一点，简报也用条目。' }],
      complete: async () => ({
        content: JSON.stringify({
          candidates: [
            {
              text: '回答短一点，简报用条目。',
              memoryKind: '习惯',
              scope: '全局',
              sourceExcerpt: '以后回答短一点，简报也用条目。',
            },
            {
              text: '这条无法追溯。',
              memoryKind: '偏好',
              scope: '全局',
              sourceExcerpt: '不存在的摘录',
            },
          ],
        }),
        toolCalls: [],
      }),
    });
    expect(result.status).toBe('success');
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]?.fromMessageIds).toEqual(['msg-7']);
    expect(result.candidates[0]?.sourceExcerpt).toContain('以后回答短一点');
  });

  it('ADD_CANDIDATE_MEMORIES 只加待确认候选，dream 只去重候选不碰主张', () => {
    const state = applyAction(baseState(), {
      type: 'ADD_CANDIDATE_MEMORIES',
      objectId: 'org-1',
      candidates: [
        {
          kind: '候选记忆',
          text: '回答短一点。',
          memoryKind: '习惯',
          scope: '全局',
          fromObjectId: 'org-1',
          fromMessageIds: ['msg-1'],
          sourceExcerpt: '以后回答短一点',
        },
      ],
    });
    expect(state.proposals).toHaveLength(1);
    expect(state.memories).toHaveLength(0);

    const duplicate: Proposal = {
      ...state.proposals[0]!,
      id: 'prop-dup',
      pending: true,
    };
    const dreamed = dreamMemoryProposals({
      ...state,
      proposals: [...state.proposals, duplicate],
      claims: [
        {
          id: 'cl-1',
          objectId: 'org-1',
          predicate: '未编目',
          text: '验收组织有一个事实。',
          status: '成立',
          unverified: true,
          sourceId: 'src-1',
          createdAt: '2026-08-30',
        },
      ],
    });
    expect(dreamed.changed).toBe(true);
    expect(dreamed.proposals.filter((proposal) => proposal.pending)).toHaveLength(1);
  });
});

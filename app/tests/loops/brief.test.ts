import { describe, expect, it } from 'vitest';
import type { Brief, Claim } from '@shared/types';
import { verifyBrief } from '../../src/main/brain/briefOut';
import { generateBrief } from '../../src/main/loops/briefGen';
import { emptyUiFields } from '@shared/defaults';
import { DEFAULT_SLOT_DEFS } from '@shared/scenario';

const claim: Claim = {
  id: 'cl-1',
  objectId: 'o1',
  predicate: '后端主栈',
  text: '主栈是 Go。',
  status: '成立',
  unverified: true,
  sourceId: 's1',
  createdAt: '2026-08-29',
};

function baseBrief(sentences: Brief['blocks'][number]['sentences']): Brief {
  return {
    id: 'b1',
    objectId: 'o1',
    taskId: 't1',
    createdAt: '2026-08-29',
    blocks: [{ title: '技术信号', sentences }],
  };
}

describe('简报出站闸', () => {
  it('没有 claimId 的句子变成未知占位', () => {
    const out = verifyBrief(
      baseBrief([{ text: '编造的年薪百万', claimIds: [], unverified: false, kind: 'claim' }]),
      [claim],
    );
    expect(out.blocks[0]?.sentences[0]?.kind).toBe('unknown');
    expect(out.blocks[0]?.sentences[0]?.claimIds).toEqual([]);
  });

  it('伪造的 claimId 被拿掉', () => {
    const out = verifyBrief(
      baseBrief([{ text: '主栈是 Go。', claimIds: ['cl-forged'], unverified: false, kind: 'claim' }]),
      [claim],
    );
    expect(out.blocks[0]?.sentences[0]?.kind).toBe('unknown');
  });

  it('未编目不当单边定论', () => {
    const uncat: Claim = { ...claim, id: 'cl-u', predicate: '未编目', text: '平台化' };
    const out = verifyBrief(
      baseBrief([{ text: '平台化', claimIds: ['cl-u'], unverified: true, kind: 'claim' }]),
      [uncat],
    );
    expect(out.blocks[0]?.sentences[0]?.flag).toBe('未编目·不作定论');
  });

  it('LLM 瞎写会被闸门打回未知', async () => {
    const state = {
      ...emptyUiFields(),
      workspaces: [{ id: 'ws', name: '区', scenario: '求职面试' as const }],
      currentWorkspaceId: 'ws',
      objects: [{ id: 'o1', kind: '组织' as const, name: '甲', relationIds: [], workspaceId: 'ws' }],
      sources: [],
      claims: [claim],
      slotDefs: DEFAULT_SLOT_DEFS,
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
    const brief = await generateBrief({
      state,
      objectId: 'o1',
      briefId: 'b',
      taskId: 't',
      complete: async () => ({
        content: JSON.stringify({
          blocks: [{ title: '技术信号', sentences: [{ text: '年薪百万', claimIds: [] }] }],
        }),
        toolCalls: [],
      }),
    });
    const sentences = brief.blocks.flatMap((b) => b.sentences);
    for (const s of sentences) {
      if (s.claimIds.length === 0) expect(s.kind).toBe('unknown');
    }
    expect(JSON.stringify(brief)).not.toMatch(/年薪百万/);
  });
});

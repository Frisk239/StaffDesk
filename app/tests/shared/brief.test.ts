import { describe, expect, it } from 'vitest';
import type { Claim, Source, State } from '@shared/types';
import { buildBrief, primarySourceIdsOf, wrapUncataloged } from '@shared/brief';
import { briefToMarkdown } from '@shared/briefMarkdown';
import { verifyBrief } from '../../src/main/brain/briefOut';
import { generateBrief } from '../../src/main/loops/briefGen';
import { emptyUiFields } from '@shared/defaults';
import { builtinScenarioTemplates, DEFAULT_SLOT_DEFS } from '@shared/scenario';

// 0062 简报主键标注：按当前对象视角取绑定角色——主张的来源绑定是主键才标，
// 独立字段 primarySourceIds，不进 flag 联合（出站闸重写 flag 的路径不得吞掉它）。

function sourceOf(id: string, boundObjectIds: string[], roles?: Record<string, '主键'>): Source {
  const source: Source = {
    id,
    title: `来源${id}`,
    body: '正文',
    path: '手给',
    boundObjectIds,
    workspaceId: 'ws',
  };
  if (roles) source.bindingRoles = roles;
  return source;
}

function claimOf(id: string, objectId: string, sourceId: string, text: string): Claim {
  return {
    id,
    objectId,
    predicate: '后端主栈',
    text,
    status: '成立',
    unverified: false,
    sourceId,
    validFrom: '2024-01-01',
    createdAt: '2024-01-01',
  };
}

function stateWith(sources: Source[], claims: Claim[]): State {
  return {
    ...emptyUiFields(),
    workspaces: [{ id: 'ws', name: '区', scenario: '求职面试' }],
    currentWorkspaceId: 'ws',
    objects: [
      { id: 'o1', kind: '组织', name: '甲', relationIds: [], workspaceId: 'ws' },
      { id: 'o2', kind: '组织', name: '乙', relationIds: [], workspaceId: 'ws' },
    ],
    sources,
    claims,
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

function sentencesOf(state: State, objectId: string, claimId: string) {
  const brief = buildBrief(state, objectId);
  return brief.blocks.flatMap((block) =>
    block.sentences.filter((sentence) => sentence.claimIds.includes(claimId)),
  );
}

describe('简报主键标注（0062）', () => {
  it('主键绑定来源的主张句列出该来源；转述来源的主张句不标', () => {
    const state = stateWith(
      [sourceOf('s1', ['o1'], { o1: '主键' }), sourceOf('s2', ['o1'])],
      [claimOf('cl-1', 'o1', 's1', '甲主栈是 Go'), claimOf('cl-2', 'o1', 's2', '甲使用 Kafka')],
    );
    expect(sentencesOf(state, 'o1', 'cl-1')[0]?.primarySourceIds).toEqual(['s1']);
    expect(sentencesOf(state, 'o1', 'cl-2')[0]?.primarySourceIds).toBeUndefined();
  });

  it('同一来源对另一对象是主键、对本对象是转述：按当前对象视角', () => {
    // s1 同时绑定 o1/o2，只有 o2 的绑定是主键；各对象只看自己的角色。
    const state = stateWith(
      [sourceOf('s1', ['o1', 'o2'], { o2: '主键' })],
      [claimOf('cl-1', 'o1', 's1', '甲主栈是 Go'), claimOf('cl-2', 'o2', 's1', '乙主栈是 Go')],
    );
    expect(sentencesOf(state, 'o1', 'cl-1')[0]?.primarySourceIds).toBeUndefined();
    expect(sentencesOf(state, 'o2', 'cl-2')[0]?.primarySourceIds).toEqual(['s1']);
  });

  it('冲突摊开的双方各自带主键标注，不因冲突丢字段', () => {
    const state = stateWith(
      [sourceOf('s1', ['o1'], { o1: '主键' }), sourceOf('s2', ['o1'])],
      [claimOf('cl-1', 'o1', 's1', '甲主栈是 Go'), claimOf('cl-2', 'o1', 's2', '甲主栈是 Rust')],
    );
    const brief = buildBrief(state, 'o1');
    const conflictSentences = brief.blocks
      .flatMap((block) => block.sentences)
      .filter((sentence) => sentence.flag === '冲突·并排');
    expect(conflictSentences).toHaveLength(2);
    expect(
      conflictSentences.find((sentence) => sentence.claimIds.includes('cl-1'))?.primarySourceIds,
    ).toEqual(['s1']);
    expect(
      conflictSentences.find((sentence) => sentence.claimIds.includes('cl-2'))?.primarySourceIds,
    ).toBeUndefined();
  });

  it('使用者陈述不是来源绑定，不标主键', () => {
    const state = stateWith([], [claimOf('cl-u', 'o1', 'user-stmt', '甲主栈是 Go')]);
    expect(sentencesOf(state, 'o1', 'cl-u')[0]?.primarySourceIds).toBeUndefined();
    expect(primarySourceIdsOf(state, ['cl-u'])).toBeUndefined();
  });

  it('LLM 组句按 claimIds 从账本回填主键标注，不丢', async () => {
    const state = stateWith(
      [sourceOf('s1', ['o1'], { o1: '主键' })],
      [claimOf('cl-1', 'o1', 's1', '甲主栈是 Go')],
    );
    const brief = await generateBrief({
      state,
      objectId: 'o1',
      briefId: 'b',
      taskId: 't',
      complete: async () => ({
        content: JSON.stringify({
          blocks: [
            {
              title: '技术信号',
              sentences: [{ text: '主栈是 Go。', claimIds: ['cl-1'] }],
            },
          ],
        }),
        toolCalls: [],
      }),
    });
    const sentence = brief.blocks
      .flatMap((block) => block.sentences)
      .find((item) => item.claimIds.includes('cl-1'));
    expect(sentence?.primarySourceIds).toEqual(['s1']);
  });

  it('出站闸未编目降级重写 flag 时保留主键标注', () => {
    const state = stateWith(
      [sourceOf('s1', ['o1'], { o1: '主键' })],
      [{ ...claimOf('cl-u', 'o1', 's1', '甲在做平台化'), predicate: '未编目' }],
    );
    const brief = buildBrief(state, 'o1');
    const degraded = verifyBrief(brief, state.claims)
      .blocks.flatMap((block) => block.sentences)
      .find((sentence) => sentence.claimIds.includes('cl-u'));
    expect(degraded?.flag).toBe('未编目·不作定论');
    expect(degraded?.primarySourceIds).toEqual(['s1']);
  });
});

function wrapCount(text: string): number {
  return Math.max(
    (text.match(/材料提到：/g) ?? []).length,
    (text.match(/（未编目，不作定论）/g) ?? []).length,
  );
}

function uncatalogedTexts(brief: ReturnType<typeof buildBrief>): string[] {
  return brief.blocks.flatMap((block) =>
    block.sentences.filter((s) => s.flag === '未编目·不作定论').map((s) => s.text),
  );
}

describe('未编目降级幂等（0037）', () => {
  it('wrapUncataloged 对已包装句子是 no-op，不特判整句', () => {
    const once = wrapUncataloged('走查样例-0903 是一家测试组织。');
    expect(wrapCount(once)).toBe(1);
    expect(wrapUncataloged(once)).toBe(once);
    expect(wrapUncataloged(`材料提到：${once}（未编目，不作定论）`)).toBe(once);
  });

  it('buildBrief、一次净化、重复净化输出同一句', () => {
    const state = stateWith(
      [sourceOf('s1', ['o1'])],
      [{ ...claimOf('cl-u', 'o1', 's1', '走查样例-0903 是一家测试组织'), predicate: '未编目' }],
    );
    const built = buildBrief(state, 'o1');
    const once = verifyBrief(built, state.claims);
    const twice = verifyBrief(once, state.claims);
    const builtTexts = uncatalogedTexts(built);
    const onceTexts = uncatalogedTexts(once);
    const twiceTexts = uncatalogedTexts(twice);
    expect(builtTexts).toHaveLength(1);
    expect(onceTexts).toEqual(builtTexts);
    expect(twiceTexts).toEqual(onceTexts);
    for (const text of onceTexts) expect(wrapCount(text)).toBe(1);
  });

  it('Markdown 复制口径也只包装一次', () => {
    const state = stateWith(
      [sourceOf('s1', ['o1'])],
      [{ ...claimOf('cl-u', 'o1', 's1', '走查样例-0903 是一家测试组织'), predicate: '未编目' }],
    );
    const brief = verifyBrief(verifyBrief(buildBrief(state, 'o1'), state.claims), state.claims);
    const markdown = briefToMarkdown({
      brief,
      objectName: '走查样例-0903',
      headLine: '出简报',
      claims: state.claims,
      sources: state.sources,
    });
    expect(wrapCount(markdown)).toBe(1);
  });
});

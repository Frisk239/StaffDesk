import { describe, expect, it } from 'vitest';
import { DEFAULT_SLOT_DEFS } from '@shared/scenario';
import type { DeskObject, Source } from '@shared/types';
import { draftsToClaims, idempotencyKey, mapPredicate, runExtractLoop } from '../../src/main/loops/extract';

const org: DeskObject = {
  id: 'org-1',
  kind: '组织',
  name: '验收组织',
  relationIds: [],
  workspaceId: 'ws-1',
};

const source: Source = {
  id: 'src-1',
  title: 'JD',
  body: '该公司在招后端实习。团队主栈是 Go。团队正在推进内部平台化。',
  path: '手给',
  boundObjectIds: ['org-1'],
};

describe('主张抽取循环 0024', () => {
  it('映射不上受控槽记未编目；指不回片段的丢掉', () => {
    const claims = draftsToClaims({
      drafts: [
        { predicate: '后端主栈', text: '主栈是 Go', span: '团队主栈是 Go' },
        { predicate: '自开槽', text: '平台化', span: '内部平台化' },
        { predicate: '在招岗位', text: '编造的地点', span: '原文没有这句话' },
      ],
      source,
      objects: [org],
      slotDefs: DEFAULT_SLOT_DEFS,
      existing: [],
      now: '2026-08-29',
    });
    expect(claims.some((c) => c.predicate === '后端主栈' && c.unverified)).toBe(true);
    expect(claims.some((c) => c.predicate === '未编目')).toBe(true);
    expect(claims.some((c) => c.text.includes('地点'))).toBe(false);
  });

  it('幂等键相同不追加', () => {
    const first = draftsToClaims({
      drafts: [{ predicate: '后端主栈', text: '主栈是 Go', span: '团队主栈是 Go' }],
      source,
      objects: [org],
      slotDefs: DEFAULT_SLOT_DEFS,
      existing: [],
      now: '2026-08-29',
    });
    const second = draftsToClaims({
      drafts: [{ predicate: '后端主栈', text: '主栈是 Go', span: '团队主栈是 Go' }],
      source,
      objects: [org],
      slotDefs: DEFAULT_SLOT_DEFS,
      existing: first,
      now: '2026-08-29',
    });
    expect(second).toHaveLength(0);
    expect(idempotencyKey('src-1', 'org-1', '后端主栈', '团队主栈是 Go')).toContain('src-1');
  });

  it('未绑定对象不写主张', () => {
    const claims = draftsToClaims({
      drafts: [{ predicate: '后端主栈', text: '主栈是 Go', span: '团队主栈是 Go' }],
      source: { ...source, boundObjectIds: [] },
      objects: [org],
      slotDefs: DEFAULT_SLOT_DEFS,
      existing: [],
      now: '2026-08-29',
    });
    expect(claims).toHaveLength(0);
  });

  it('JSON 校验失败则不写', async () => {
    const claims = await runExtractLoop({
      source,
      objects: [org],
      slotDefs: DEFAULT_SLOT_DEFS,
      existing: [],
      complete: async () => ({ content: 'not-json', toolCalls: [] }),
    });
    expect(claims).toHaveLength(0);
  });

  it('mapPredicate 自开槽 → 未编目', () => {
    expect(mapPredicate('我发明的槽', '组织', DEFAULT_SLOT_DEFS)).toBe('未编目');
    expect(mapPredicate('后端主栈', '组织', DEFAULT_SLOT_DEFS)).toBe('后端主栈');
  });
});

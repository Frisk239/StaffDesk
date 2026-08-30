import { describe, expect, it } from 'vitest';
import { DEFAULT_SLOT_DEFS } from '@shared/scenario';
import type { DeskObject, Source } from '@shared/types';
import {
  draftsToClaims,
  idempotencyKey,
  mapPredicate,
  runExtractLoop,
} from '../../src/main/loops/extract';

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

  it('重抽新主张使用不透明唯一 ID，不与仍在账本的旧主张相撞', () => {
    const first = draftsToClaims({
      drafts: [
        { predicate: '后端主栈', text: '主栈是 Go', span: '团队主栈是 Go' },
        { predicate: '未编目', text: '正在推进平台化', span: '内部平台化' },
      ],
      source,
      objects: [org],
      slotDefs: DEFAULT_SLOT_DEFS,
      existing: [],
      now: '2026-08-29',
    });
    const kept = first[0];
    if (!kept) throw new Error('首轮抽取失败');

    const retry = draftsToClaims({
      drafts: [
        { predicate: '后端主栈', text: '主栈是 Go', span: '团队主栈是 Go' },
        { predicate: '未编目', text: '正在推进平台化', span: '内部平台化' },
      ],
      source,
      objects: [org],
      slotDefs: DEFAULT_SLOT_DEFS,
      existing: [kept],
      now: '2026-08-29',
    });

    expect(retry).toHaveLength(1);
    expect(retry[0]?.id).toMatch(/^cl-x-/);
    expect(retry[0]?.id).not.toBe(kept.id);
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
    const result = await runExtractLoop({
      source,
      objects: [org],
      slotDefs: DEFAULT_SLOT_DEFS,
      existing: [],
      complete: async () => ({ content: 'not-json', toolCalls: [] }),
    });
    expect(result.status).toBe('invalid-output');
    expect(result.claims).toHaveLength(0);
    expect(result.detail).toContain('JSON');
  });

  it('兼容代码围栏，并把对象和允许槽写进模型指令', async () => {
    let system = '';
    const result = await runExtractLoop({
      source,
      objects: [org],
      slotDefs: DEFAULT_SLOT_DEFS,
      existing: [],
      complete: async (request) => {
        system = request.messages[0]?.content ?? '';
        return {
          content:
            '```json\n{"claims":[{"objectName":"验收组织","predicate":"后端主栈","text":"验收组织的团队主栈是 Go","span":"团队主栈是 Go"}]}\n```',
          toolCalls: [],
        };
      },
    });
    expect(result.status).toBe('success');
    expect(result.claims).toHaveLength(1);
    expect(result.draftCount).toBe(1);
    expect(system).toContain('组织「验收组织」');
    expect(system).toContain('组织可用槽名：');
    expect(system).toContain('后端主栈');
  });

  it('未配置与调用失败是不同终态', async () => {
    const unconfigured = await runExtractLoop({
      source,
      objects: [org],
      slotDefs: DEFAULT_SLOT_DEFS,
      existing: [],
    });
    const failed = await runExtractLoop({
      source,
      objects: [org],
      slotDefs: DEFAULT_SLOT_DEFS,
      existing: [],
      complete: async () => {
        throw new Error('endpoint unavailable');
      },
    });
    expect(unconfigured.status).toBe('unconfigured');
    expect(failed.status).toBe('failed');
    expect(failed.detail).toContain('endpoint unavailable');
  });

  it('mapPredicate 自开槽 → 未编目', () => {
    expect(mapPredicate('我发明的槽', '组织', DEFAULT_SLOT_DEFS)).toBe('未编目');
    expect(mapPredicate('后端主栈', '组织', DEFAULT_SLOT_DEFS)).toBe('后端主栈');
  });
});

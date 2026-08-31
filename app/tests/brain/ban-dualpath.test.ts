import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { bannedHit } from '@shared/brief';
import { normalizeValue } from '@shared/scenario';
import type { Claim, State } from '@shared/types';
import { openBrain } from '../../src/main/brain';
import { outboundBrief } from '../../src/main/brain/briefOut';
import { completeExtraction } from '../helpers/extraction';

const dirs: string[] = [];

function tmpBrain() {
  const dir = mkdtempSync(join(tmpdir(), 'staffdesk-brain-'));
  dirs.push(dir);
  return join(dir, 'brain.db');
}

afterEach(() => {
  while (dirs.length) {
    const dir = dirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function setup() {
  const brain = openBrain(tmpBrain());
  brain.dispatch({ type: 'ADD_WORKSPACE', name: '验收区', scenario: '求职面试' });
  brain.dispatch({ type: 'ADD_OBJECT', kind: '组织', name: '甲组织' });
  const obj = brain.snapshot().objects[0];
  if (!obj) throw new Error('无对象');
  brain.dispatch({
    type: 'ADD_SOURCE',
    title: 'JD',
    body: '团队主栈是 Go。团队同时维护一个 Rust 工具链。',
  });
  const source = brain.snapshot().sources.find((s) => !s.virtual);
  if (!source) throw new Error('无来源');
  brain.dispatch({ type: 'BIND_CONFIRMED', sourceId: source.id, objectIds: [obj.id] });
  completeExtraction(brain, source.id, [
    { predicate: '后端主栈', text: '团队主栈是 Go', span: '团队主栈是 Go' },
    {
      predicate: '使用技术',
      text: '团队同时维护一个 Rust 工具链',
      span: '团队同时维护一个 Rust 工具链',
    },
  ]);
  return { brain, obj, source };
}

function mainStackClaim(st: State): Claim {
  const claim = st.claims.find((c) => c.predicate === '后端主栈' && c.text.includes('Go'));
  if (!claim) throw new Error('主栈主张未落账');
  return claim;
}

describe('禁写双路（0054）', () => {
  it('纠正已晋升主张后，禁写携带结构化三字段：对象、谓词槽、归一化取值', () => {
    const { brain, obj } = setup();
    const claim = mainStackClaim(brain.snapshot());
    brain.dispatch({ type: 'PROMOTE_CLAIM', claimId: claim.id });
    brain.dispatch({
      type: 'CORRECT_CLAIM',
      claimId: claim.id,
      closeReason: '从未成立',
      newText: '甲组织后端主栈已改为 Rust。',
    });
    const st = brain.snapshot();
    const ban = st.memories.find((m) => m.kind === '禁写');
    expect(ban).toBeDefined();
    expect(ban?.bannedObjectId).toBe(obj.id);
    expect(ban?.bannedPredicate).toBe('后端主栈');
    expect(ban?.bannedValue).toBe(normalizeValue(claim.text));
    brain.close();
  });

  it('结构化路拦住仅格式不同的复述；旧格式禁写行原句路继续兜住原句', () => {
    const { brain } = setup();
    const claim = mainStackClaim(brain.snapshot());
    brain.dispatch({ type: 'PROMOTE_CLAIM', claimId: claim.id });
    brain.dispatch({
      type: 'CORRECT_CLAIM',
      claimId: claim.id,
      closeReason: '从未成立',
      newText: '甲组织后端主栈已改为 Rust。',
    });
    const st = brain.snapshot();
    // 换格式复述：大小写上移 + 尾随空白——归一化等值，子串路必不命中。
    const restated: Claim = { ...claim, id: 'cl-restated', text: `${claim.text.toUpperCase()} ` };
    expect(st.memories.some((m) => m.text.includes(restated.text))).toBe(false);
    expect(bannedHit(st, restated)).toBe(true);
    // 旧行回归：迁移前只有 text 的禁写行，结构化列缺失，原句路必须兜住原句本身。
    const legacy: State = {
      ...st,
      memories: [
        {
          id: 'mem-legacy',
          scope: '全局',
          kind: '禁写',
          text: `出站不得再写：「${claim.text}」（关闭原因：世界已变）`,
          createdAt: '2026-08-30',
        },
      ],
    };
    expect(bannedHit(legacy, claim)).toBe(true);
    expect(bannedHit(legacy, restated)).toBe(false);
    brain.close();
  });

  it('端到端：重放换格式主张，出站闸与提议闸都拦；替代新句不误拦', () => {
    const { brain, obj } = setup();
    const claim = mainStackClaim(brain.snapshot());
    brain.dispatch({ type: 'PROMOTE_CLAIM', claimId: claim.id });
    brain.dispatch({
      type: 'CORRECT_CLAIM',
      claimId: claim.id,
      closeReason: '从未成立',
      newText: '甲组织后端主栈已改为 Rust。',
    });
    // 重放：同来源再交一条仅格式不同的主张（span 置空穿幂等键）。
    const restated: Claim = {
      ...claim,
      id: 'cl-restated',
      text: `${claim.text.toUpperCase()} `,
      status: '成立',
      unverified: true,
      validTo: undefined,
      closeReason: undefined,
      supersededBy: undefined,
      span: undefined,
      sourceStart: undefined,
      sourceEnd: undefined,
      sourceLocator: undefined,
    };
    brain.dispatch({ type: 'EXTRACT_DONE', sourceId: claim.sourceId, claims: [restated] });
    const replayed = brain.snapshot().claims.find((c) => c.id === restated.id);
    expect(replayed).toBeDefined();
    const brief = outboundBrief(brain.snapshot(), obj.id, 'brief-ban', 'task-ban');
    const text = brief.blocks
      .flatMap((block) => block.sentences)
      .map((sentence) => sentence.text)
      .join('\n');
    expect(text.includes(restated.text.trim())).toBe(false);
    // 提议闸：晋升重放主张被拒，队列不增。
    const before = brain.snapshot().writeQueue.length;
    brain.dispatch({
      type: 'ENQUEUE_WRITE',
      draft: {
        objectId: obj.id,
        kind: '晋升',
        claimId: replayed?.id ?? restated.id,
        headline: `晋升「${restated.text}」`,
        evidence: '禁写双路测试',
      },
    });
    expect(brain.snapshot().writeQueue.length).toBe(before);
    // 替代新句（使用者陈述）不误拦：纠正产出的新主张可以出站。
    const replacement = brain
      .snapshot()
      .claims.find((c) => c.text === '甲组织后端主栈已改为 Rust。');
    expect(replacement).toBeDefined();
    expect(bannedHit(brain.snapshot(), replacement!)).toBe(false);
    brain.close();
  });
});

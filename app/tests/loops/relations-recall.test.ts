import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { State } from '@shared/types';
import { openBrain, type Brain } from '../../src/main/brain';
import { recallClaims, relatedObjectIds, RECALL_LIMIT } from '../../src/main/loops/readonlyTools';
import { runSessionTurn } from '../../src/main/loops/session';
import { completeExtraction } from '../helpers/extraction';

const brains: Brain[] = [];
const dirs: string[] = [];

function track(b: Brain): Brain {
  brains.push(b);
  return b;
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
    const d = dirs.pop();
    if (d) {
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {
        /* lock */
      }
    }
  }
});

interface SeedOptions {
  orgClaimCount?: number;
  personClaimCount?: number;
}

/** 组织 + 人两对象，各绑各的来源各抽主张；可选是否建关系。 */
function seed(opts: SeedOptions & { relate: boolean }) {
  const dir = mkdtempSync(join(tmpdir(), 'sd-relations-recall-'));
  dirs.push(dir);
  const brain = track(openBrain(join(dir, 'brain.db')));
  brain.dispatch({ type: 'ADD_WORKSPACE', name: '区', scenario: '求职面试' });
  brain.dispatch({ type: 'ADD_OBJECT', kind: '组织', name: '甲组织' });
  brain.dispatch({ type: 'ADD_OBJECT', kind: '人', name: '甲人物' });
  const objects = brain.snapshot().objects;
  const org = objects.find((o) => o.kind === '组织');
  const person = objects.find((o) => o.kind === '人');
  if (!org || !person) throw new Error('对象未写入');

  const orgCount = opts.orgClaimCount ?? 2;
  const personCount = opts.personClaimCount ?? 2;
  // 幂等键 = source+object+predicate+span 起点，span 必须逐条不同，否则塌成一条。
  const orgSpans = Array.from({ length: orgCount }, (_, i) => `组织主张${i}号`);
  const personSpans = Array.from({ length: personCount }, (_, i) => `人物主张${i}号`);

  brain.dispatch({
    type: 'ADD_SOURCE',
    title: '组织材料',
    body: orgSpans.map((s) => `${s}。`).join(''),
  });
  brain.dispatch({
    type: 'ADD_SOURCE',
    title: '人物材料',
    body: personSpans.map((s) => `${s}。`).join(''),
  });
  const sources = brain.snapshot().sources.filter((s) => !s.virtual);
  const orgSource = sources.find((s) => s.title === '组织材料');
  const personSource = sources.find((s) => s.title === '人物材料');
  if (!orgSource || !personSource) throw new Error('来源未写入');
  brain.dispatch({ type: 'BIND_CONFIRMED', sourceId: orgSource.id, objectIds: [org.id] });
  brain.dispatch({ type: 'BIND_CONFIRMED', sourceId: personSource.id, objectIds: [person.id] });
  completeExtraction(
    brain,
    orgSource.id,
    orgSpans.map((span, i) => ({
      objectName: '甲组织',
      predicate: '在招岗位',
      text: i === 0 ? '甲组织在招后端实习' : `甲组织${i}季度有产出`,
      span,
    })),
  );
  completeExtraction(
    brain,
    personSource.id,
    personSpans.map((span, i) => ({
      objectName: '甲人物',
      predicate: '未编目测试',
      text: i === 0 ? '甲人物供职于甲组织' : `甲人物${i}月主导评审`,
      span,
    })),
  );
  if (opts.relate) {
    brain.dispatch({ type: 'ADD_RELATION', objectId: org.id, targetId: person.id });
  }
  return { brain, org, person, orgSource, personSource };
}

describe('召回一跳（关系边进语境）', () => {
  it('relatedObjectIds 任一方向的边都算邻居，悬边跳过', () => {
    const { brain, org, person } = seed({ relate: true });
    const state = brain.snapshot();
    expect(relatedObjectIds(state, org.id)).toEqual([person.id]);
    expect(relatedObjectIds(state, person.id)).toEqual([org.id]);
    const dangling: State = {
      ...state,
      objects: state.objects.map((o) => ({ ...o, relationIds: [...o.relationIds, 'org-幽灵'] })),
    };
    expect(relatedObjectIds(dangling, org.id)).toEqual([person.id]);
  });

  it('本对象优先、一跳补位，一跳条目带 objectName、本对象条目不带', () => {
    const { brain, org, person } = seed({ relate: true });
    const out = recallClaims(brain.snapshot(), org.id, '');
    expect(out.length).toBe(4);
    expect(out.slice(0, 2).every((e) => !e.objectName)).toBe(true);
    expect(out.slice(2).every((e) => e.objectName === '甲人物')).toBe(true);
    const state = brain.snapshot();
    expect(out.slice(2).map((e) => e.id)).toEqual(
      state.claims.filter((c) => c.objectId === person.id).map((c) => c.id),
    );
  });

  it('一跳查询过滤同口径：带问句时只补带出命中词的主张', () => {
    const { brain, org } = seed({ relate: true, orgClaimCount: 1, personClaimCount: 2 });
    const out = recallClaims(brain.snapshot(), org.id, '供职');
    expect(out.map((e) => e.text)).toEqual(['甲人物供职于甲组织。']);
    expect(out[0]?.objectName).toBe('甲人物');
  });

  it('关联对象的未绑定来源主张不进语境', () => {
    const { brain, org, person, personSource } = seed({ relate: true });
    brain.dispatch({ type: 'UNBIND_SOURCE', sourceId: personSource.id, objectId: person.id });
    const out = recallClaims(brain.snapshot(), org.id, '');
    expect(out.every((e) => !e.objectName)).toBe(true);
  });

  it('总上限仍 12：本对象吃满位置时一跳不进来', () => {
    const { brain, org } = seed({ relate: true, orgClaimCount: 12, personClaimCount: 3 });
    const out = recallClaims(brain.snapshot(), org.id, '');
    expect(out.length).toBe(RECALL_LIMIT);
    expect(out.every((e) => !e.objectName)).toBe(true);
  });

  it('不足上限时一跳补位到 12，超出部分不带出', () => {
    const { brain, org } = seed({ relate: true, orgClaimCount: 10, personClaimCount: 5 });
    const out = recallClaims(brain.snapshot(), org.id, '');
    expect(out.length).toBe(RECALL_LIMIT);
    expect(out.slice(0, 10).every((e) => !e.objectName)).toBe(true);
    expect(out.slice(10).every((e) => e.objectName === '甲人物')).toBe(true);
  });

  it('没有关系时行为与旧一致：只有本对象主张、无 objectName', () => {
    const { brain, org } = seed({ relate: false });
    const out = recallClaims(brain.snapshot(), org.id, '');
    expect(out.length).toBe(2);
    expect(out.every((e) => e.objectName === undefined)).toBe(true);
  });

  it('会话引用白名单含一跳主张 id：引用关联对象主张可点', async () => {
    const { brain, org } = seed({ relate: true });
    const state = brain.snapshot();
    // 查询词取两边主张文本共有的「甲组织」，验证一跳与本体同进白名单。
    // 按文本取 id：claims 读回序不保证，find(objectId) 会抓到另一条不含查询词的主张。
    const relatedClaim = state.claims.find((c) => c.text === '甲人物供职于甲组织。');
    const ownClaim = state.claims.find((c) => c.text === '甲组织在招后端实习。');
    if (!relatedClaim || !ownClaim) throw new Error('主张未写入');
    const reply = await runSessionTurn(state, org.id, '甲组织', {
      db: brain.db,
      complete: async () => ({
        content: `组织侧见 [ref:${ownClaim.id}]；人物侧见 [ref:${relatedClaim.id}]`,
        toolCalls: [],
      }),
    });
    expect(reply.claimRefs).toContain(ownClaim.id);
    expect(reply.claimRefs).toContain(relatedClaim.id);
  });

  it('会话 prompt 的一跳条目带「（关联·对象名）」标注', async () => {
    const { brain, org } = seed({ relate: true });
    const state = brain.snapshot();
    let systemPrompt = '';
    await runSessionTurn(state, org.id, '主栈', {
      complete: async (req) => {
        systemPrompt = String(req.messages[0]?.content ?? '');
        return { content: '好', toolCalls: [] };
      },
    });
    expect(systemPrompt).toContain('（关联·甲人物）');
  });
});

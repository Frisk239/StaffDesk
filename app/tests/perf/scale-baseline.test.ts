import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { afterEach, describe, expect, it } from 'vitest';
import { emptyUiFields } from '@shared/defaults';
import type { Claim, State } from '@shared/types';
import { applyAction } from '../../src/main/brain/applyAction';
import { openBrain, type Brain } from '../../src/main/brain';

// F6（M34）：规模基线——5k 主张下 snapshot+dispatch 的全量广播成本可观测，未来增量化有基线。
// 阈值是数量级护栏而非精确度量：只防算法退化（O(n²)/意外全表广播），环境抖动不该红；
// 超线红说明 dispatch 链路出现了规模性回归。数字口径见各常量注释（本机实测留档）。

const CLAIM_COUNT = 5_000;

/** 纯 reducer 层：轻 action 批量（MARK_TURN_PLAYED，claims 数组不动）宽松上限。 */
const LIGHT_ACTIONS = 50;
const LIGHT_BUDGET_MS = 1_000;
/** 纯 reducer 层：UPDATE 类重 action 批量（PROMOTE_CLAIM，5k claims 全量 map + 结果卡）。 */
const HEAVY_ACTIONS = 20;
const HEAVY_BUDGET_MS = 2_000;
/** 全链路层：临时库灌 5k 主张后，轻 + 重混合 dispatch 的总耗时上限。 */
const FULL_CHAIN_ACTIONS = 5;
const FULL_CHAIN_BUDGET_MS = 5_000;

const dirs: string[] = [];
const brains: Brain[] = [];

afterEach(() => {
  while (brains.length) {
    try {
      brains.pop()?.close();
    } catch {
      /* already closed */
    }
  }
  while (dirs.length) {
    const dir = dirs.pop();
    if (dir) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* windows lock */
      }
    }
  }
});

function scaleClaims(count: number): Claim[] {
  // 构造先例 relations-recall.test.ts：幂等键含 span，逐条不同防塌并。
  return Array.from({ length: count }, (_, i) => ({
    id: `cl-${i}`,
    objectId: 'obj-1',
    predicate: '未编目测试',
    text: `规模主张${i}号`,
    status: '成立',
    unverified: true,
    sourceId: 'src-1',
    span: `规模主张${i}号`,
    createdAt: '2026-09-01',
  }));
}

function scaleState(): State {
  return {
    workspaces: [{ id: 'ws-1', name: '规模基线区', scenario: '求职面试' }],
    currentWorkspaceId: 'ws-1',
    objects: [
      { id: 'obj-1', kind: '组织', name: '规模组织', relationIds: [], workspaceId: 'ws-1' },
    ],
    sources: [
      { id: 'src-1', title: '规模材料', body: '', path: '手给', boundObjectIds: ['obj-1'] },
    ],
    claims: scaleClaims(CLAIM_COUNT),
    slotDefs: [],
    scenarioTemplates: [],
    briefs: [],
    memories: [],
    inbox: [],
    proposals: [],
    tasks: [],
    taskAudits: [],
    chatByObject: {
      'obj-1': [
        {
          id: 'msg-d1',
          role: 'desk',
          text: '基线占位',
          turn: {
            tools: [],
            think: { runningTitle: '', doneTitle: '', summary: '', body: '' },
            played: false,
          },
        },
      ],
    },
    seq: 2,
    onboardingDone: true,
    ...emptyUiFields(),
  };
}

describe('规模基线：5k 主张下 dispatch 链路（数量级护栏）', () => {
  it(`纯 reducer 层：${LIGHT_ACTIONS} 次轻 action（MARK_TURN_PLAYED）总耗时低于宽松上限`, () => {
    const base = scaleState();
    const start = performance.now();
    let state = base;
    for (let i = 0; i < LIGHT_ACTIONS; i += 1) {
      state = applyAction(state, {
        type: 'MARK_TURN_PLAYED',
        objectId: 'obj-1',
        messageId: 'msg-d1',
      });
    }
    const elapsed = performance.now() - start;
    expect(state.claims.length).toBe(CLAIM_COUNT);
    // 本机实测（2026-09-02，dev 机 Electron-as-node）：50 次约 2ms 量级；上限放三个数量级防环境抖动。
    expect(elapsed).toBeLessThan(LIGHT_BUDGET_MS);
  });

  it(`纯 reducer 层：${HEAVY_ACTIONS} 次 UPDATE 类重 action（PROMOTE_CLAIM）总耗时低于宽松上限`, () => {
    const base = scaleState();
    const start = performance.now();
    let state = base;
    for (let i = 0; i < HEAVY_ACTIONS; i += 1) {
      // 每次 base 起步晋升不同 claim：避免结果卡累积把耗时归因到卡片数组而非 claims map。
      state = applyAction(base, { type: 'PROMOTE_CLAIM', claimId: `cl-${i}` });
    }
    const elapsed = performance.now() - start;
    expect(state.claims.find((c) => c.id === `cl-${HEAVY_ACTIONS - 1}`)?.unverified).toBe(false);
    // 本机实测（2026-09-02，dev 机 Electron-as-node）：20 次约 1.3ms 量级（base 起步各晋升一条，
    // 耗时归因 5k claims map + 结果卡，不含卡片累积）；上限放三个数量级防环境抖动。
    expect(elapsed).toBeLessThan(HEAVY_BUDGET_MS);
  });

  it(`全链路层：临时库灌 ${CLAIM_COUNT} 主张后 ${FULL_CHAIN_ACTIONS} 次轻/重混合 dispatch 总耗时低于宽松上限`, () => {
    const dir = mkdtempSync(join(tmpdir(), 'staffdesk-scale-baseline-'));
    dirs.push(dir);
    const brain = openBrain(join(dir, 'brain.db'));
    brains.push(brain);
    brain.dispatch({ type: 'ADD_WORKSPACE', name: '规模基线区', scenario: '求职面试' });
    brain.dispatch({ type: 'ADD_OBJECT', kind: '组织', name: '规模组织' });
    const objectId = brain.snapshot().objects[0]!.id;
    // body 非空才真落来源（ADD_SOURCE 对空 body 静默不动）。
    brain.dispatch({ type: 'ADD_SOURCE', title: '规模材料', body: '规模材料正文。' });
    const sourceId = brain.snapshot().sources.find((s) => !s.virtual)!.id;
    brain.dispatch({ type: 'BIND_CONFIRMED', sourceId, objectIds: [objectId] });
    brain.dispatch({ type: 'CHAT_APPEND_DESK', objectId, text: '基线占位' });
    const deskId = brain.snapshot().chatByObject[objectId]![0]!.id;
    brain.dispatch({
      type: 'EXTRACT_DONE',
      sourceId,
      claims: scaleClaims(CLAIM_COUNT).map((claim) => ({ ...claim, objectId, sourceId })),
    });
    expect(brain.snapshot().claims.length).toBe(CLAIM_COUNT);

    const start = performance.now();
    brain.dispatch({ type: 'MARK_TURN_PLAYED', objectId, messageId: deskId });
    const claimIds = brain
      .snapshot()
      .claims.slice(0, FULL_CHAIN_ACTIONS - 1)
      .map((c) => c.id);
    for (const claimId of claimIds) {
      brain.dispatch({ type: 'PROMOTE_CLAIM', claimId });
    }
    const elapsed = performance.now() - start;
    // 本机实测（2026-09-02，dev 机 Electron-as-node）：1 轻 + 4 重约 98ms（每次 PROMOTE 走
    // loadLedger 5k 行读回 + claims 表主键三分 + FTS 触发器单行 UPDATE）；上限放两个数量级防 CI 抖动，
    // 数量级护栏非精确度量——超线说明链路出现 O(n²) 级回归而非机器慢。
    expect(elapsed).toBeLessThan(FULL_CHAIN_BUDGET_MS);
  });
});

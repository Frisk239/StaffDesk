import type { Action } from '@shared/actions';
import type { Claim, RightTab, State } from '@shared/types';
import { deriveConflicts } from '@shared/scenario';
import { claimActions } from './claimActions';
import { objectChatActions } from './objectChatActions';
import { proposalActions } from './proposalActions';
import { slotTemplateActions } from './slotTemplateActions';
import { sourceActions } from './sourceActions';
import { taskActions } from './taskActions';
import { writeQueueActions } from './writeQueueActions';

// · 账本规则（必须落在 reducer / 纯函数里，不是画在 UI 上） ·
// 1. 未绑定来源不投影、不进对象对话默认语境：投影与对话都只读 claims，
//    而 claims 只有 EXTRACT_DONE（绑定确认之后）才会写入。
// 2. 绑定须人确认：只有 BIND_CONFIRMED 才入队抽取；没有自动绑定路径。
// 3. 闲聊不 push claim：CHAT_SEND 分支永远不改 claims。
// 4. 「记下来」立刻写 memory；纠正立刻关窗 + 禁写。
// 5. 未编目不建冲突：冲突完全派生（0029），只在受控单值槽主张间按互斥判定算出。
// 6. 简报只读当时能出站的主张：buildBrief 只从 claims 组句，无 claimId 的句子只能是 unknown 占位。
// 7. 禁写命中的措辞不得再当单边定论：buildBrief 过滤禁写命中。
// 8. 未知格子保持空：投影槽无主张时只有「未知」占位，代码里没有 fallback 文案。

export type { Action };

// M34 D2：80 个 case 按域拆进 7 个域文件，本文件只剩分发壳与既有导出（纯搬运，行为零变化）。
// 域处理器返回 undefined 表示「不归本域」；CONFIRM_WRITE/UNDO_RESULT 的递归 dispatch 经
// 注入的 reducer 参数回调本入口，域文件不得 import 本壳（防循环）。
export function reducer(state: State, action: Action): State {
  return (
    sourceActions(state, action) ??
    claimActions(state, action) ??
    writeQueueActions(state, action, reducer) ??
    proposalActions(state, action) ??
    taskActions(state, action) ??
    slotTemplateActions(state, action) ??
    objectChatActions(state, action) ??
    state
  );
}

export { reducer as applyAction };

export function projectionClaims(state: State, objectId: string): Claim[] {
  const bound = new Set(
    state.sources.filter((s) => s.boundObjectIds.includes(objectId)).map((s) => s.id),
  );
  bound.add('user-stmt');
  return state.claims.filter(
    (c) => c.objectId === objectId && c.status !== '过时' && bound.has(c.sourceId),
  );
}

export function closedClaims(state: State, objectId: string): Claim[] {
  return state.claims.filter((c) => c.objectId === objectId && c.status === '过时');
}

export function isExtracting(state: State, objectId: string): boolean {
  const bound = state.sources.filter((s) => s.boundObjectIds.includes(objectId)).map((s) => s.id);
  return state.extractJobs.some((j) => bound.includes(j.sourceId) && j.status === '抽取中');
}

/** 0029：冲突派生——同对象同单值槽互斥主张，关窗后自动消失。 */
export function conflictsOf(state: State, claimId: string): Claim[] {
  const self = state.claims.find((c) => c.id === claimId);
  if (!self || self.status === '过时') return [];
  const out: Claim[] = [];
  for (const c of deriveConflicts(state.claims, state.slotDefs)) {
    if (c.claimIdA === claimId) {
      const b = state.claims.find((x) => x.id === c.claimIdB);
      if (b) out.push(b);
    }
    if (c.claimIdB === claimId) {
      const a = state.claims.find((x) => x.id === c.claimIdA);
      if (a) out.push(a);
    }
  }
  return out.filter((c) => c.status !== '过时');
}

export function tabsFor(state: State, objectId: string): RightTab[] {
  return state.rightTabsByObject[objectId] ?? [];
}

export function activeTabIdFor(state: State, objectId: string): string | null {
  return state.activeRightTabByObject[objectId] ?? null;
}

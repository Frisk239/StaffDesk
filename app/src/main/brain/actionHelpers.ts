import type { Action } from '@shared/actions';
import type {
  ChatCard,
  ChatMessage,
  ObjectKind,
  Predicate,
  RightTab,
  RightTabKind,
  State,
  WriteProposal,
} from '@shared/types';
import { bannedHit } from '@shared/brief';
import { bindingRole, shouldSuggestPrimary } from '@shared/primarySource';

// 跨动作域共享的 reducer 基础 helper（M34 D2 自 applyAction 拆出）：只放被多个动作域
// 共用的写入原语与判定；本文件不得 import 任何动作域文件，域文件反向依赖本文件。

/** 递归 dispatch 注入口：域处理器经此回调分发壳入口，域文件不得反向 import 壳。 */
export type ReducerFn = (state: State, action: Action) => State;

export function nextId(state: State, prefix: string): [string, number] {
  const n = state.seq;
  return [`${prefix}-${n}`, n + 1];
}

export function pushChat(
  state: State,
  objectId: string,
  msg: ChatMessage,
): Record<string, ChatMessage[]> {
  const list = state.chatByObject[objectId] ?? [];
  return { ...state.chatByObject, [objectId]: [...list, msg] };
}

export function pushCard(state: State, objectId: string, card: ChatCard, text = ''): State {
  const [id, seq] = nextId(state, 'msg');
  const msg: ChatMessage = { id, role: 'card', text, card };
  return {
    ...state,
    seq,
    chatByObject: pushChat({ ...state, seq }, objectId, msg),
    selectedClaimId: card.claimId ?? state.selectedClaimId,
    view: { kind: 'object', objectId },
  };
}

export function tabsOf(state: State, objectId: string): RightTab[] {
  return state.rightTabsByObject[objectId] ?? [];
}

export function patchTabs(
  state: State,
  objectId: string,
  tabs: RightTab[],
  active: string | null,
): State {
  return {
    ...state,
    rightTabsByObject: { ...state.rightTabsByObject, [objectId]: tabs },
    activeRightTabByObject: { ...state.activeRightTabByObject, [objectId]: active },
  };
}

export function ensureTab(
  state: State,
  objectId: string,
  kind: RightTabKind,
  focus: boolean,
): State {
  const tabs = tabsOf(state, objectId);
  const existing = tabs.find((t) => t.kind === kind);
  if (existing) {
    const active = focus ? existing.id : (state.activeRightTabByObject[objectId] ?? existing.id);
    return patchTabs(state, objectId, tabs, active);
  }
  const tab: RightTab = { id: `tab-${kind}-${objectId}`, kind };
  const nextTabs = [...tabs, tab];
  const active = focus ? tab.id : (state.activeRightTabByObject[objectId] ?? tab.id);
  return patchTabs(state, objectId, nextTabs, active);
}

export function openObject(state: State, objectId: string): State {
  return ensureTab(
    { ...state, view: { kind: 'object', objectId } },
    objectId,
    '档案',
    !state.activeRightTabByObject[objectId],
  );
}

/** 0025：受控谓词表是数据（state.slotDefs），整理只能并入表内已有槽。 */
export function slotIsControlled(state: State, name: Predicate): boolean {
  return state.slotDefs.some((d) => d.name === name);
}

/** 0057：同名槽在不同种类分区各占一行（UNIQUE(name,kind)）；主张归属按其对象种类落到唯一分区。
 *  对象已删（孤儿历史主张）时无从判分区，跟随槽名走，不得静默漏改。 */
export function claimBelongsToSlotKind(state: State, objectId: string, kind: ObjectKind): boolean {
  const obj = state.objects.find((o) => o.id === objectId);
  return obj === undefined || obj.kind === kind;
}

export function enqueueWrite(state: State, draft: Omit<WriteProposal, 'id'>): State {
  if ((draft.kind === '晋升' || draft.kind === '纠正' || draft.kind === '整理') && !draft.claimId) {
    return {
      ...state,
      toast: { text: '无出处的写提议不许生成', id: state.seq },
      seq: state.seq + 1,
    };
  }
  if (
    (draft.kind === '批量晋升' || draft.kind === '批量回退') &&
    !(draft.claimIds && draft.claimIds.length > 0)
  ) {
    return {
      ...state,
      toast: { text: '无出处的写提议不许生成', id: state.seq },
      seq: state.seq + 1,
    };
  }
  if (draft.kind === '绑定' && !draft.sourceId) {
    return {
      ...state,
      toast: { text: '无出处的写提议不许生成', id: state.seq },
      seq: state.seq + 1,
    };
  }
  if (draft.kind === '设角色' && (!draft.sourceId || !draft.role)) {
    return {
      ...state,
      toast: { text: '无出处的写提议不许生成', id: state.seq },
      seq: state.seq + 1,
    };
  }
  const claim = draft.claimId ? state.claims.find((c) => c.id === draft.claimId) : undefined;
  if (
    claim &&
    bannedHit(state, claim) &&
    (draft.kind === '晋升' || draft.kind === '纠正' || draft.kind === '整理')
  ) {
    return {
      ...state,
      toast: { text: '命中禁写，不许把这句话写回来', id: state.seq },
      seq: state.seq + 1,
    };
  }
  if (
    draft.kind === '整理' &&
    draft.targetPredicate &&
    !slotIsControlled(state, draft.targetPredicate)
  ) {
    return {
      ...state,
      toast: { text: '不许自开谓词槽，只能并入已有槽', id: state.seq },
      seq: state.seq + 1,
    };
  }
  const [id, seq] = nextId(state, 'wr');
  return { ...state, seq, writeQueue: [...state.writeQueue, { ...draft, id }] };
}

/** 0062：绑定时域名启发只进 takeover，人点才写角色，永不自动定。 */
export function maybeEnqueuePrimarySuggestions(
  state: State,
  sourceId: string,
  objectIds: string[],
): State {
  const source = state.sources.find((item) => item.id === sourceId);
  if (!source) return state;
  let next = state;
  for (const objectId of objectIds) {
    if (bindingRole(source, objectId) === '主键') continue;
    const object = next.objects.find((item) => item.id === objectId);
    if (!object || !shouldSuggestPrimary(source, object, next.claims)) continue;
    const queued = next.writeQueue.some(
      (write) =>
        write.kind === '设角色' &&
        write.sourceId === sourceId &&
        write.objectId === objectId &&
        write.role === '主键',
    );
    if (queued) continue;
    next = enqueueWrite(next, {
      objectId,
      kind: '设角色',
      sourceId,
      role: '主键',
      headline: '建议标为主键？',
      evidence: [
        `来源「${source.title}」的域名与「${object.name}」的官网或主页一致。`,
        '确认后按当前对象标为主键；拒绝则保持转述。系统不会自动定。',
      ].join('\n'),
    });
  }
  return next;
}

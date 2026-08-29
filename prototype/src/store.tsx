import { createContext, useContext, useReducer } from 'react';
import type { Dispatch, ReactNode } from 'react';
import type {
  Brief,
  ChatCard,
  ChatMessage,
  CloseReason,
  Claim,
  LlmProvider,
  ObjectKind,
  RightTab,
  Predicate,
  RightTabKind,
  ScenarioKind,
  State,
  ThemePreference,
  ThinkingEffort,
  View,
  WriteProposal,
} from './types';
import { allSources, makeInitialState, seedPendingClaims } from './seed';
import { bannedHit, buildBrief } from './brief';
import { deriveConflicts } from './scenario';
import { scriptReply } from './chat';
import { attachTurn } from './turn';

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

export type Action =
  | { type: 'SET_VIEW'; view: View }
  | { type: 'BIND_CONFIRMED'; sourceId: string; objectIds: string[] }
  | { type: 'EXTRACT_DONE'; sourceId: string }
  | { type: 'OPEN_AUDIT_CARD'; claimId: string }
  | { type: 'OPEN_CORRECT_CARD'; claimId: string }
  | { type: 'OPEN_PROPOSAL_CARD'; proposalId: string }
  | { type: 'DISMISS_CARD'; objectId: string; messageId: string }
  | { type: 'FOCUS_SOURCE'; sourceId: string }
  | {
      type: 'CORRECT_CLAIM';
      claimId: string;
      closeReason: CloseReason;
      newText?: string;
    }
  | { type: 'PROMOTE_CLAIM'; claimId: string }
  | { type: 'GENERATE_BRIEF_START'; objectId: string }
  | { type: 'GENERATE_BRIEF_DONE' }
  | { type: 'CHAT_SEND'; objectId: string; text: string }
  | { type: 'PROPOSAL_DECIDE'; proposalId: string; decision: 'accept-merge' | 'accept-drop' | 'reject' }
  | { type: 'ADD_SOURCE'; title: string; body: string; fromUrl?: boolean; unparsed?: boolean }
  | { type: 'TOAST'; text: string | null }
  | { type: 'SELECT_CLAIM'; claimId: string | null }
  | { type: 'SET_THEME'; preference: ThemePreference }
  | { type: 'UPSERT_PROVIDER'; provider: LlmProvider }
  | { type: 'REMOVE_PROVIDER'; id: string }
  | { type: 'SET_ACTIVE_PROVIDER'; id: string }
  | { type: 'SET_ACTIVE_MODEL'; id: string }
  | { type: 'SET_THINKING'; effort: ThinkingEffort }
  | { type: 'OPEN_RIGHT_TAB'; objectId: string; kind: RightTabKind }
  | { type: 'CLOSE_RIGHT_TAB'; objectId: string; id: string }
  | { type: 'FOCUS_RIGHT_TAB'; objectId: string; id: string }
  | { type: 'SWITCH_WORKSPACE'; id: string }
  | { type: 'ADD_WORKSPACE'; name: string; scenario: ScenarioKind }
  | { type: 'REMOVE_WORKSPACE'; id: string }
  | { type: 'ADD_OBJECT'; kind: ObjectKind; name: string }
  | { type: 'ARCHIVE_OBJECT'; id: string }
  | { type: 'UNARCHIVE_OBJECT'; id: string }
  | { type: 'DELETE_OBJECT'; id: string }
  | { type: 'RESTORE_OBJECT'; id: string } // 0032：孤儿/归档对象恢复进当前工作区
  | { type: 'ADD_SLOT'; name: string; kind: ObjectKind; arity: '单值' | '多值' } // 0025：谓词表由人维护
  | { type: 'ENQUEUE_WRITE'; draft: Omit<WriteProposal, 'id'> }
  | { type: 'CONFIRM_WRITE'; writeId: string; closeReason?: CloseReason; newText?: string }
  | { type: 'REJECT_WRITE'; writeId: string }
  | { type: 'UNDO_RESULT'; objectId: string; messageId: string }
  | { type: 'REMOVE_MEMORY'; id: string }
  | { type: 'TEST_PROVIDER'; id: string }
  | { type: 'CERT_DONE'; id: string }
  | { type: 'MARK_TURN_PLAYED'; objectId: string; messageId: string };

function nextId(state: State, prefix: string): [string, number] {
  const n = state.seq;
  return [`${prefix}-${n}`, n + 1];
}

function pushChat(state: State, objectId: string, msg: ChatMessage): Record<string, ChatMessage[]> {
  const list = state.chatByObject[objectId] ?? [];
  return { ...state.chatByObject, [objectId]: [...list, msg] };
}

function pushCard(state: State, objectId: string, card: ChatCard, text = ''): State {
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

function tabsOf(state: State, objectId: string): RightTab[] {
  return state.rightTabsByObject[objectId] ?? [];
}

function patchTabs(state: State, objectId: string, tabs: RightTab[], active: string | null): State {
  return {
    ...state,
    rightTabsByObject: { ...state.rightTabsByObject, [objectId]: tabs },
    activeRightTabByObject: { ...state.activeRightTabByObject, [objectId]: active },
  };
}

function ensureTab(state: State, objectId: string, kind: RightTabKind, focus: boolean): State {
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

function openObject(state: State, objectId: string): State {
  return ensureTab({ ...state, view: { kind: 'object', objectId } }, objectId, '档案', !state.activeRightTabByObject[objectId]);
}

/** 0025：受控谓词表是数据（state.slotDefs），整理只能并入表内已有槽。 */
function slotIsControlled(state: State, name: Predicate): boolean {
  return state.slotDefs.some((d) => d.name === name);
}

function enqueueWrite(state: State, draft: Omit<WriteProposal, 'id'>): State {
  if ((draft.kind === '晋升' || draft.kind === '纠正' || draft.kind === '整理') && !draft.claimId) {
    return { ...state, toast: { text: '无出处的写提议不许生成', id: state.seq }, seq: state.seq + 1 };
  }
  if ((draft.kind === '批量晋升' || draft.kind === '批量回退') && !(draft.claimIds && draft.claimIds.length > 0)) {
    return { ...state, toast: { text: '无出处的写提议不许生成', id: state.seq }, seq: state.seq + 1 };
  }
  if (draft.kind === '绑定' && !draft.sourceId) {
    return { ...state, toast: { text: '无出处的写提议不许生成', id: state.seq }, seq: state.seq + 1 };
  }
  const claim = draft.claimId ? state.claims.find((c) => c.id === draft.claimId) : undefined;
  if (claim && bannedHit(state, claim) && (draft.kind === '晋升' || draft.kind === '纠正' || draft.kind === '整理')) {
    return { ...state, toast: { text: '命中禁写，不许把这句话写回来', id: state.seq }, seq: state.seq + 1 };
  }
  if (draft.kind === '整理' && draft.targetPredicate && !slotIsControlled(state, draft.targetPredicate)) {
    return { ...state, toast: { text: '不许自开谓词槽，只能并入已有槽', id: state.seq }, seq: state.seq + 1 };
  }
  // TODO(待拍板 §10) 任务级白名单「本任务内允许晋升」先不做。
  const [id, seq] = nextId(state, 'wr');
  return { ...state, seq, writeQueue: [...state.writeQueue, { ...draft, id }] };
}

function proposalObjectId(state: State, proposalId: string): string | null {
  const p = state.proposals.find((x) => x.id === proposalId);
  if (!p) return null;
  if (p.payload.kind === '候选记忆') return p.payload.fromObjectId ?? null;
  if (p.payload.kind === '丢弃未核') {
    const dropHead = p.payload.claimIds[0];
    return state.claims.find((c) => c.id === dropHead)?.objectId
      ?? state.pendingClaims.find((c) => c.id === dropHead)?.objectId
      ?? null;
  }
  const claimId = p.payload.claimId;
  return state.claims.find((c) => c.id === claimId)?.objectId
    ?? state.pendingClaims.find((c) => c.id === claimId)?.objectId
    ?? null;
}

export function reducer(state: State, action: Action): State {
  switch (action.type) {
    case 'SET_VIEW': {
      if (action.view.kind === 'object') {
        return openObject({ ...state, selectedClaimId: state.selectedClaimId }, action.view.objectId);
      }
      return { ...state, view: action.view };
    }

    case 'BIND_CONFIRMED': {
      const source = state.sources.find((s) => s.id === action.sourceId);
      if (!source || action.objectIds.length === 0) return state;
      let seq = state.seq;
      let sources = state.sources.map((s) =>
        s.id === action.sourceId ? { ...s, boundObjectIds: action.objectIds } : s,
      );
      let jobs = [...state.extractJobs, { sourceId: action.sourceId, status: '抽取中' as const }];
      if (action.sourceId === 'src-jd' && !sources.some((s) => s.id === 'src-web')) {
        const web = allSources.find((s) => s.id === 'src-web');
        if (!web) return state;
        const orgId = action.objectIds.find((id) => id.startsWith('org-')) ?? action.objectIds[0];
        sources = [...sources, { ...web, boundObjectIds: [orgId] }];
        jobs = [...jobs, { sourceId: 'src-web', status: '抽取中' as const }];
        seq += 1;
      }
      const objectId = action.objectIds.find((id) => id.startsWith('org-')) ?? action.objectIds[0];
      let next = openObject(
        {
          ...state,
          seq,
          sources,
          inbox: state.inbox.filter((id) => id !== action.sourceId),
          extractJobs: jobs,
          toast: { text: '已绑定，抽取中', id: seq },
        },
        objectId,
      );
      next = ensureTab(next, objectId, '来源', false);
      return pushCard(
        next,
        objectId,
        { kind: '结果', result: '绑定', undo: { kind: '绑定', sourceId: action.sourceId } },
        `已绑定 ${action.objectIds.length} 个对象 · 抽取中`,
      );
    }

    case 'EXTRACT_DONE': {
      const incoming = state.pendingClaims.filter((c) => c.sourceId === action.sourceId);
      const jobs = state.extractJobs.map((j) => (j.sourceId === action.sourceId ? { ...j, status: '完成' as const } : j));
      const src = state.sources.find((s) => s.id === action.sourceId);
      // 绑定被撤销后迟到的抽取完成：来源已不在绑定态，只清理作业，不写入、不弹卡。
      if (!src || src.boundObjectIds.length === 0) {
        return { ...state, extractJobs: jobs, pendingClaims: state.pendingClaims.filter((c) => c.sourceId !== action.sourceId) };
      }
      const objectId = src.boundObjectIds[0];
      if (incoming.length === 0) {
        let next: State = { ...state, extractJobs: jobs };
        if (objectId) {
          next = pushCard(next, objectId, { kind: '结果', result: '抽取' }, '未抽出可核对命题，未写入账本');
        }
        return next;
      }
      const now = new Date().toISOString().slice(0, 10);
      const claims = [...state.claims, ...incoming.map((c) => ({ ...c, createdAt: now }))];
      let next: State = {
        ...state,
        claims,
        pendingClaims: state.pendingClaims.filter((c) => c.sourceId !== action.sourceId),
        extractJobs: jobs,
        toast: { text: `抽出 ${incoming.length} 条主张，全部未核`, id: state.seq },
        seq: state.seq + 1,
      };
      if (objectId) {
        const claimObjIds = [...new Set(incoming.map((c) => c.objectId))];
        const bound = src?.boundObjectIds ?? [];
        const hit = claimObjIds.some((id) => bound.includes(id));
        let text = `抽出 ${incoming.length} 条主张，全部未核`;
        if (!hit && bound.length > 0) {
          const claimNames = claimObjIds.map((id) => state.objects.find((o) => o.id === id)?.name ?? id).join('、');
          const boundNames = bound.map((id) => state.objects.find((o) => o.id === id)?.name ?? id).join('、');
          text += `。主张挂在「${claimNames}」，本次绑定的是「${boundNames}」`;
        }
        next = pushCard(
          next,
          objectId,
          { kind: '结果', result: '抽取', claimIds: incoming.map((c) => c.id) },
          text,
        );
      }
      return next;
    }

    case 'OPEN_AUDIT_CARD': {
      const claim = state.claims.find((c) => c.id === action.claimId);
      if (!claim) return state;
      return pushCard(openObject(state, claim.objectId), claim.objectId, { kind: '审计', claimId: claim.id });
    }

    case 'OPEN_CORRECT_CARD': {
      const claim = state.claims.find((c) => c.id === action.claimId);
      if (!claim) return state;
      return enqueueWrite(openObject(state, claim.objectId), {
        objectId: claim.objectId,
        kind: '纠正',
        claimId: claim.id,
        headline: `纠正「${claim.text}」`,
        evidence: claim.span ?? claim.text,
      });
    }

    case 'OPEN_PROPOSAL_CARD': {
      // 候选记忆与「丢弃未核」不走对话流决策（仓位在待确认页），此入口只对并入类整理提议开放。
      const prop = state.proposals.find((p) => p.id === action.proposalId);
      const objectId = proposalObjectId(state, action.proposalId);
      if (prop?.payload.kind === '丢弃未核') {
        return { ...state, toast: { text: '丢弃类提议请在待确认页处理', id: state.seq }, seq: state.seq + 1 };
      }
      if (!prop || !objectId || prop.payload.kind !== '整理') {
        return { ...state, toast: { text: '这条提议没有对应对象', id: state.seq }, seq: state.seq + 1 };
      }
      return enqueueWrite(openObject(state, objectId), {
        objectId,
        kind: '整理',
        claimId: prop.payload.claimId,
        targetPredicate: prop.payload.targetPredicate,
        headline: `并入「${prop.payload.targetPredicate}」`,
        evidence: prop.detail,
      });
    }

    case 'DISMISS_CARD': {
      const list = (state.chatByObject[action.objectId] ?? []).filter((m) => m.id !== action.messageId);
      return { ...state, chatByObject: { ...state.chatByObject, [action.objectId]: list } };
    }

    case 'FOCUS_SOURCE': {
      const source = state.sources.find((s) => s.id === action.sourceId);
      const objectId =
        (state.view.kind === 'object' ? state.view.objectId : null) ?? source?.boundObjectIds[0] ?? null;
      if (!objectId) return { ...state, sourceFocusId: action.sourceId };
      return ensureTab({ ...openObject(state, objectId), sourceFocusId: action.sourceId }, objectId, '来源', true);
    }

    case 'CORRECT_CLAIM': {
      const old = state.claims.find((c) => c.id === action.claimId);
      if (!old) return state;
      const today = new Date().toISOString().slice(0, 10);
      // 0037：未核主张被纠正直接丢弃，不写禁写——禁写只保护已出过站的定论。
      if (old.unverified) {
        let seq = state.seq + 1;
        let claims = state.claims.filter((c) => c.id !== old.id);
        let newId: string | undefined;
        if (action.newText && action.newText.trim()) {
          [newId, seq] = nextId({ ...state, seq }, 'cl');
          claims = [
            ...claims,
            {
              id: newId,
              objectId: old.objectId,
              predicate: old.predicate,
              text: action.newText.trim(),
              status: '成立' as const,
              unverified: false,
              validFrom: today,
              sourceId: 'user-stmt',
              createdAt: today,
            },
          ];
        }
        const next: State = {
          ...state,
          seq,
          claims,
          toast: { text: '未核主张已丢弃，未写禁写', id: seq + 1 },
        };
        return pushCard(
          next,
          old.objectId,
          { kind: '结果', claimId: old.id, result: '整理', undo: { kind: '整理丢弃', claim: { ...old } } },
          newId ? '未核旧句已丢弃，你的新句已记入（未写禁写）' : '已丢弃（未核主张，不写禁写）',
        );
      }
      // 已晋升（出过站）：关窗 + 必填关闭原因 + 禁写（0006）。
      let seq = state.seq + 1;
      let claims = state.claims.map((c) =>
        c.id === old.id
          ? {
              ...c,
              status: '过时' as const,
              validTo: today,
              closeReason: action.closeReason,
            }
          : c,
      );
      let newId: string | undefined;
      if (action.newText && action.newText.trim()) {
        [newId, seq] = nextId({ ...state, seq }, 'cl');
        claims = [
          ...claims,
          {
            id: newId,
            objectId: old.objectId,
            predicate: old.predicate,
            text: action.newText.trim(),
            status: '成立' as const,
            unverified: false,
            validFrom: today,
            sourceId: 'user-stmt',
            createdAt: today,
          },
        ];
        claims = claims.map((c) => (c.id === old.id ? { ...c, supersededBy: newId } : c));
      }
      const memId = `mem-${seq}`;
      // 禁写粒度是精确子串。
      let next: State = {
        ...state,
        seq: seq + 1,
        claims,
        memories: [
          ...state.memories,
          {
            id: memId,
            scope: '全局',
            kind: '禁写',
            text: `出站不得再写：「${old.text}」（关闭原因：${action.closeReason}）`,
            createdAt: today,
          },
        ],
        toast: { text: '已纠正，禁写已生效', id: seq + 1 },
      };
      // 0034：补偿载荷=重开旧句 + 移除禁写 + 配套新句一并关窗（Q4 原子性）。
      return pushCard(
        next,
        old.objectId,
        { kind: '结果', claimId: old.id, result: '关窗', undo: { kind: '关窗', claimId: old.id, memoryId: memId, companionId: newId } },
        `已关窗 · ${action.closeReason} · 禁写已生效`,
      );
    }

    case 'PROMOTE_CLAIM': {
      const claim = state.claims.find((c) => c.id === action.claimId);
      if (!claim) return state;
      const next: State = {
        ...state,
        claims: state.claims.map((c) => (c.id === action.claimId ? { ...c, unverified: false } : c)),
        toast: { text: '已晋升', id: state.seq },
        seq: state.seq + 1,
      };
      return pushCard(
        next,
        claim.objectId,
        { kind: '结果', claimId: claim.id, result: '晋升', undo: { kind: '晋升', claimId: claim.id } },
        '已晋升，简报不再带未核',
      );
    }

    case 'GENERATE_BRIEF_START':
      return { ...state, briefDraftingFor: action.objectId };

    case 'GENERATE_BRIEF_DONE': {
      if (!state.briefDraftingFor) return state;
      const objectId = state.briefDraftingFor;
      const [taskId, seq1] = nextId(state, 'task');
      const [briefId, seq2] = nextId({ ...state, seq: seq1 }, 'brief');
      const createdAt = new Date().toISOString().replace('T', ' ').slice(0, 16);
      const brief: Brief = buildBrief(state, objectId, briefId, taskId);
      brief.createdAt = createdAt;
      const unverifiedClaims = state.claims.filter((c) => c.objectId === objectId && c.unverified && c.status === '成立');
      let next: State = {
        ...state,
        seq: seq2,
        tasks: [
          ...state.tasks,
          { id: taskId, objectId, kind: '出简报', status: '已完成', createdAt },
        ],
        briefs: [...state.briefs, brief],
        briefDraftingFor: null,
        view: { kind: 'object', objectId },
        toast: { text: '简报已生成', id: seq2 },
      };
      next = ensureTab(next, objectId, '简报', true);
      next = pushCard(
        next,
        objectId,
        { kind: '结果', briefId, result: '简报' },
        `简报已出 · ${brief.blocks.length} 块 · ${unverifiedClaims.length} 条未核`,
      );
      // 0016：任务结束可对本任务未核全部晋升或保持——唯一的批量白名单，以 takeover 提议出现。
      // 0016：任务结束可对本任务未核全部晋升或保持——唯一的批量白名单，以 takeover 提议出现。
      if (unverifiedClaims.length > 0) {
        next = enqueueWrite(next, {
          objectId,
          kind: '批量晋升',
          claimIds: unverifiedClaims.map((c) => c.id),
          headline: `本任务未核 ${unverifiedClaims.length} 条：全部晋升，还是全部保持？`,
          evidence: unverifiedClaims.map((c) => `· ${c.text}`).join('\n'),
          outbound: true,
        });
      }
      return next;
    }

    case 'CHAT_SEND': {
      const { text } = action;
      const userMsg: ChatMessage = { id: `msg-${state.seq}`, role: 'user', text };
      let st: State = { ...state, seq: state.seq + 1, chatByObject: pushChat(state, action.objectId, userMsg) };
      const result = scriptReply(st, action.objectId, text);
      const deskMsg: ChatMessage = attachTurn(
        st,
        action.objectId,
        {
          id: `msg-${st.seq}`,
          role: 'desk',
          text: result.replyText,
          claimRefs: result.claimRefs,
          note: result.note,
        },
        text,
        result.effect,
      );
      st = { ...st, seq: st.seq + 1, chatByObject: pushChat(st, action.objectId, deskMsg) };
      switch (result.effect?.type) {
        case 'propose': {
          const effect = result.effect;
          if (!effect || effect.type !== 'propose') break;
          st = enqueueWrite(st, effect.draft);
          break;
        }
        case 'refuse': {
          break;
        }
        case 'remember': {
          const effect = result.effect;
          if (!effect || effect.type !== 'remember') break;
          const dup = st.memories.some((m) => m.text === effect.text);
          const memId = `mem-${st.seq}`;
          if (!dup) {
            st = {
              ...st,
              memories: [
                ...st.memories,
                {
                  id: memId,
                  scope: '全局',
                  kind: effect.kind,
                  text: effect.text,
                  createdAt: new Date().toISOString().slice(0, 10),
                },
              ],
              seq: st.seq + 1,
            };
          }
          st = pushCard(
            st,
            action.objectId,
            { kind: '结果', result: '记忆', undo: dup ? undefined : { kind: '记忆', memoryId: memId } },
            dup ? '这条已经记过，未再写入' : '已记下，立刻生效',
          );
          break;
        }
        case 'correct': {
          const effect = result.effect;
          if (!effect || effect.type !== 'correct') break;
          const c = st.claims.find((x) => x.id === effect.claimId);
          if (c) {
            st = enqueueWrite(st, {
              objectId: c.objectId,
              kind: '纠正',
              claimId: c.id,
              headline: `纠正「${c.text}」`,
              evidence: c.span ?? c.text,
            });
          }
          break;
        }
        case 'toast': {
          st = { ...st, toast: { text: result.effect.text, id: st.seq }, seq: st.seq + 1 };
          break;
        }
      }
      return st;
    }

    case 'PROPOSAL_DECIDE': {
      const prop = state.proposals.find((p) => p.id === action.proposalId);
      if (!prop || !prop.pending) return state;
      const objectId = proposalObjectId(state, action.proposalId);
      if (prop.payload.kind === '候选记忆') {
        if (action.decision === 'reject') {
          return pushCard(
            {
              ...state,
              proposals: state.proposals.map((p) => (p.id === prop.id ? { ...p, pending: false, decision: 'reject' } : p)),
              toast: { text: '已驳回', id: state.seq },
              seq: state.seq + 1,
            },
            objectId ?? state.currentWorkspaceId,
            { kind: '结果', result: '拒绝' },
            '已驳回这条候选记忆',
          );
        }
        const text = prop.payload.text;
        const dup = state.memories.some((m) => m.text === text);
        const scope = prop.payload.scope;
        const memId = `mem-${state.seq}`;
        return pushCard(
          {
            ...state,
            memories: dup
              ? state.memories
              : [
                  ...state.memories,
                  {
                    id: memId,
                    scope,
                    objectId: scope === '对象' ? prop.payload.fromObjectId : undefined,
                    kind: prop.payload.memoryKind,
                    text,
                    createdAt: new Date().toISOString().slice(0, 10),
                  },
                ],
            proposals: state.proposals.map((p) => (p.id === prop.id ? { ...p, pending: false, decision: 'accept-merge' } : p)),
            toast: { text: dup ? '已经在记忆里' : `已写入${scope}记忆`, id: state.seq },
            seq: state.seq + 1,
          },
          objectId ?? state.currentWorkspaceId,
          { kind: '结果', result: '记忆', undo: dup ? undefined : { kind: '记忆', memoryId: memId } },
          dup ? '候选记忆已在记忆里，未再写入' : `已写入${scope}记忆`,
        );
      }
      // 0037：「丢弃未核」提议——未核积压的兜底出口，接受即删、可撤销恢复。
      if (prop.payload.kind === '丢弃未核') {
        if (!objectId) return state;
        const dropIds = prop.payload.claimIds;
        if (action.decision === 'accept-drop') {
          const dropped = state.claims.filter((c) => dropIds.includes(c.id));
          return pushCard(
            {
              ...state,
              claims: state.claims.filter((c) => !dropIds.includes(c.id)),
              proposals: state.proposals.map((p) => (p.id === prop.id ? { ...p, pending: false, decision: 'accept-drop' } : p)),
              toast: { text: `已丢弃 ${dropped.length} 条未核主张`, id: state.seq },
              seq: state.seq + 1,
            },
            objectId,
            {
              kind: '结果',
              claimIds: prop.payload.claimIds,
              result: '整理',
              undo: dropped.length === 1 ? { kind: '整理丢弃', claim: { ...dropped[0]! } } : undefined,
            },
            `已丢弃 ${dropped.length} 条未核主张（派生冲突随之消失）`,
          );
        }
        const decided = action.decision === 'accept-merge' ? 'accept-drop' : 'reject';
        return pushCard(
          {
            ...state,
            proposals: state.proposals.map((p) => (p.id === prop.id ? { ...p, pending: false, decision: decided } : p)),
            toast: { text: '已驳回', id: state.seq },
            seq: state.seq + 1,
          },
          objectId,
          { kind: '结果', result: '拒绝' },
          '已驳回丢弃提议，主张保持未核',
        );
      }
      const tidy = prop.payload;
      if (tidy.kind !== '整理' || !objectId) return state;
      if (action.decision === 'accept-merge') {
        const fromPredicate = state.claims.find((c) => c.id === tidy.claimId)?.predicate;
        const claims = state.claims.map((c) =>
          c.id === tidy.claimId ? { ...c, predicate: tidy.targetPredicate } : c,
        );
        return pushCard(
          {
            ...state,
            claims,
            proposals: state.proposals.map((p) => (p.id === prop.id ? { ...p, pending: false, decision: 'accept-merge' } : p)),
            toast: { text: `已并入「${tidy.targetPredicate}」`, id: state.seq },
            seq: state.seq + 1,
          },
          objectId,
          {
            kind: '结果',
            claimId: tidy.claimId,
            result: '整理',
            undo: fromPredicate ? { kind: '整理并入', claimId: tidy.claimId, fromPredicate } : undefined,
          },
          `已并入「${tidy.targetPredicate}」`,
        );
      }
      if (action.decision === 'accept-drop') {
        const dropped = state.claims.find((c) => c.id === tidy.claimId);
        return pushCard(
          {
            ...state,
            claims: state.claims.filter((c) => c.id !== tidy.claimId),
            proposals: state.proposals.map((p) => (p.id === prop.id ? { ...p, pending: false, decision: 'accept-drop' } : p)),
            toast: { text: '已丢弃', id: state.seq },
            seq: state.seq + 1,
          },
          objectId,
          {
            kind: '结果',
            claimId: tidy.claimId,
            result: '整理',
            undo: dropped ? { kind: '整理丢弃', claim: { ...dropped } } : undefined,
          },
          '已丢弃这条未编目主张',
        );
      }
      return pushCard(
        {
          ...state,
          proposals: state.proposals.map((p) => (p.id === prop.id ? { ...p, pending: false, decision: 'reject' } : p)),
          toast: { text: '已驳回', id: state.seq },
          seq: state.seq + 1,
        },
        objectId,
        { kind: '结果', result: '拒绝' },
        '已驳回这条整理提议',
      );
    }

    case 'ADD_SOURCE': {
      const body = action.body.trim();
      if (!body) return state;
      const [id, seq] = nextId(state, 'src');
      const title = action.title.trim() || (action.fromUrl ? body.split('\n')[0] : body.slice(0, 24) || '粘贴文本');
      return {
        ...state,
        seq,
        sources: [
          ...state.sources,
          {
            id,
            title,
            body,
            path: '手给',
            boundObjectIds: [],
            workspaceId: state.currentWorkspaceId,
            ...(action.unparsed ? { unparsed: true } : {}),
          },
        ],
        inbox: [...state.inbox, id],
        toast: {
          text: action.unparsed ? '文件已收下，成品才解析' : action.fromUrl ? '已收下，成品才抓 URL' : '已加入 Inbox',
          id: seq,
        },
      };
    }

    case 'TOAST':
      // 不在 reducer 里做 seq++ 自增（StrictMode 双 dispatch 会跳号）；派生下一个序号。
      return action.text === null
        ? { ...state, toast: null }
        : { ...state, seq: state.seq + 1, toast: { text: action.text, id: state.seq + 1 } };

    case 'SELECT_CLAIM':
      return { ...state, selectedClaimId: action.claimId };

    case 'SET_THEME':
      return { ...state, themePreference: action.preference };

    case 'UPSERT_PROVIDER': {
      const exists = state.providers.some((p) => p.id === action.provider.id);
      if (exists) {
        const providers = state.providers.map((p) => (p.id === action.provider.id ? action.provider : p));
        const still = providers.find((p) => p.id === state.activeProviderId)?.models.some((m) => m.id === state.activeModelId);
        return { ...state, providers, activeModelId: still ? state.activeModelId : providers.find((p) => p.id === state.activeProviderId)?.models[0]?.id ?? state.activeModelId };
      }
      return { ...state, providers: [...state.providers, action.provider], seq: state.seq + 1 };
    }

    case 'REMOVE_PROVIDER': {
      const providers = state.providers.filter((p) => p.id !== action.id);
      const activeProviderId =
        state.activeProviderId === action.id ? (providers[0]?.id ?? state.activeProviderId) : state.activeProviderId;
      return { ...state, providers, activeProviderId };
    }

    case 'SET_ACTIVE_PROVIDER': {
      const p = state.providers.find((x) => x.id === action.id);
      return {
        ...state,
        activeProviderId: action.id,
        activeModelId: p?.models[0]?.id ?? state.activeModelId,
      };
    }

    case 'SET_ACTIVE_MODEL':
      return { ...state, activeModelId: action.id };

    case 'SET_THINKING':
      return { ...state, thinkingEffort: action.effort };

    case 'OPEN_RIGHT_TAB': {
      return ensureTab(state, action.objectId, action.kind, true);
    }

    case 'CLOSE_RIGHT_TAB': {
      const tabs = tabsOf(state, action.objectId).filter((t) => t.id !== action.id);
      const prev = state.activeRightTabByObject[action.objectId];
      const active = prev === action.id ? (tabs[tabs.length - 1]?.id ?? null) : prev ?? null;
      return patchTabs(state, action.objectId, tabs, active);
    }

    case 'FOCUS_RIGHT_TAB':
      return {
        ...state,
        activeRightTabByObject: { ...state.activeRightTabByObject, [action.objectId]: action.id },
      };

    case 'SWITCH_WORKSPACE':
      if (!state.workspaces.some((w) => w.id === action.id)) return state;
      return {
        ...state,
        currentWorkspaceId: action.id,
        selectedClaimId: null,
        sourceFocusId: null,
        view: { kind: 'inbox' },
      };

    case 'ADD_WORKSPACE': {
      const name = action.name.trim();
      if (!name) return state;
      const [id, seq] = nextId(state, 'ws');
      return {
        ...state,
        seq,
        workspaces: [...state.workspaces, { id, name, scenario: action.scenario }],
        currentWorkspaceId: id,
        view: { kind: 'inbox' },
        selectedClaimId: null,
        sourceFocusId: null,
      };
    }

    case 'ADD_OBJECT': {
      const name = action.name.trim();
      if (!name) return state;
      const [id, seq] = nextId(state, action.kind === '人' ? 'person' : action.kind === '组织' ? 'org' : 'proj');
      const obj = {
        id,
        kind: action.kind,
        name,
        workspaceId: state.currentWorkspaceId,
        relationIds: [] as string[],
      };
      return openObject({ ...state, seq, objects: [...state.objects, obj] }, id);
    }

    case 'REMOVE_WORKSPACE': {
      if (state.workspaces.length <= 1) {
        return { ...state, toast: { text: '至少保留一个工作区', id: state.seq }, seq: state.seq + 1 };
      }
      const rest = state.workspaces.filter((w) => w.id !== action.id);
      const nextIdWs = action.id === state.currentWorkspaceId ? rest[0]!.id : state.currentWorkspaceId;
      const openObj = state.view.kind === 'object' ? state.view.objectId : null;
      const leaving = Boolean(openObj && state.objects.find((o) => o.id === openObj)?.workspaceId === action.id);
      // 0032：对象保留 workspaceId（指向已删区）并归档，成为可从「全部对象」找回的孤儿，不丢主张。
      return {
        ...state,
        workspaces: rest,
        objects: state.objects.map((o) => (o.workspaceId === action.id ? { ...o, archived: true } : o)),
        currentWorkspaceId: nextIdWs,
        view: leaving || action.id === state.currentWorkspaceId ? { kind: 'inbox' } : state.view,
        selectedClaimId: null,
        sourceFocusId: null,
        toast: { text: '工作区已移除', id: state.seq },
        seq: state.seq + 1,
      };
    }

    case 'ARCHIVE_OBJECT': {
      const obj = state.objects.find((o) => o.id === action.id);
      if (!obj) return state;
      const leaving = state.view.kind === 'object' && state.view.objectId === action.id;
      return {
        ...state,
        objects: state.objects.map((o) => (o.id === action.id ? { ...o, archived: true } : o)),
        view: leaving ? { kind: 'inbox' } : state.view,
        selectedClaimId: leaving ? null : state.selectedClaimId,
      };
    }

    case 'UNARCHIVE_OBJECT':
      return {
        ...state,
        objects: state.objects.map((o) => (o.id === action.id ? { ...o, archived: false } : o)),
      };

    case 'ENQUEUE_WRITE':
      return enqueueWrite(state, action.draft);

    case 'CONFIRM_WRITE': {
      const head = state.writeQueue.find((w) => w.id === action.writeId);
      if (!head) return state;
      const rest = state.writeQueue.filter((w) => w.id !== action.writeId);
      let st: State = { ...state, writeQueue: rest };
      if (head.kind === '晋升' && head.claimId) {
        st = reducer(st, { type: 'PROMOTE_CLAIM', claimId: head.claimId });
      } else if (head.kind === '纠正' && head.claimId) {
        // 0037：未核主张纠正=丢弃，无需关闭原因；已晋升的必填。
        const target = st.claims.find((c) => c.id === head.claimId);
        if (target && !target.unverified && !action.closeReason) {
          return { ...state, toast: { text: '关闭原因必填', id: state.seq }, seq: state.seq + 1 };
        }
        st = reducer(st, { type: 'CORRECT_CLAIM', claimId: head.claimId, closeReason: action.closeReason ?? '从未成立', newText: action.newText });
      } else if (head.kind === '整理' && head.claimId && head.targetPredicate) {
        const prop = st.proposals.find((p) => p.payload.kind === '整理' && p.payload.claimId === head.claimId && p.pending);
        if (prop) st = reducer(st, { type: 'PROPOSAL_DECIDE', proposalId: prop.id, decision: 'accept-merge' });
        else {
          const claims = st.claims.map((c) => (c.id === head.claimId ? { ...c, predicate: head.targetPredicate! } : c));
          st = { ...st, claims };
          st = pushCard(st, head.objectId, { kind: '结果', claimId: head.claimId, result: '整理' }, `已并入「${head.targetPredicate}」`);
        }
      } else if (head.kind === '批量晋升' && head.claimIds) {
        st = {
          ...st,
          claims: st.claims.map((c) => (head.claimIds!.includes(c.id) ? { ...c, unverified: false } : c)),
        };
        st = pushCard(
          st,
          head.objectId,
          { kind: '结果', claimIds: head.claimIds, result: '批量晋升', undo: { kind: '批量晋升', claimIds: head.claimIds } },
          `已全部晋升 ${head.claimIds.length} 条，简报不再带未核`,
        );
      } else if (head.kind === '批量回退' && head.claimIds) {
        // 0034：批量晋升的补偿走 takeover 确认（Q3/Q5），确认后整批回到未核。
        st = {
          ...st,
          claims: st.claims.map((c) => (head.claimIds!.includes(c.id) ? { ...c, unverified: true } : c)),
        };
        st = pushCard(
          st,
          head.objectId,
          { kind: '结果', claimIds: head.claimIds, result: '撤销' },
          `已全部回到未核 ${head.claimIds.length} 条`,
        );
      } else if (head.kind === '绑定' && head.sourceId && head.objectIds) {
        st = reducer(st, { type: 'BIND_CONFIRMED', sourceId: head.sourceId, objectIds: head.objectIds });
      }
      return st;
    }

    case 'REJECT_WRITE': {
      const head = state.writeQueue.find((w) => w.id === action.writeId);
      if (!head) return state;
      const rest = state.writeQueue.filter((w) => w.id !== action.writeId);
      const text =
        head.kind === '批量晋升'
          ? `已全部保持未核 ${head.claimIds?.length ?? 0} 条`
          : '已拒绝这条提议';
      return pushCard({ ...state, writeQueue: rest }, head.objectId, { kind: '结果', result: '拒绝' }, text);
    }

    case 'UNDO_RESULT': {
      // 0034：撤销 = 追加补偿写。原卡去掉撤销入口防重复补偿，补偿卡本身不再带撤销（重做走正常入口）。
      const list = state.chatByObject[action.objectId] ?? [];
      const msg = list.find((m) => m.id === action.messageId);
      const undo = msg?.card?.undo;
      if (!undo) return state;
      const stripped = list.map((m) =>
        m.id === action.messageId && m.card ? { ...m, card: { ...m.card, undo: undefined } } : m,
      );
      let st: State = { ...state, chatByObject: { ...state.chatByObject, [action.objectId]: stripped } };
      switch (undo.kind) {
        case '晋升':
          st = {
            ...st,
            claims: st.claims.map((c) => (c.id === undo.claimId ? { ...c, unverified: true } : c)),
            toast: { text: '已撤回晋升', id: st.seq },
            seq: st.seq + 1,
          };
          return pushCard(st, action.objectId, { kind: '结果', claimId: undo.claimId, result: '撤销' }, '已撤回晋升，回到未核');
        case '整理并入':
          st = {
            ...st,
            claims: st.claims.map((c) => (c.id === undo.claimId ? { ...c, predicate: undo.fromPredicate } : c)),
            toast: { text: '已撤回并入', id: st.seq },
            seq: st.seq + 1,
          };
          return pushCard(st, action.objectId, { kind: '结果', claimId: undo.claimId, result: '撤销' }, `已撤回并入，回到「${undo.fromPredicate}」`);
        case '整理丢弃':
          st = {
            ...st,
            claims: st.claims.some((c) => c.id === undo.claim.id) ? st.claims : [...st.claims, undo.claim],
            toast: { text: '已恢复该主张', id: st.seq },
            seq: st.seq + 1,
          };
          return pushCard(st, action.objectId, { kind: '结果', claimId: undo.claim.id, result: '撤销' }, '已恢复被丢弃的主张');
        case '记忆':
          st = {
            ...st,
            memories: st.memories.filter((m) => m.id !== undo.memoryId),
            toast: { text: '已移除这条记忆', id: st.seq },
            seq: st.seq + 1,
          };
          return pushCard(st, action.objectId, { kind: '结果', result: '撤销' }, '已移除刚写入的记忆');
        case '绑定': {
          // 0031：解绑 = 撤该来源下的主张，来源回 Inbox。src-jd 连带种子里自动出现的 src-web。
          const affected = undo.sourceId === 'src-jd' ? ['src-jd', 'src-web'] : [undo.sourceId];
          const restoredPending = seedPendingClaims.filter((c) => affected.includes(c.sourceId));
          st = {
            ...st,
            claims: st.claims.filter((c) => !affected.includes(c.sourceId)),
            pendingClaims: [
              ...st.pendingClaims.filter((c) => !affected.includes(c.sourceId)),
              ...restoredPending,
            ],
            sources: st.sources
              .filter((s) => !(affected.includes(s.id) && s.id !== undo.sourceId))
              .map((s) => (s.id === undo.sourceId ? { ...s, boundObjectIds: [] } : s)),
            inbox: st.inbox.includes(undo.sourceId) ? st.inbox : [...st.inbox, undo.sourceId],
            extractJobs: st.extractJobs.filter((j) => !affected.includes(j.sourceId)),
            toast: { text: '已解绑，来源回 Inbox', id: st.seq },
            seq: st.seq + 1,
          };
          return pushCard(st, action.objectId, { kind: '结果', result: '撤销' }, '已解绑：该来源的主张已撤，来源回到 Inbox（可撤销本步重新绑定）');
        }
        case '关窗':
          // Q4 原子性：重开旧句 + 移除禁写 + 配套新句一并撤。
          st = {
            ...st,
            claims: st.claims
              .filter((c) => c.id !== undo.companionId)
              .map((c) =>
                c.id === undo.claimId
                  ? { ...c, status: '成立' as const, validTo: undefined, closeReason: undefined, supersededBy: undefined }
                  : c,
              ),
            memories: st.memories.filter((m) => m.id !== undo.memoryId),
            toast: { text: '已重开，禁写已移除', id: st.seq },
            seq: st.seq + 1,
          };
          return pushCard(st, action.objectId, { kind: '结果', claimId: undo.claimId, result: '撤销' }, '已重开旧句，禁写已移除，配套新句一并撤下');
        case '批量晋升': {
          // Q3：影响面大的补偿走 takeover 确认，不一键。
          return enqueueWrite(st, {
            objectId: action.objectId,
            kind: '批量回退',
            claimIds: undo.claimIds,
            headline: `撤销批量晋升：${undo.claimIds.length} 条回到未核`,
            evidence: undo.claimIds
              .map((id) => {
                const c = st.claims.find((x) => x.id === id);
                return `· ${c ? c.text : id}`;
              })
              .join('\n'),
          });
        }
        default:
          return st;
      }
    }

    case 'REMOVE_MEMORY':
      // 0034：禁写的显式回退（待确认页记忆区）。移除本身可再补偿（重新纠正会再写）。
      return {
        ...state,
        memories: state.memories.filter((m) => m.id !== action.id),
        toast: { text: '已移除这条禁写', id: state.seq },
        seq: state.seq + 1,
      };

    case 'TEST_PROVIDER':
      // 0039：三级自检——连通、能力探测、资格认证。原型模拟跑分，不真连。
      return {
        ...state,
        seq: state.seq + 1,
        certByProvider: {
          ...state.certByProvider,
          [action.id]: { status: '认证中', startedAt: Date.now() },
        },
        toast: { text: '三级自检运行中：连通 → 能力探测 → 资格认证', id: state.seq + 1 },
      };

    case 'CERT_DONE': {
      // 编造率偶发超 5% 红线，演示警告形态；其余只展示不设闸。
      const fabrication = Number((0.5 + Math.random() * 6).toFixed(1));
      return {
        ...state,
        seq: state.seq + 1,
        certByProvider: {
          ...state.certByProvider,
          [action.id]: {
            status: '已认证',
            recall: Math.round(78 + Math.random() * 17),
            faithful: Math.round(80 + Math.random() * 16),
            unknown: Math.round(85 + Math.random() * 13),
            fabrication,
          },
        },
        toast: {
          text: fabrication > 5 ? `认证完成：编造率 ${fabrication}%，超过 5% 红线，该配置慎用` : `认证完成：编造率 ${fabrication}%，达标`,
          id: state.seq + 1,
        },
      };
    }

    case 'MARK_TURN_PLAYED': {
      const list = (state.chatByObject[action.objectId] ?? []).map((m) =>
        m.id === action.messageId && m.turn ? { ...m, turn: { ...m.turn, played: true } } : m,
      );
      return { ...state, chatByObject: { ...state.chatByObject, [action.objectId]: list } };
    }

    case 'DELETE_OBJECT': {
      // 0032：永久删除对象 = 名下主张级联关窗（对象误建，保留防再写入），简报留为孤儿快照，会话删除。
      const obj = state.objects.find((o) => o.id === action.id);
      if (!obj?.archived) return state;
      const today = new Date().toISOString().slice(0, 10);
      const claimIds = new Set(state.claims.filter((c) => c.objectId === action.id).map((c) => c.id));
      const { [action.id]: _drop, ...chatByObject } = state.chatByObject;
      const { [action.id]: _t1, ...rightTabsByObject } = state.rightTabsByObject;
      const { [action.id]: _t2, ...activeRightTabByObject } = state.activeRightTabByObject;
      const leaving = state.view.kind === 'object' && state.view.objectId === action.id;
      return {
        ...state,
        objects: state.objects.filter((o) => o.id !== action.id),
        claims: state.claims.map((c) =>
          c.objectId === action.id ? { ...c, status: '过时' as const, validTo: today, closeReason: '对象误建' as const } : c,
        ),
        pendingClaims: state.pendingClaims.filter((c) => c.objectId !== action.id),
        proposals: state.proposals.filter((p) => {
          if (p.payload.kind === '整理') return !claimIds.has(p.payload.claimId);
          if (p.payload.kind === '丢弃未核') return !p.payload.claimIds.some((id) => claimIds.has(id));
          return p.payload.fromObjectId !== action.id;
        }),
        tasks: state.tasks.filter((t) => t.objectId !== action.id),
        chatByObject,
        rightTabsByObject,
        activeRightTabByObject,
        view: leaving ? { kind: 'inbox' } : state.view,
        selectedClaimId: leaving || (state.selectedClaimId && claimIds.has(state.selectedClaimId)) ? null : state.selectedClaimId,
        toast: { text: '已永久删除，名下主张已关窗（对象误建）', id: state.seq },
        seq: state.seq + 1,
      };
    }

    case 'RESTORE_OBJECT': {
      // 0032：孤儿或归档对象恢复进当前工作区。
      const obj = state.objects.find((o) => o.id === action.id);
      if (!obj) return state;
      return openObject(
        {
          ...state,
          objects: state.objects.map((o) =>
            o.id === action.id ? { ...o, archived: false, workspaceId: state.currentWorkspaceId } : o,
          ),
        },
        action.id,
      );
    }

    case 'ADD_SLOT': {
      // 0025：谓词表由人维护。新槽默认通用（所有场景显示），单值/多值影响冲突判定（0029）。
      const name = action.name.trim();
      if (!name) return { ...state, toast: { text: '槽名不能为空', id: state.seq }, seq: state.seq + 1 };
      if (name === '未编目') {
        return { ...state, toast: { text: '「未编目」是保留值', id: state.seq }, seq: state.seq + 1 };
      }
      if (state.slotDefs.some((d) => d.name === name && d.kind === action.kind)) {
        return { ...state, toast: { text: '该种类下已有同名槽', id: state.seq }, seq: state.seq + 1 };
      }
      return {
        ...state,
        seq: state.seq + 1,
        slotDefs: [...state.slotDefs, { name, kind: action.kind, arity: action.arity, scenarios: [] }],
        toast: { text: `已加槽「${name}」（通用）`, id: state.seq + 1 },
      };
    }

    default:
      return state;
  }
}

const StoreContext = createContext<{ state: State; dispatch: Dispatch<Action> } | null>(null);

export function StoreProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, undefined, makeInitialState);
  return <StoreContext.Provider value={{ state, dispatch }}>{children}</StoreContext.Provider>;
}

export function useStore() {
  const ctx = useContext(StoreContext);
  if (!ctx) throw new Error('useStore 必须在 StoreProvider 内使用');
  return ctx;
}

export function projectionClaims(state: State, objectId: string): Claim[] {
  return state.claims.filter((c) => c.objectId === objectId && c.status !== '过时');
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

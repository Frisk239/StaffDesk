import type { Action } from '@shared/actions';
import type { Brief, CandidatePayload, ChatMessage, State, TaskAudit } from '@shared/types';
import { scriptReply } from '@shared/chat';
import { attachTurn } from '@shared/turn';
import { normalizeValue } from '@shared/scenario';
import { utcIso } from '@shared/time';
import { outboundBrief, verifyBrief } from './briefOut';
import { dreamMemoryProposals } from '../loops/memoryDream';
import {
  enqueueWrite,
  ensureTab,
  nextId,
  openObject,
  patchTabs,
  pushCard,
  pushChat,
  tabsOf,
} from './actionHelpers';

// 对象/关系/工作区、对象对话、简报与记忆、视图页签与模型设置等动作域 reducer 分支。

function modelSelection(
  providers: State['providers'],
  providerId: string,
  modelId: string,
): Pick<State, 'activeProviderId' | 'activeModelId'> {
  const requested = providers.find((provider) => provider.id === providerId);
  const activeProvider =
    (requested?.enabled ? requested : undefined) ?? providers.find((provider) => provider.enabled);
  const activeModel =
    activeProvider?.models.find((model) => model.id === modelId) ?? activeProvider?.models[0];
  return {
    activeProviderId: activeProvider?.id ?? '',
    activeModelId: activeModel?.id ?? '',
  };
}

/** 0018/0049：回放只读 task_audit。出简报至少落开始/组装/出站校验/完成，失败记阶段。 */
function briefTaskAudits(args: {
  taskId: string;
  objectId: string;
  ts: string;
  outcome: '完成' | '失败';
  brief?: Brief | undefined;
  error?: string | undefined;
}): TaskAudit[] {
  const { taskId, objectId, ts } = args;
  const start: TaskAudit = {
    taskId,
    seq: 1,
    kind: '开始',
    payload: { objectId, kind: '出简报' },
    ts,
  };
  if (args.outcome === '失败') {
    return [
      start,
      {
        taskId,
        seq: 2,
        kind: '失败',
        payload: { stage: '组装', detail: args.error ?? '简报生成失败' },
        ts,
      },
    ];
  }
  const sentences = args.brief?.blocks.reduce((n, block) => n + block.sentences.length, 0) ?? 0;
  return [
    start,
    {
      taskId,
      seq: 2,
      kind: '组装',
      payload: { blocks: args.brief?.blocks.length ?? 0 },
      ts,
    },
    {
      taskId,
      seq: 3,
      kind: '出站校验',
      payload: { sentences },
      ts,
    },
    {
      taskId,
      seq: 4,
      kind: '完成',
      payload: { briefId: args.brief?.id },
      ts,
    },
  ];
}

function normalizeMemoryCandidateKey(payload: CandidatePayload): string {
  // 0053：文本归一化收口到 normalizeValue；全半角折叠只影响键值，不改变判重语义（行为超集安全）。
  return [
    payload.scope,
    payload.memoryKind,
    payload.scope === '对象' ? (payload.fromObjectId ?? '') : '',
    normalizeValue(payload.text),
  ].join('\0');
}

export function objectChatActions(state: State, action: Action): State | undefined {
  switch (action.type) {
    case 'SET_VIEW': {
      // 审计五轮 E2：selectedClaimId 自赋值是无操作噪音，已删。
      if (action.view.kind === 'object') {
        return openObject(state, action.view.objectId);
      }
      return { ...state, view: action.view };
    }

    case 'GENERATE_BRIEF_START':
      return { ...state, briefDraftingFor: action.objectId };

    case 'GENERATE_BRIEF_DONE': {
      if (!state.briefDraftingFor) return state;
      const objectId = state.briefDraftingFor;
      if (
        action.brief &&
        (state.briefs.some((item) => item.id === action.brief?.id) ||
          state.tasks.some((item) => item.id === action.brief?.taskId && item.kind === '出简报'))
      ) {
        return { ...state, briefDraftingFor: null };
      }
      const [taskId, seq1] = nextId(state, 'task');
      const [briefId, seq2] = nextId({ ...state, seq: seq1 }, 'brief');
      const createdAt = utcIso();
      const ts = createdAt;
      if (action.error) {
        const audits = briefTaskAudits({
          taskId,
          objectId,
          ts,
          outcome: '失败',
          error: action.error,
        });
        return {
          ...state,
          seq: seq1,
          tasks: [
            ...state.tasks,
            {
              id: taskId,
              objectId,
              kind: '出简报',
              status: '已停止',
              stopReason: '失败',
              createdAt,
            },
          ],
          taskAudits: [...state.taskAudits, ...audits],
          briefDraftingFor: null,
          toast: { text: `简报生成失败：${action.error}`, id: seq1 },
        };
      }
      const assembled = action.brief ?? outboundBrief(state, objectId, briefId, taskId);
      const brief: Brief = {
        ...verifyBrief(assembled, state.claims),
        id: briefId,
        taskId,
        createdAt,
      };
      const unverifiedClaims = state.claims.filter(
        (c) => c.objectId === objectId && c.unverified && c.status === '成立',
      );
      const audits = briefTaskAudits({
        taskId,
        objectId,
        ts,
        outcome: '完成',
        brief,
      });
      let next: State = {
        ...state,
        seq: seq2,
        tasks: [
          ...state.tasks,
          { id: taskId, objectId, kind: '出简报', status: '已完成', createdAt },
        ],
        taskAudits: [...state.taskAudits, ...audits],
        briefs: [...state.briefs, brief],
        briefDraftingFor: null,
        view: { kind: 'object', objectId },
        toast: { text: '简报已生成', id: seq2 },
      };
      next = ensureTab(next, objectId, '简报', true);
      next = pushCard(
        next,
        objectId,
        { kind: '结果', taskId, briefId, result: '简报' },
        `简报已出 · ${brief.blocks.length} 块 · ${unverifiedClaims.length} 条未核`,
      );
      // 0016：任务结束可对本任务未核全部晋升或保持——唯一的批量白名单，以 takeover 提议出现。
      if (unverifiedClaims.length > 0) {
        next = enqueueWrite(next, {
          objectId,
          taskId,
          kind: '批量晋升',
          claimIds: unverifiedClaims.map((c) => c.id),
          headline: `本任务未核 ${unverifiedClaims.length} 条主张：全部晋升，还是全部保持？`,
          evidence: unverifiedClaims.map((c) => `· ${c.text}`).join('\n'),
          outbound: true,
        });
      }
      return next;
    }

    case 'CHAT_SEND': {
      const { text } = action;
      const userMsg: ChatMessage = { id: `msg-${state.seq}`, role: 'user', text };
      let st: State = {
        ...state,
        seq: state.seq + 1,
        chatByObject: pushChat(state, action.objectId, userMsg),
      };
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
            {
              kind: '结果',
              result: '记忆',
              undo: dup ? undefined : { kind: '记忆', memoryId: memId },
            },
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
      const exists = state.providers.some((provider) => provider.id === action.provider.id);
      const providers = exists
        ? state.providers.map((provider) =>
            provider.id === action.provider.id ? action.provider : provider,
          )
        : [...state.providers, action.provider];
      const selected = modelSelection(
        providers,
        state.activeProviderId || action.provider.id,
        state.activeModelId,
      );
      return {
        ...state,
        providers,
        ...selected,
        seq: state.seq + 1,
      };
    }

    case 'REMOVE_PROVIDER': {
      const providers = state.providers.filter((p) => p.id !== action.id);
      const selected = modelSelection(
        providers,
        state.activeProviderId === action.id ? '' : state.activeProviderId,
        state.activeModelId,
      );
      return {
        ...state,
        providers,
        ...selected,
        seq: state.seq + 1,
      };
    }

    case 'SET_ACTIVE_PROVIDER': {
      if (!state.providers.some((provider) => provider.id === action.id)) return state;
      const selected = modelSelection(state.providers, action.id, '');
      return {
        ...state,
        ...selected,
        seq: state.seq + 1,
      };
    }

    case 'SET_ACTIVE_MODEL': {
      const provider = state.providers.find((item) => item.id === action.providerId);
      if (!provider?.enabled || !provider.models.some((model) => model.id === action.modelId)) {
        return state;
      }
      return {
        ...state,
        activeProviderId: provider.id,
        activeModelId: action.modelId,
        seq: state.seq + 1,
      };
    }

    case 'SET_THINKING':
      return { ...state, thinkingEffort: action.effort };

    case 'OPEN_RIGHT_TAB': {
      return ensureTab(state, action.objectId, action.kind, true);
    }

    case 'CLOSE_RIGHT_TAB': {
      const tabs = tabsOf(state, action.objectId).filter((t) => t.id !== action.id);
      const prev = state.activeRightTabByObject[action.objectId];
      const active = prev === action.id ? (tabs[tabs.length - 1]?.id ?? null) : (prev ?? null);
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
      // 0058：workspaces.scenario 的枚举 CHECK 已随 v8 拆除，库层不再兜底——
      // 「模板存在才建区」由 reducer 守住，防悬挂引用。
      if (!state.scenarioTemplates.some((t) => t.name === action.scenario)) {
        return {
          ...state,
          toast: { text: `场景模板「${action.scenario}」不存在，无法创建工作区`, id: state.seq },
          seq: state.seq + 1,
        };
      }
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
      if (!state.currentWorkspaceId) {
        return { ...state, toast: { text: '先建工作区', id: state.seq }, seq: state.seq + 1 };
      }
      const [id, seq] = nextId(
        state,
        action.kind === '人' ? 'person' : action.kind === '组织' ? 'org' : 'proj',
      );
      const obj = {
        id,
        kind: action.kind,
        name,
        workspaceId: state.currentWorkspaceId,
        relationIds: [] as string[],
      };
      return openObject({ ...state, seq, objects: [...state.objects, obj] }, id);
    }

    case 'ADD_RELATION': {
      // CONTEXT「关系」：对象之间可跳转的裸边，无类型标签；仅人↔组织、项目↔组织、人↔项目
      // 三种跨种类边（三种种类两两即全部，同种类/自指拒绝）。对称双侧存储：两端 relationIds
      // 各 append 对方，读侧任查一侧即可。
      const a = state.objects.find((o) => o.id === action.objectId);
      const b = state.objects.find((o) => o.id === action.targetId);
      if (!a || !b)
        return {
          ...state,
          seq: state.seq + 1,
          toast: { text: '对象不存在，无法建关系', id: state.seq },
        };
      if (a.id === b.id)
        return {
          ...state,
          seq: state.seq + 1,
          toast: { text: '不能和对象自己建关系', id: state.seq },
        };
      if (a.archived || b.archived)
        return {
          ...state,
          seq: state.seq + 1,
          toast: { text: '已归档对象不能建关系', id: state.seq },
        };
      if (a.kind === b.kind)
        return {
          ...state,
          seq: state.seq + 1,
          toast: { text: '同种类对象之间不建关系', id: state.seq },
        };
      if (a.relationIds.includes(b.id) || b.relationIds.includes(a.id))
        return {
          ...state,
          seq: state.seq + 1,
          toast: { text: '这两个对象已经关联', id: state.seq },
        };
      return {
        ...state,
        seq: state.seq + 1,
        objects: state.objects.map((o) =>
          o.id === a.id
            ? { ...o, relationIds: [...o.relationIds, b.id] }
            : o.id === b.id
              ? { ...o, relationIds: [...o.relationIds, a.id] }
              : o,
        ),
      };
    }

    case 'REMOVE_RELATION': {
      const a = state.objects.find((o) => o.id === action.objectId);
      const b = state.objects.find((o) => o.id === action.targetId);
      if (!a || !b)
        return {
          ...state,
          seq: state.seq + 1,
          toast: { text: '对象不存在，无法解除关系', id: state.seq },
        };
      if (!a.relationIds.includes(b.id) && !b.relationIds.includes(a.id))
        return {
          ...state,
          seq: state.seq + 1,
          toast: { text: '这两个对象之间没有关系', id: state.seq },
        };
      // 关系不做撤销（0034 的补偿写只覆盖账本写入类动作；边可即时重建，不进撤销载荷）。
      return {
        ...state,
        seq: state.seq + 1,
        objects: state.objects.map((o) =>
          o.id === a.id || o.id === b.id
            ? { ...o, relationIds: o.relationIds.filter((id) => id !== a.id && id !== b.id) }
            : o,
        ),
        toast: { text: '已移除关系', id: state.seq },
      };
    }

    case 'SET_OBJECT_NOTE': {
      // 清空写 null 不写空串：loadLedger 只对非空 note 读回（persist 行构造器 `o.note ?? null`）。
      const obj = state.objects.find((o) => o.id === action.objectId);
      if (!obj)
        return {
          ...state,
          seq: state.seq + 1,
          toast: { text: '对象不存在，无法写备注', id: state.seq },
        };
      const note = action.note?.trim() ?? '';
      return {
        ...state,
        seq: state.seq + 1,
        objects: state.objects.map((o) =>
          o.id === action.objectId ? { ...o, note: note || undefined } : o,
        ),
      };
    }

    case 'REMOVE_WORKSPACE': {
      const rest = state.workspaces.filter((w) => w.id !== action.id);
      if (rest.length === state.workspaces.length) return state;
      const nextIdWs =
        action.id === state.currentWorkspaceId ? (rest[0]?.id ?? '') : state.currentWorkspaceId;
      const openObj = state.view.kind === 'object' ? state.view.objectId : null;
      const leaving = Boolean(
        openObj && state.objects.find((o) => o.id === openObj)?.workspaceId === action.id,
      );
      // 0032：对象保留 workspaceId（指向已删区）并归档，成为可从「全部对象」找回的孤儿，不丢主张。
      return {
        ...state,
        workspaces: rest,
        objects: state.objects.map((o) =>
          o.workspaceId === action.id ? { ...o, archived: true } : o,
        ),
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

    case 'REMOVE_MEMORY': {
      // 0034：禁写的显式回退（待确认页记忆区）。移除本身可再补偿（重新纠正会再写）。
      // F7（审计 2026-09-02）：文案按被删记忆的种类出——设置页记忆节也能删偏好/习惯，
      // 不再硬编码「禁写」；删不存在的 id 时回落到「记忆」。
      const kind = state.memories.find((m) => m.id === action.id)?.kind ?? '记忆';
      return {
        ...state,
        memories: state.memories.filter((m) => m.id !== action.id),
        toast: { text: `已移除这条${kind}`, id: state.seq },
        seq: state.seq + 1,
      };
    }

    case 'SET_ONBOARDING':
      return { ...state, onboardingDone: action.done };

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
      const claimIds = new Set(
        state.claims.filter((c) => c.objectId === action.id).map((c) => c.id),
      );
      const { [action.id]: _drop, ...chatByObject } = state.chatByObject;
      const { [action.id]: _t1, ...rightTabsByObject } = state.rightTabsByObject;
      const { [action.id]: _t2, ...activeRightTabByObject } = state.activeRightTabByObject;
      const leaving = state.view.kind === 'object' && state.view.objectId === action.id;
      return {
        ...state,
        // 0032 同精神：不留幽灵——对端 relationIds 里指向被删对象的悬边一并清掉。
        objects: state.objects
          .filter((o) => o.id !== action.id)
          .map((o) =>
            o.relationIds.includes(action.id)
              ? { ...o, relationIds: o.relationIds.filter((id) => id !== action.id) }
              : o,
          ),
        claims: state.claims.map((c) =>
          c.objectId === action.id
            ? { ...c, status: '过时' as const, validTo: today, closeReason: '对象误建' as const }
            : c,
        ),
        pendingClaims: state.pendingClaims.filter((c) => c.objectId !== action.id),
        proposals: state.proposals.filter((p) => {
          if (p.payload.kind === '整理' || p.payload.kind === '标过时')
            return !claimIds.has(p.payload.claimId);
          if (p.payload.kind === '主键新版过时')
            return !claimIds.has(p.payload.oldClaimId) && !claimIds.has(p.payload.newClaimId);
          if (p.payload.kind === '丢弃未核')
            return !p.payload.claimIds.some((id) => claimIds.has(id));
          if (p.payload.kind === '合并重复')
            return (
              !claimIds.has(p.payload.keepId) && !p.payload.dropIds.some((id) => claimIds.has(id))
            );
          // 补关系提议：任一端是被删对象就一并撤下，不留建不成的边。
          if (p.payload.kind === '建关系')
            return p.payload.objectId !== action.id && p.payload.targetId !== action.id;
          // 候选记忆与建对象共享挂靠字段：挂靠对象没了就撤。
          return p.payload.fromObjectId !== action.id;
        }),
        tasks: state.tasks.filter((t) => t.objectId !== action.id),
        chatByObject,
        rightTabsByObject,
        activeRightTabByObject,
        view: leaving ? { kind: 'inbox' } : state.view,
        selectedClaimId:
          leaving || (state.selectedClaimId && claimIds.has(state.selectedClaimId))
            ? null
            : state.selectedClaimId,
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
            o.id === action.id
              ? { ...o, archived: false, workspaceId: state.currentWorkspaceId }
              : o,
          ),
        },
        action.id,
      );
    }

    case 'CHAT_USER_ONLY': {
      const userMsg: ChatMessage = { id: `msg-${state.seq}`, role: 'user', text: action.text };
      return {
        ...state,
        seq: state.seq + 1,
        chatByObject: pushChat(state, action.objectId, userMsg),
      };
    }

    case 'CHAT_APPEND_DESK': {
      const deskMsg: ChatMessage = {
        id: `msg-${state.seq}`,
        role: 'desk',
        text: action.text,
        claimRefs: action.claimRefs ?? [],
      };
      return {
        ...state,
        seq: state.seq + 1,
        chatByObject: pushChat(state, action.objectId, deskMsg),
      };
    }

    case 'ADD_CANDIDATE_MEMORIES': {
      if (!state.objects.some((object) => object.id === action.objectId)) return state;
      const existing = new Set(
        state.proposals
          .filter((proposal) => proposal.payload.kind === '候选记忆')
          .map((proposal) => normalizeMemoryCandidateKey(proposal.payload as CandidatePayload)),
      );
      for (const memory of state.memories) {
        // 0053：与 normalizeMemoryCandidateKey 同口径，走 normalizeValue 收口。
        existing.add(
          [
            memory.scope,
            memory.kind,
            memory.scope === '对象' ? (memory.objectId ?? '') : '',
            normalizeValue(memory.text),
          ].join('\0'),
        );
      }
      let seq = state.seq;
      const proposals = [...state.proposals];
      for (const raw of action.candidates) {
        const text = raw.text.trim();
        const sourceExcerpt = raw.sourceExcerpt.trim();
        if (!text || !sourceExcerpt || raw.fromMessageIds.length === 0) continue;
        const payload: CandidatePayload = {
          ...raw,
          text,
          sourceExcerpt,
          fromObjectId: raw.fromObjectId ?? action.objectId,
          fromMessageIds: [...new Set(raw.fromMessageIds)],
        };
        const key = normalizeMemoryCandidateKey(payload);
        if (existing.has(key)) continue;
        existing.add(key);
        const [id, nextSeq] = nextId({ ...state, seq }, 'prop');
        seq = nextSeq;
        proposals.push({
          id,
          type: '候选记忆',
          title: `${payload.memoryKind}候选`,
          detail: [
            payload.text,
            '',
            `来自会话消息：${payload.fromMessageIds.join('、')}`,
            `原文摘录：${payload.sourceExcerpt}`,
          ].join('\n'),
          payload,
          pending: true,
        });
      }
      if (proposals.length === state.proposals.length) return state;
      return {
        ...state,
        seq,
        proposals,
        toast: { text: `新增 ${proposals.length - state.proposals.length} 条候选记忆`, id: seq },
      };
    }

    case 'RUN_MEMORY_DREAM': {
      const result = dreamMemoryProposals(state);
      return result.changed ? { ...state, proposals: result.proposals } : state;
    }

    default:
      return undefined;
  }
}

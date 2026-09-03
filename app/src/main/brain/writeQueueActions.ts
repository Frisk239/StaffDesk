import type { Action } from '@shared/actions';
import type { Claim, State } from '@shared/types';
import { withBindingRole } from '@shared/primarySource';
import { applyScenarioTemplateUpsert } from './slotTemplateActions';
import { claimBelongsToSlotKind, enqueueWrite, pushCard, type ReducerFn } from './actionHelpers';

// write_queue 域 reducer 分支：写卡入队、确认落账与撤销补偿；确认/撤销里的递归
// dispatch（PROMOTE_CLAIM/CORRECT_CLAIM/PROPOSAL_DECIDE/BIND_CONFIRMED/SET_SOURCE_ROLE
// /UNBIND_SOURCE/DELETE_SOURCE/RETRY_EXTRACTION）经注入的 reducer 参数回调分发壳入口，
// 本文件不得 import 壳。

function claimStillHasSource(state: State, claim: Claim): boolean {
  if (claim.sourceId === 'user-stmt') return true;
  const source = state.sources.find((item) => item.id === claim.sourceId);
  return Boolean(source?.boundObjectIds.includes(claim.objectId));
}

export function writeQueueActions(
  state: State,
  action: Action,
  reducer: ReducerFn,
): State | undefined {
  switch (action.type) {
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
        st = reducer(st, {
          type: 'CORRECT_CLAIM',
          claimId: head.claimId,
          closeReason: action.closeReason ?? '从未成立',
          newText: action.newText,
        });
      } else if (head.kind === '整理' && head.claimId && head.targetPredicate) {
        const prop = st.proposals.find(
          (p) => p.payload.kind === '整理' && p.payload.claimId === head.claimId && p.pending,
        );
        if (prop)
          st = reducer(st, {
            type: 'PROPOSAL_DECIDE',
            proposalId: prop.id,
            decision: 'accept-merge',
          });
        else {
          // F2（0057/F2 审计 2026-09-01）：级联撤行后的兜底——目标槽已不在受控表、或只剩别的
          // 种类分区的同名槽（主张并过去会从对象页静默消失）时拒绝确认，不把主张写回死谓词名。
          const target = head.targetPredicate;
          const claim = st.claims.find((c) => c.id === head.claimId);
          const targetable =
            target !== undefined &&
            claim !== undefined &&
            st.slotDefs.some(
              (d) => d.name === target && claimBelongsToSlotKind(st, claim.objectId, d.kind),
            );
          if (!targetable) {
            return {
              ...state,
              toast: { text: '该槽已不存在，请重新并入', id: state.seq },
              seq: state.seq + 1,
            };
          }
          const claims = st.claims.map((c) =>
            c.id === head.claimId ? { ...c, predicate: target } : c,
          );
          st = { ...st, claims };
          st = pushCard(
            st,
            head.objectId,
            { kind: '结果', claimId: head.claimId, result: '整理' },
            `已并入「${target}」`,
          );
        }
      } else if (head.kind === '场景' && head.template) {
        // M27：AI 起草的场景模板——确认即建（不编辑既有模板），守卫复用 UPSERT 校验
        // （0025 兜底：草稿落地前槽被删/被清时拒建）；校验失败 toast 拒且队列行保留（照 F2 口径）；
        // 免 undo——场景模板 CRUD 不进补偿写（0058/0057 口径）。
        const name = head.template.name.trim();
        if (st.scenarioTemplates.some((t) => t.name === name)) {
          return {
            ...state,
            toast: { text: `已有同名场景模板「${name}」，请放弃草稿后改用编辑`, id: state.seq },
            seq: state.seq + 1,
          };
        }
        const applied = applyScenarioTemplateUpsert(st, { ...head.template, builtin: false });
        if (!applied.ok) {
          const reject = applied.state.toast ?? { text: '场景模板未创建', id: state.seq };
          return { ...state, toast: reject, seq: state.seq + 1 };
        }
        st = pushCard(
          applied.state,
          head.objectId,
          { kind: '结果', result: '整理' },
          `已创建场景模板「${name}」`,
        );
      } else if (head.kind === '批量晋升' && head.claimIds) {
        const liveClaimIds = head.claimIds.filter((id) =>
          st.claims.some((claim) => claim.id === id && claim.status === '成立' && claim.unverified),
        );
        st = {
          ...st,
          claims: st.claims.map((c) =>
            liveClaimIds.includes(c.id) ? { ...c, unverified: false } : c,
          ),
        };
        st = pushCard(
          st,
          head.objectId,
          {
            kind: '结果',
            taskId: head.taskId,
            claimIds: liveClaimIds,
            result: '批量晋升',
            undo:
              liveClaimIds.length > 0 ? { kind: '批量晋升', claimIds: liveClaimIds } : undefined,
          },
          `已全部晋升 ${liveClaimIds.length} 条，简报不再带未核`,
        );
      } else if (head.kind === '批量回退' && head.claimIds) {
        // 0034：批量晋升的补偿走 takeover 确认（Q3/Q5），确认后整批回到未核。
        st = {
          ...st,
          claims: st.claims.map((c) =>
            head.claimIds!.includes(c.id) ? { ...c, unverified: true } : c,
          ),
        };
        st = pushCard(
          st,
          head.objectId,
          { kind: '结果', taskId: head.taskId, claimIds: head.claimIds, result: '撤销' },
          `已全部回到未核 ${head.claimIds.length} 条`,
        );
      } else if (head.kind === '绑定' && head.sourceId && head.objectIds) {
        st = reducer(st, {
          type: 'BIND_CONFIRMED',
          sourceId: head.sourceId,
          objectIds: head.objectIds,
        });
      } else if (head.kind === '设角色' && head.sourceId && head.role) {
        st = reducer(st, {
          type: 'SET_SOURCE_ROLE',
          sourceId: head.sourceId,
          objectId: head.objectId,
          role: head.role,
        });
      } else if (head.kind === '解绑' && head.sourceId) {
        // 0027：确认卡成交，不在此复写解绑规则。
        st = reducer(st, {
          type: 'UNBIND_SOURCE',
          sourceId: head.sourceId,
          objectId: head.objectId,
        });
      } else if (head.kind === '删除来源' && head.sourceId) {
        // 0027：确认卡成交；删除规则仍在 DELETE_SOURCE（0035 无一键撤销）。
        st = reducer(st, { type: 'DELETE_SOURCE', sourceId: head.sourceId });
      } else if (head.kind === '重试抽取' && head.sourceId) {
        // 0027：确认卡成交，抽取重试仍走 RETRY_EXTRACTION。
        st = reducer(st, { type: 'RETRY_EXTRACTION', sourceId: head.sourceId });
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
      return pushCard(
        { ...state, writeQueue: rest },
        head.objectId,
        { kind: '结果', taskId: head.taskId, claimIds: head.claimIds, result: '拒绝' },
        text,
      );
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
      let st: State = {
        ...state,
        chatByObject: { ...state.chatByObject, [action.objectId]: stripped },
      };
      switch (undo.kind) {
        case '晋升':
          st = {
            ...st,
            claims: st.claims.map((c) => (c.id === undo.claimId ? { ...c, unverified: true } : c)),
            toast: { text: '已撤回晋升', id: st.seq },
            seq: st.seq + 1,
          };
          return pushCard(
            st,
            action.objectId,
            { kind: '结果', claimId: undo.claimId, result: '撤销' },
            '已撤回晋升，回到未核',
          );
        case '整理并入':
          st = {
            ...st,
            claims: st.claims.map((c) =>
              c.id === undo.claimId ? { ...c, predicate: undo.fromPredicate } : c,
            ),
            toast: { text: '已撤回并入', id: st.seq },
            seq: st.seq + 1,
          };
          return pushCard(
            st,
            action.objectId,
            { kind: '结果', claimId: undo.claimId, result: '撤销' },
            `已撤回并入，回到「${undo.fromPredicate}」`,
          );
        case '整理丢弃': {
          const discarded = 'claims' in undo ? undo.claims : [undo.claim];
          const existingIds = new Set(st.claims.map((claim) => claim.id));
          const restored = discarded.filter(
            (claim) => !existingIds.has(claim.id) && claimStillHasSource(st, claim),
          );
          st = {
            ...st,
            claims: [...st.claims, ...restored],
            toast: { text: `已恢复 ${restored.length} 条主张`, id: st.seq },
            seq: st.seq + 1,
          };
          return pushCard(
            st,
            action.objectId,
            {
              kind: '结果',
              claimIds: discarded.map((claim) => claim.id),
              result: '撤销',
            },
            `已恢复被丢弃的 ${restored.length} 条主张`,
          );
        }
        case '记忆':
          st = {
            ...st,
            memories: st.memories.filter((m) => m.id !== undo.memoryId),
            toast: { text: '已移除这条记忆', id: st.seq },
            seq: st.seq + 1,
          };
          return pushCard(
            st,
            action.objectId,
            { kind: '结果', result: '撤销' },
            '已移除刚写入的记忆',
          );
        case '绑定': {
          // 0031：解绑 = 撤该来源下的主张，来源回 Inbox。
          if (!st.sources.some((source) => source.id === undo.sourceId)) return st;
          const affected = [undo.sourceId];
          st = {
            ...st,
            claims: st.claims.filter((c) => !affected.includes(c.sourceId)),
            pendingClaims: st.pendingClaims.filter((c) => !affected.includes(c.sourceId)),
            sources: st.sources.map((s) =>
              s.id === undo.sourceId ? { ...s, boundObjectIds: [], bindingRoles: undefined } : s,
            ),
            inbox: st.inbox.includes(undo.sourceId) ? st.inbox : [...st.inbox, undo.sourceId],
            extractJobs: st.extractJobs.filter((j) => !affected.includes(j.sourceId)),
            toast: { text: '已解绑，来源回 Inbox', id: st.seq },
            seq: st.seq + 1,
          };
          return pushCard(
            st,
            action.objectId,
            { kind: '结果', result: '撤销' },
            '已解绑：该来源的主张已撤，来源回到 Inbox',
          );
        }
        case '解绑': {
          const source = st.sources.find((item) => item.id === undo.sourceId);
          if (!source) return st;
          const existingIds = new Set(st.claims.map((claim) => claim.id));
          const restoredClaims = undo.claims.filter((claim) => !existingIds.has(claim.id));
          st = {
            ...st,
            sources: st.sources.map((item) => {
              if (item.id !== undo.sourceId || item.boundObjectIds.includes(undo.objectId)) {
                return item;
              }
              const rebound = {
                ...item,
                boundObjectIds: [...item.boundObjectIds, undo.objectId],
              };
              return undo.role ? withBindingRole(rebound, undo.objectId, undo.role) : rebound;
            }),
            claims: [...st.claims, ...restoredClaims],
            inbox: st.inbox.filter((id) => id !== undo.sourceId),
            toast: { text: '已撤销解绑，绑定与主张已恢复', id: st.seq },
            seq: st.seq + 1,
          };
          return pushCard(
            st,
            action.objectId,
            {
              kind: '结果',
              claimIds: restoredClaims.map((claim) => claim.id),
              result: '撤销',
            },
            `已撤销解绑，恢复 ${restoredClaims.length} 条主张`,
          );
        }
        case '关窗':
          // Q4 原子性：重开旧句 + 移除禁写 + 配套新句一并撤。
          {
            const target = st.claims.find((claim) => claim.id === undo.claimId);
            if (target && !claimStillHasSource(st, target)) return st;
          }
          st = {
            ...st,
            claims: st.claims
              .filter((c) => c.id !== undo.companionId)
              .map((c) =>
                c.id === undo.claimId
                  ? {
                      ...c,
                      status: '成立' as const,
                      validTo: undefined,
                      closeReason: undefined,
                      supersededBy: undefined,
                    }
                  : c,
              ),
            memories: st.memories.filter((m) => m.id !== undo.memoryId),
            toast: { text: '已重开，禁写已移除', id: st.seq },
            seq: st.seq + 1,
          };
          return pushCard(
            st,
            action.objectId,
            { kind: '结果', claimId: undo.claimId, result: '撤销' },
            '已重开旧句，禁写已移除，配套新句一并撤下',
          );
        case '设角色': {
          st = reducer(st, {
            type: 'SET_SOURCE_ROLE',
            sourceId: undo.sourceId,
            objectId: undo.objectId,
            role: undo.previousRole,
          });
          return st;
        }
        case '批量晋升': {
          // Q3：影响面大的补偿走 takeover 确认，不一键。
          return enqueueWrite(st, {
            objectId: action.objectId,
            taskId: msg.card?.taskId,
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

    default:
      return undefined;
  }
}

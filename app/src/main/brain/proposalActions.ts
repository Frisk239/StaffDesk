import type { Action } from '@shared/actions';
import type { State } from '@shared/types';
import { normalizeLingerDays } from '@shared/lingerDays';
import { lingerClock } from './lingerClock';
import {
  lingeringUnverifiedClaims,
  refreshPendingDropUnverified,
  scanLingerUnverified,
} from '../loops/tidy';
import { enqueueWrite, nextId, openObject, pushCard, slotIsControlled } from './actionHelpers';

// 提议域 reducer 分支：PROPOSAL_DECIDE 各类提议的接受/驳回，以及审计卡/纠正卡/提议卡打开与撤卡。

function proposalObjectId(state: State, proposalId: string): string | null {
  const p = state.proposals.find((x) => x.id === proposalId);
  if (!p) return null;
  if (p.payload.kind === '候选记忆') return p.payload.fromObjectId ?? null;
  if (p.payload.kind === '丢弃未核') {
    if (p.payload.objectId) return p.payload.objectId;
    const dropHead = p.payload.claimIds[0];
    return (
      state.claims.find((c) => c.id === dropHead)?.objectId ??
      state.pendingClaims.find((c) => c.id === dropHead)?.objectId ??
      null
    );
  }
  if (p.payload.kind === '合并重复') {
    const keepId = p.payload.keepId;
    return state.claims.find((c) => c.id === keepId)?.objectId ?? null;
  }
  // 建关系挂在锚对象账页；建对象挂在抽取语境对象（fromObjectId）的账页。
  if (p.payload.kind === '建关系') return p.payload.objectId;
  if (p.payload.kind === '建对象') return p.payload.fromObjectId;
  if (p.payload.kind === '主键新版过时') {
    const oldClaimId = p.payload.oldClaimId;
    return state.claims.find((c) => c.id === oldClaimId)?.objectId ?? null;
  }
  const claimId = p.payload.claimId;
  return (
    state.claims.find((c) => c.id === claimId)?.objectId ??
    state.pendingClaims.find((c) => c.id === claimId)?.objectId ??
    null
  );
}

export function proposalActions(state: State, action: Action): State | undefined {
  switch (action.type) {
    case 'SCAN_LINGER_UNVERIFIED':
      return scanLingerUnverified(
        state,
        normalizeLingerDays(action.lingerDays),
        action.now,
        action.objectIds,
      );

    case 'OPEN_AUDIT_CARD': {
      const claim = state.claims.find((c) => c.id === action.claimId);
      if (!claim) return state;
      return pushCard(openObject(state, claim.objectId), claim.objectId, {
        kind: '审计',
        claimId: claim.id,
      });
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
      // 候选记忆、「丢弃未核」「合并重复」「标过时」不走对话流决策（仓位在待确认页）；
      // 无预选槽的编目卡同样只在待确认页处理——转发链拿不到人选的槽。
      const prop = state.proposals.find((p) => p.id === action.proposalId);
      const objectId = proposalObjectId(state, action.proposalId);
      if (prop?.payload.kind === '丢弃未核') {
        return {
          ...state,
          toast: { text: '丢弃类提议请在待确认页处理', id: state.seq },
          seq: state.seq + 1,
        };
      }
      if (prop && (prop.payload.kind !== '整理' || !prop.payload.targetPredicate)) {
        return {
          ...state,
          toast: { text: '这类提议请在待确认页处理', id: state.seq },
          seq: state.seq + 1,
        };
      }
      if (!prop || !objectId || prop.payload.kind !== '整理') {
        return {
          ...state,
          toast: { text: '这条提议没有对应对象', id: state.seq },
          seq: state.seq + 1,
        };
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
      const list = (state.chatByObject[action.objectId] ?? []).filter(
        (m) => m.id !== action.messageId,
      );
      return { ...state, chatByObject: { ...state.chatByObject, [action.objectId]: list } };
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
              proposals: state.proposals.map((p) =>
                p.id === prop.id ? { ...p, pending: false, decision: 'reject' } : p,
              ),
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
        // 0055：范围以确认时人选为准，未改动回落 payload 默认。
        const scope = action.scope ?? prop.payload.scope;
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
            proposals: state.proposals.map((p) =>
              p.id === prop.id ? { ...p, pending: false, decision: 'accept-merge' } : p,
            ),
            toast: { text: dup ? '已经在记忆里' : `已写入${scope}记忆`, id: state.seq },
            seq: state.seq + 1,
          },
          objectId ?? state.currentWorkspaceId,
          {
            kind: '结果',
            result: '记忆',
            undo: dup ? undefined : { kind: '记忆', memoryId: memId },
          },
          dup ? '候选记忆已在记忆里，未再写入' : `已写入${scope}记忆`,
        );
      }
      // 0037/0064：「丢弃未核」——接受按 live 滞留重算，只丢此刻仍滞留的；已晋升/关窗/删除的不动。
      if (prop.payload.kind === '丢弃未核') {
        if (!objectId) return state;
        if (action.decision === 'accept-drop') {
          const clock = lingerClock();
          const liveIds = new Set(
            lingeringUnverifiedClaims(state, objectId, clock.lingerDays, clock.now).map(
              (c) => c.id,
            ),
          );
          const dropIds = prop.payload.claimIds.filter((id) => liveIds.has(id));
          const dropped = state.claims.filter((c) => dropIds.includes(c.id));
          const dropIdSet = new Set(dropIds);
          return pushCard(
            {
              ...state,
              claims: state.claims.filter((c) => !dropIdSet.has(c.id)),
              proposals: state.proposals.map((p) =>
                p.id === prop.id ? { ...p, pending: false, decision: 'accept-drop' } : p,
              ),
              toast: { text: `已丢弃 ${dropped.length} 条滞留未核`, id: state.seq },
              seq: state.seq + 1,
            },
            objectId,
            {
              kind: '结果',
              claimIds: dropIds,
              result: '整理',
              undo:
                dropped.length > 0
                  ? { kind: '整理丢弃', claims: dropped.map((claim) => ({ ...claim })) }
                  : undefined,
            },
            dropped.length > 0
              ? `已丢弃 ${dropped.length} 条滞留未核：\n${dropped.map((c) => `· ${c.text}`).join('\n')}`
              : '没有仍滞留的未核可丢弃',
          );
        }
        const decided = action.decision === 'accept-merge' ? 'accept-drop' : 'reject';
        return pushCard(
          {
            ...state,
            proposals: state.proposals.map((p) =>
              p.id === prop.id ? { ...p, pending: false, decision: decided } : p,
            ),
            toast: { text: '已驳回', id: state.seq },
            seq: state.seq + 1,
          },
          objectId,
          { kind: '结果', result: '拒绝' },
          '已驳回丢弃提议，主张保持未核',
        );
      }
      // 0053：合并重复——只删 dropIds、keep 行不动；补偿复用批量整理丢弃（同构零新 undo kind）。
      if (prop.payload.kind === '合并重复') {
        if (!objectId) return state;
        if (action.decision === 'accept-merge') {
          const dropIds = new Set(prop.payload.dropIds);
          const dropped = state.claims.filter((c) => dropIds.has(c.id));
          return pushCard(
            {
              ...state,
              claims: state.claims.filter((c) => !dropIds.has(c.id)),
              proposals: state.proposals.map((p) =>
                p.id === prop.id ? { ...p, pending: false, decision: 'accept-merge' } : p,
              ),
              toast: { text: `已合并重复，去掉 ${dropped.length} 条`, id: state.seq },
              seq: state.seq + 1,
            },
            objectId,
            {
              kind: '结果',
              claimIds: prop.payload.dropIds,
              result: '整理',
              undo:
                dropped.length > 0
                  ? { kind: '整理丢弃', claims: dropped.map((claim) => ({ ...claim })) }
                  : undefined,
            },
            `已合并重复主张：保留首条，去掉 ${dropped.length} 条（派生冲突随之消失）`,
          );
        }
        // 合并卡不提供 accept-drop / accept-close：非 accept-merge 一律驳回。
        return pushCard(
          {
            ...state,
            proposals: state.proposals.map((p) =>
              p.id === prop.id ? { ...p, pending: false, decision: 'reject' } : p,
            ),
            toast: { text: '已驳回', id: state.seq },
            seq: state.seq + 1,
          },
          objectId,
          { kind: '结果', result: '拒绝' },
          '已驳回合并提议，重复主张原样保留',
        );
      }
      // 0062：主键新版过时——人确认才关窗，关闭原因「被主键新版取代」；undo 复用关窗补偿（0034）。
      if (prop.payload.kind === '主键新版过时') {
        if (!objectId) return state;
        const payload = prop.payload;
        const oldClaimId = payload.oldClaimId;
        if (action.decision === 'accept-close') {
          const today = new Date().toISOString().slice(0, 10);
          const target = state.claims.find((c) => c.id === oldClaimId);
          if (!target || target.status === '过时') {
            return refreshDropCards(
              {
                ...state,
                proposals: state.proposals.map((p) =>
                  p.id === prop.id ? { ...p, pending: false, decision: 'accept-close' } : p,
                ),
              },
              objectId,
            );
          }
          return refreshDropCards(
            pushCard(
              {
                ...state,
                claims: state.claims.map((c) =>
                  c.id === oldClaimId
                    ? {
                        ...c,
                        status: '过时' as const,
                        validTo: today,
                        closeReason: '被主键新版取代' as const,
                        supersededBy: payload.newClaimId,
                      }
                    : c,
                ),
                proposals: state.proposals.map((p) =>
                  p.id === prop.id ? { ...p, pending: false, decision: 'accept-close' } : p,
                ),
                toast: { text: '已关窗（被主键新版取代）', id: state.seq },
                seq: state.seq + 1,
              },
              objectId,
              {
                kind: '结果',
                claimId: oldClaimId,
                result: '关窗',
                undo: { kind: '关窗', claimId: oldClaimId },
              },
              '已确认旧版过时并关窗，关闭原因「被主键新版取代」',
            ),
            objectId,
          );
        }
        return pushCard(
          {
            ...state,
            proposals: state.proposals.map((p) =>
              p.id === prop.id ? { ...p, pending: false, decision: 'reject' } : p,
            ),
            toast: { text: '已驳回', id: state.seq },
            seq: state.seq + 1,
          },
          objectId,
          { kind: '结果', result: '拒绝' },
          '已驳回旧版过时提议，冲突双方仍并排',
        );
      }
      // 标过时——复核提示的落点：人确认才关窗（世界已变），undo 复用关窗补偿重开（历史不改写，0034）。
      if (prop.payload.kind === '标过时') {
        if (!objectId) return state;
        const staleClaimId = prop.payload.claimId;
        if (action.decision === 'accept-close') {
          const today = new Date().toISOString().slice(0, 10);
          return refreshDropCards(
            pushCard(
              {
                ...state,
                claims: state.claims.map((c) =>
                  c.id === staleClaimId
                    ? {
                        ...c,
                        status: '过时' as const,
                        validTo: today,
                        closeReason: '世界已变' as const,
                      }
                    : c,
                ),
                proposals: state.proposals.map((p) =>
                  p.id === prop.id ? { ...p, pending: false, decision: 'accept-close' } : p,
                ),
                toast: { text: '已关窗（世界已变）', id: state.seq },
                seq: state.seq + 1,
              },
              objectId,
              {
                kind: '结果',
                claimId: staleClaimId,
                result: '关窗',
                undo: { kind: '关窗', claimId: staleClaimId },
              },
              '已确认过时并关窗，有效期内仍是历史事实',
            ),
            objectId,
          );
        }
        return pushCard(
          {
            ...state,
            proposals: state.proposals.map((p) =>
              p.id === prop.id ? { ...p, pending: false, decision: 'reject' } : p,
            ),
            toast: { text: '已驳回', id: state.seq },
            seq: state.seq + 1,
          },
          objectId,
          { kind: '结果', result: '拒绝' },
          '已驳回复核提议，主张保持成立',
        );
      }
      // 0052：建对象——对象身份只由人确认。内联复刻 ADD_OBJECT 的创建（nextId + append），
      // 但不 openObject 不抢视图；确认后不自动绑定来源（绑定须人确认，0028 精神）。
      // 免 undo：对齐关系裁决口径（对象可归档回退，operations 行留痕），不进 UndoPayload。
      if (prop.payload.kind === '建对象') {
        if (!objectId || !state.objects.some((o) => o.id === objectId)) return state;
        if (action.decision !== 'accept-merge') {
          return pushCard(
            {
              ...state,
              proposals: state.proposals.map((p) =>
                p.id === prop.id ? { ...p, pending: false, decision: 'reject' } : p,
              ),
              toast: { text: '已驳回', id: state.seq },
              seq: state.seq + 1,
            },
            objectId,
            { kind: '结果', result: '拒绝' },
            `已驳回复核提议，未建立新对象「${prop.payload.name}」`,
          );
        }
        const kind = action.objectKind;
        if (!kind) {
          return {
            ...state,
            toast: { text: '请先选择对象种类', id: state.seq },
            seq: state.seq + 1,
          };
        }
        const name = prop.payload.name.trim();
        if (!state.currentWorkspaceId) {
          return { ...state, toast: { text: '先建工作区', id: state.seq }, seq: state.seq + 1 };
        }
        if (state.objects.some((o) => o.name === name)) {
          return {
            ...state,
            toast: { text: '已存在同名对象，未建立', id: state.seq },
            seq: state.seq + 1,
          };
        }
        const [newId, seq] = nextId(
          state,
          kind === '人' ? 'person' : kind === '组织' ? 'org' : 'proj',
        );
        const next: State = {
          ...state,
          seq,
          objects: [
            ...state.objects,
            { id: newId, kind, name, workspaceId: state.currentWorkspaceId, relationIds: [] },
          ],
          proposals: state.proposals.map((p) =>
            p.id === prop.id ? { ...p, pending: false, decision: 'accept-merge' } : p,
          ),
          toast: { text: `已建立对象「${name}」`, id: state.seq },
        };
        return pushCard(
          next,
          objectId,
          { kind: '结果', result: '整理' },
          `已建立${kind}对象「${name}」。来源不会自动绑定到新对象，需要时可手动绑定。`,
        );
      }
      // 补关系——内联复刻 ADD_RELATION 的对称双侧 append；四重校验在提议层已滤，
      // 这里仍要防确认间隙的变动（人可能先归档了对端）：查到不合法就 toast 拒、保持待确认。
      // 免 undo：关系不进补偿写载荷（ADD_RELATION/REMOVE_RELATION 同口径，0034）。
      if (prop.payload.kind === '建关系') {
        if (!objectId || !state.objects.some((o) => o.id === objectId)) return state;
        if (action.decision !== 'accept-merge') {
          return pushCard(
            {
              ...state,
              proposals: state.proposals.map((p) =>
                p.id === prop.id ? { ...p, pending: false, decision: 'reject' } : p,
              ),
              toast: { text: '已驳回', id: state.seq },
              seq: state.seq + 1,
            },
            objectId,
            { kind: '结果', result: '拒绝' },
            '已驳回复核提议，两个对象之间不建关系',
          );
        }
        // 判定要用的字段先落到 const：payload 判别收窄进不了下面的 find 回调。
        const relAId = prop.payload.objectId;
        const relBId = prop.payload.targetId;
        const a = state.objects.find((o) => o.id === relAId);
        const b = state.objects.find((o) => o.id === relBId);
        const invalid =
          !a || !b
            ? '对象不存在，无法建关系'
            : a.id === b.id
              ? '不能和对象自己建关系'
              : a.archived || b.archived
                ? '已归档对象不能建关系'
                : a.kind === b.kind
                  ? '同种类对象之间不建关系'
                  : a.relationIds.includes(b.id) || b.relationIds.includes(a.id)
                    ? '这两个对象已经关联'
                    : null;
        if (invalid) {
          return { ...state, toast: { text: invalid, id: state.seq }, seq: state.seq + 1 };
        }
        if (!a || !b) return state;
        const next: State = {
          ...state,
          seq: state.seq + 1,
          objects: state.objects.map((o) =>
            o.id === a.id
              ? { ...o, relationIds: [...o.relationIds, b.id] }
              : o.id === b.id
                ? { ...o, relationIds: [...o.relationIds, a.id] }
                : o,
          ),
          proposals: state.proposals.map((p) =>
            p.id === prop.id ? { ...p, pending: false, decision: 'accept-merge' } : p,
          ),
          toast: { text: `已建立「${a.name}」与「${b.name}」的关系`, id: state.seq },
        };
        return pushCard(
          next,
          objectId,
          { kind: '结果', result: '整理' },
          `已建立「${a.name}」与「${b.name}」的关系，主张未动。`,
        );
      }
      const tidy = prop.payload;
      if (tidy.kind !== '整理' || !objectId) return state;
      if (action.decision === 'accept-merge') {
        // 人选拖槽：决策载荷的槽优先，回落 payload 预选；0025 只能并入受控表已有槽。
        const targetPredicate = action.targetPredicate ?? tidy.targetPredicate;
        if (!targetPredicate) {
          return {
            ...state,
            toast: { text: '请先选择要并入的槽', id: state.seq },
            seq: state.seq + 1,
          };
        }
        if (!slotIsControlled(state, targetPredicate)) {
          return {
            ...state,
            toast: { text: '不许自开谓词槽，只能并入已有槽', id: state.seq },
            seq: state.seq + 1,
          };
        }
        const fromPredicate = state.claims.find((c) => c.id === tidy.claimId)?.predicate;
        const claims = state.claims.map((c) =>
          c.id === tidy.claimId ? { ...c, predicate: targetPredicate } : c,
        );
        return pushCard(
          {
            ...state,
            claims,
            proposals: state.proposals.map((p) =>
              p.id === prop.id ? { ...p, pending: false, decision: 'accept-merge' } : p,
            ),
            toast: { text: `已并入「${targetPredicate}」`, id: state.seq },
            seq: state.seq + 1,
          },
          objectId,
          {
            kind: '结果',
            claimId: tidy.claimId,
            result: '整理',
            undo: fromPredicate
              ? { kind: '整理并入', claimId: tidy.claimId, fromPredicate }
              : undefined,
          },
          `已并入「${targetPredicate}」`,
        );
      }
      if (action.decision === 'accept-drop') {
        const dropped = state.claims.find((c) => c.id === tidy.claimId);
        return pushCard(
          {
            ...state,
            claims: state.claims.filter((c) => c.id !== tidy.claimId),
            proposals: state.proposals.map((p) =>
              p.id === prop.id ? { ...p, pending: false, decision: 'accept-drop' } : p,
            ),
            toast: { text: '已丢弃', id: state.seq },
            seq: state.seq + 1,
          },
          objectId,
          {
            kind: '结果',
            claimId: tidy.claimId,
            result: '整理',
            undo: dropped ? { kind: '整理丢弃', claims: [{ ...dropped }] } : undefined,
          },
          '已丢弃这条未编目主张',
        );
      }
      return pushCard(
        {
          ...state,
          proposals: state.proposals.map((p) =>
            p.id === prop.id ? { ...p, pending: false, decision: 'reject' } : p,
          ),
          toast: { text: '已驳回', id: state.seq },
          seq: state.seq + 1,
        },
        objectId,
        { kind: '结果', result: '拒绝' },
        '已驳回这条整理提议',
      );
    }

    default:
      return undefined;
  }
}

function refreshDropCards(state: State, objectId: string): State {
  const clock = lingerClock();
  return refreshPendingDropUnverified(state, objectId, clock.lingerDays, clock.now);
}

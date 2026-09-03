import type { Action } from '@shared/actions';
import type { ChatCard, ChatMessage, IngestJob, State } from '@shared/types';
import { bindingRole, dropBindingRole, withBindingRole } from '@shared/primarySource';
import { readLingerDays } from '../lingerDays';
import { proposeSupersedeByPrimary, refreshPendingDropUnverified } from '../loops/tidy';
import {
  ensureTab,
  maybeEnqueuePrimarySuggestions,
  nextId,
  openObject,
  pushCard,
  pushChat,
} from './actionHelpers';

// 来源与绑定域 reducer 分支：材料入 Inbox、绑定/解绑/角色、删除与恢复、导入作业与抽取重试。

/** 追加账本结果卡但不抢走用户当前视图，用于可同时影响多对象的来源动作。 */
function appendCard(state: State, objectId: string, card: ChatCard, text = ''): State {
  const [id, seq] = nextId(state, 'msg');
  const msg: ChatMessage = { id, role: 'card', text, card };
  return {
    ...state,
    seq,
    chatByObject: pushChat({ ...state, seq }, objectId, msg),
  };
}

function proposalTouchesClaims(state: State, proposalId: string, claimIds: Set<string>): boolean {
  const proposal = state.proposals.find((item) => item.id === proposalId);
  if (!proposal) return false;
  if (proposal.payload.kind === '整理' || proposal.payload.kind === '标过时')
    return claimIds.has(proposal.payload.claimId);
  if (proposal.payload.kind === '主键新版过时') {
    return claimIds.has(proposal.payload.oldClaimId) || claimIds.has(proposal.payload.newClaimId);
  }
  if (proposal.payload.kind === '丢弃未核') {
    return proposal.payload.claimIds.some((id) => claimIds.has(id));
  }
  if (proposal.payload.kind === '合并重复') {
    return (
      claimIds.has(proposal.payload.keepId) ||
      proposal.payload.dropIds.some((id) => claimIds.has(id))
    );
  }
  return false;
}

function appendSupersedeProposals(state: State, objectIds: string[]): State {
  const ids = [...new Set(objectIds)];
  const fresh = ids.flatMap((objectId) => proposeSupersedeByPrimary(state, objectId, state.seq));
  if (fresh.length === 0) return state;
  return { ...state, proposals: [...state.proposals, ...fresh] };
}

function refreshDropCards(
  state: State,
  objectId: string,
  goneClaimIds?: ReadonlySet<string>,
): State {
  return refreshPendingDropUnverified(
    state,
    objectId,
    readLingerDays(),
    new Date().toISOString(),
    goneClaimIds,
  );
}

function ingestStatusText(job: IngestJob): string {
  if (job.inputKind === 'url') return '正在获取链接正文';
  if (job.inputKind === 'file') return '正在读取文件';
  return '正在解析文本';
}

export function sourceActions(state: State, action: Action): State | undefined {
  switch (action.type) {
    case 'BIND_CONFIRMED': {
      const source = state.sources.find((s) => s.id === action.sourceId);
      if (!source || action.objectIds.length === 0) return state;
      if (source.unparsed) {
        return {
          ...state,
          toast: { text: '旧版占位材料需要重新导入后再绑定', id: state.seq },
          seq: state.seq + 1,
        };
      }
      const seq = state.seq;
      const sources = state.sources.map((s) => {
        if (s.id !== action.sourceId) return s;
        const kept = { ...s.bindingRoles };
        for (const key of Object.keys(kept)) {
          if (!action.objectIds.includes(key)) delete kept[key];
        }
        const bindingRoles = Object.keys(kept).length > 0 ? kept : undefined;
        return { ...s, boundObjectIds: action.objectIds, bindingRoles };
      });
      const jobs = [
        ...state.extractJobs.filter((job) => job.sourceId !== action.sourceId),
        { sourceId: action.sourceId, status: '抽取中' as const },
      ];
      const objectId = action.objectIds[0];
      if (!objectId) return state;
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
      next = pushCard(
        next,
        objectId,
        { kind: '结果', result: '绑定', undo: { kind: '绑定', sourceId: action.sourceId } },
        `已绑定 ${action.objectIds.length} 个对象 · 抽取中`,
      );
      return maybeEnqueuePrimarySuggestions(next, action.sourceId, action.objectIds);
    }

    case 'UNBIND_SOURCE': {
      const source = state.sources.find((item) => item.id === action.sourceId);
      if (!source || source.virtual || !source.boundObjectIds.includes(action.objectId))
        return state;
      const remainingObjectIds = source.boundObjectIds.filter((id) => id !== action.objectId);
      const previousRole = bindingRole(source, action.objectId);
      const droppedClaims = state.claims.filter(
        (claim) => claim.sourceId === action.sourceId && claim.objectId === action.objectId,
      );
      const droppedIds = new Set(droppedClaims.map((claim) => claim.id));
      const sourceTitle = source.title;
      const next: State = {
        ...state,
        sources: state.sources.map((item) =>
          item.id === action.sourceId
            ? { ...dropBindingRole(item, action.objectId), boundObjectIds: remainingObjectIds }
            : item,
        ),
        claims: state.claims.filter(
          (claim) => !(claim.sourceId === action.sourceId && claim.objectId === action.objectId),
        ),
        pendingClaims: state.pendingClaims.filter(
          (claim) => !(claim.sourceId === action.sourceId && claim.objectId === action.objectId),
        ),
        proposals: state.proposals.filter((proposal) => {
          // 0064：丢弃未核卡按 live 滞留刷新，不解绑就整张撤掉。
          if (proposal.payload.kind === '丢弃未核') return true;
          return !proposalTouchesClaims(state, proposal.id, droppedIds);
        }),
        writeQueue: state.writeQueue.filter(
          (write) =>
            !(write.claimId && droppedIds.has(write.claimId)) &&
            !write.claimIds?.some((id) => droppedIds.has(id)),
        ),
        inbox:
          remainingObjectIds.length === 0 && !state.inbox.includes(action.sourceId)
            ? [...state.inbox, action.sourceId]
            : state.inbox,
        extractJobs:
          remainingObjectIds.length === 0
            ? state.extractJobs.filter((job) => job.sourceId !== action.sourceId)
            : state.extractJobs,
        selectedClaimId:
          state.selectedClaimId && droppedIds.has(state.selectedClaimId)
            ? null
            : state.selectedClaimId,
        toast: {
          text:
            remainingObjectIds.length === 0
              ? `已解绑「${sourceTitle}」，来源回 Inbox`
              : `已解绑「${sourceTitle}」与当前对象`,
          id: state.seq,
        },
        seq: state.seq + 1,
      };
      return refreshDropCards(
        pushCard(
          next,
          action.objectId,
          {
            kind: '结果',
            claimIds: droppedClaims.map((claim) => claim.id),
            result: '解绑',
            undo: {
              kind: '解绑',
              sourceId: action.sourceId,
              objectId: action.objectId,
              claims: droppedClaims.map((claim) => ({ ...claim })),
              role: previousRole,
            },
          },
          `已解绑「${sourceTitle}」：撤下该对象下 ${droppedClaims.length} 条主张${
            remainingObjectIds.length === 0 ? '，来源回到 Inbox' : ''
          }`,
        ),
        action.objectId,
        droppedIds,
      );
    }

    case 'SET_SOURCE_ROLE': {
      // 0062：绑定级角色。默认转述；同一来源对不同对象可不同。不自动关窗。
      const source = state.sources.find((item) => item.id === action.sourceId);
      if (!source || source.virtual || !source.boundObjectIds.includes(action.objectId)) {
        return state;
      }
      const previousRole = bindingRole(source, action.objectId);
      if (previousRole === action.role) return state;
      let next: State = {
        ...state,
        sources: state.sources.map((item) =>
          item.id === action.sourceId ? withBindingRole(item, action.objectId, action.role) : item,
        ),
        proposals:
          action.role === '转述'
            ? state.proposals.map((p) => {
                const payload = p.payload;
                if (!p.pending || payload.kind !== '主键新版过时') {
                  return p;
                }
                const oldC = state.claims.find((c) => c.id === payload.oldClaimId);
                const newC = state.claims.find((c) => c.id === payload.newClaimId);
                const touches =
                  (oldC?.sourceId === action.sourceId && oldC.objectId === action.objectId) ||
                  (newC?.sourceId === action.sourceId && newC.objectId === action.objectId);
                return touches ? { ...p, pending: false, decision: 'reject' as const } : p;
              })
            : state.proposals,
        toast: {
          text: action.role === '主键' ? '已标为主键' : '已改为转述',
          id: state.seq,
        },
        seq: state.seq + 1,
      };
      next = pushCard(
        next,
        action.objectId,
        {
          kind: '结果',
          result: '整理',
          undo: {
            kind: '设角色',
            sourceId: action.sourceId,
            objectId: action.objectId,
            previousRole,
          },
        },
        action.role === '主键'
          ? `已将来源「${source.title}」标为主键（仅当前对象）`
          : `已将来源「${source.title}」改为转述（仅当前对象）`,
      );
      if (action.role === '主键') next = appendSupersedeProposals(next, [action.objectId]);
      return next;
    }

    case 'DELETE_SOURCE': {
      const source = state.sources.find((item) => item.id === action.sourceId);
      if (!source || source.virtual) return state;
      const today = new Date().toISOString().slice(0, 10);
      const relatedClaims = state.claims.filter((claim) => claim.sourceId === action.sourceId);
      const closingClaims = relatedClaims.filter((claim) => claim.status === '成立');
      const relatedIds = new Set(relatedClaims.map((claim) => claim.id));
      const affectedObjectIds = [
        ...new Set([...source.boundObjectIds, ...relatedClaims.map((claim) => claim.objectId)]),
      ].filter((objectId) => state.objects.some((object) => object.id === objectId));
      let next: State = {
        ...state,
        sources: state.sources.filter((item) => item.id !== action.sourceId),
        claims: state.claims.map((claim) =>
          claim.sourceId === action.sourceId && claim.status === '成立'
            ? {
                ...claim,
                status: '过时' as const,
                validTo: today,
                closeReason: '来源删除' as const,
              }
            : claim,
        ),
        pendingClaims: state.pendingClaims.filter((claim) => claim.sourceId !== action.sourceId),
        proposals: state.proposals.filter((proposal) => {
          if (proposal.payload.kind === '丢弃未核') return true;
          return !proposalTouchesClaims(state, proposal.id, relatedIds);
        }),
        writeQueue: state.writeQueue.filter(
          (write) =>
            write.sourceId !== action.sourceId &&
            !(write.claimId && relatedIds.has(write.claimId)) &&
            !write.claimIds?.some((id) => relatedIds.has(id)),
        ),
        inbox: state.inbox.filter((id) => id !== action.sourceId),
        extractJobs: state.extractJobs.filter((job) => job.sourceId !== action.sourceId),
        sourceFocusId: state.sourceFocusId === action.sourceId ? null : state.sourceFocusId,
        toast: {
          text: `已删除来源「${source.title}」，${closingClaims.length} 条主张已关窗`,
          id: state.seq,
        },
        seq: state.seq + 1,
      };
      for (const objectId of affectedObjectIds) {
        const count = closingClaims.filter((claim) => claim.objectId === objectId).length;
        next = appendCard(
          next,
          objectId,
          { kind: '结果', result: '删除来源' },
          `已删除来源「${source.title}」：该对象下 ${count} 条主张已关窗（来源删除），历史简报不改`,
        );
        next = refreshDropCards(next, objectId, relatedIds);
      }
      return next;
    }

    case 'RESTORE_DELETED_SOURCE': {
      const source = action.recovery.source;
      if (source.virtual || state.sources.some((item) => item.id === source.id)) return state;
      const objectIds = new Set(state.objects.map((object) => object.id));
      const boundObjectIds = source.boundObjectIds.filter((id) => objectIds.has(id));
      const restoredSource = { ...source, boundObjectIds };
      const snapshots = new Map(
        action.recovery.claims
          .filter((claim) => claim.sourceId === source.id && objectIds.has(claim.objectId))
          .map((claim) => [claim.id, claim]),
      );
      const restoredIds = new Set<string>();
      const claims = state.claims.map((claim) => {
        const snapshot = snapshots.get(claim.id);
        if (!snapshot) return claim;
        restoredIds.add(claim.id);
        return { ...snapshot };
      });
      const missingClaims = [...snapshots.values()]
        .filter((claim) => !restoredIds.has(claim.id))
        .map((claim) => ({ ...claim }));
      const affectedObjectIds = [
        ...new Set([...boundObjectIds, ...[...snapshots.values()].map((claim) => claim.objectId)]),
      ].filter((objectId) => objectIds.has(objectId));
      let next: State = {
        ...state,
        sources: [...state.sources, restoredSource],
        claims: [...claims, ...missingClaims],
        inbox:
          boundObjectIds.length === 0 && !state.inbox.includes(source.id)
            ? [...state.inbox, source.id]
            : state.inbox.filter((id) => id !== source.id),
        deletedSourceRecoveries: state.deletedSourceRecoveries.filter(
          (item) => item.source.id !== source.id,
        ),
        toast: {
          text: `已恢复来源「${source.title}」`,
          id: state.seq,
        },
        seq: state.seq + 1,
      };
      for (const objectId of affectedObjectIds) {
        const count = [...snapshots.values()].filter((claim) => claim.objectId === objectId).length;
        next = appendCard(
          next,
          objectId,
          { kind: '结果', result: '撤销' },
          `已恢复来源「${source.title}」：恢复绑定并重开 ${count} 条主张`,
        );
      }
      return next;
    }

    case 'RETRY_EXTRACTION': {
      const source = state.sources.find((item) => item.id === action.sourceId);
      if (!source || source.boundObjectIds.length === 0) return state;
      return {
        ...state,
        extractJobs: [
          ...state.extractJobs.filter((job) => job.sourceId !== action.sourceId),
          { sourceId: action.sourceId, status: '抽取中' },
        ],
        toast: { text: '已重新开始抽取', id: state.seq + 1 },
        seq: state.seq + 1,
      };
    }

    case 'FOCUS_SOURCE': {
      const source = state.sources.find((s) => s.id === action.sourceId);
      const objectId =
        (state.view.kind === 'object' ? state.view.objectId : null) ??
        source?.boundObjectIds[0] ??
        null;
      if (!objectId) return { ...state, sourceFocusId: action.sourceId };
      return ensureTab(
        { ...openObject(state, objectId), sourceFocusId: action.sourceId },
        objectId,
        '来源',
        true,
      );
    }

    case 'ADD_SOURCE': {
      if (action.fromUrl || action.unparsed) {
        return {
          ...state,
          toast: { text: '请使用导入入口获取真实正文', id: state.seq },
          seq: state.seq + 1,
        };
      }
      const body = action.body.trim();
      if (!body) return state;
      const [id, seq] = nextId(state, 'src');
      // 审计五轮 E2：fromUrl 在 case 顶部已早退，标题回退不留死分支。
      const title = action.title.trim() || body.slice(0, 24) || '粘贴文本';
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
          },
        ],
        inbox: [...state.inbox, id],
        toast: { text: '已加入 Inbox', id: seq },
      };
    }

    case 'INGEST_STARTED': {
      const existing = state.ingestJobs.find((job) => job.id === action.job.id);
      const jobs = existing
        ? state.ingestJobs.map((job) =>
            job.id === action.job.id
              ? {
                  ...action.job,
                  createdAt: job.createdAt,
                  attempt: Math.max(action.job.attempt, job.attempt + 1),
                }
              : job,
          )
        : [...state.ingestJobs, action.job];
      return {
        ...state,
        ingestJobs: jobs,
        toast: { text: ingestStatusText(action.job), id: state.seq },
      };
    }

    case 'INGEST_SUCCEEDED': {
      const body = action.body.trim();
      if (!body) return state;
      const [id, seq] = nextId(state, 'src');
      const source = {
        id,
        title: action.title.trim() || '导入材料',
        body,
        path: '手给' as const,
        boundObjectIds: [],
        workspaceId: state.currentWorkspaceId,
        origin: action.origin,
        segments: action.segments,
        contentHash: action.contentHash,
        fetchedAt: action.origin.fetchedAt,
      };
      const updatedAt = new Date().toISOString();
      const jobs = state.ingestJobs.map((job) =>
        job.id === action.jobId
          ? {
              ...job,
              status: '完成' as const,
              sourceId: id,
              title: source.title,
              locator: action.origin.finalUrl ?? action.origin.locator ?? job.locator,
              detail: undefined,
              failureKind: undefined,
              updatedAt,
            }
          : job,
      );
      return {
        ...state,
        seq,
        sources: [...state.sources, source],
        inbox: [...state.inbox, id],
        ingestJobs: jobs,
        toast: { text: '真实材料已解析并加入 Inbox', id: seq },
      };
    }

    case 'INGEST_FAILED': {
      const updatedAt = new Date().toISOString();
      const jobs = state.ingestJobs.map((job) =>
        job.id === action.jobId
          ? {
              ...job,
              status: '失败' as const,
              title: action.title ?? job.title,
              locator: action.locator ?? job.locator,
              failureKind: action.failureKind,
              detail: action.detail,
              updatedAt,
            }
          : job,
      );
      return {
        ...state,
        ingestJobs: jobs,
        toast: { text: `导入失败：${action.detail}`, id: state.seq },
      };
    }

    default:
      return undefined;
  }
}

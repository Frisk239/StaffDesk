import type { Action } from '@shared/actions';
import type {
  Brief,
  ChatCard,
  ChatMessage,
  Claim,
  ExtractionOutcomeKind,
  IngestJob,
  CandidatePayload,
  Proposal,
  RightTab,
  Predicate,
  RightTabKind,
  State,
  TaskAudit,
  WriteProposal,
} from '@shared/types';
import { bannedHit } from '@shared/brief';
import {
  pendingTaskClaimReview,
  sourceResearchTaskId,
  taskClaimReviewReady,
  taskClaimReviewSummary,
  unverifiedClaimIdsForTask,
} from '@shared/taskClaims';
import { outboundBrief, verifyBrief } from './briefOut';
import { idempotencyKey } from '../loops/extract';
import {
  proposeCatalogUncataloged,
  proposeDropUnverified,
  proposeMarkStale,
  proposeMergeDuplicates,
} from '../loops/tidy';
import { deriveConflicts, normalizeValue } from '@shared/scenario';
import { scriptReply } from '@shared/chat';
import { attachTurn } from '@shared/turn';
import { dreamMemoryProposals } from '../loops/memoryDream';

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

function claimStillHasSource(state: State, claim: Claim): boolean {
  if (claim.sourceId === 'user-stmt') return true;
  const source = state.sources.find((item) => item.id === claim.sourceId);
  return Boolean(source?.boundObjectIds.includes(claim.objectId));
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
  return ensureTab(
    { ...state, view: { kind: 'object', objectId } },
    objectId,
    '档案',
    !state.activeRightTabByObject[objectId],
  );
}

/** 0025：受控谓词表是数据（state.slotDefs），整理只能并入表内已有槽。 */
function slotIsControlled(state: State, name: Predicate): boolean {
  return state.slotDefs.some((d) => d.name === name);
}

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

function extractionResultText(
  outcome: ExtractionOutcomeKind,
  detail: string | undefined,
  draftCount: number,
  rejectedCount: number,
): string {
  if (outcome === 'unconfigured') {
    return '未开始抽取：还没有可调用的模型。请先到设置里完成模型配置，再点来源旁的重试。';
  }
  if (outcome === 'invalid-output') {
    return `抽取未完成：${detail ?? '模型输出结构不合格'}。没有写入任何主张，可以重试。`;
  }
  if (outcome === 'failed') {
    return `抽取失败：${detail ?? '模型调用失败'}。没有写入任何主张，可以重试。`;
  }
  if (draftCount > 0 && rejectedCount >= draftCount) {
    return `模型返回了 ${draftCount} 条候选，但都没有通过原文片段、对象或去重校验；没有写入主张。`;
  }
  return '原文中没有抽出可核对的主张；没有写入账本。';
}

function ingestStatusText(job: IngestJob): string {
  if (job.inputKind === 'url') return '正在获取链接正文';
  if (job.inputKind === 'file') return '正在读取文件';
  return '正在解析文本';
}

function claimEvidenceKey(claim: Claim): string {
  const span = claim.span ?? claim.text;
  return typeof claim.sourceStart === 'number' ? `${span}\0${claim.sourceStart}` : span;
}

function enqueueWrite(state: State, draft: Omit<WriteProposal, 'id'>): State {
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

function enqueueTaskClaimReview(state: State, taskId: string): State {
  const task = state.tasks.find((item) => item.id === taskId);
  if (!task || !taskClaimReviewReady(state, taskId) || pendingTaskClaimReview(state, taskId)) {
    return state;
  }
  const claimIds = unverifiedClaimIdsForTask(state, taskId);
  if (claimIds.length === 0) return state;
  // 0016：任务结束时只允许对「本任务产生的未核」批量决策；晋升只翻核对轴。
  return enqueueWrite(state, {
    objectId: task.objectId,
    taskId,
    kind: '批量晋升',
    claimIds,
    headline: `本次${task.kind}新增未核 ${claimIds.length} 条：全部晋升，还是全部保持？`,
    evidence: taskClaimReviewSummary(state, claimIds),
    outbound: true,
  });
}

function enqueueTaskClaimReviewForSource(state: State, sourceId: string): State {
  const source = state.sources.find((item) => item.id === sourceId);
  const taskId = source ? sourceResearchTaskId(source) : null;
  return taskId ? enqueueTaskClaimReview(state, taskId) : state;
}

function proposalObjectId(state: State, proposalId: string): string | null {
  const p = state.proposals.find((x) => x.id === proposalId);
  if (!p) return null;
  if (p.payload.kind === '候选记忆') return p.payload.fromObjectId ?? null;
  if (p.payload.kind === '丢弃未核') {
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
  const claimId = p.payload.claimId;
  return (
    state.claims.find((c) => c.id === claimId)?.objectId ??
    state.pendingClaims.find((c) => c.id === claimId)?.objectId ??
    null
  );
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

function addDaysIso(iso: string, days: number): string {
  const parsed = parseStamp(iso);
  const base = Number.isNaN(parsed) ? Date.now() : parsed;
  return formatStamp(base + days * 24 * 60 * 60 * 1000);
}

function parseStamp(stamp: string): number {
  const match = stamp.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/);
  if (!match) return Date.parse(stamp.replace(' ', 'T'));
  const [, y, m, d, h, min] = match;
  return new Date(Number(y), Number(m) - 1, Number(d), Number(h), Number(min)).getTime();
}

function formatStamp(ms: number): string {
  const d = new Date(ms);
  const pad = (value: number) => String(value).padStart(2, '0');
  return [
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
    `${pad(d.getHours())}:${pad(d.getMinutes())}`,
  ].join(' ');
}

function nextRadarDueAfter(
  task: { nextDueAt?: string | undefined; intervalDays?: number | undefined },
  afterIso: string,
): string {
  const interval = Math.max(1, task.intervalDays ?? 1);
  let due = task.nextDueAt ?? afterIso;
  let guard = 0;
  while (parseStamp(due) <= parseStamp(afterIso) && guard < 370) {
    due = addDaysIso(due, interval);
    guard += 1;
  }
  return due;
}

function taskAuditKey(audit: TaskAudit): string {
  return `${audit.taskId}\0${audit.seq}`;
}

function appendTaskAudits(existing: TaskAudit[], incoming: TaskAudit[]): TaskAudit[] {
  const seen = new Set(existing.map(taskAuditKey));
  const fresh = incoming.filter((audit) => {
    const key = taskAuditKey(audit);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return fresh.length > 0 ? [...existing, ...fresh] : existing;
}

export function reducer(state: State, action: Action): State {
  switch (action.type) {
    case 'SET_VIEW': {
      if (action.view.kind === 'object') {
        return openObject(
          { ...state, selectedClaimId: state.selectedClaimId },
          action.view.objectId,
        );
      }
      return { ...state, view: action.view };
    }

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
      const sources = state.sources.map((s) =>
        s.id === action.sourceId ? { ...s, boundObjectIds: action.objectIds } : s,
      );
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
      return pushCard(
        next,
        objectId,
        { kind: '结果', result: '绑定', undo: { kind: '绑定', sourceId: action.sourceId } },
        `已绑定 ${action.objectIds.length} 个对象 · 抽取中`,
      );
    }

    case 'UNBIND_SOURCE': {
      const source = state.sources.find((item) => item.id === action.sourceId);
      if (!source || source.virtual || !source.boundObjectIds.includes(action.objectId))
        return state;
      const remainingObjectIds = source.boundObjectIds.filter((id) => id !== action.objectId);
      const droppedClaims = state.claims.filter(
        (claim) => claim.sourceId === action.sourceId && claim.objectId === action.objectId,
      );
      const droppedIds = new Set(droppedClaims.map((claim) => claim.id));
      const sourceTitle = source.title;
      const next: State = {
        ...state,
        sources: state.sources.map((item) =>
          item.id === action.sourceId ? { ...item, boundObjectIds: remainingObjectIds } : item,
        ),
        claims: state.claims.filter(
          (claim) => !(claim.sourceId === action.sourceId && claim.objectId === action.objectId),
        ),
        pendingClaims: state.pendingClaims.filter(
          (claim) => !(claim.sourceId === action.sourceId && claim.objectId === action.objectId),
        ),
        proposals: state.proposals.filter(
          (proposal) => !proposalTouchesClaims(state, proposal.id, droppedIds),
        ),
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
      return pushCard(
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
          },
        },
        `已解绑「${sourceTitle}」：撤下该对象下 ${droppedClaims.length} 条主张${
          remainingObjectIds.length === 0 ? '，来源回到 Inbox' : ''
        }`,
      );
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
        proposals: state.proposals.filter(
          (proposal) => !proposalTouchesClaims(state, proposal.id, relatedIds),
        ),
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

    case 'EXTRACT_DONE': {
      const outcome = action.outcome ?? 'success';
      const finalStatus: State['extractJobs'][number]['status'] =
        outcome === 'success' ? '完成' : outcome === 'unconfigured' ? '未配置' : '失败';
      const terminalJob = {
        sourceId: action.sourceId,
        status: finalStatus,
        detail: action.detail,
      };
      const jobs = state.extractJobs.some((job) => job.sourceId === action.sourceId)
        ? state.extractJobs.map((job) => (job.sourceId === action.sourceId ? terminalJob : job))
        : [...state.extractJobs, terminalJob];
      const src = state.sources.find((s) => s.id === action.sourceId);
      // 绑定被撤销后迟到的抽取完成：来源已不在绑定态，只清理作业，不写入、不弹卡。
      if (!src || src.boundObjectIds.length === 0) {
        return {
          ...state,
          extractJobs: jobs,
          pendingClaims: state.pendingClaims.filter((c) => c.sourceId !== action.sourceId),
        };
      }
      const objectId = src.boundObjectIds[0];
      const pending = state.pendingClaims.filter((c) => c.sourceId === action.sourceId);
      // action.claims 只接收真实抽取循环的结果；未配置模型时不写任何主张。
      const candidates = outcome === 'success' ? (action.claims ?? pending) : [];
      // 抽取请求可能在解绑/重绑之间并发完成；最终落账必须再次按当前账本幂等复核。
      const seen = new Set(
        state.claims.map((claim) =>
          idempotencyKey(claim.sourceId, claim.objectId, claim.predicate, claimEvidenceKey(claim)),
        ),
      );
      const incoming = candidates.filter((claim) => {
        if (claim.sourceId !== action.sourceId || !src.boundObjectIds.includes(claim.objectId)) {
          return false;
        }
        const key = idempotencyKey(
          claim.sourceId,
          claim.objectId,
          claim.predicate,
          claimEvidenceKey(claim),
        );
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      if (incoming.length === 0) {
        let next: State = {
          ...state,
          extractJobs: jobs,
          pendingClaims: state.pendingClaims.filter((c) => c.sourceId !== action.sourceId),
        };
        if (objectId) {
          const text = extractionResultText(
            outcome,
            action.detail,
            action.draftCount ?? 0,
            action.rejectedCount ?? 0,
          );
          next = pushCard(next, objectId, { kind: '结果', result: '抽取' }, text);
        }
        return enqueueTaskClaimReviewForSource(next, action.sourceId);
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
          const claimNames = claimObjIds
            .map((id) => state.objects.find((o) => o.id === id)?.name ?? id)
            .join('、');
          const boundNames = bound
            .map((id) => state.objects.find((o) => o.id === id)?.name ?? id)
            .join('、');
          text += `。主张挂在「${claimNames}」，本次绑定的是「${boundNames}」`;
        }
        next = pushCard(
          next,
          objectId,
          { kind: '结果', result: '抽取', claimIds: incoming.map((c) => c.id) },
          text,
        );
        // CONTEXT「整理」：抽取落账后的提议面——丢弃滞留未核（0037）、合并重复（0053）、
        // 标过时复核、未编目编目。全部人确认才改账本，各提议器自带 pending 去重；
        // id 前缀互不相同，天然不撞。
        const tidySeq = next.seq;
        const fresh = [
          proposeDropUnverified(next, objectId, tidySeq),
          ...proposeMergeDuplicates(next, objectId, tidySeq),
          ...proposeMarkStale(next, objectId, tidySeq),
          ...proposeCatalogUncataloged(next, objectId, tidySeq),
        ].filter((p): p is Proposal => p !== null);
        if (fresh.length > 0) next = { ...next, proposals: [...next.proposals, ...fresh] };
      }
      return enqueueTaskClaimReviewForSource(next, action.sourceId);
    }

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
          {
            kind: '结果',
            claimId: old.id,
            result: '整理',
            undo: { kind: '整理丢弃', claims: [{ ...old }] },
          },
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
      // 0054：禁写双路——text 保留被纠正原句（原句路兜底），
      // 结构化字段记（对象、谓词槽、归一化取值）拦换措辞复述与再抽取。
      const next: State = {
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
            bannedObjectId: old.objectId,
            bannedPredicate: old.predicate,
            bannedValue: normalizeValue(old.text),
          },
        ],
        toast: { text: '已纠正，禁写已生效', id: seq + 1 },
      };
      // 0034：补偿载荷=重开旧句 + 移除禁写 + 配套新句一并关窗（Q4 原子性）。
      return pushCard(
        next,
        old.objectId,
        {
          kind: '结果',
          claimId: old.id,
          result: '关窗',
          undo: { kind: '关窗', claimId: old.id, memoryId: memId, companionId: newId },
        },
        `已关窗 · ${action.closeReason} · 禁写已生效`,
      );
    }

    case 'PROMOTE_CLAIM': {
      const claim = state.claims.find((c) => c.id === action.claimId);
      if (!claim) return state;
      const next: State = {
        ...state,
        claims: state.claims.map((c) =>
          c.id === action.claimId ? { ...c, unverified: false } : c,
        ),
        toast: { text: '已晋升', id: state.seq },
        seq: state.seq + 1,
      };
      return pushCard(
        next,
        claim.objectId,
        {
          kind: '结果',
          claimId: claim.id,
          result: '晋升',
          undo: { kind: '晋升', claimId: claim.id },
        },
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
      const assembled = action.brief ?? outboundBrief(state, objectId, briefId, taskId);
      const brief: Brief = { ...verifyBrief(assembled, state.claims), createdAt };
      const unverifiedClaims = state.claims.filter(
        (c) => c.objectId === objectId && c.unverified && c.status === '成立',
      );
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
              proposals: state.proposals.map((p) =>
                p.id === prop.id ? { ...p, pending: false, decision: 'accept-drop' } : p,
              ),
              toast: { text: `已丢弃 ${dropped.length} 条未核主张`, id: state.seq },
              seq: state.seq + 1,
            },
            objectId,
            {
              kind: '结果',
              claimIds: prop.payload.claimIds,
              result: '整理',
              undo:
                dropped.length > 0
                  ? { kind: '整理丢弃', claims: dropped.map((claim) => ({ ...claim })) }
                  : undefined,
            },
            `已丢弃 ${dropped.length} 条未核主张（派生冲突随之消失）`,
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
      // 标过时——复核提示的落点：人确认才关窗（世界已变），undo 复用关窗补偿重开（历史不改写，0034）。
      if (prop.payload.kind === '标过时') {
        if (!objectId) return state;
        const staleClaimId = prop.payload.claimId;
        if (action.decision === 'accept-close') {
          const today = new Date().toISOString().slice(0, 10);
          return pushCard(
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
      const title =
        action.title.trim() ||
        (action.fromUrl ? (body.split('\n')[0] ?? body.slice(0, 24)) : body.slice(0, 24)) ||
        '粘贴文本';
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
          const claims = st.claims.map((c) =>
            c.id === head.claimId ? { ...c, predicate: head.targetPredicate! } : c,
          );
          st = { ...st, claims };
          st = pushCard(
            st,
            head.objectId,
            { kind: '结果', claimId: head.claimId, result: '整理' },
            `已并入「${head.targetPredicate}」`,
          );
        }
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
              s.id === undo.sourceId ? { ...s, boundObjectIds: [] } : s,
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
            sources: st.sources.map((item) =>
              item.id === undo.sourceId && !item.boundObjectIds.includes(undo.objectId)
                ? { ...item, boundObjectIds: [...item.boundObjectIds, undo.objectId] }
                : item,
            ),
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

    case 'REMOVE_MEMORY':
      // 0034：禁写的显式回退（待确认页记忆区）。移除本身可再补偿（重新纠正会再写）。
      return {
        ...state,
        memories: state.memories.filter((m) => m.id !== action.id),
        toast: { text: '已移除这条禁写', id: state.seq },
        seq: state.seq + 1,
      };

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
          if (p.payload.kind === '丢弃未核')
            return !p.payload.claimIds.some((id) => claimIds.has(id));
          if (p.payload.kind === '合并重复')
            return (
              !claimIds.has(p.payload.keepId) && !p.payload.dropIds.some((id) => claimIds.has(id))
            );
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

    case 'TASK_RUN_STARTED': {
      const object = state.objects.find((item) => item.id === action.task.objectId);
      if (!object) return state;
      const task = { ...action.task, status: '进行中' as const };
      delete task.stopReason;
      const exists = state.tasks.some((item) => item.id === task.id);
      const tasks = exists
        ? state.tasks.map((item) => (item.id === task.id ? task : item))
        : [...state.tasks, task];
      return {
        ...state,
        seq: state.seq + 1,
        tasks,
        toast: {
          text: task.kind === '再搜一轮' ? '再搜一轮已开始' : '调研已开始',
          id: state.seq + 1,
        },
      };
    }

    case 'TASK_AUDIT_APPENDED': {
      if (!state.tasks.some((task) => task.id === action.taskId)) return state;
      const incoming = action.audits.filter((audit) => audit.taskId === action.taskId);
      const taskAudits = appendTaskAudits(state.taskAudits, incoming);
      return taskAudits === state.taskAudits ? state : { ...state, taskAudits };
    }

    case 'TASK_STOP_REQUESTED': {
      const task = state.tasks.find((item) => item.id === action.taskId);
      if (!task) {
        return {
          ...state,
          seq: state.seq + 1,
          toast: { text: '没有这条任务', id: state.seq + 1 },
        };
      }
      if (task.status !== '进行中') {
        return {
          ...state,
          seq: state.seq + 1,
          toast: { text: '任务已经结束', id: state.seq + 1 },
        };
      }
      return {
        ...state,
        seq: state.seq + 1,
        tasks: state.tasks.map((item) =>
          item.id === action.taskId
            ? { ...item, status: '已停止' as const, stopReason: '手动' as const }
            : item,
        ),
        toast: { text: '正在停止任务', id: state.seq + 1 },
      };
    }

    case 'CREATE_RADAR': {
      const object = state.objects.find((item) => item.id === action.objectId);
      if (!object) return state;
      const existing = state.tasks.find(
        (task) =>
          task.objectId === action.objectId &&
          task.kind === '周期性雷达' &&
          task.status !== '已停止',
      );
      if (existing) {
        return {
          ...state,
          toast: { text: '这个对象已有每日雷达', id: state.seq },
          seq: state.seq + 1,
        };
      }
      const [taskId, seq] = nextId(state, 'task');
      const now = new Date();
      const createdAt = now.toISOString().replace('T', ' ').slice(0, 16);
      const intervalDays = Math.max(1, action.intervalDays ?? 1);
      const nextDueAt = addDaysIso(createdAt, intervalDays);
      const task = {
        id: taskId,
        objectId: action.objectId,
        kind: '周期性雷达' as const,
        status: '待启动' as const,
        budgetGear: action.budgetGear ?? '快搜',
        query: action.query?.trim() || `${object.name} 官方 介绍`,
        intervalDays,
        nextDueAt,
        createdAt,
      };
      return {
        ...state,
        seq,
        tasks: [...state.tasks, task],
        taskAudits: [
          ...state.taskAudits,
          {
            taskId,
            seq: 1,
            kind: '计划',
            payload: { intervalDays, nextDueAt, query: task.query },
            ts: new Date().toISOString(),
          },
        ],
        toast: { text: `已创建每日雷达，下次 ${nextDueAt}`, id: seq },
      };
    }

    case 'APPLY_RESEARCH': {
      const existingIds = new Set(state.sources.map((s) => s.id));
      const incoming = action.sources.filter((s) => !existingIds.has(s.id));
      const parentTaskId = action.task.parentTaskId;
      const existingTask = state.tasks.find((task) => task.id === action.task.id);
      const task =
        existingTask?.status === '已停止' && existingTask.stopReason === '手动'
          ? { ...action.task, status: '已停止' as const, stopReason: '手动' as const }
          : action.task;
      const tasks = [...state.tasks.filter((t) => t.id !== task.id), task].map((item) =>
        parentTaskId && item.id === parentTaskId && item.kind === '周期性雷达'
          ? {
              ...item,
              status: '待启动' as const,
              lastRunAt: action.task.createdAt,
              nextDueAt: nextRadarDueAfter(item, action.task.createdAt),
            }
          : item,
      );
      return {
        ...state,
        tasks,
        taskAudits: [
          ...(state.taskAudits ?? []).filter((a) => a.taskId !== action.task.id),
          ...action.audits,
        ],
        sources: [...state.sources, ...incoming],
        toast: {
          text:
            task.status === '已停止'
              ? `调研停止：${task.stopReason ?? '失败'}，写入 ${incoming.length} 条来源`
              : task.stopReason === '触顶'
                ? `调研触顶：已打开 ${incoming.length} 条来源入库`
                : `调研完成：写入 ${incoming.length} 条来源`,
          id: state.seq,
        },
        seq: state.seq + 1,
        view:
          state.view.kind === 'replay' && state.view.taskId === task.id
            ? state.view
            : { kind: 'object', objectId: task.objectId },
      };
    }

    case 'ADD_SLOT': {
      // 0025：谓词表由人维护。新槽默认通用（所有场景显示），单值/多值影响冲突判定（0029）。
      const name = action.name.trim();
      if (!name)
        return { ...state, toast: { text: '槽名不能为空', id: state.seq }, seq: state.seq + 1 };
      if (name === '未编目') {
        return {
          ...state,
          toast: { text: '「未编目」是保留值', id: state.seq },
          seq: state.seq + 1,
        };
      }
      if (state.slotDefs.some((d) => d.name === name && d.kind === action.kind)) {
        return {
          ...state,
          toast: { text: '该种类下已有同名槽', id: state.seq },
          seq: state.seq + 1,
        };
      }
      return {
        ...state,
        seq: state.seq + 1,
        slotDefs: [
          ...state.slotDefs,
          { name, kind: action.kind, arity: action.arity, scenarios: [] },
        ],
        toast: { text: `已加槽「${name}」（通用）`, id: state.seq + 1 },
      };
    }

    default:
      return state;
  }
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

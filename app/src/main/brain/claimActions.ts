// M34 D2（纯搬运）：主张与抽取域——EXTRACT_DONE / CORRECT_CLAIM / PROMOTE_CLAIM 与抽取幂等、
// 任务复核入队等域内 helper；账本规则注释随 case 原样保留。
import type { Action } from '@shared/actions';
import type { Claim, ExtractionOutcomeKind, State } from '@shared/types';
import {
  pendingTaskClaimReview,
  sourceResearchTaskId,
  taskClaimReviewReady,
  taskClaimReviewSummary,
  unverifiedClaimIdsForTask,
} from '@shared/taskClaims';
import { idempotencyKey } from '../loops/extract';
import {
  proposeCatalogUncataloged,
  proposeMarkStale,
  proposeMergeDuplicates,
  proposeNewObjects,
  proposeRelations,
  proposeSupersedeByPrimary,
  refreshPendingDropUnverified,
  scanLingerUnverified,
} from '../loops/tidy';
import { lingerClock } from './lingerClock';
import { normalizeValue } from '@shared/scenario';
import { enqueueWrite, nextId, pushCard } from './actionHelpers';

// 主张与抽取域 reducer 分支：抽取落账（幂等复核 + 提议面）、纠正（关窗/禁写/丢弃）与晋升。

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

function claimEvidenceKey(claim: Claim): string {
  const span = claim.span ?? claim.text;
  return typeof claim.sourceStart === 'number' ? `${span}\0${claim.sourceStart}` : span;
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

export function claimActions(state: State, action: Action): State | undefined {
  switch (action.type) {
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
          // 零主张也可能发现新主体名（0052）：早退分支同样挂建对象提议器。
          const newNames = proposeNewObjects(next, objectId, next.seq, action.unknownObjectNames);
          if (newNames.length > 0) next = { ...next, proposals: [...next.proposals, ...newNames] };
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
        // CONTEXT「整理」：抽取落账后的提议面——丢弃滞留未核（0037/0064）、合并重复（0053）、
        // 标过时复核、未编目编目、建新对象（0052）与补关系。全部人确认才改账本，
        // 各提议器自带 pending 去重；id 前缀互不相同，天然不撞。
        // 0064：刚抽出的主张 age 0，进不了丢弃卡；同对象上已滞留的仍会生成或刷新。
        const clock = lingerClock();
        next = scanLingerUnverified(next, clock.lingerDays, clock.now, [objectId]);
        const tidySeq = next.seq;
        const fresh = [
          ...proposeMergeDuplicates(next, objectId, tidySeq),
          ...proposeMarkStale(next, objectId, tidySeq),
          ...proposeCatalogUncataloged(next, objectId, tidySeq),
          ...proposeNewObjects(next, objectId, tidySeq, action.unknownObjectNames),
          ...proposeRelations(next, objectId, tidySeq),
          ...src.boundObjectIds.flatMap((oid) => proposeSupersedeByPrimary(next, oid, tidySeq)),
        ];
        if (fresh.length > 0) next = { ...next, proposals: [...next.proposals, ...fresh] };
      }
      return enqueueTaskClaimReviewForSource(next, action.sourceId);
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
        return refreshDropCards(
          pushCard(
            next,
            old.objectId,
            {
              kind: '结果',
              claimId: old.id,
              result: '整理',
              undo: { kind: '整理丢弃', claims: [{ ...old }] },
            },
            newId ? '未核旧句已丢弃，你的新句已记入（未写禁写）' : '已丢弃（未核主张，不写禁写）',
          ),
          old.objectId,
          new Set([old.id]),
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
      return refreshDropCards(
        pushCard(
          next,
          old.objectId,
          {
            kind: '结果',
            claimId: old.id,
            result: '关窗',
            undo: { kind: '关窗', claimId: old.id, memoryId: memId, companionId: newId },
          },
          `已关窗 · ${action.closeReason} · 禁写已生效`,
        ),
        old.objectId,
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
      return refreshDropCards(
        pushCard(
          next,
          claim.objectId,
          {
            kind: '结果',
            claimId: claim.id,
            result: '晋升',
            undo: { kind: '晋升', claimId: claim.id },
          },
          '已晋升，简报不再带未核',
        ),
        claim.objectId,
      );
    }

    default:
      return undefined;
  }
}

function refreshDropCards(
  state: State,
  objectId: string,
  goneClaimIds?: ReadonlySet<string>,
): State {
  const clock = lingerClock();
  return refreshPendingDropUnverified(state, objectId, clock.lingerDays, clock.now, goneClaimIds);
}

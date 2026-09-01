import { FEE_AUDIT_KIND, emptyFeeSpend, feeAuditPayload, recordFeeSpend } from '@shared/taskFee';
import type { State, TaskAudit } from '@shared/types';
import { createReachAdapter, type ReachAdapter } from '../adapters/reach';
import type { Brain } from '../brain';
import { createExtractionJobExecutor } from '../extraction';
import type { TokenUsage } from '@shared/taskFee';
import { activeModelCompletion, type ModelCompletion } from '../llm/runtime';
import {
  budgetFor,
  createResearchTask,
  defaultQuery,
  hitFeeCap,
  runResearchTask,
  type BudgetGear,
  type ResearchDeps,
  type ResearchRunOptions,
} from './engine';

export interface ApplyResearchRunDeps {
  /** 可空闭包：每步账本写入都经它现取当前 brain（live()）——退出/恢复语义见函数注释。 */
  getBrain: () => Brain | null;
  publish: (state: State) => void;
  objectId: string;
  gear: BudgetGear;
  options: ResearchRunOptions;
  /** 缺省每轮用当下 live brain 现构（executor 只需 {brain, publish}，构造廉价）；注入 seam 留给编排测试，注入时跳过内部构建。 */
  executeExtractionJob?: ((sourceId: string) => Promise<State>) | undefined;
  /** 单飞锁命中时的侧效应（调用方自落 TOAST/广播），统一函数只负责早退。 */
  onBusy?: (() => void) | undefined;
  /** 检索适配注入 seam：缺省 createReachAdapter；编排测试注假 reach，不触真实适配。 */
  reach?: ReachAdapter | undefined;
  /** 查询构造注入 seam：缺省 defaultQuery。 */
  queryFor?: ResearchDeps['queryFor'] | undefined;
  /** 时钟注入 seam：缺省引擎真钟（epoch 毫秒），不传即由 engine 自取 Date.now。 */
  now?: (() => number) | undefined;
  /**
   * 抽取 complete 注入 seam：缺省 activeModelCompletion。
   * 仅调研/再搜一轮/雷达抽取走计量包装；用户手发 chat 不经本函数，不进任务预算（ADR 0059）。
   */
  complete?: ModelCompletion | undefined;
}

// 单飞锁：对象 → 在跑 task id。模块级而非 registerIpc 闭包级——用户入口与启动雷达补跑共抢同一把锁。
const runningResearchByObject = new Map<string, string>();

/**
 * 调研收口的唯一编排：建任务 → TASK_RUN_STARTED → 跑循环（审计即发即播）→ APPLY_RESEARCH →
 * 逐来源 BIND_CONFIRMED + 抽取 → 末次广播。异常一律向上传播，由调用方决定怎么收。
 *
 * 锁窗口纪律：set 与后续所有步同在 try 内，has→set 之间零 await——首笔 dispatch/广播抛错
 * 也必经 finally 释放，绝不让某对象永久 busy。
 *
 * 账本写入纪律：一切 dispatch/executor 构造都经 live() 现取当前实例。恢复备份会替换 brain，
 * 退出会关闭 brain——两条路径都让位：退出（null）时丢弃在途结果不写半成品账本；
 * 恢复（新实例）时余下流程写进新库，绝不打已关闭的旧连接。
 */
export async function applyResearchRun(deps: ApplyResearchRunDeps): Promise<State | null> {
  const { getBrain, publish, objectId, gear, options, onBusy } = deps;
  if (runningResearchByObject.has(objectId)) {
    onBusy?.();
    return null;
  }
  // checkpoint 式存活检查：getBrain 抛错（requireBrain 在未开库时）按退出语义静默让位。
  const live = (): Brain | null => {
    try {
      return getBrain();
    } catch {
      return null;
    }
  };
  const reach = deps.reach ?? createReachAdapter();
  const queryFor = deps.queryFor ?? defaultQuery;
  const now = deps.now;
  const start = live();
  if (!start) return null;
  const task = createResearchTask(
    start.snapshot(),
    objectId,
    gear,
    now ? { reach, queryFor, now } : { reach, queryFor },
    options,
  );
  let next: State;
  try {
    // set→dispatch→publish 全在 try 内且零 await 间隔：锁一旦建立，任何抛出点都有 finally 兜底。
    runningResearchByObject.set(objectId, task.id);
    next = start.dispatch({ type: 'TASK_RUN_STARTED', task });
    publish(next);
    let spend = emptyFeeSpend();
    const result = await runResearchTask(
      start.snapshot(),
      objectId,
      gear,
      {
        reach,
        queryFor,
        ...(now ? { now } : {}),
        usageSpend: () => spend,
        onAudit: (audit) => {
          // 查到哪个实例就 dispatch 哪个：恢复后审计行写进新库，退出则让位不写。
          const current = live();
          if (!current) return;
          const updated = current.dispatch({
            type: 'TASK_AUDIT_APPENDED',
            taskId: task.id,
            audits: [audit],
          });
          publish(updated);
        },
        shouldStop: () => {
          const current = live()
            ?.snapshot()
            .tasks.find((item) => item.id === task.id);
          return current?.status === '已停止' && current.stopReason === '手动';
        },
      },
      { ...options, task },
    );
    // APPLY_RESEARCH checkpoint：退出即丢弃在途结果（账本里没有半份调研），恢复则写进新实例。
    const applyTarget = live();
    if (!applyTarget) return null;
    next = applyTarget.dispatch({
      type: 'APPLY_RESEARCH',
      task: result.task,
      audits: result.audits,
      sources: result.sources,
    });
    const budget = budgetFor(gear);
    let feeCapped = result.stopReason === '费用触顶';
    let auditSeq = result.audits.reduce((max, audit) => Math.max(max, audit.seq), 0);
    const feeCapNow = () => hitFeeCap(budget, spend);

    for (const src of result.sources) {
      if (src.boundObjectIds.length === 0) continue;
      const current = live();
      if (!current) return null;
      const running = current.snapshot().tasks.find((item) => item.id === task.id);
      if (running?.status === '已停止' && running.stopReason === '手动') break;

      if (deps.executeExtractionJob) {
        next = current.dispatch({
          type: 'BIND_CONFIRMED',
          sourceId: src.id,
          objectIds: src.boundObjectIds,
        });
        next = await deps.executeExtractionJob(src.id);
        continue;
      }

      if (feeCapped || feeCapNow()) {
        feeCapped = true;
        // 硬顶：已打开的照写；跳过的抽取保持未知，作业记完成以免悬挂。
        next = current.dispatch({
          type: 'EXTRACT_DONE',
          sourceId: src.id,
          claims: [],
          outcome: 'success',
        });
        publish(next);
        continue;
      }

      const inner = deps.complete ?? activeModelCompletion(current.snapshot());
      const metered = inner
        ? wrapMeteredCompletion(inner, (usage) => {
            spend = recordFeeSpend(spend, usage);
          })
        : undefined;
      next = current.dispatch({
        type: 'BIND_CONFIRMED',
        sourceId: src.id,
        objectIds: src.boundObjectIds,
      });
      next = await createExtractionJobExecutor({
        brain: current,
        publish,
        ...(metered ? { complete: metered } : {}),
      })(src.id);
      if (inner) {
        const feeTarget = live();
        if (!feeTarget) return null;
        auditSeq += 1;
        const feeAudit: TaskAudit = {
          taskId: task.id,
          seq: auditSeq,
          kind: FEE_AUDIT_KIND,
          payload: feeAuditPayload(spend, src.id),
          ts: new Date().toISOString(),
        };
        next = feeTarget.dispatch({
          type: 'TASK_AUDIT_APPENDED',
          taskId: task.id,
          audits: [feeAudit],
        });
        publish(next);
      }
      if (feeCapNow()) feeCapped = true;
    }

    if (feeCapped && result.task.stopReason !== '手动' && result.task.stopReason !== '失败') {
      const feeStopTarget = live();
      if (!feeStopTarget) return null;
      auditSeq += 1;
      next = feeStopTarget.dispatch({
        type: 'TASK_AUDIT_APPENDED',
        taskId: task.id,
        audits: [
          {
            taskId: task.id,
            seq: auditSeq,
            kind: '费用触顶',
            payload: {
              tokens: spend.totalTokens,
              missingUsageCalls: spend.missingUsageCalls,
            },
            ts: new Date().toISOString(),
          },
        ],
      });
      const audits = withFeeStopReason(
        feeStopTarget.snapshot().taskAudits.filter((audit) => audit.taskId === task.id),
        '费用触顶',
      );
      next = feeStopTarget.dispatch({
        type: 'APPLY_RESEARCH',
        task: { ...result.task, status: '已完成', stopReason: '费用触顶' },
        audits,
        sources: [],
      });
    }

    publish(next);
    return next;
  } finally {
    if (runningResearchByObject.get(objectId) === task.id) {
      runningResearchByObject.delete(objectId);
    }
  }
}

function wrapMeteredCompletion(
  complete: ModelCompletion,
  onUsage: (usage: TokenUsage | undefined) => void,
): ModelCompletion {
  return async (request) => {
    const result = await complete(request);
    onUsage(result.usage);
    return result;
  };
}

function withFeeStopReason(audits: TaskAudit[], reason: '费用触顶'): TaskAudit[] {
  return audits.map((audit) => {
    if (audit.kind !== '停止') return audit;
    const base =
      audit.payload && typeof audit.payload === 'object'
        ? { ...(audit.payload as Record<string, unknown>) }
        : {};
    return { ...audit, payload: { ...base, reason } };
  });
}

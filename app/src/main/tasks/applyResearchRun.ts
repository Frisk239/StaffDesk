import type { State } from '@shared/types';
import { createReachAdapter } from '../adapters/reach';
import type { Brain } from '../brain';
import { createExtractionJobExecutor } from '../extraction';
import {
  createResearchTask,
  defaultQuery,
  runResearchTask,
  type BudgetGear,
  type ResearchRunOptions,
} from './engine';

export interface ApplyResearchRunDeps {
  /** 可空闭包：启动补跑侧传模块级 brain（before-quit 置 null 后各处静默早退）； IPC 侧的 requireBrain 抛错时照原样向上传播。 */
  getBrain: () => Brain | null;
  publish: (state: State) => void;
  objectId: string;
  gear: BudgetGear;
  options: ResearchRunOptions;
  /** 缺省内部自建（只需 getBrain 解析出的 brain 与 publish）；注入 seam 留给编排测试。 */
  executeExtractionJob?: ((sourceId: string) => Promise<State>) | undefined;
  /** 单飞锁命中时的侧效应（调用方自落 TOAST/广播），统一函数只负责早退。 */
  onBusy?: (() => void) | undefined;
}

// 单飞锁：对象 → 在跑 task id。模块级而非 registerIpc 闭包级——用户入口与启动雷达补跑共抢同一把锁。
const runningResearchByObject = new Map<string, string>();

/**
 * 调研收口的唯一编排：建任务 → TASK_RUN_STARTED → 跑循环（审计即发即播）→ APPLY_RESEARCH →
 * 逐来源 BIND_CONFIRMED + 抽取 → 末次广播。异常一律向上传播，由调用方决定怎么收。
 */
export async function applyResearchRun(deps: ApplyResearchRunDeps): Promise<State | null> {
  const { getBrain, publish, objectId, gear, options, onBusy } = deps;
  if (runningResearchByObject.has(objectId)) {
    onBusy?.();
    return null;
  }
  const brain = getBrain();
  if (!brain) return null;
  const executeExtractionJob =
    deps.executeExtractionJob ?? createExtractionJobExecutor({ brain, publish });
  const state = brain.snapshot();
  const reach = createReachAdapter();
  const task = createResearchTask(
    state,
    objectId,
    gear,
    {
      reach,
      queryFor: defaultQuery,
    },
    options,
  );
  runningResearchByObject.set(objectId, task.id);
  let next = brain.dispatch({ type: 'TASK_RUN_STARTED', task });
  publish(next);
  // checkpoint 式存活检查：恢复备份/退出会替换或关闭 brain，此时账本写入静默让位给新实例。
  const live = (): Brain | null => {
    try {
      return getBrain();
    } catch {
      return null;
    }
  };
  try {
    const result = await runResearchTask(
      brain.snapshot(),
      objectId,
      gear,
      {
        reach,
        queryFor: defaultQuery,
        onAudit: (audit) => {
          if (!live()) return;
          const updated = brain.dispatch({
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
    next = brain.dispatch({
      type: 'APPLY_RESEARCH',
      task: result.task,
      audits: result.audits,
      sources: result.sources,
    });
    for (const src of result.sources) {
      if (src.boundObjectIds.length === 0) continue;
      next = brain.dispatch({
        type: 'BIND_CONFIRMED',
        sourceId: src.id,
        objectIds: src.boundObjectIds,
      });
      next = await executeExtractionJob(src.id);
    }
    publish(next);
    return next;
  } finally {
    if (runningResearchByObject.get(objectId) === task.id) {
      runningResearchByObject.delete(objectId);
    }
  }
}

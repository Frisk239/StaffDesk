import type { DeskTask, State } from '@shared/types';
import type { Brain } from '../brain';
import { dueRadars } from './radar';

export interface RadarWatchdogDeps {
  /** 可空闭包：恢复备份换库/退出时 brain 短暂为 null——tick 空跳，绝不打旧连接。 */
  getBrain: () => Brain | null;
  /** 装配契约：与 applyResearchRun 的 deps 形状对齐；实际广播由注入的 run 闭包自持。 */
  publish: (state: State) => void;
  /** 单条到期雷达的执行编排（planRadarRun → applyResearchRun）；onBusy「跳过」TOAST 由调用方注入于此。 */
  run: (radar: DeskTask) => Promise<unknown>;
  now?: () => number;
  intervalMs?: number;
  /** tick 收尾回调（托盘雷达菜单刷新）；brain 为 null 的空跳也照调，由回调侧兜文案。 */
  onTick?: () => void;
}

export interface RadarWatchdog {
  stop(): void;
  tick(): Promise<void>;
}

/**
 * 0038：常驻期间的雷达心跳。每分钟看一眼到期队列（dueRadars 按 due 降序），逐条串行交给
 * 注入的 run——多对象各自到期都跑，撞单飞锁由 run 内 onBusy 让位。启动一次性补跑
 * （latestDueRadar 只补最新一条）是一次性语义，本模块接管之后按 due 全量。
 */
export function createRadarWatchdog(deps: RadarWatchdogDeps): RadarWatchdog {
  const { getBrain, run, now = Date.now, intervalMs = 60_000, onTick } = deps;
  const tick = async (): Promise<void> => {
    const brain = getBrain();
    if (brain) {
      for (const radar of dueRadars(brain.snapshot().tasks, now())) {
        // run 抛错向上传播：装配方（index.ts）在 run 闭包内收 TOAST，watchdog 不吞错、不断流。
        await run(radar);
      }
    }
    onTick?.();
  };
  const timer = setInterval(() => void tick(), intervalMs);
  timer.unref?.();
  return {
    stop: () => clearInterval(timer),
    tick,
  };
}

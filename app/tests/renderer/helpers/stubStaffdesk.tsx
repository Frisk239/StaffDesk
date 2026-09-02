import { emptyUiFields } from '@shared/defaults';
import type { StaffdeskApi } from '@shared/api';
import type { Action } from '@shared/actions';
import type { State } from '@shared/types';

// F5/D3（M34）：renderer 组件行为测试的公共桩——mock window.staffdesk 的 IPC 边界
// （snapshot / dispatch / chatSend / onStateChanged），不真调主进程、不触外网。
// 组件测试只关注渲染与发起（renderer 层纪律），账本语义由 brain 层测试守。

export function makeState(partial: Partial<State> = {}): State {
  return {
    workspaces: [{ id: 'ws-1', name: '验收区', scenario: '求职面试' }],
    currentWorkspaceId: 'ws-1',
    objects: [],
    sources: [],
    claims: [],
    slotDefs: [],
    scenarioTemplates: [],
    briefs: [],
    memories: [],
    inbox: [],
    proposals: [],
    tasks: [],
    taskAudits: [],
    chatByObject: {},
    seq: 1,
    onboardingDone: true,
    ...emptyUiFields(),
    ...partial,
  };
}

export interface StaffdeskStub {
  /** 渲染层发起过的 dispatch 动作（按序）。 */
  actions: Action[];
  /** chatSend 收到的调用参数（按序）。 */
  chatCalls: Array<{ objectId: string; text: string }>;
  /** chatSend 应答面：返回的 State 会像主进程 broadcast 一样推给 renderer（默认原样返回当前态）。 */
  respondChat: (objectId: string, text: string) => State;
  /** 模拟主进程 broadcast：推进当前状态并通知订阅的 renderer。 */
  setState(next: State): void;
}

/**
 * 安装 window.staffdesk 桩并返回记录面。dispatch 桩只实现 TOAST 的最小状态语义
 * （App 消散计时器依赖它清 toast），其余动作仅记录——账本规则不在这里复刻。
 */
export function installStaffdeskStub(initial: State): StaffdeskStub {
  const listeners = new Set<(state: State) => void>();
  let current = initial;
  const stub: StaffdeskStub = {
    actions: [],
    chatCalls: [],
    respondChat: () => current,
    setState(next) {
      current = next;
      for (const listener of listeners) listener(next);
    },
  };
  const api: StaffdeskApi = {
    snapshot: () => Promise.resolve(current),
    dispatch: (action) => {
      stub.actions.push(action);
      if (action.type === 'TOAST') {
        stub.setState(
          action.text === null
            ? { ...current, toast: null }
            : { ...current, toast: { text: action.text, id: current.seq + 1 } },
        );
      }
      return Promise.resolve(current);
    },
    onStateChanged: (cb) => {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
    chatSend: (objectId, text) => {
      stub.chatCalls.push({ objectId, text });
      const next = stub.respondChat(objectId, text);
      stub.setState(next);
      return Promise.resolve(next);
    },
    ingestText: () => Promise.resolve(current),
    ingestUrl: () => Promise.resolve(current),
    chooseAndIngestFiles: () => Promise.resolve(current),
    ingestDroppedFiles: () => Promise.resolve(current),
    retryIngest: () => Promise.resolve(current),
    runExtract: () => Promise.resolve(current),
    testProvider: () => Promise.resolve(current),
    startResearch: () => Promise.resolve(current),
    stopTask: () => Promise.resolve(current),
    createRadar: () => Promise.resolve(current),
    runRadar: () => Promise.resolve(current),
    generateBrief: () => Promise.resolve(current),
    exportBrain: () => Promise.resolve(null),
    restoreBrain: () => Promise.resolve(null),
    exportBrief: () => Promise.resolve(null),
    copyBrief: () => Promise.resolve(),
    logsDir: () => Promise.resolve(''),
    exportLogs: () => Promise.resolve(null),
  };
  window.staffdesk = api;
  return stub;
}

import { BrowserWindow, dialog, ipcMain, type IpcMainInvokeEvent } from 'electron';
import type { BrainBackupExportResult, BrainRestoreResult } from '@shared/api';
import type { Action } from '@shared/actions';
import { attachTurn } from '@shared/turn';
import { createReachAdapter } from './adapters/reach';
import type { Brain } from './brain';
import { createIngestionExecutor } from './ingestion';
import { checkCapability, checkConnect } from './llm/selfCheck';
import { activeModelCompletion, completionForProvider } from './llm/runtime';
import { createExtractionJobExecutor } from './extraction';
import { generateBrief } from './loops/briefGen';
import { isWriteIntent, runSessionTurn } from './loops/session';
import { extractCandidateMemories } from './loops/memoryExtract';
import { createResearchTask, defaultQuery, runResearchTask, type BudgetGear } from './tasks/engine';
import { planRadarRun } from './tasks/radar';
import { createBrainBackupArchive, writeBrainBackupFile } from './brainBackup';
import { GOLD_PACKS } from './eval/goldPacks';
import { runQualityRegression } from './eval/runner';
import {
  buildQualificationTarget,
  qualificationFingerprint,
  QUALITY_SUITE_VERSION,
} from './eval/fingerprint';
import type { QualityQualificationRecord } from '@shared/types';

type IpcSecurity = {
  assertTrustedSender: (event: IpcMainInvokeEvent) => void;
};

type BrainHandle = Brain | (() => Brain);

type BrainLifecycle = {
  restoreBrainBackup: (archivePath: string) => Promise<BrainRestoreResult>;
};

function broadcast(next: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('state:changed', next);
  }
}

export function registerIpc(
  brainHandle: BrainHandle,
  security?: IpcSecurity,
  lifecycle?: BrainLifecycle,
): void {
  const getBrain = typeof brainHandle === 'function' ? brainHandle : () => brainHandle;
  const assertTrustedSender = security?.assertTrustedSender ?? (() => undefined);
  const runningResearchByObject = new Map<string, string>();
  const handleTrusted = <Args extends unknown[], Result>(
    channel: string,
    handler: (event: IpcMainInvokeEvent, ...args: Args) => Result,
  ): void => {
    ipcMain.handle(channel, (event, ...args) => {
      assertTrustedSender(event);
      return handler(event, ...(args as Args));
    });
  };
  const runResearchAndApply = async (
    objectId: string,
    gear: BudgetGear,
    options: Parameters<typeof runResearchTask>[4] = {},
  ) => {
    const brain = getBrain();
    if (runningResearchByObject.has(objectId)) {
      const next = brain.dispatch({ type: 'TOAST', text: '这个对象已有调研正在收口' });
      broadcast(next);
      return next;
    }
    const executeExtractionJob = createExtractionJobExecutor({ brain, publish: broadcast });
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
    broadcast(next);
    try {
      const result = await runResearchTask(
        brain.snapshot(),
        objectId,
        gear,
        {
          reach,
          queryFor: defaultQuery,
          onAudit: (audit) => {
            const updated = brain.dispatch({
              type: 'TASK_AUDIT_APPENDED',
              taskId: task.id,
              audits: [audit],
            });
            broadcast(updated);
          },
          shouldStop: () => {
            const current = brain.snapshot().tasks.find((item) => item.id === task.id);
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
      broadcast(next);
      return next;
    } finally {
      if (runningResearchByObject.get(objectId) === task.id) {
        runningResearchByObject.delete(objectId);
      }
    }
  };

  handleTrusted('brain:snapshot', () => getBrain().snapshot());
  handleTrusted('brain:dispatch', (_event, action: Action) => {
    const brain = getBrain();
    const next = brain.dispatch(action);
    broadcast(next);
    return next;
  });

  handleTrusted('chat:send', async (event, payload: { objectId: string; text: string }) => {
    const text = payload.text.trim();
    const brain = getBrain();
    if (!text) return brain.snapshot();
    if (isWriteIntent(text)) {
      const next = brain.dispatch({ type: 'CHAT_SEND', objectId: payload.objectId, text });
      broadcast(next);
      return next;
    }
    brain.dispatch({ type: 'CHAT_USER_ONLY', objectId: payload.objectId, text });
    const state = brain.snapshot();
    const userMessage = [...(state.chatByObject[payload.objectId] ?? [])]
      .reverse()
      .find((message) => message.role === 'user' && message.text === text);
    const complete = activeModelCompletion(state);
    const reply = await runSessionTurn(state, payload.objectId, text, {
      db: brain.db,
      complete,
      onDelta: (chunk) => event.sender.send('chat:delta', { objectId: payload.objectId, chunk }),
    });
    const st = brain.snapshot();
    const desk = attachTurn(
      st,
      payload.objectId,
      {
        id: `msg-${st.seq}`,
        role: 'desk',
        text: reply.replyText,
        claimRefs: reply.claimRefs,
        note: reply.note,
      },
      text,
      reply.effect,
    );
    const next = brain.dispatch({
      type: 'CHAT_APPEND_DESK',
      objectId: payload.objectId,
      text: desk.text,
      claimRefs: reply.claimRefs,
    });
    let finalState = next;
    const memoryResult = await extractCandidateMemories({
      state: finalState,
      objectId: payload.objectId,
      userMessages: userMessage ? [userMessage] : [],
      complete,
    });
    if (memoryResult.candidates.length > 0) {
      finalState = brain.dispatch({
        type: 'ADD_CANDIDATE_MEMORIES',
        objectId: payload.objectId,
        candidates: memoryResult.candidates,
      });
      finalState = brain.dispatch({ type: 'RUN_MEMORY_DREAM' });
    } else if (memoryResult.status === 'unconfigured' && memoryResult.detail) {
      finalState = brain.dispatch({ type: 'TOAST', text: memoryResult.detail });
    } else if (
      (memoryResult.status === 'invalid-output' || memoryResult.status === 'failed') &&
      memoryResult.detail
    ) {
      finalState = brain.dispatch({
        type: 'TOAST',
        text: `候选记忆抽取未完成：${memoryResult.detail}`,
      });
    }
    broadcast(finalState);
    return finalState;
  });

  handleTrusted(
    'ingest:text',
    async (_event, payload: { text: string; suggestedTitle?: string }) => {
      const brain = getBrain();
      const executeIngest = createIngestionExecutor({ brain, publish: broadcast });
      return executeIngest({
        kind: 'text',
        text: payload.text,
        suggestedTitle: payload.suggestedTitle,
      });
    },
  );

  handleTrusted('ingest:url', async (_event, payload: { url: string }) => {
    const brain = getBrain();
    const executeIngest = createIngestionExecutor({ brain, publish: broadcast });
    return executeIngest({ kind: 'url', url: payload.url });
  });

  const ingestFilePaths = async (filePaths: string[]) => {
    const brain = getBrain();
    const executeIngest = createIngestionExecutor({ brain, publish: broadcast });
    let next = brain.snapshot();
    for (const filePath of filePaths) {
      next = await executeIngest({ kind: 'file', filePath });
    }
    return next;
  };

  handleTrusted('ingest:chooseFiles', async () => {
    const picked = await dialog.showOpenDialog({
      title: '选择材料',
      properties: ['openFile', 'multiSelections'],
      filters: [
        {
          name: '可解析材料',
          extensions: [
            'txt',
            'md',
            'markdown',
            'csv',
            'json',
            'html',
            'htm',
            'log',
            'yaml',
            'yml',
            'xml',
            'pdf',
          ],
        },
        { name: '所有文件', extensions: ['*'] },
      ],
    });
    if (picked.canceled || picked.filePaths.length === 0) return getBrain().snapshot();
    return ingestFilePaths(picked.filePaths);
  });

  handleTrusted('ingest:files', async (_event, payload: { filePaths?: unknown }) => {
    const filePaths = Array.isArray(payload.filePaths)
      ? payload.filePaths.filter((filePath): filePath is string => typeof filePath === 'string')
      : [];
    if (filePaths.length === 0) return getBrain().snapshot();
    return ingestFilePaths(filePaths);
  });

  handleTrusted('ingest:retry', async (_event, jobId: string) => {
    const brain = getBrain();
    const executeIngest = createIngestionExecutor({ brain, publish: broadcast });
    const job = brain.snapshot().ingestJobs.find((item) => item.id === jobId);
    if (!job?.input) return brain.snapshot();
    return executeIngest(job.input, job.id);
  });

  handleTrusted('extract:run', async (_event, sourceId: string) => {
    const brain = getBrain();
    const executeExtractionJob = createExtractionJobExecutor({ brain, publish: broadcast });
    return executeExtractionJob(sourceId);
  });

  handleTrusted(
    'settings:testProvider',
    async (_event, payload: { providerId: string; modelId: string }) => {
      const brain = getBrain();
      const frozen = brain.snapshot();
      const provider = frozen.providers.find((item) => item.id === payload.providerId);
      if (!provider?.enabled || !provider.models.some((model) => model.id === payload.modelId)) {
        const next = brain.dispatch({ type: 'TOAST', text: '没有这条模型配置' });
        broadcast(next);
        return next;
      }
      const target = buildQualificationTarget(provider, payload.modelId, frozen.thinkingEffort);
      const fingerprint = qualificationFingerprint(target);
      let next = brain.startQualification(target);
      broadcast(next);

      const connect = await checkConnect({ baseUrl: provider.baseUrl, apiKey: provider.apiKey });
      if (!connect.ok) {
        next = finishQualificationAttempt(brain, {
          fingerprint,
          endpointIdentity: target.endpointIdentity,
          modelId: target.modelId,
          suiteVersion: QUALITY_SUITE_VERSION,
          completedAt: new Date().toISOString(),
          connect: { status: '失败', detail: connect.detail },
          capability: { status: '失败', detail: '连通未通过，未运行' },
          detail: `连通失败：${connect.detail}`,
        });
        broadcast(next);
        return next;
      }

      const capability = await checkCapability({
        baseUrl: provider.baseUrl,
        apiKey: provider.apiKey,
        model: payload.modelId,
      });
      if (!capability.ok) {
        next = finishQualificationAttempt(brain, {
          fingerprint,
          endpointIdentity: target.endpointIdentity,
          modelId: target.modelId,
          suiteVersion: QUALITY_SUITE_VERSION,
          completedAt: new Date().toISOString(),
          connect: { status: '通过', detail: connect.detail },
          capability: { status: '失败', detail: capability.detail },
          detail: `能力探测失败：${capability.detail}`,
        });
        broadcast(next);
        return next;
      }

      try {
        const complete = completionForProvider(provider, payload.modelId);
        if (!complete) throw new Error('模型配置不完整');
        const report = await runQualityRegression({ packs: GOLD_PACKS, complete });
        const failed = report.stages.find((stage) => stage.status !== '通过');
        next = finishQualificationAttempt(brain, {
          fingerprint,
          endpointIdentity: target.endpointIdentity,
          modelId: target.modelId,
          suiteVersion: QUALITY_SUITE_VERSION,
          completedAt: report.completedAt,
          connect: { status: '通过', detail: connect.detail },
          capability: { status: '通过', detail: capability.detail },
          report,
          ...(failed ? { detail: `${failed.name}失败：${failed.detail ?? '未完成'}` } : {}),
        });
      } catch (error) {
        const detail = safeDetail(error);
        next = finishQualificationAttempt(brain, {
          fingerprint,
          endpointIdentity: target.endpointIdentity,
          modelId: target.modelId,
          suiteVersion: QUALITY_SUITE_VERSION,
          completedAt: new Date().toISOString(),
          connect: { status: '通过', detail: connect.detail },
          capability: { status: '通过', detail: capability.detail },
          detail: `资格认证未完成：${detail}`,
        });
      }
      broadcast(next);
      return next;
    },
  );

  handleTrusted('brief:generate', async (_event, objectId: string) => {
    const brain = getBrain();
    let state = brain.snapshot();
    if (!state.briefDraftingFor) {
      state = brain.dispatch({ type: 'GENERATE_BRIEF_START', objectId });
      broadcast(state);
    }
    const complete = activeModelCompletion(state);
    const [taskId, briefId] = [`task-${state.seq + 1}`, `brief-${state.seq + 2}`];
    const brief = await generateBrief({
      state,
      objectId,
      briefId,
      taskId,
      complete,
    });
    const next = brain.dispatch({ type: 'GENERATE_BRIEF_DONE', brief });
    broadcast(next);
    return next;
  });

  handleTrusted('brain:export', async (): Promise<BrainBackupExportResult | null> => {
    const picked = await dialog.showSaveDialog({
      title: '导出大脑备份',
      defaultPath: 'staffdesk-brain-backup.zip',
      filters: [{ name: 'StaffDesk 大脑备份', extensions: ['zip'] }],
    });
    if (picked.canceled || !picked.filePath) return null;
    const backup = await createBrainBackupArchive(getBrain());
    return { filePath: picked.filePath, backup: writeBrainBackupFile(picked.filePath, backup) };
  });

  handleTrusted('brain:restore', async (): Promise<BrainRestoreResult | null> => {
    if (!lifecycle?.restoreBrainBackup) {
      const next = getBrain().dispatch({ type: 'TOAST', text: '当前版本不能恢复大脑备份' });
      broadcast(next);
      return null;
    }
    const picked = await dialog.showOpenDialog({
      title: '恢复大脑备份',
      properties: ['openFile'],
      filters: [{ name: 'StaffDesk 大脑备份', extensions: ['zip'] }],
    });
    if (picked.canceled || picked.filePaths.length === 0) return null;
    const result = await lifecycle.restoreBrainBackup(picked.filePaths[0]!);
    broadcast(result.state);
    return result;
  });

  handleTrusted(
    'task:startResearch',
    async (_event, payload: { objectId: string; gear?: BudgetGear }) => {
      return runResearchAndApply(payload.objectId, payload.gear ?? '快搜');
    },
  );

  handleTrusted('task:stop', (_event, payload: { taskId: string }) => {
    const brain = getBrain();
    const next = brain.dispatch({ type: 'TASK_STOP_REQUESTED', taskId: payload.taskId });
    broadcast(next);
    return next;
  });

  handleTrusted('task:createRadar', async (_event, payload: { objectId: string }) => {
    const brain = getBrain();
    const state = brain.snapshot();
    const query = defaultQuery(state, payload.objectId);
    const next = brain.dispatch({
      type: 'CREATE_RADAR',
      objectId: payload.objectId,
      query,
      intervalDays: 1,
      budgetGear: '快搜',
    });
    broadcast(next);
    return next;
  });

  handleTrusted('task:runRadar', async (_event, payload: { radarTaskId: string }) => {
    const brain = getBrain();
    const state = brain.snapshot();
    const radar = state.tasks.find((task) => task.id === payload.radarTaskId);
    if (!radar || radar.kind !== '周期性雷达') {
      const next = brain.dispatch({ type: 'TOAST', text: '没有这条雷达计划' });
      broadcast(next);
      return next;
    }
    const plan = planRadarRun(radar);
    return runResearchAndApply(radar.objectId, radar.budgetGear ?? '快搜', plan.options);
  });
}

function finishQualificationAttempt(
  brain: Brain,
  record: QualityQualificationRecord,
): ReturnType<Brain['snapshot']> {
  brain.finishQualification(record);
  const complete =
    record.connect.status === '通过' &&
    record.capability.status === '通过' &&
    record.report?.stages.every((stage) => stage.status === '通过');
  return brain.dispatch({
    type: 'TOAST',
    text: complete ? '资格认证完成' : safeDetail(record.detail ?? '资格认证未完成'),
  });
}

function safeDetail(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw
    .replace(/Bearer\s+\S+/gi, 'Bearer ***')
    .replace(/sk-[A-Za-z0-9_-]+/g, 'sk-***')
    .slice(0, 120);
}

export function unregisterIpc(): void {
  ipcMain.removeHandler('brain:snapshot');
  ipcMain.removeHandler('brain:dispatch');
  ipcMain.removeHandler('chat:send');
  ipcMain.removeHandler('ingest:text');
  ipcMain.removeHandler('ingest:url');
  ipcMain.removeHandler('ingest:chooseFiles');
  ipcMain.removeHandler('ingest:files');
  ipcMain.removeHandler('ingest:retry');
  ipcMain.removeHandler('extract:run');
  ipcMain.removeHandler('settings:testProvider');
  ipcMain.removeHandler('task:startResearch');
  ipcMain.removeHandler('task:stop');
  ipcMain.removeHandler('task:createRadar');
  ipcMain.removeHandler('task:runRadar');
  ipcMain.removeHandler('brief:generate');
  ipcMain.removeHandler('brain:export');
  ipcMain.removeHandler('brain:restore');
}

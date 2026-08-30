import { writeFileSync } from 'node:fs';
import { BrowserWindow, dialog, ipcMain } from 'electron';
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
import { defaultQuery, runResearchTask, type BudgetGear } from './tasks/engine';
import { planRadarRun } from './tasks/radar';
import { runLiveCertForScenario } from './eval/cert';
import { exportBrainZip } from './exportZip';
import { scenarioOfWorkspace } from '@shared/scenario';

function broadcast(next: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('state:changed', next);
  }
}

export function registerIpc(brain: Brain): void {
  const executeExtractionJob = createExtractionJobExecutor({ brain, publish: broadcast });
  const executeIngest = createIngestionExecutor({ brain, publish: broadcast });
  const runResearchAndApply = async (
    objectId: string,
    gear: BudgetGear,
    options: Parameters<typeof runResearchTask>[4] = {},
  ) => {
    const state = brain.snapshot();
    const reach = createReachAdapter();
    const result = await runResearchTask(
      state,
      objectId,
      gear,
      {
        reach,
        queryFor: defaultQuery,
      },
      options,
    );
    let next = brain.dispatch({
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
  };

  ipcMain.handle('brain:snapshot', () => brain.snapshot());
  ipcMain.handle('brain:dispatch', (_event, action: Action) => {
    const next = brain.dispatch(action);
    broadcast(next);
    return next;
  });

  ipcMain.handle('chat:send', async (event, payload: { objectId: string; text: string }) => {
    const text = payload.text.trim();
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

  ipcMain.handle(
    'ingest:text',
    async (_event, payload: { text: string; suggestedTitle?: string }) => {
      return executeIngest({
        kind: 'text',
        text: payload.text,
        suggestedTitle: payload.suggestedTitle,
      });
    },
  );

  ipcMain.handle('ingest:url', async (_event, payload: { url: string }) => {
    return executeIngest({ kind: 'url', url: payload.url });
  });

  const ingestFilePaths = async (filePaths: string[]) => {
    let next = brain.snapshot();
    for (const filePath of filePaths) {
      next = await executeIngest({ kind: 'file', filePath });
    }
    return next;
  };

  ipcMain.handle('ingest:chooseFiles', async () => {
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
    if (picked.canceled || picked.filePaths.length === 0) return brain.snapshot();
    return ingestFilePaths(picked.filePaths);
  });

  ipcMain.handle('ingest:files', async (_event, payload: { filePaths?: unknown }) => {
    const filePaths = Array.isArray(payload.filePaths)
      ? payload.filePaths.filter((filePath): filePath is string => typeof filePath === 'string')
      : [];
    if (filePaths.length === 0) return brain.snapshot();
    return ingestFilePaths(filePaths);
  });

  ipcMain.handle('ingest:retry', async (_event, jobId: string) => {
    const job = brain.snapshot().ingestJobs.find((item) => item.id === jobId);
    if (!job?.input) return brain.snapshot();
    return executeIngest(job.input, job.id);
  });

  ipcMain.handle('extract:run', async (_event, sourceId: string) => {
    return executeExtractionJob(sourceId);
  });

  ipcMain.handle('settings:testProvider', async (_event, id: string) => {
    const state = brain.snapshot();
    const provider = state.providers.find((p) => p.id === id);
    const model =
      (state.activeProviderId === id
        ? provider?.models.find((m) => m.id === state.activeModelId)?.id
        : undefined) ??
      provider?.models[0]?.id ??
      '';
    if (!provider) return brain.snapshot();
    let next = brain.dispatch({ type: 'TEST_PROVIDER', id });
    broadcast(next);
    const c1 = await checkConnect({ baseUrl: provider.baseUrl, apiKey: provider.apiKey });
    next = brain.dispatch({
      type: 'SELF_CHECK',
      id,
      connect: c1.ok ? 'ok' : 'fail',
      detail: c1.detail,
    });
    broadcast(next);
    if (!c1.ok) return next;
    const c2 = await checkCapability({
      baseUrl: provider.baseUrl,
      apiKey: provider.apiKey,
      model,
    });
    next = brain.dispatch({
      type: 'SELF_CHECK',
      id,
      connect: 'ok',
      capability: c2.ok ? 'ok' : 'fail',
      detail: c2.detail,
    });
    broadcast(next);
    if (!c2.ok) return next;
    const ws = next.workspaces.find((w) => w.id === next.currentWorkspaceId);
    const scenario = ws?.scenario ?? scenarioOfWorkspace(next.workspaces, next.currentWorkspaceId);
    try {
      const complete = completionForProvider(provider, model);
      if (!complete) throw new Error('模型配置不完整');
      const scores = await runLiveCertForScenario(scenario, complete);
      next = brain.dispatch({ type: 'CERT_DONE', id, scores });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      next = brain.dispatch({
        type: 'CERT_FAILED',
        id,
        detail: `隔离样本检查失败：${detail.slice(0, 120)}`,
      });
    }
    broadcast(next);
    return next;
  });

  ipcMain.handle('brief:generate', async (_event, objectId: string) => {
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

  ipcMain.handle('brain:export', async () => {
    const picked = await dialog.showSaveDialog({
      title: '导出大脑',
      defaultPath: 'staffdesk-brain.zip',
      filters: [{ name: 'Zip', extensions: ['zip'] }],
    });
    if (picked.canceled || !picked.filePath) return null;
    writeFileSync(picked.filePath, exportBrainZip(brain.filePath));
    return picked.filePath;
  });

  ipcMain.handle(
    'task:startResearch',
    async (_event, payload: { objectId: string; gear?: BudgetGear }) => {
      return runResearchAndApply(payload.objectId, payload.gear ?? '快搜');
    },
  );

  ipcMain.handle('task:createRadar', async (_event, payload: { objectId: string }) => {
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

  ipcMain.handle('task:runRadar', async (_event, payload: { radarTaskId: string }) => {
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
  ipcMain.removeHandler('task:createRadar');
  ipcMain.removeHandler('task:runRadar');
  ipcMain.removeHandler('brief:generate');
  ipcMain.removeHandler('brain:export');
}

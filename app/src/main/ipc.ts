import { clipboard, dialog, ipcMain, type IpcMainInvokeEvent } from 'electron';
import { writeFile } from 'node:fs/promises';
import type { BrainBackupExportResult, BrainRestoreResult } from '@shared/api';
import type { Action } from '@shared/actions';
import { attachTurn } from '@shared/turn';
import type { Brain } from './brain';
import { createIngestionExecutor } from './ingestion';
import { checkCapability, checkConnect } from './llm/selfCheck';
import { activeModelCompletion, completionForProvider } from './llm/runtime';
import { createExtractionJobExecutor } from './extraction';
import { generateBrief } from './loops/briefGen';
import { isWriteIntent, runSessionTurn } from './loops/session';
import { extractCandidateMemories } from './loops/memoryExtract';
import { draftScenarioTemplate } from './loops/scenarioDraft';
import { parseScenarioDraftIntent } from '@shared/chat';
import { defaultQuery, type BudgetGear, type ResearchRunOptions } from './tasks/engine';
import { applyResearchRun } from './tasks/applyResearchRun';
import { planRadarRun } from './tasks/radar';
import { safeDetail } from './redact';
import { broadcastState as broadcast } from './windowBroadcast';
import { createBrainBackupArchive, writeBrainBackupFile } from './brainBackup';
import { GOLD_PACKS } from './eval/goldPacks';
import { runQualityRegression } from './eval/runner';
import {
  buildQualificationTarget,
  qualificationFingerprint,
  QUALITY_SUITE_VERSION,
} from './eval/fingerprint';
import type { QualityQualificationRecord, State, TaskKind } from '@shared/types';

type IpcSecurity = {
  assertTrustedSender: (event: IpcMainInvokeEvent) => void;
};

type BrainHandle = Brain | (() => Brain);

type BrainLifecycle = {
  restoreBrainBackup: (archivePath: string) => Promise<BrainRestoreResult>;
};

// 全部注册通道的单一清单：注册侧以这里的通道名为类型约束，卸载侧遍历同一份，两处列表不漂移。
const HANDLED_CHANNELS = [
  { channel: 'brain:snapshot', trusted: true },
  { channel: 'brain:dispatch', trusted: true },
  { channel: 'chat:send', trusted: true },
  { channel: 'ingest:text', trusted: true },
  { channel: 'ingest:url', trusted: true },
  { channel: 'ingest:chooseFiles', trusted: true },
  { channel: 'ingest:files', trusted: true },
  { channel: 'ingest:retry', trusted: true },
  { channel: 'extract:run', trusted: true },
  { channel: 'settings:testProvider', trusted: true },
  { channel: 'brief:generate', trusted: true },
  { channel: 'brief:copy', trusted: true },
  { channel: 'brief:export', trusted: true },
  { channel: 'brain:export', trusted: true },
  { channel: 'brain:restore', trusted: true },
  { channel: 'task:startResearch', trusted: true },
  { channel: 'task:stop', trusted: true },
  { channel: 'task:createRadar', trusted: true },
  { channel: 'task:runRadar', trusted: true },
] as const;

type HandledChannel = (typeof HANDLED_CHANNELS)[number]['channel'];

export type StartResearchPayload = {
  objectId: string;
  gear?: BudgetGear | undefined;
  kind?: Extract<TaskKind, '调研' | '再搜一轮'> | undefined;
  fromTaskId?: string | undefined;
};

// 0036：「再搜一轮」只在账本里找得到父任务时成立，否则回落普通调研，不伪造父子链。
// 渲染端只给 fromTaskId；dueAt/missedRuns/late 属雷达补跑语义，不随用户入口下发。
export function researchOptionsFor(
  state: State,
  payload: StartResearchPayload,
): ResearchRunOptions {
  if (payload.kind !== '再搜一轮' || !payload.fromTaskId) return {};
  const parent = state.tasks.find((task) => task.id === payload.fromTaskId);
  if (!parent) return {};
  return { kind: '再搜一轮', parentTaskId: parent.id, query: parent.query };
}

/** 简报导出文件名：对象名里的路径分隔符与空白折成连字符，空的回落「简报」。 */
function briefFileName(objectName: string | undefined): string {
  const cleaned = (objectName ?? '').replace(/[\\/:*?"<>|\s]+/g, '-').replace(/^-+|-+$/g, '');
  return cleaned.slice(0, 40) || '简报';
}

export function registerIpc(
  brainHandle: BrainHandle,
  security: IpcSecurity,
  lifecycle?: BrainLifecycle,
): void {
  const getBrain = typeof brainHandle === 'function' ? brainHandle : () => brainHandle;
  const assertTrustedSender = security.assertTrustedSender;
  const handleTrusted = <Args extends unknown[], Result>(
    channel: HandledChannel,
    handler: (event: IpcMainInvokeEvent, ...args: Args) => Result,
  ): void => {
    ipcMain.handle(channel, (event, ...args) => {
      assertTrustedSender(event);
      return handler(event, ...(args as Args));
    });
  };
  // 薄壳：编排与单飞锁在 tasks/applyResearchRun（与启动雷达补跑共用同一把锁）；这里只落用户入口语义。
  const runResearchAndApply = async (
    objectId: string,
    gear: BudgetGear,
    options: ResearchRunOptions = {},
  ): Promise<State> => {
    const next = await applyResearchRun({
      getBrain,
      publish: broadcast,
      objectId,
      gear,
      options,
      onBusy: () => {
        const busy = getBrain().dispatch({ type: 'TOAST', text: '这个对象已有调研正在收口' });
        broadcast(busy);
      },
    });
    // busy/brain 已关时统一函数返回 null；busy 路径的 TOAST 已在 onBusy 广播，回最新快照即可。
    return next ?? getBrain().snapshot();
  };

  handleTrusted('brain:snapshot', () => getBrain().snapshot());
  handleTrusted('brain:dispatch', (_event, action: Action) => {
    const brain = getBrain();
    const next = brain.dispatch(action);
    broadcast(next);
    return next;
  });

  handleTrusted('chat:send', async (_event, payload: { objectId: string; text: string }) => {
    const text = payload.text.trim();
    const brain = getBrain();
    if (!text) return brain.snapshot();
    // M27：起草场景意图——本轮不做脚本回复；用户消息先落账广播（照「记下来」立即写的例外口径），
    // 再走起草钩子：模型产草稿 → ENQUEUE_WRITE kind '场景' 进 takeover；失败落脱敏 TOAST，不炸轮次。
    const draftIntent = parseScenarioDraftIntent(text);
    if (draftIntent) {
      const afterUser = brain.dispatch({
        type: 'CHAT_USER_ONLY',
        objectId: payload.objectId,
        text,
      });
      broadcast(afterUser);
      try {
        const complete = activeModelCompletion(afterUser);
        const result = await draftScenarioTemplate({
          state: brain.snapshot(),
          userText: text,
          complete,
        });
        if (result.status === 'success') {
          let next = brain.dispatch({
            type: 'CHAT_APPEND_DESK',
            objectId: payload.objectId,
            text: `场景模板「${result.template.name}」草稿已备好，确认后创建。`,
            claimRefs: [],
          });
          next = brain.dispatch({
            type: 'ENQUEUE_WRITE',
            draft: {
              objectId: payload.objectId,
              kind: '场景',
              headline: `起草场景模板「${result.template.name}」`,
              evidence: draftIntent.brief || text,
              template: result.template,
            },
          });
          broadcast(next);
          return next;
        }
        const toastText =
          result.status === 'unconfigured'
            ? (result.detail ?? '起草场景需要先在设置里配置模型')
            : `场景模板起草未完成：${result.detail ?? '模型输出不合格'}`;
        const failed = brain.dispatch({ type: 'TOAST', text: toastText });
        broadcast(failed);
        return failed;
      } catch (error) {
        // 0030 口径：失败如实告知（脱敏 TOAST），不编草稿、不炸轮次。
        const failed = brain.dispatch({
          type: 'TOAST',
          text: `场景模板起草失败：${safeDetail(error, 120)}`,
        });
        broadcast(failed);
        return failed;
      }
    }
    if (isWriteIntent(text)) {
      const next = brain.dispatch({ type: 'CHAT_SEND', objectId: payload.objectId, text });
      broadcast(next);
      return next;
    }
    const afterUser = brain.dispatch({
      type: 'CHAT_USER_ONLY',
      objectId: payload.objectId,
      text,
    });
    // 用户消息先广播再走模型：失败时这句话也不悬挂、不丢。
    broadcast(afterUser);
    const userMessage = [...(afterUser.chatByObject[payload.objectId] ?? [])]
      .reverse()
      .find((message) => message.role === 'user' && message.text === text);
    const complete = activeModelCompletion(afterUser);
    try {
      const reply = await runSessionTurn(afterUser, payload.objectId, text, {
        db: brain.db,
        complete,
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
    } catch (error) {
      // 0030：本轮失败如实告知（脱敏 TOAST），不编造回复；invoke 正常 resolve，渲染端不悬挂。
      const failed = brain.dispatch({
        type: 'TOAST',
        text: `本轮回复失败：${safeDetail(error, 120)}`,
      });
      broadcast(failed);
      return failed;
    }
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
        const detail = safeDetail(error, 120);
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

  // 审计 F4：复制走主进程 clipboard——0047 权限全拒下 renderer 的
  // navigator.clipboard.writeText 会被 clipboard-sanitized-write 权限静默拦下。
  handleTrusted('brief:copy', (_event, payload: { markdown: string }): void => {
    clipboard.writeText(payload.markdown);
  });

  handleTrusted(
    'brief:export',
    async (_event, payload: { markdown: string; objectName?: string }) => {
      // 审计 F4：简报出站出口——照 brain:export 的保存对话框模式写 .md；正文由 renderer 的
      // 同一份 Markdown 组装函数提供，主进程不重排格式。
      const picked = await dialog.showSaveDialog({
        title: '导出简报',
        defaultPath: `${briefFileName(payload.objectName)}.md`,
        filters: [{ name: 'Markdown', extensions: ['md'] }],
      });
      if (picked.canceled || !picked.filePath) return null;
      await writeFile(picked.filePath, payload.markdown, 'utf8');
      return { filePath: picked.filePath };
    },
  );

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

  handleTrusted('task:startResearch', async (_event, payload: StartResearchPayload) => {
    const options = researchOptionsFor(getBrain().snapshot(), payload);
    return runResearchAndApply(payload.objectId, payload.gear ?? '快搜', options);
  });

  handleTrusted('task:stop', (_event, payload: { taskId: string }) => {
    const brain = getBrain();
    const next = brain.dispatch({ type: 'TASK_STOP_REQUESTED', taskId: payload.taskId });
    broadcast(next);
    return next;
  });

  handleTrusted(
    'task:createRadar',
    async (_event, payload: { objectId: string; intervalDays?: number }) => {
      const brain = getBrain();
      const state = brain.snapshot();
      const query = defaultQuery(state, payload.objectId);
      const next = brain.dispatch({
        type: 'CREATE_RADAR',
        objectId: payload.objectId,
        query,
        intervalDays: payload.intervalDays ?? 1,
        budgetGear: '快搜',
      });
      broadcast(next);
      return next;
    },
  );

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
    text: complete ? '资格认证完成' : safeDetail(record.detail ?? '资格认证未完成', 120),
  });
}

export function unregisterIpc(): void {
  for (const { channel } of HANDLED_CHANNELS) {
    ipcMain.removeHandler(channel);
  }
}

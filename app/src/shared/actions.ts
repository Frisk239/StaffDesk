import type {
  Brief,
  Claim,
  CloseReason,
  DeletedSourceRecovery,
  DeskTask,
  IngestJob,
  LlmProvider,
  MemoryScope,
  ObjectKind,
  RightTabKind,
  ScenarioKind,
  ScenarioTemplate,
  Source,
  SourceOrigin,
  SourceRole,
  SourceSegment,
  TaskAudit,
  ThemePreference,
  ThinkingEffort,
  View,
  WriteProposal,
  ExtractionOutcomeKind,
  BudgetGear,
  CandidatePayload,
} from './types';

type ExtractDoneBase = {
  type: 'EXTRACT_DONE';
  sourceId: string;
  detail?: string | undefined;
  draftCount?: number | undefined;
  rejectedCount?: number | undefined;
  // 0052：抽取发现的未建对象名——只喂建对象提议，不影响主张归属。
  unknownObjectNames?: string[] | undefined;
};

type ExtractDoneAction =
  | (ExtractDoneBase & {
      outcome?: 'success' | undefined;
      claims?: Claim[] | undefined;
    })
  | (ExtractDoneBase & {
      outcome: Exclude<ExtractionOutcomeKind, 'success'>;
      claims?: never;
    });

export type Action =
  | { type: 'SET_VIEW'; view: View }
  | { type: 'BIND_CONFIRMED'; sourceId: string; objectIds: string[] }
  | { type: 'UNBIND_SOURCE'; sourceId: string; objectId: string }
  // 0062：绑定级角色，默认转述；同一 URL 对不同对象可不同。operations 留痕，确认走 takeover。
  | { type: 'SET_SOURCE_ROLE'; sourceId: string; objectId: string; role: SourceRole }
  | { type: 'DELETE_SOURCE'; sourceId: string; recovery?: DeletedSourceRecovery | undefined }
  | { type: 'RESTORE_DELETED_SOURCE'; recovery: DeletedSourceRecovery }
  | ExtractDoneAction
  | { type: 'RETRY_EXTRACTION'; sourceId: string }
  | { type: 'OPEN_AUDIT_CARD'; claimId: string }
  | { type: 'OPEN_CORRECT_CARD'; claimId: string }
  | { type: 'OPEN_PROPOSAL_CARD'; proposalId: string }
  | { type: 'DISMISS_CARD'; objectId: string; messageId: string }
  | { type: 'FOCUS_SOURCE'; sourceId: string }
  | {
      type: 'CORRECT_CLAIM';
      claimId: string;
      closeReason: CloseReason;
      newText?: string | undefined;
    }
  | { type: 'PROMOTE_CLAIM'; claimId: string }
  // 0064：打开待确认扫描滞留未核；lingerDays / now 由调用方注入，reducer 不读设置文件。
  | {
      type: 'SCAN_LINGER_UNVERIFIED';
      lingerDays: number;
      now: string;
      objectIds?: string[] | undefined;
    }
  | { type: 'GENERATE_BRIEF_START'; objectId: string }
  | { type: 'GENERATE_BRIEF_DONE'; brief?: Brief | undefined; error?: string | undefined }
  | { type: 'CHAT_SEND'; objectId: string; text: string }
  | { type: 'CHAT_USER_ONLY'; objectId: string; text: string }
  | { type: 'CHAT_APPEND_DESK'; objectId: string; text: string; claimRefs?: string[] | undefined }
  | { type: 'ADD_CANDIDATE_MEMORIES'; objectId: string; candidates: CandidatePayload[] }
  | { type: 'RUN_MEMORY_DREAM' }
  | { type: 'TASK_RUN_STARTED'; task: DeskTask }
  | { type: 'TASK_AUDIT_APPENDED'; taskId: string; audits: TaskAudit[] }
  | { type: 'TASK_STOP_REQUESTED'; taskId: string }
  | {
      type: 'APPLY_RESEARCH';
      task: DeskTask;
      audits: TaskAudit[];
      sources: Source[];
    }
  | {
      type: 'CREATE_RADAR';
      objectId: string;
      query?: string | undefined;
      intervalDays?: number | undefined;
      budgetGear?: BudgetGear | undefined;
    }
  | {
      type: 'PROPOSAL_DECIDE';
      proposalId: string;
      decision: 'accept-merge' | 'accept-drop' | 'accept-close' | 'reject';
      // 编目提议（整理）人选槽：reducer 里仍须过受控表（0025），防自开槽。
      targetPredicate?: string | undefined;
      // 建对象提议（整理）人选种类：0052 对象只由人确认建立，确认载荷补齐种类。
      objectKind?: ObjectKind | undefined;
      // 候选记忆（0055）：范围以确认时的人选为准，未改动回落 payload 默认。
      scope?: MemoryScope | undefined;
    }
  | {
      type: 'ADD_SOURCE';
      title: string;
      body: string;
      fromUrl?: boolean | undefined;
      unparsed?: boolean | undefined;
    }
  | { type: 'INGEST_STARTED'; job: IngestJob }
  | {
      type: 'INGEST_SUCCEEDED';
      jobId: string;
      title: string;
      body: string;
      origin: SourceOrigin;
      segments: SourceSegment[];
      contentHash: string;
    }
  | {
      type: 'INGEST_FAILED';
      jobId: string;
      failureKind: IngestJob['failureKind'];
      detail: string;
      title?: string | undefined;
      locator?: string | undefined;
    }
  | { type: 'TOAST'; text: string | null }
  | { type: 'SELECT_CLAIM'; claimId: string | null }
  | { type: 'SET_THEME'; preference: ThemePreference }
  | { type: 'UPSERT_PROVIDER'; provider: LlmProvider }
  | { type: 'REMOVE_PROVIDER'; id: string }
  | { type: 'SET_ACTIVE_PROVIDER'; id: string }
  | { type: 'SET_ACTIVE_MODEL'; providerId: string; modelId: string }
  | { type: 'SET_THINKING'; effort: ThinkingEffort }
  | { type: 'OPEN_RIGHT_TAB'; objectId: string; kind: RightTabKind }
  | { type: 'CLOSE_RIGHT_TAB'; objectId: string; id: string }
  | { type: 'FOCUS_RIGHT_TAB'; objectId: string; id: string }
  | { type: 'SWITCH_WORKSPACE'; id: string }
  | { type: 'ADD_WORKSPACE'; name: string; scenario: ScenarioKind }
  | { type: 'REMOVE_WORKSPACE'; id: string }
  | {
      // 0058：模板编辑是人手设置动作（0057 口径）——直接改账本、不进撤销卡，operations 留痕。
      // previousName 只在改自定义模板名时给出（reducer 靠它区分「改名」与「新建」并做撞名/内置守卫）；
      // builtin 标记由 reducer 按 existing 行裁定，载荷值不作为身份来源。
      type: 'UPSERT_SCENARIO_TEMPLATE';
      template: ScenarioTemplate;
      previousName?: string | undefined;
    }
  | { type: 'REMOVE_SCENARIO_TEMPLATE'; name: string }
  | { type: 'ADD_OBJECT'; kind: ObjectKind; name: string }
  | { type: 'ADD_RELATION'; objectId: string; targetId: string }
  | { type: 'REMOVE_RELATION'; objectId: string; targetId: string }
  | { type: 'SET_OBJECT_NOTE'; objectId: string; note: string | null }
  | { type: 'ARCHIVE_OBJECT'; id: string }
  | { type: 'UNARCHIVE_OBJECT'; id: string }
  | { type: 'DELETE_OBJECT'; id: string }
  | { type: 'RESTORE_OBJECT'; id: string }
  | { type: 'ADD_SLOT'; name: string; kind: ObjectKind; arity: '单值' | '多值' }
  | {
      // 0057：编辑是直接改账本的人手设置动作（改名 / 单值↔多值 / 场景适用标记），不进撤销卡。
      // kind 不可改：换种类等于跨分区搬家，抽取按对象种类走映射会乱。
      type: 'UPDATE_SLOT';
      name: string;
      kind: ObjectKind;
      next: {
        name?: string | undefined;
        arity?: '单值' | '多值' | undefined;
        scenarios?: ScenarioKind[] | undefined;
      };
    }
  | { type: 'REMOVE_SLOT'; name: string; kind: ObjectKind }
  | { type: 'ENQUEUE_WRITE'; draft: Omit<WriteProposal, 'id'> }
  | {
      type: 'CONFIRM_WRITE';
      writeId: string;
      closeReason?: CloseReason | undefined;
      newText?: string | undefined;
    }
  | { type: 'REJECT_WRITE'; writeId: string }
  | { type: 'UNDO_RESULT'; objectId: string; messageId: string }
  | { type: 'REMOVE_MEMORY'; id: string }
  | { type: 'SET_ONBOARDING'; done: boolean }
  | { type: 'MARK_TURN_PLAYED'; objectId: string; messageId: string };

import type {
  Brief,
  Claim,
  CloseReason,
  DeletedSourceRecovery,
  DeskTask,
  IngestJob,
  LlmProvider,
  ObjectKind,
  RightTabKind,
  ScenarioKind,
  Source,
  SourceOrigin,
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
  | { type: 'GENERATE_BRIEF_START'; objectId: string }
  | { type: 'GENERATE_BRIEF_DONE'; brief?: Brief | undefined }
  | { type: 'CHAT_SEND'; objectId: string; text: string }
  | { type: 'CHAT_USER_ONLY'; objectId: string; text: string }
  | { type: 'CHAT_APPEND_DESK'; objectId: string; text: string; claimRefs?: string[] | undefined }
  | { type: 'ADD_CANDIDATE_MEMORIES'; objectId: string; candidates: CandidatePayload[] }
  | { type: 'RUN_MEMORY_DREAM' }
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
      decision: 'accept-merge' | 'accept-drop' | 'reject';
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
  | { type: 'ADD_OBJECT'; kind: ObjectKind; name: string }
  | { type: 'ARCHIVE_OBJECT'; id: string }
  | { type: 'UNARCHIVE_OBJECT'; id: string }
  | { type: 'DELETE_OBJECT'; id: string }
  | { type: 'RESTORE_OBJECT'; id: string }
  | { type: 'ADD_SLOT'; name: string; kind: ObjectKind; arity: '单值' | '多值' }
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

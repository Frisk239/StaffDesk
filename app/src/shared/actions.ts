import type {
  Brief,
  Claim,
  CloseReason,
  DeskTask,
  LlmProvider,
  ObjectKind,
  RightTabKind,
  ScenarioKind,
  Source,
  TaskAudit,
  ThemePreference,
  ThinkingEffort,
  View,
  WriteProposal,
} from './types';

export type Action =
  | { type: 'SET_VIEW'; view: View }
  | { type: 'BIND_CONFIRMED'; sourceId: string; objectIds: string[] }
  | { type: 'EXTRACT_DONE'; sourceId: string; claims?: Claim[] | undefined }
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
  | {
      type: 'SELF_CHECK';
      id: string;
      connect: 'ok' | 'fail';
      capability?: 'ok' | 'fail' | undefined;
      detail: string;
    }
  | {
      type: 'APPLY_RESEARCH';
      task: DeskTask;
      audits: TaskAudit[];
      sources: Source[];
    }
  | { type: 'PROPOSAL_DECIDE'; proposalId: string; decision: 'accept-merge' | 'accept-drop' | 'reject' }
  | { type: 'ADD_SOURCE'; title: string; body: string; fromUrl?: boolean | undefined; unparsed?: boolean | undefined }
  | { type: 'TOAST'; text: string | null }
  | { type: 'SELECT_CLAIM'; claimId: string | null }
  | { type: 'SET_THEME'; preference: ThemePreference }
  | { type: 'UPSERT_PROVIDER'; provider: LlmProvider }
  | { type: 'REMOVE_PROVIDER'; id: string }
  | { type: 'SET_ACTIVE_PROVIDER'; id: string }
  | { type: 'SET_ACTIVE_MODEL'; id: string }
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
  | { type: 'CONFIRM_WRITE'; writeId: string; closeReason?: CloseReason | undefined; newText?: string | undefined }
  | { type: 'REJECT_WRITE'; writeId: string }
  | { type: 'UNDO_RESULT'; objectId: string; messageId: string }
  | { type: 'REMOVE_MEMORY'; id: string }
  | { type: 'TEST_PROVIDER'; id: string }
  | {
      type: 'CERT_DONE';
      id: string;
      scores?:
        | { recall: number; faithful: number; unknown: number; fabrication: number }
        | undefined;
    }
  | { type: 'SET_ONBOARDING'; done: boolean }
  | { type: 'MARK_TURN_PLAYED'; objectId: string; messageId: string };

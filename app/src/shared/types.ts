// 词汇与字段名跟 CONTEXT.md / docs/prototype.md「内存状态」走，不发明新领域概念。

export type ObjectKind = '人' | '组织' | '项目';

// 0033：场景是工作区级预设包，不是第四种对象、不是任务种类。
export type ScenarioKind = '求职面试' | '求学申请' | '技术选型' | '尽调研究' | '自定义';

export interface Workspace {
  id: string;
  name: string;
  scenario: ScenarioKind;
}

export interface DeskObject {
  id: string;
  kind: ObjectKind;
  name: string;
  note?: string | undefined;
  relationIds: string[];
  workspaceId: string;
  archived?: boolean | undefined;
}

export type FeedPath = '手给' | '调研';
export type SourceRole = '主键' | '转述';
export type SourceOriginKind = 'text' | 'url' | 'file' | 'research' | 'legacy';

export interface SourceOrigin {
  kind: SourceOriginKind;
  locator?: string | undefined;
  finalUrl?: string | undefined;
  fileName?: string | undefined;
  mimeType?: string | undefined;
  sizeBytes?: number | undefined;
  contentHash?: string | undefined;
  fetchedAt?: string | undefined;
  pageCount?: number | undefined;
}

export interface SourceSegment {
  id: string;
  start: number;
  end: number;
  page?: number | undefined;
  label?: string | undefined;
}

export interface Source {
  id: string;
  title: string;
  body: string;
  path: FeedPath;
  role?: SourceRole | undefined;
  boundObjectIds: string[]; // 空 = 未绑定（在 Inbox）
  workspaceId?: string | undefined;
  virtual?: boolean | undefined; // 使用者陈述的落点：不进 Inbox、不进来源侧
  unparsed?: boolean | undefined; // 当前版本未解析的 PDF/二进制来源，只保留可见占位说明。
  origin?: SourceOrigin | undefined;
  segments?: SourceSegment[] | undefined;
  contentHash?: string | undefined;
  fetchedAt?: string | undefined;
}

// 0030：主张状态收敛为成立/过时；未知只是页面语义（槽内无主张的空格子），不是账本枚举值。
export type ClaimStatus = '成立' | '过时';
// 0031/0032：关闭原因补齐「来源删除」「对象误建」。
export type CloseReason = '世界已变' | '从未成立' | '来源删除' | '对象误建';
// 0025/0033：谓词是受控槽，槽表是数据（state.slotDefs），人可在设置页加槽；'未编目' 是映射不上的特殊值。
export type Predicate = string;

// 0025/0033：槽按对象种类分区，带单值/多值声明（0029 互斥判定只用单值槽）与场景适用标记（空 = 通用槽）。
export interface SlotDef {
  name: Predicate;
  kind: ObjectKind;
  arity: '单值' | '多值';
  scenarios: ScenarioKind[];
}

// 0033：简报说明由场景决定，是数据不是分支代码。
export type BriefBlockKind = 'background' | 'slots' | 'synthesis' | 'gaps';

export interface BriefSpecBlock {
  title: string;
  kind: BriefBlockKind;
  predicates?: Predicate[] | undefined; // kind = slots 时该块装哪些槽
}

export interface Claim {
  id: string;
  objectId: string;
  predicate: Predicate;
  text: string;
  status: ClaimStatus;
  unverified: boolean;
  validFrom?: string | undefined;
  validTo?: string | undefined;
  closeReason?: CloseReason | undefined;
  sourceId: string; // 'user-stmt' 表示使用者陈述
  span?: string | undefined; // 来源原文片段
  sourceStart?: number | undefined;
  sourceEnd?: number | undefined;
  sourceLocator?: SourceSegment | undefined;
  supersededBy?: string | undefined;
  createdAt: string;
}

// 0035：删除来源不做一键撤销，但操作日志必须保留可显式恢复的来源、绑定与主张快照。
export interface DeletedSourceRecovery {
  source: Source;
  claims: Claim[];
  deletedAt: string;
}

// 0029：冲突是派生关系（同对象 + 同单值槽 + 有效期重叠 + 取值互斥），不存独立状态。
export interface Conflict {
  claimIdA: string;
  claimIdB: string;
}

export type SentenceKind = 'claim' | 'unknown' | 'synthesis';

export interface BriefSentence {
  text: string;
  lines?: string[] | undefined;
  claimIds: string[];
  unverified: boolean;
  kind: SentenceKind;
  flag?: '冲突·并排' | '未编目·不作定论' | undefined;
}

export interface BriefBlock {
  title: string;
  sentences: BriefSentence[];
}

export interface Brief {
  id: string;
  objectId: string;
  taskId: string;
  createdAt: string;
  blocks: BriefBlock[];
}

export type MemoryScope = '全局' | '对象' | '会话';
export type MemoryKind = '偏好' | '禁写' | '习惯';

export interface Memory {
  id: string;
  scope: MemoryScope;
  text: string;
  kind: MemoryKind;
  createdAt: string;
  objectId?: string | undefined;
}

export interface ExtractJob {
  sourceId: string;
  status: '抽取中' | '完成' | '失败' | '未配置';
  detail?: string | undefined;
}

export type ExtractionOutcomeKind = 'success' | 'unconfigured' | 'invalid-output' | 'failed';

export type IngestFailureKind =
  | 'invalid-input'
  | 'unsupported-mime'
  | 'too-large'
  | 'too-many-pages'
  | 'timeout'
  | 'fetch-failed'
  | 'parse-failed'
  | 'empty-body'
  | 'interrupted';

export type IngestInput =
  | { kind: 'text'; text: string; suggestedTitle?: string | undefined }
  | { kind: 'url'; url: string }
  | { kind: 'file'; filePath: string };

export interface IngestJob {
  id: string;
  inputKind: IngestInput['kind'];
  input?: IngestInput | undefined;
  status: '排队' | '获取中' | '解析中' | '提交中' | '完成' | '失败';
  title?: string | undefined;
  locator?: string | undefined;
  sourceId?: string | undefined;
  failureKind?: IngestFailureKind | undefined;
  detail?: string | undefined;
  attempt: number;
  workspaceId?: string | undefined;
  createdAt: string;
  updatedAt: string;
}

export type ProposalDecision = 'accept-merge' | 'accept-drop' | 'reject';

export type TidyPayload = { kind: '整理'; claimId: string; targetPredicate: Predicate };
// 0037：整理提议的「丢弃未核」类型——未核积压的兜底出口（单条起，批量留待真链）。
export type DropUnverifiedPayload = {
  kind: '丢弃未核';
  claimIds: string[];
  reason?: string | undefined;
};
export type CandidatePayload = {
  kind: '候选记忆';
  text: string;
  memoryKind: MemoryKind;
  fromObjectId?: string | undefined;
  fromMessageIds: string[];
  sourceExcerpt: string;
  // TODO(待拍板 §11) 范围由 payload 给定，卡上不做下拉。
  scope: MemoryScope;
};
export type ProposalPayload = TidyPayload | CandidatePayload | DropUnverifiedPayload;

export interface Proposal {
  id: string;
  type: '整理' | '候选记忆';
  title: string;
  detail: string;
  payload: ProposalPayload;
  pending: boolean;
  decision?: ProposalDecision | undefined;
}

export type ChatCardKind = '审计' | '结果' | '提议';
// refit-3 P1-1：结果用不同图标区分；「整理」「拒绝」是新补的语义（0027 时间线要求每个已发生动作落结果卡）；
// 「撤销」（0034）是补偿写的结果卡图标。
export type ResultKind =
  | '关窗'
  | '晋升'
  | '记忆'
  | '简报'
  | '绑定'
  | '解绑'
  | '删除来源'
  | '抽取'
  | '整理'
  | '拒绝'
  | '批量晋升'
  | '撤销';

// 0034：撤销 = 追加补偿写。每张可撤销的结果卡带着补偿所需的最小载荷。
export type UndoPayload =
  | { kind: '晋升'; claimId: string }
  | { kind: '批量晋升'; claimIds: string[] }
  | { kind: '整理并入'; claimId: string; fromPredicate: string }
  // 新写入一律用 claims；旧数据库里已持久化的 { claim } 仍可读取和补偿。
  | { kind: '整理丢弃'; claims: Claim[] }
  | { kind: '整理丢弃'; claim: Claim }
  | { kind: '记忆'; memoryId: string }
  | { kind: '绑定'; sourceId: string }
  | { kind: '解绑'; sourceId: string; objectId: string; claims: Claim[] }
  | {
      kind: '关窗';
      claimId: string;
      memoryId?: string | undefined;
      companionId?: string | undefined;
    };

export interface ChatCard {
  kind: ChatCardKind;
  claimId?: string | undefined;
  claimIds?: string[] | undefined;
  proposalId?: string | undefined;
  briefId?: string | undefined;
  result?: ResultKind | undefined;
  undo?: UndoPayload | undefined;
}

export type ToolIcon = 'book' | 'file' | 'disk' | 'warn' | 'search';

export interface ToolCall {
  id: string;
  title: string;
  summary: string;
  icon: ToolIcon;
  input: string;
  output: string;
}

export interface ThinkCopy {
  runningTitle: string;
  doneTitle: string;
  summary: string;
  body: string;
}

export interface TurnVisual {
  tools: ToolCall[];
  think: ThinkCopy;
  played: boolean;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'desk' | 'card';
  text: string;
  claimRefs?: string[] | undefined;
  note?: string | undefined;
  card?: ChatCard | undefined;
  turn?: TurnVisual | undefined;
}

// 「批量回退」（0034）：批量晋升撤销的补偿走 takeover 确认（Q3 裁决）。
export type WriteKind = '晋升' | '纠正' | '整理' | '绑定' | '批量晋升' | '批量回退';

export interface WriteProposal {
  id: string;
  objectId: string;
  kind: WriteKind;
  headline: string;
  evidence: string;
  claimId?: string | undefined;
  claimIds?: string[] | undefined; // 批量晋升（0016：任务结束对本任务未核全部晋升或保持，唯一批量白名单）
  sourceId?: string | undefined;
  objectIds?: string[] | undefined;
  targetPredicate?: Predicate | undefined;
  outbound?: boolean | undefined;
}

// 0036：任务四态 + 停止原因；触顶不是失败，取消不独立（待启动撤回即删记录）。
export type TaskKind = '调研' | '出简报' | '再搜一轮' | '周期性雷达';
export type TaskStatus = '待启动' | '进行中' | '已完成' | '已停止';
export type TaskStopReason = '手动' | '触顶' | '失败';
export type BudgetGear = '快搜' | '深挖';

export interface DeskTask {
  id: string;
  objectId: string;
  kind: TaskKind;
  status: TaskStatus;
  stopReason?: TaskStopReason | undefined;
  budgetGear?: BudgetGear | undefined;
  query?: string | undefined;
  intervalDays?: number | undefined;
  nextDueAt?: string | undefined;
  lastRunAt?: string | undefined;
  parentTaskId?: string | undefined;
  dueAt?: string | undefined;
  createdAt: string;
}

export interface TaskAudit {
  taskId: string;
  seq: number;
  kind: string;
  payload: unknown;
  ts: string;
}

export type View =
  | { kind: 'inbox' }
  | { kind: 'pending' }
  | { kind: 'all' } // 全部对象（0032）：含已归档、含无工作区的孤儿对象，可恢复进当前工作区
  | { kind: 'object'; objectId: string }
  | { kind: 'replay'; taskId: string };

export type ThemePreference = 'light' | 'dark' | 'system';

export interface LlmModel {
  id: string;
  name: string;
  contextWindow: number;
  maxOutput: number;
}

export interface LlmProvider {
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  enabled: boolean;
  models: LlmModel[];
}

export type ThinkingEffort = '关闭' | '低' | '中' | '高';

export type RightTabKind = '档案' | '来源' | '简报';

export interface RightTab {
  id: string;
  kind: RightTabKind;
}

// 0039：三级自检（连通 → 能力探测 → 隔离样本验证）。样本不写入用户大脑文件。
export interface ProviderCert {
  status: '未认证' | '认证中' | '已认证';
  startedAt?: number | undefined;
  connect?: 'ok' | 'fail' | undefined;
  capability?: 'ok' | 'fail' | undefined;
  connectDetail?: string | undefined;
  capabilityDetail?: string | undefined;
  certDetail?: string | undefined;
  recall?: number | undefined; // 证据召回 %
  faithful?: number | undefined; // 简报忠实 %
  unknown?: number | undefined; // 未知遵守 %
  fabrication?: number | undefined; // 编造率 %（唯一红线，默认 5%）
}

export interface State {
  workspaces: Workspace[];
  currentWorkspaceId: string;
  objects: DeskObject[];
  sources: Source[];
  claims: Claim[];
  slotDefs: SlotDef[]; // 受控谓词表（0025）：数据化的槽表，设置页可加槽
  briefs: Brief[];
  memories: Memory[];
  inbox: string[];
  ingestJobs: IngestJob[];
  extractJobs: ExtractJob[];
  pendingClaims: Claim[]; // 抽取循环还没写进账本的主张（绑定确认后才入账）
  proposals: Proposal[];
  tasks: DeskTask[];
  taskAudits: TaskAudit[];
  chatByObject: Record<string, ChatMessage[]>;
  view: View;
  selectedClaimId: string | null;
  sourceFocusId: string | null;
  toast: { text: string; id: number } | null;
  briefDraftingFor: string | null;
  seq: number;
  themePreference: ThemePreference;
  providers: LlmProvider[];
  activeProviderId: string;
  activeModelId: string;
  thinkingEffort: ThinkingEffort;
  rightTabsByObject: Record<string, RightTab[]>;
  activeRightTabByObject: Record<string, string | null>;
  writeQueue: WriteProposal[];
  certByProvider: Record<string, ProviderCert>;
  onboardingDone: boolean;
  deletedSourceRecoveries: DeletedSourceRecovery[];
}

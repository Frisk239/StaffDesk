import type { Claim, DeskObject, Memory, Proposal, Source, State } from './types';
import { DEFAULT_SLOT_DEFS } from './scenario';

// 种子结构按 docs/prototype.md「种子数据」，可改文案不可改结构。
// 两个工作区两个场景（0033）：秋招走求职面试主链；消息队列选型走技术选型，演示同一底座换场景预设。

const workspaces = [
  { id: 'ws-autumn', name: '2026 秋招', scenario: '求职面试' as const },
  { id: 'ws-mq', name: '消息队列选型', scenario: '技术选型' as const },
];

const objects: DeskObject[] = [
  { id: 'org-zhanqiao', kind: '组织', name: '栈桥科技', workspaceId: 'ws-autumn', relationIds: ['proj-2026-autumn', 'person-zhou'] },
  {
    id: 'proj-2026-autumn',
    kind: '项目',
    name: '后端实习 2026 秋招',
    note: '属于栈桥科技',
    workspaceId: 'ws-autumn',
    relationIds: ['org-zhanqiao'],
  },
  { id: 'person-zhou', kind: '人', name: '周若水', note: '面试官', workspaceId: 'ws-autumn', relationIds: ['org-zhanqiao'] },
  // —— 技术选型场景（ws-mq）——
  {
    id: 'proj-mq',
    kind: '项目',
    name: '消息队列选型 2026',
    note: '对比候选，出选型结论',
    workspaceId: 'ws-mq',
    relationIds: ['proj-nord'],
  },
  {
    id: 'proj-nord',
    kind: '项目',
    name: 'NordStream',
    note: '候选之一（虚构项目）',
    workspaceId: 'ws-mq',
    relationIds: ['proj-mq', 'org-lufts'],
  },
  {
    id: 'org-lufts',
    kind: '组织',
    name: 'LuftData',
    note: 'NordStream 背后的公司（虚构）',
    workspaceId: 'ws-mq',
    relationIds: ['proj-nord'],
  },
];

const jdBody = `栈桥科技 2026 秋季校园招聘 · 后端开发实习生

【岗位职责】
参与后端服务的设计、开发与维护，和团队一起把内部平台化建设往前推。

【任职要求】
- 本科及以上在读，每周可实习 4 天以上
- 团队主栈是 Go，熟悉任一后端语言即可，不设硬性门槛
- 对服务端基本功（存储、并发、网络）有基本概念

【其他】
如果你目前主要写 Java，团队后端选型也在评估 Java 方向，欢迎投递聊聊。

（本 JD 由招聘方发布，原文未提及工作地点。）`;

const webBody = `栈桥科技 · 官网首页摘录（zhanqiao.dev）

栈桥科技做开发者基础设施产品。我们的后端主栈是 Go，线上服务每天承载千万级请求；
团队规模不大，习惯把重复劳动沉淀成内部工具。`;

const nordDocBody = `NordStream · 官方文档摘录（docs.nordstream.dev，虚构项目）

NordStream 是 LuftData 开源的高吞吐消息中间件，以 Apache-2.0 许可证发布。
项目保持每两周一次例行发布，主干分支持续可发布。
社区贡献方面，近一年每月有数十名活跃贡献者提交。
LuftData 主营流处理基础设施，为 NordStream 提供商业支持。`;

const benchBody = `第三方基准与观察文章摘录（转述，虚构）

从 issue 响应和邮件列表看，NordStream 社区热度近两季度趋于冷清，核心维护者精力转向商业产品。
（原文未提供吞吐对比数据。）`;

const sources: Source[] = [
  {
    id: 'src-jd',
    title: 'jd-zhanqiao.txt',
    body: jdBody,
    path: '手给',
    role: '主键',
    boundObjectIds: [],
    workspaceId: 'ws-autumn',
  },
  {
    // 绑定 JD 之后才内置出现的官网摘录（已绑定、调研带回、未核）
    id: 'src-web',
    title: '栈桥科技官网首页摘录（zhanqiao.dev）',
    body: webBody,
    path: '调研',
    role: '主键',
    boundObjectIds: ['org-zhanqiao'],
    workspaceId: 'ws-autumn',
  },
  {
    id: 'src-nord-doc',
    title: 'NordStream 官方文档摘录（docs.nordstream.dev）',
    body: nordDocBody,
    path: '手给',
    role: '主键',
    boundObjectIds: ['proj-nord', 'org-lufts'],
    workspaceId: 'ws-mq',
  },
  {
    id: 'src-bench',
    title: '第三方基准文章摘录（转述）',
    body: benchBody,
    path: '调研',
    role: '转述',
    boundObjectIds: ['proj-nord'],
    workspaceId: 'ws-mq',
  },
  {
    // 使用者陈述的落点：不是来源展览，仅供审计卡指回
    id: 'user-stmt',
    title: '使用者陈述',
    body: '',
    path: '手给',
    boundObjectIds: [],
    virtual: true,
  },
];

// 绑定确认、抽取完成后写入账本的主张（默认未核）。
// 0029：主栈冲突落单值槽「后端主栈」——互斥判定只用单值槽。
const pendingClaims: Claim[] = [
  {
    id: 'cl-1',
    objectId: 'org-zhanqiao',
    predicate: '在招岗位',
    text: '栈桥科技 2026 秋招在招后端实习。',
    status: '成立',
    unverified: true,
    validFrom: '2026-08-01',
    sourceId: 'src-jd',
    span: '栈桥科技 2026 秋季校园招聘 · 后端开发实习生',
    createdAt: '',
  },
  {
    id: 'cl-2',
    objectId: 'org-zhanqiao',
    predicate: '后端主栈',
    text: '栈桥科技后端主栈是 Go。',
    status: '成立',
    unverified: true,
    validFrom: '2026-07-15',
    sourceId: 'src-web',
    span: '我们的后端主栈是 Go，线上服务每天承载千万级请求',
    createdAt: '',
  },
  {
    id: 'cl-3',
    objectId: 'org-zhanqiao',
    predicate: '后端主栈',
    text: '栈桥科技后端选型也在评估 Java 方向。',
    status: '成立',
    unverified: true,
    validFrom: '2026-08-01',
    sourceId: 'src-jd',
    span: '如果你目前主要写 Java，团队后端选型也在评估 Java 方向，欢迎投递聊聊',
    createdAt: '',
  },
  {
    id: 'cl-4',
    objectId: 'org-zhanqiao',
    predicate: '未编目',
    text: '栈桥科技团队正在推进内部平台化。',
    status: '成立',
    unverified: true,
    validFrom: '2026-08-01',
    sourceId: 'src-jd',
    span: '和团队一起把内部平台化建设往前推',
    createdAt: '',
  },
];

// 技术选型场景（ws-mq）已入账的主张：换一套槽表（活跃度/发布节奏/许可证/主营业务），
// 活跃度单值槽上主键与转述冲突并排——同一套纪律在不同场景下的样子。
const mqClaims: Claim[] = [
  {
    id: 'mq-1',
    objectId: 'proj-nord',
    predicate: '许可证',
    text: 'NordStream 以 Apache-2.0 许可证发布。',
    status: '成立',
    unverified: true,
    validFrom: '2026-06-01',
    sourceId: 'src-nord-doc',
    span: '以 Apache-2.0 许可证发布',
    createdAt: '2026-08-10',
  },
  {
    id: 'mq-2',
    objectId: 'proj-nord',
    predicate: '发布节奏',
    text: 'NordStream 保持每两周一次例行发布。',
    status: '成立',
    unverified: true,
    validFrom: '2026-08-01',
    sourceId: 'src-nord-doc',
    span: '项目保持每两周一次例行发布，主干分支持续可发布',
    createdAt: '2026-08-10',
  },
  {
    id: 'mq-3',
    objectId: 'proj-nord',
    predicate: '活跃度',
    text: 'NordStream 社区近一年每月有数十名活跃贡献者提交。',
    status: '成立',
    unverified: true,
    validFrom: '2026-07-01',
    sourceId: 'src-nord-doc',
    span: '近一年每月有数十名活跃贡献者提交',
    createdAt: '2026-08-10',
  },
  {
    id: 'mq-4',
    objectId: 'proj-nord',
    predicate: '活跃度',
    text: 'NordStream 社区热度近两季度趋于冷清。',
    status: '成立',
    unverified: true,
    validFrom: '2026-08-01',
    sourceId: 'src-bench',
    span: 'NordStream 社区热度近两季度趋于冷清，核心维护者精力转向商业产品',
    createdAt: '2026-08-12',
  },
  {
    id: 'mq-5',
    objectId: 'org-lufts',
    predicate: '主营业务',
    text: 'LuftData 主营流处理基础设施。',
    status: '成立',
    unverified: true,
    validFrom: '2026-06-01',
    sourceId: 'src-nord-doc',
    span: 'LuftData 主营流处理基础设施，为 NordStream 提供商业支持',
    createdAt: '2026-08-10',
  },
];

const memories: Memory[] = [
  {
    id: 'mem-1',
    scope: '全局',
    kind: '习惯',
    text: '简报用条目，别写长',
    createdAt: '2026-08-20',
  },
];

const proposals: Proposal[] = [
  {
    id: 'prop-1',
    type: '整理',
    title: '未编目主张建议编目：内部平台化',
    detail:
      '主张「栈桥科技团队正在推进内部平台化。」映射不上受控谓词表。建议并入槽「使用技术」，或丢弃；也可以驳回本次提议，等新槽。',
    payload: { kind: '整理', claimId: 'cl-4', targetPredicate: '使用技术' },
    pending: true,
  },
  {
    id: 'prop-2',
    type: '候选记忆',
    title: '会话扫出：回复偏短',
    detail: '对着栈桥科技问了几轮后，使用者多次把回答压成条目。这是偏好，不是世界事实，等人确认才升对象记忆。',
    payload: {
      kind: '候选记忆',
      text: '对着这家组织，回复用条目，别写长段',
      memoryKind: '偏好',
      fromObjectId: 'org-zhanqiao',
      scope: '对象',
    },
    pending: true,
  },
  {
    // 0037：整理新增「丢弃未核」——未核积压的兜底出口。演示：转述主张滞留未核且与主键冲突，建议丢弃。
    id: 'prop-3',
    type: '整理',
    title: '建议丢弃滞留未核：社区趋于冷清（转述）',
    detail:
      '「NordStream 社区热度近两季度趋于冷清。」来自转述来源、尚未晋升，且与主键来源的活跃度主张并排冲突。整理建议丢弃这条未核主张（丢弃后派生冲突随之消失）；也可以驳回，留待晋升或关窗。',
    payload: { kind: '丢弃未核', claimIds: ['mq-4'] },
    pending: true,
  },
];

/** 官网摘录完整对象。初始状态滤掉，绑定 JD 后再从这里取，不要从 makeInitialState().sources 找。 */
export const allSources: Source[] = sources;

/** 绑定撤销（0034）要恢复抽取前的待抽主张：按 sourceId 取这里。 */
export const seedPendingClaims: Claim[] = pendingClaims;

export function makeInitialState(): State {
  return {
    workspaces,
    currentWorkspaceId: 'ws-autumn',
    objects,
    sources: sources.filter((s) => s.id !== 'src-web'), // 官网摘录：绑定后才内置
    claims: mqClaims, // 技术选型场景直接入账；秋招主链走 pendingClaims 绑定流程
    slotDefs: DEFAULT_SLOT_DEFS,
    briefs: [],
    memories,
    inbox: ['src-jd'],
    extractJobs: [],
    pendingClaims,
    proposals,
    tasks: [],
    chatByObject: {},
    view: { kind: 'inbox' }, // 启动不是对话首页；先处理 Inbox
    selectedClaimId: null,
    sourceFocusId: null,
    toast: null,
    briefDraftingFor: null,
    seq: 1,
    themePreference: 'system',
    providers: [
      {
        id: 'p-deepseek',
        kind: 'deepseek',
        name: 'DeepSeek',
        baseUrl: 'https://api.deepseek.com/v1',
        apiKey: '',
        protocol: 'chat-completions',
        enabled: true,
        models: [
          { id: 'deepseek-chat', name: 'deepseek-chat', contextWindow: 128000, maxOutput: 8192 },
          { id: 'deepseek-reasoner', name: 'deepseek-reasoner', contextWindow: 128000, maxOutput: 8192 },
        ],
      },
      {
        id: 'p-openai',
        kind: 'openai',
        name: 'OpenAI',
        baseUrl: 'https://api.openai.com/v1',
        apiKey: '',
        protocol: 'chat-completions',
        enabled: true,
        models: [{ id: 'gpt-4o', name: 'gpt-4o', contextWindow: 128000, maxOutput: 16384 }],
      },
      {
        id: 'p-anthropic',
        kind: 'anthropic',
        name: 'Anthropic',
        baseUrl: 'https://api.anthropic.com',
        apiKey: '',
        protocol: 'anthropic-messages',
        enabled: true,
        models: [{ id: 'claude-sonnet-4-5', name: 'claude-sonnet-4-5', contextWindow: 200000, maxOutput: 16384 }],
      },
    ],
    activeProviderId: 'p-deepseek',
    activeModelId: 'deepseek-chat',
    thinkingEffort: '中',
    writeQueue: [],
    rightTabsByObject: {},
    activeRightTabByObject: {},
    certByProvider: {},
  };
}

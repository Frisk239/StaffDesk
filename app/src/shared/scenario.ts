import type { Claim, ObjectKind, Predicate, ScenarioKind, SlotDef, BriefSpecBlock } from './types';

// 0033：场景预设包。三件套里的两件是数据（槽表预设、简报说明），
// 第三件（建对象引导）在 Chrome.tsx 的建对象表单里按场景给 placeholder。
// 谓词表全局受控一张（0025），槽带场景适用标记；空 scenarios = 通用槽，所有场景都显示。

export const SCENARIOS: ScenarioKind[] = ['求职面试', '求学申请', '技术选型', '尽调研究', '自定义'];

export const SCENARIO_HINTS: Record<ScenarioKind, string> = {
  求职面试: '盯一个岗位：公司、面试官、这场招聘',
  求学申请: '盯一次申请：学校、导师、申请方向',
  技术选型: '盯一次选型：候选项目、维护方、社区信号',
  尽调研究: '盯一个标的：业务、团队、风险',
  自定义: '自己配槽表和简报说明',
};

export const DEFAULT_SLOT_DEFS: SlotDef[] = [
  // 通用槽（所有场景）
  { name: '任职于', kind: '人', arity: '单值', scenarios: [] },
  // 求职面试
  { name: '教育背景', kind: '人', arity: '单值', scenarios: ['求职面试', '求学申请', '尽调研究'] },
  { name: '公开观点', kind: '人', arity: '多值', scenarios: ['求职面试', '尽调研究'] },
  { name: '招生情况', kind: '人', arity: '单值', scenarios: ['求学申请'] },
  { name: '研究方向', kind: '人', arity: '多值', scenarios: ['求学申请'] },
  { name: '在招岗位', kind: '组织', arity: '多值', scenarios: ['求职面试'] },
  { name: '后端主栈', kind: '组织', arity: '单值', scenarios: ['求职面试', '技术选型'] },
  { name: '使用技术', kind: '组织', arity: '多值', scenarios: ['求职面试', '技术选型'] },
  { name: '办公地点', kind: '组织', arity: '单值', scenarios: ['求职面试', '尽调研究'] },
  { name: '融资轮次', kind: '组织', arity: '单值', scenarios: ['求职面试', '尽调研究'] },
  { name: '岗位要点', kind: '项目', arity: '多值', scenarios: ['求职面试'] },
  // 求学申请
  { name: '排名层次', kind: '组织', arity: '单值', scenarios: ['求学申请'] },
  { name: '学制学费', kind: '组织', arity: '单值', scenarios: ['求学申请'] },
  { name: '申请要点', kind: '项目', arity: '多值', scenarios: ['求学申请'] },
  // 技术选型
  { name: '活跃度', kind: '项目', arity: '单值', scenarios: ['技术选型'] },
  { name: '发布节奏', kind: '项目', arity: '单值', scenarios: ['技术选型'] },
  { name: '许可证', kind: '项目', arity: '单值', scenarios: ['技术选型'] },
  { name: '性能口径', kind: '项目', arity: '多值', scenarios: ['技术选型'] },
  { name: '商业支持', kind: '组织', arity: '单值', scenarios: ['技术选型'] },
  { name: '维护方', kind: '组织', arity: '单值', scenarios: ['技术选型'] },
  // 尽调研究
  { name: '主营业务', kind: '组织', arity: '单值', scenarios: ['尽调研究', '技术选型'] },
  { name: '团队规模', kind: '组织', arity: '单值', scenarios: ['尽调研究'] },
  { name: '风险信号', kind: '组织', arity: '多值', scenarios: ['尽调研究'] },
  { name: '标的要点', kind: '项目', arity: '多值', scenarios: ['尽调研究'] },
];

// 0033：简报说明由场景决定。块的装法见 brief.ts 的组装器：
// background 装非槽位主张、slots 装指定槽（冲突摊开、未编目降级）、synthesis 综合（必须指回主张）、gaps 材料缺口。
export const BRIEF_SPECS: Record<ScenarioKind, BriefSpecBlock[]> = {
  求职面试: [
    { title: '组织是谁', kind: 'background' },
    { title: '在招什么', kind: 'slots', predicates: ['在招岗位'] },
    { title: '技术信号', kind: 'slots', predicates: ['后端主栈', '使用技术'] },
    { title: '可能问什么', kind: 'synthesis' },
    { title: '材料缺口', kind: 'gaps' },
  ],
  求学申请: [
    { title: '学校与项目', kind: 'background' },
    { title: '方向与导师', kind: 'slots', predicates: ['研究方向', '招生情况', '任职于'] },
    { title: '申请要求', kind: 'slots', predicates: ['申请要点', '排名层次', '学制学费'] },
    { title: '材料缺口', kind: 'gaps' },
  ],
  技术选型: [
    { title: '是什么', kind: 'background' },
    {
      title: '成熟度',
      kind: 'slots',
      predicates: ['活跃度', '发布节奏', '许可证', '维护方', '商业支持'],
    },
    { title: '风险与依赖', kind: 'slots', predicates: ['风险信号', '性能口径'] },
    { title: '材料缺口', kind: 'gaps' },
  ],
  尽调研究: [
    { title: '对象是谁', kind: 'background' },
    {
      title: '关键事实',
      kind: 'slots',
      predicates: ['主营业务', '团队规模', '融资轮次', '标的要点'],
    },
    { title: '风险与冲突', kind: 'slots', predicates: ['风险信号'] },
    { title: '材料缺口', kind: 'gaps' },
  ],
  自定义: [
    { title: '关键事实', kind: 'background' },
    { title: '材料缺口', kind: 'gaps' },
  ],
};

/** 当前工作区的场景（0033：场景挂工作区，区内对象继承）。 */
export function scenarioOfWorkspace(
  workspaces: { id: string; scenario: ScenarioKind }[],
  workspaceId: string,
): ScenarioKind {
  return workspaces.find((w) => w.id === workspaceId)?.scenario ?? '求职面试';
}

/** 对象页投影的槽：谓词表按种类分区后，再按对象所在工作区的场景过滤；通用槽恒显示（0033）。 */
export function slotsForScene(
  slotDefs: SlotDef[],
  kind: ObjectKind,
  scenario: ScenarioKind,
): Predicate[] {
  return slotDefs
    .filter((d) => d.kind === kind)
    .filter((d) => d.scenarios.length === 0 || d.scenarios.includes(scenario))
    .map((d) => d.name);
}

/**
 * 0053：归一化取值——只做大小写、空白与全半角（NFKC），不做同义改写。
 * 「北京」与「北京市」归一化后仍不同，冲突照建，由人关窗或纠正消解。
 * 互斥判定（deriveConflicts）与禁写结构化路（0054 bannedValue）共用此函数，是唯一收口点。
 */
export function normalizeValue(value: string): string {
  return value.normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * 0029：冲突完全派生——同对象、同单值谓词槽、都未关窗、有效期重叠、取值互斥。
 * 0053：互斥 = 归一化取值不同（大小写、空白、全半角差异不算互斥），不做语义判断。
 * 不存独立状态；关窗后冲突自动消失。多值槽并存不互斥，不建冲突。
 */
export function deriveConflicts(
  claims: Claim[],
  slotDefs: SlotDef[],
): { claimIdA: string; claimIdB: string }[] {
  const single = new Set(slotDefs.filter((d) => d.arity === '单值').map((d) => d.name));
  const live = claims.filter(
    (c) => c.status !== '过时' && c.predicate !== '未编目' && single.has(c.predicate),
  );
  const out: { claimIdA: string; claimIdB: string }[] = [];
  for (let i = 0; i < live.length; i++) {
    for (let j = i + 1; j < live.length; j++) {
      const a = live[i]!;
      const b = live[j]!;
      // 0053：互斥按归一化取值判定，裸文本相等口径已废。
      if (
        a.objectId !== b.objectId ||
        a.predicate !== b.predicate ||
        normalizeValue(a.text) === normalizeValue(b.text)
      )
        continue;
      const aFrom = a.validFrom ?? '0000';
      const bFrom = b.validFrom ?? '0000';
      const aTo = a.validTo ?? '9999';
      const bTo = b.validTo ?? '9999';
      if (aFrom > bTo || bFrom > aTo) continue; // 有效期不重叠
      out.push({ claimIdA: a.id, claimIdB: b.id });
    }
  }
  return out;
}

import type { ObjectKind, ScenarioKind } from '@shared/types';
import { DEFAULT_SLOT_DEFS } from '@shared/scenario';

export interface GoldExpected {
  predicate: string;
  textIncludes: string;
  spanIncludes: string;
}

export interface GoldRetrievalCase {
  query: string;
  expectedRanking: string[];
  k: number;
}

export interface GoldConflictCase {
  predicate: string;
  textIncludes: [string, string];
}

export interface GoldCorrectionCase {
  claimTextIncludes: string;
  replacementText: string;
}

/** 未编目纪律用例（0037）：正文里映射不上受控槽的话，出站必须带降级标记而非单边定论。 */
export interface GoldUncatCase {
  textIncludes: string;
}

/** 撤销补偿用例（0034）：晋升确认后必须能经结果卡 undo 回到未核。 */
export interface GoldUndoCase {
  claimTextIncludes: string;
}

export interface GoldPack {
  id: string;
  scenario: ScenarioKind;
  object: { kind: ObjectKind; name: string };
  source: { title: string; body: string };
  expected: GoldExpected[];
  retrievalCases: GoldRetrievalCase[];
  conflicts: GoldConflictCase[];
  correctionCases: GoldCorrectionCase[];
  uncatCases?: GoldUncatCase[] | undefined;
  undoCases?: GoldUndoCase[] | undefined;
  unknownSlots: string[];
  negatives: string[];
}

/** 内置虚构金标只陈述材料事实；测试控制信息只存在于结构化期望中。 */
export const GOLD_PACKS: GoldPack[] = [
  {
    id: 'gold-interview',
    scenario: '求职面试',
    object: { kind: '组织', name: '青浦书院' },
    source: {
      title: '青浦书院实习材料（虚构）',
      body: [
        '青浦书院 2026 校园招聘后端实习生。',
        '团队技术说明称后端主栈是 TypeScript。',
        '项目交接记录则称后端主栈是 Go。',
      ].join(''),
    },
    expected: [
      { predicate: '在招岗位', textIncludes: '后端实习生', spanIncludes: '后端实习生' },
      {
        predicate: '后端主栈',
        textIncludes: 'TypeScript',
        spanIncludes: '后端主栈是 TypeScript',
      },
      { predicate: '后端主栈', textIncludes: 'Go', spanIncludes: '后端主栈是 Go' },
    ],
    retrievalCases: [
      { query: 'TypeScript 主栈', expectedRanking: ['TypeScript'], k: 3 },
      { query: '后端实习生', expectedRanking: ['后端实习生'], k: 3 },
    ],
    conflicts: [{ predicate: '后端主栈', textIncludes: ['TypeScript', 'Go'] }],
    correctionCases: [],
    unknownSlots: ['办公地点'],
    negatives: ['年薪百万', '总部在火星'],
  },
  {
    id: 'gold-study',
    scenario: '求学申请',
    object: { kind: '人', name: '江澈' },
    source: {
      title: '导师主页摘录（虚构）',
      body: '江澈任职于河图大学，研究方向是程序语言。本年度开放两名硕士名额。',
    },
    expected: [
      { predicate: '任职于', textIncludes: '河图大学', spanIncludes: '任职于河图大学' },
      { predicate: '研究方向', textIncludes: '程序语言', spanIncludes: '程序语言' },
    ],
    retrievalCases: [{ query: '程序语言 研究方向', expectedRanking: ['程序语言'], k: 3 }],
    conflicts: [],
    correctionCases: [],
    unknownSlots: [],
    negatives: ['已经退休', '拒绝招生'],
  },
  {
    id: 'gold-tech',
    scenario: '技术选型',
    object: { kind: '项目', name: '镜川' },
    source: {
      title: '镜川文档摘录（虚构）',
      body: '镜川以 MIT 许可证发布。项目保持每月一次例行发布。团队还在用内部脚本做发布。',
    },
    expected: [
      { predicate: '许可证', textIncludes: 'MIT', spanIncludes: 'MIT 许可证' },
      { predicate: '发布节奏', textIncludes: '每月', spanIncludes: '每月一次例行发布' },
      // 「内部脚本做发布」映射不上任何受控槽：抽取环归入未编目，出站只许降级为「材料提到」。
      { predicate: '未编目', textIncludes: '内部脚本', spanIncludes: '内部脚本' },
    ],
    retrievalCases: [{ query: 'MIT 许可证', expectedRanking: ['MIT'], k: 3 }],
    conflicts: [],
    correctionCases: [
      {
        claimTextIncludes: '每月',
        replacementText: '镜川项目改为每季度一次例行发布。',
      },
    ],
    uncatCases: [{ textIncludes: '内部脚本' }],
    undoCases: [{ claimTextIncludes: 'MIT' }],
    unknownSlots: ['性能口径'],
    negatives: ['吞吐百万 QPS', '已经停更'],
  },
];

export function packForScenario(scenario: ScenarioKind): GoldPack {
  return GOLD_PACKS.find((pack) => pack.scenario === scenario) ?? GOLD_PACKS[0]!;
}

export function validateGoldPacks(packs: readonly GoldPack[]): string[] {
  const errors: string[] = [];
  const ids = new Set<string>();
  for (const pack of packs) {
    if (ids.has(pack.id)) errors.push(`${pack.id}：ID 重复`);
    ids.add(pack.id);
    if (!pack.source.body.trim()) errors.push(`${pack.id}：来源正文为空`);
    if (/不要写|必须输出|测试指令/.test(pack.source.body)) {
      errors.push(`${pack.id}：来源正文含测试控制指令`);
    }
    if (pack.expected.length === 0) errors.push(`${pack.id}：没有期望主张`);
    for (const item of pack.expected) {
      const controlled = DEFAULT_SLOT_DEFS.some(
        (slot) =>
          slot.name === item.predicate &&
          slot.kind === pack.object.kind &&
          (slot.scenarios.length === 0 || slot.scenarios.includes(pack.scenario)),
      );
      if (item.predicate !== '未编目' && !controlled) {
        errors.push(`${pack.id}：期望谓词不在当前场景受控槽中：${item.predicate}`);
      }
      if (!pack.source.body.includes(item.spanIncludes)) {
        errors.push(`${pack.id}：出处片段无法定位：${item.spanIncludes}`);
      }
    }
    for (const retrieval of pack.retrievalCases) {
      if (!retrieval.query.trim() || retrieval.expectedRanking.length === 0 || retrieval.k < 1) {
        errors.push(`${pack.id}：检索期望不完整`);
      }
    }
    for (const conflict of pack.conflicts) {
      if (conflict.textIncludes[0] === conflict.textIncludes[1]) {
        errors.push(`${pack.id}：冲突两侧相同`);
      }
    }
    // 未编目纪律与撤销补偿用例必须锚在期望主张上，否则评测剧本永远空跑成 100。
    for (const uncat of pack.uncatCases ?? []) {
      const covered = pack.expected.some(
        (item) => item.predicate === '未编目' && item.textIncludes.includes(uncat.textIncludes),
      );
      if (!covered)
        errors.push(`${pack.id}：未编目用例没有对应的期望未编目主张：${uncat.textIncludes}`);
    }
    for (const undo of pack.undoCases ?? []) {
      const covered = pack.expected.some((item) =>
        item.textIncludes.includes(undo.claimTextIncludes),
      );
      if (!covered)
        errors.push(`${pack.id}：撤销补偿用例没有对应的期望主张：${undo.claimTextIncludes}`);
    }
  }
  return errors;
}

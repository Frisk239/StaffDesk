import type { ObjectKind, ScenarioKind } from '@shared/types';

export interface GoldExpected {
  predicate: string;
  textIncludes: string;
  spanIncludes: string;
}

export interface GoldPack {
  id: string;
  scenario: ScenarioKind;
  object: { kind: ObjectKind; name: string };
  source: { title: string; body: string };
  expected: GoldExpected[];
  unknownSlots: string[];
  negatives: string[];
}

/** 内置虚构金标，不随真实世界腐烂。 */
export const GOLD_PACKS: GoldPack[] = [
  {
    id: 'gold-interview',
    scenario: '求职面试',
    object: { kind: '组织', name: '青浦书院' },
    source: {
      title: '青浦书院实习 JD（虚构）',
      body: `青浦书院 2026 校园招聘后端实习生。团队主栈是 TypeScript。原文未写办公地点。不要写年薪。`,
    },
    expected: [
      { predicate: '在招岗位', textIncludes: '实习', spanIncludes: '后端实习生' },
      { predicate: '后端主栈', textIncludes: 'TypeScript', spanIncludes: '主栈是 TypeScript' },
    ],
    unknownSlots: ['办公地点'],
    negatives: ['年薪百万', '总部在火星'],
  },
  {
    id: 'gold-study',
    scenario: '求学申请',
    object: { kind: '人', name: '江澈' },
    source: {
      title: '导师主页摘录（虚构）',
      body: `江澈任职于河图大学，研究方向是程序语言。招生情况：本年度开放两名硕士名额。`,
    },
    expected: [
      { predicate: '任职于', textIncludes: '河图大学', spanIncludes: '任职于河图大学' },
      { predicate: '研究方向', textIncludes: '程序语言', spanIncludes: '程序语言' },
    ],
    unknownSlots: [],
    negatives: ['已经退休', '拒绝招生'],
  },
  {
    id: 'gold-tech',
    scenario: '技术选型',
    object: { kind: '项目', name: '镜川' },
    source: {
      title: '镜川文档摘录（虚构）',
      body: `镜川以 MIT 许可证发布。项目保持每月一次例行发布。原文未提供性能口径数字。`,
    },
    expected: [
      { predicate: '许可证', textIncludes: 'MIT', spanIncludes: 'MIT 许可证' },
      { predicate: '发布节奏', textIncludes: '每月', spanIncludes: '每月一次例行发布' },
    ],
    unknownSlots: ['性能口径'],
    negatives: ['吞吐百万 QPS', '已经停更'],
  },
];

export function packForScenario(scenario: ScenarioKind): GoldPack {
  return GOLD_PACKS.find((p) => p.scenario === scenario) ?? GOLD_PACKS[0]!;
}

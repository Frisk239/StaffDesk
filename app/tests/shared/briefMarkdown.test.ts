import { describe, expect, it } from 'vitest';
import type { Brief, Claim, Source } from '@shared/types';
import { briefToMarkdown } from '@shared/briefMarkdown';

// 审计 F4：简报出站出口的唯一 Markdown 组装——句后 [^n] 引用转脚注，
// 文末列 claim 的来源定位（谓词、来源、片段）；复制与导出共用这一份。

const primaryClaim: Claim = {
  id: 'cl-1',
  objectId: 'o1',
  predicate: '后端主栈',
  text: '甲主栈是 Go',
  status: '成立',
  unverified: false,
  sourceId: 's1',
  span: '主栈是 Go',
  createdAt: '2026-09-01',
};

const userClaim: Claim = {
  ...primaryClaim,
  id: 'cl-2',
  text: '甲在用平台化',
  predicate: '未编目',
  unverified: true,
  sourceId: 'user-stmt',
};

const source: Source = {
  id: 's1',
  title: '官网关于页',
  body: '正文',
  path: '手给',
  boundObjectIds: ['o1'],
  workspaceId: 'ws',
  origin: { kind: 'url', locator: 'https://example.com/about' },
};

const brief: Brief = {
  id: 'b1',
  objectId: 'o1',
  taskId: 't1',
  createdAt: '2026-09-02 10:00',
  blocks: [
    {
      title: '技术信号',
      sentences: [
        {
          text: primaryClaim.text,
          claimIds: ['cl-1'],
          unverified: false,
          kind: 'claim',
          primarySourceIds: ['s1'],
        },
        {
          text: `材料提到：${userClaim.text}（未编目，不作定论）`,
          claimIds: ['cl-2'],
          unverified: true,
          kind: 'claim',
          flag: '未编目·不作定论',
        },
        {
          text: '未知：账本中暂无「融资阶段」相关主张。',
          claimIds: [],
          unverified: false,
          kind: 'unknown',
        },
      ],
    },
  ],
};

describe('简报 Markdown 组装（审计 F4）', () => {
  const markdown = briefToMarkdown({
    brief,
    objectName: '甲公司',
    headLine: '出简报 · t1 · 2026-09-02 10:00',
    claims: [primaryClaim, userClaim],
    sources: [source],
  });

  it('标题、块标题与主张句都在，句后挂脚注引用', () => {
    expect(markdown).toContain('# 甲公司');
    expect(markdown).toContain('> 出简报 · t1 · 2026-09-02 10:00');
    expect(markdown).toContain('## 技术信号');
    expect(markdown).toContain('- 甲主栈是 Go（主键来源）[^1]');
  });

  it('标注折进句尾括号：主键来源、未编目、未核', () => {
    expect(markdown).toContain('（主键来源）[^1]');
    expect(markdown).toContain('（未编目·不作定论·未核）[^2]');
  });

  it('脚注列出谓词、来源定位与原文片段；使用者陈述如实标注', () => {
    expect(markdown).toContain(
      '[^1]: 〔后端主栈〕甲主栈是 Go —— 来源：官网关于页，https://example.com/about，片段「主栈是 Go」',
    );
    expect(markdown).toContain('[^2]: 〔未编目〕甲在用平台化 —— 来源：使用者陈述');
  });

  it('未知占位句不带脚注引用', () => {
    expect(markdown).toContain('未知：账本中暂无「融资阶段」相关主张。');
    expect(markdown).not.toMatch(/未知：账本中暂无「融资阶段」相关主张。\[\^/u);
    expect(markdown).not.toContain('[^3]');
  });

  it('同一主张重复出现复用同号，不重复编号', () => {
    const repeated: Brief = {
      ...brief,
      blocks: [
        brief.blocks[0]!,
        { title: '材料缺口', sentences: [{ ...brief.blocks[0]!.sentences[0]! }] },
      ],
    };
    const out = briefToMarkdown({
      brief: repeated,
      objectName: '甲公司',
      headLine: '出简报',
      claims: [primaryClaim, userClaim],
      sources: [source],
    });
    expect(out.match(/\[\^1\]/gu)?.length).toBe(3); // 两处句后引用 + 文末脚注定义
  });

  it('来源已删的主张脚注如实标注，不编造出处', () => {
    const out = briefToMarkdown({
      brief,
      objectName: '甲公司',
      headLine: '出简报',
      claims: [primaryClaim, userClaim],
      sources: [],
    });
    expect(out).toContain('[^1]: 〔后端主栈〕甲主栈是 Go —— 来源：来源已删除');
  });
});

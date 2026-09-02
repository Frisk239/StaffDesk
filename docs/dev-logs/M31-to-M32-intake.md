# M31 → M32 intake

## Verdict

M31 审计刀通过（PR #27 已合 main，b1bceae；纯文档，docs/audit-2026-09-02.md）。

## Merge state

- `origin/main` = `b1bceae`；本地 main 已同步；功能面齐平达成后的第一个巩固期排期在档。
- 工作树仅剩用户本地 AGENTS.md 代理段（随树漂移，不入库）。

## Regression evidence

- 审计刀 Owner 门禁（基准树 58a796d）：43 文件 / 308 测试 / Lines 92.7% / eval 四阶段 / e2e 30，全绿（机械摘取）。

## M32 slice（加固收尾刀，按审计排期原文）

Must：
1. **P-A/P-C 词条修订**：快搜词条删「跳数」（CONTEXT.md:185，与 0059 三重矛盾）；检索词条剪「跟踪链接」措辞（CONTEXT.md:93，引擎无跳链）。
2. **P-B 简报主键标注补兑现（0062）**：buildBrief 按当前对象视角给主张/冲突标注主键来源（brief 侧零 role 引用是审计 P2）。
3. **D1 fetch 超时**：reach.ts:156（GitHub 搜索）与 :246（Jina open）加 AbortSignal.timeout（对齐 spawn 的 25s/20s 口径）；e2e 注入挂起 fetch 断言墙钟收口、任务不永久挂死。
4. **F4 简报出站出口**：BriefView 加「复制 Markdown」与导出 .md（引用转脚注），纯 renderer + 最小 IPC。
5. **F8 unparsed 重导**：带 URL 的 unparsed 旧材料加「重新获取」入口走既有 ingestUrl。

红线：不改已裁决 ADR（0042/0060/0059 等）；简报标注是展示层增强不改冲突派生；审计 D2/D4 不在本刀（M34/ADR 队列）；费用口径不动。

流程：探索者先行（brief 渲染/导出面与 unparsed/剪贴板 IPC 面是审计未铺开行号的区域）→ 单执行者实现（代码面内聚）→ Owner 门禁 + 双轴评审 + 整改 → 关刀。

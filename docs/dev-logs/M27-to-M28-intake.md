# M27 → M28 intake

## Verdict

M27 通过（PR #22 已合 main，fdbc393；含 code-review 整改轮 dd3e294/ec139bc）。

## Merge state

- `origin/main` = `fdbc393`（M27 五提交全入）；本地 main 已同步；tag 仍只到 v0.1.0-m1-m7（用户合并仪式，不动）。
- 工作树仅剩用户本地 AGENTS.md 代理段（随树漂移，不入库）。

## Regression evidence

- M27 两轮门禁同数字全绿：38 文件 / 259 测试 / 覆盖 93.1% / eval 四阶段 / e2e 25（机械摘取）。
- computer-use 真实验收九项全过（docs/dev-logs/M27.md）。

## M28 slice（读路径债刀 + 费用维度，审计排期原文）

Must：
1. **双 loadLedger 对齐 0051**：dispatch 单次读，operations 扫描移出 snapshot。
2. **syncTable 增量化**：脏表行 diff 从全表 SELECT 改按键集查询；0056 等价套件必须全绿。
3. **taskAudits 主键/索引/保留（schema v10）**：PK(task_id, seq) + 索引 + 每任务上限裁旧（触顶/费用/手动停止/失败行豁免）。
4. **FTS 触发器接线**：claims 三触发器维护 FTS，全量重建保留为 repair 通道；前置核实 UPDATE 保 rowid。
5. **费用维度（G4，ADR 0059 已拍板）**：usage token 按任务累计、档位预算、费用触顶并入硬顶纪律、usage 缺失退化次数近似并审计标注、任务行/回放显示 token 消耗；hops 死维度删除。
   - 用户裁决（2026-09-01）：计费口径 = usage token 数（不折金额不建单价表）；费用维度捎带本刀落地。
6. G 系列清账后仅剩 ADR 队列（G1 主键标记、G2/G3 向量召回/多平台排期或改判）——功能齐平验收的最后一块。

红线：四件债不扩面（跳链是真功能刀，本刀只删 hops 声明）；费用不折金额；chat 不进任务预算；不碰 M29+ 的检索扩展。

代理分工：D = 四件债（brain/persist/schema/migrate/ipc），F = 费用维度（adapters/llm/tasks/renderer/e2e）；冲突面 persist/schema 由 Owner 盯（F 被令不碰 brain 持久化）。

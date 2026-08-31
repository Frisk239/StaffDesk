# M20 → M21 intake

## Verdict

通过。

## Merge state

- `origin/main` 已合入 M20：`2b58397 Merge pull request #13 from Frisk239/codex/m20-dirty-table-persist`
- M20 三个提交（`ae4310e` ADR / `c6a2108` 实现 / `ff343ff` 验收）均为 `origin/main` 祖先；本地 main 已同步，主 CI 绿。

## Regression evidence

- 抽查 `npx vitest run tests/brain/persist-diff.test.ts tests/brain/actions.test.ts`：2 文件 / 9 测试通过（含等价性套件与敏感时序）。
- M20.md 声称交付逐项核对在合并 diff 中：ADR 0056、persistLedgerDiff、PERSIST_TABLES 重构、persist-diff.test.ts 均在。

## Debt carried

- 读路径双 loadLedger 未动（后续刀，须先对齐 0051「snapshot 从 SQLite 恢复」）。
- FTS 触发器化未接线（前置：claims 行 UPDATE 保 rowid）；taskAudits 无界增长、operations 扫描无索引。
- 0053/0054/0055 已裁决未实现，随功能刀落地。

## M21 slice

M21「质量刀」：eval 金标升级（低分失败路径、未编目谓词、撤销补偿、任务停止用例；0054 未实现前「纠正复发」按已实现行为立金标）+ `runDueRadarCatchup` 与 `runResearchAndApply` 编排合一（catchup 补单飞锁）+ 脱敏 helper 收口（十份、五种截断，参数化保留各站点现行长度）+ 广播函数两份合一。红线：不新增账本功能面、不改 UI。

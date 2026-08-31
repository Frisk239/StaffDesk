# M23 → M24 intake

## Verdict

通过。

## Merge state

- `origin/main` 已合入 M23：`ba5b56c Merge pull request #16 from Frisk239/codex/m23-tidy-breadth`（用户手动开合）。
- 三个提交（2647ee2 / f6c2f33 / 155d342）均为祖先；本地 main 已同步。

## Regression evidence

- M23 分支树与合并树同体，Owner 已亲跑全套门禁（34 文件 189 测试、eval 四阶段、17 e2e）。
- main 抽查：ban-dualpath / tidy-decide / tidy 25 测试通过。

## Debt carried

- outbound 政策 v3：既有机器资格认证回落未认证，需用户在设置页补跑一次。
- 读路径债：dispatch 双 loadLedger（需对齐 0051「snapshot 从 SQLite 恢复」再动，推后）、syncTable 全表 SELECT；**operations 无索引全扫本刀拆**。
- taskAudits 无界、FTS 触发器未接线、renderer 零行为测试、编排 busy 无 e2e——不变。

## M24 slice

M24「提议收尾 + 雷达常驻」：
- **建新对象提议**（0052 整理面收尾）：抽取草稿引用了不存在于账本的对象名时，不再静默丢弃——tidy 提议「发现疑似新对象」，人确认才建（ADD_OBJECT 走既有确认链），对象只由人确认建立的裁决不变。
- **补关系提议**：主张正文提及另一既有对象名（长度 ≥2 字防误配）且两者无边时，提议建边（复用 M22 的 ADD_RELATION，跨种类校验照旧）。
- **雷达常驻**（0038「按时跑」半边）：主进程周期 watchdog 扫 dueRadars 走 applyResearchRun（单飞锁已共享，撞手动调研自动让位）；托盘菜单补雷达状态（下次到期/立即补跑）；`task:createRadar` 透传 intervalDays（ipc.ts 现硬编码 1）+ 创建 UI 间隔可选。
- **0055 落地**：候选记忆确认卡上 scope 可改（提议给默认，确认时以人选为准）。
- **读路径债（部分）**：operations 表 action 列建索引（schema v7 迁移），`listDeletedSourceRecoveries` 每次双 snapshot 的全扫从 O(n) 降为索引查。双 loadLedger 推后（对齐 0051 后再动）。
红线：不动场景模板/谓词表；watchdog 只跑雷达不碰手动任务入口。

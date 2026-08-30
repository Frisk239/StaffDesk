# M19 → M20 intake

## Verdict

通过。

## Merge state

- `origin/main` 已合入 M19：`8a67007 Merge pull request #12 from Frisk239/codex/m19-task-entries-closeout`
- M19 三个提交（`c8a2149` / `020a715` / `eed9ed0`，含首提遗漏 app/tests 后补交）均为 `origin/main` 祖先；本地 main 已同步。
- 主 CI 绿（merge 后 42s 通过）。

## Regression evidence

- 抽查 `npx vitest run tests/brain/actions.test.ts tests/brain/undo-restart.test.ts tests/main/ipc.test.ts`：3 文件 / 20 测试通过。
- M19.md 声称的交付逐项在合并 diff 中核对：GearMenu/再搜一轮/任务列表页、chat 兜底、HANDLED_CHANNELS、ipc.test.ts、e2e task-entries.spec.ts 均在。

## Debt carried

- 深挖/再搜一轮入口已开，但 runDueRadarCatchup 与 runResearchAndApply 的编排仍两份（catchup 缺单飞锁）——排 M21。
- eval 金标仍是确定性 adapter 必然满分；未编目/撤销/停止用例与低分失败路径缺失；0054 禁写双路未实现（「纠正复发」不可测）——排 M21。
- 脱敏 helper 十份、截断五种取值——排 M21。
- 0053/0054/0055 已裁决未实现的账本语义，随对应功能刀落地。

## M20 slice

M20「拆墙刀」：先落 ADR 0056，把 `Brain.dispatch` 的持久化从「每次全量 DELETE-all/INSERT-all 15 表 + FTS 全量重建」改为按集合引用差异的脏表写入，配等价性回归测试（diff 写与全量重写结果逐表一致）。红线：本刀不新增任何账本功能面。原计划并入 M20 的 eval 升级、编排合一、脱敏收口拆出为 M21 质量刀，避免最高风险改动与杂项混在同一批。

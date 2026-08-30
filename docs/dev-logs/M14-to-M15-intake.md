# M14 -> M15 Intake

裁决：**通过**。

## 合并状态

- M14 功能提交 `4af0e72` 已进入 `origin/main`，合并提交为 `d7ee1fb`。
- M15 从 `origin/main` 新建功能分支 `codex/m15-task-run-control`。

## 验收抽查

- `git merge-base --is-ancestor 4af0e72 origin/main`：通过。
- `npm run typecheck --prefix app`：通过。
- `npx vitest run tests/main/brainBackup.test.ts --coverage.enabled false`：4 个备份恢复单测通过。
- `npx playwright test e2e/brain-backup.spec.ts`：通过；设置页导出/恢复路径仍绿。

## M15 入口观察

- M14 已把大脑备份/恢复边界补齐；数据安全这条线可以先收束。
- 下一处高价值缺口是任务运行态：调研/雷达现在能创建与执行，但用户对运行中任务缺少统一可见、可停止、可回放的控制面。
- M15 应做一条用户可演示路径：从对象页启动调研后，用户能看到任务正在运行、看到过程审计累积、可以停止任务，并能在任务结束后从对象页打开回放。

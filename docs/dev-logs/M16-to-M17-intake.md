# M16 → M17 intake

## Verdict

通过。

## Merge state

- `origin/main` 已合入 M16：`dd56f39 Merge pull request #9 from Frisk239/codex/m16-claim-promotion-flow`
- M16 实现提交 `0e454e2 feat(tasks): add task-scoped claim review` 是 `origin/main` 的祖先。
- M17 工作分支：`codex/m17-persistent-write-queue`

## Regression evidence

- `npm run typecheck --prefix app`：通过
- `cd app && npx vitest run tests/brain/actions.test.ts tests/brain/undo-restart.test.ts --coverage.enabled false`：2 个文件 / 9 个测试通过

## M17 slice

M16 已把任务末未核决策接进 takeover，但 takeover 队列仍是运行时 UI 状态，重启后会消失。M17 让待确认写提议进入业务账本：绑定、晋升、纠正、整理、批量晋升/回退等尚未确认的提议可跨重启恢复，并继续按同一个 `writeId` 确认或拒绝。

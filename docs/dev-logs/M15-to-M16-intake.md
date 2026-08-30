# M15 → M16 intake

## Verdict

通过。

## Merge state

- `origin/main` 已合入 M15：`4be9ed1 Merge pull request #8 from Frisk239/codex/m15-task-run-control`
- M15 实现提交 `f41768b feat(tasks): add task run control and replay` 是 `origin/main` 的祖先。
- M16 工作分支：`codex/m16-claim-promotion-flow`

## Regression evidence

- `npm run typecheck --prefix app`：通过
- `cd app && npx vitest run tests/tasks/engine.test.ts tests/brain/actions.test.ts --coverage.enabled false`：2 个文件 / 8 个测试通过
- `npm run build --prefix app`：通过
- `cd app && npx playwright test e2e/task-run-control.spec.ts`：1 个 e2e 通过

## M16 slice

M15 已经把任务运行、停止、回放做成可见链路。M16 接在这个任务层之后，补 0016 的唯一批量白名单：任务完成后，对“本任务产生的未核主张”提供一次明确决策入口——全部晋升，或全部保持未核。晋升只翻 `unverified`，不改变主张状态、不裁决冲突。

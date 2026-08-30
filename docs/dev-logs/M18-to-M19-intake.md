# M18 → M19 intake

## Verdict

通过。

## Merge state

- `origin/main` 已合入 M18：`ba208e9 Merge pull request #11 from Frisk239/codex/m18-design-decisions`
- M18 的三个提交（`0ef731d` / `3446c4c` / `558e19b`）均为 `origin/main` 祖先；本地 main 已同步。
- 纯文档 + 注释刀：ADR 0052–0055、CONTEXT.md 词条同步、两条过时 TODO 注释处理，无行为变更。

## Regression evidence

- PR #11 分支 CI 双绿（push + pull_request）；合入后 main CI 绿。
- 抽查 `npx vitest run tests/brain/actions.test.ts tests/main/runtimeSecurity.test.ts`：2 文件 / 10 测试通过。
- M18.md 声称的交付（四份 ADR、CONTEXT 五词条、§10 注释删除、§11 注释指向 0055）逐项核对存在。

## Debt carried

- 0053/0054/0055 均为「已裁决、未实现」：归一化互斥、禁写双路、记忆范围卡上可改，实现分别排进整理/记忆相关功能刀。
- 0052 的「整理提议新对象」依赖整理广度刀（合并重复/补关系/标过时同批）。

## M19 slice

M19「任务入口与收口」：把任务层的三个缺失入口补成可见路径（对象页选档位发起深挖、回放页发起再搜一轮、任务列表页浏览历史任务并打开回放），同时偿还主进程侧快赢债（chat:send 失败兜底、IPC fail-closed、chat:delta 死线清理、ipc 行为测试、console.log 与英文 describe 清理）。持久化拆墙与 eval 金标升级排 M20。

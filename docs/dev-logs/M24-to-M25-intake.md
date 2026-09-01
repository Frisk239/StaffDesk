# M24 → M25 intake

## Verdict

通过。

## Merge state

- `origin/main` 已合入 M24（PR #17）与 CI 加固（PR #18）：`c37f847`。
- main 合并 CI 三 job 全绿：check 59s、e2e 2m08s、**package 首跑 6m21s 成功**（NSIS artifact 已上传，AGENTS.md 的 package job 承诺首次兑现）。

## Regression evidence

- e2e job 首跑抓出真实环境耦合：两个抽取类 spec 隐式依赖开发机真实模型配置——修复为自足桩模型（`e2e/stub-model.ts` + 隔离 user-data-dir），任何干净机器成立（d160b87）。
- 本地 main 已同步；18 e2e 全过。

## Debt carried

- 读路径：dispatch 双 loadLedger（对齐 0051 后再动）、syncTable 全表 SELECT、taskAudits 无界、FTS 触发器未接线。
- gh CLI 需挂 7890 代理（keyring 令牌正常，不挂会假性「令牌无效」）——已记入会话记忆。
- 用户 AGENTS.md「开发环境与代理」小节仍为本地未提交编辑，处置待用户定。

## M25 slice

M25「谓词表编辑刀」：补齐受控谓词表的管理面——
- `UPDATE_SLOT`（改名/改单值多值/改场景适用标记）与 `REMOVE_SLOT`（删除）两个 action + 级联纪律（先落 ADR 0057）。
- Settings 谓词表页从只读+添加升级为行内编辑（改名、arity 切换、场景标记勾选、删除确认）。
- 红线：内置场景简报说明（BRIEF_SPECS）引用的槽受保护（改名/删除会破坏内置简报块），待 M26 场景数据化后解除。

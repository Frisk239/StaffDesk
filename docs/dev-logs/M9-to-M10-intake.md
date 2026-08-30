# M9 -> M10 Intake

裁决：**有条件通过**。

## 合并状态

- `origin/main` 已合入 M9 首个实现提交 `54071c5`，merge commit 为 `76ac272`。
- M9 返修提交 `a3a7e6d` 仍停在 `origin/codex/m9-real-ingestion`，尚未进入 `origin/main`。
- M10 应从 M9 返修 tip 继续叠分支，直到人工按顺序合入 M9 返修和 M10。

## 验收抽查

- `npm run typecheck --prefix app` 通过。
- `npm run test --prefix app` 通过：20 个测试文件、86 项测试，行覆盖率 88.15%。
- M9 相关抽样测试实际 12 项通过；单独跑子集时因全局 coverage 门槛低于 80% 退出失败，不代表测试断言失败。
- `git diff --check origin/main...HEAD` 无空白错误。

## 安全与遗留

- 未跟踪的 `test-results/` 是本地 Playwright 运行产物，不应提交。
- 快速密钥扫描只发现测试夹具中的假 key 与 `staffdesk-*` 临时目录命名，不发现生产密钥材料。
- 遗留条件：M9 返修 commit 必须先于或随 M10 合入，避免 main 只停留在未返修的 M9 首版。

# M8 → M9 Intake

裁决：**通过**。

## 合并状态

- M8 提交 `ff4e09a` 已推送到 `origin/codex/m8-trustworthiness-closeout`。
- 该提交尚未进入 `origin/main`；M9 按长程切片节奏从 M8 tip 叠分支开发。

## 验收抽查

- `npm run typecheck`、`npm run lint`、`npm run build` 通过。
- 19 个测试文件、76 项单测通过，覆盖率 87.93%。
- 3 项 Electron E2E 通过：持久化、900px 布局、来源删除与恢复。
- M8 最终 Standards 复核无 P1；抽取并发幂等、隐式选模认证失效、向导可续均已闭环。

## 安全与遗留

- M8 提交未包含 API Key、业务数据库、`.scratch/` 或 Playwright 临时产物。
- 两项 P2 不阻塞 M9：来源删除与恢复日志尚非单事务；认证忠实度尚未逐句验证 span 支持度。
- M9 必须继续遵守：测试夹具只进测试目录或临时 `brain.db`，生产路径不保留 mock/stub fallback。

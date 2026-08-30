# M11 -> M12 Intake

裁决：**通过**。

## 合并状态

- M11 功能提交 `c483df7` 已进入 `origin/main`，合并提交为 `a9097e8`。
- M12 从 `origin/main` 新建 `codex/m12-electron-security`，不叠在旧功能分支上。

## 验收抽查

- `npm run typecheck --prefix app` 通过。
- `npm run eval` 通过：四阶段全部通过，核心质量指标保持 M11 记录中的满分口径。
- M11 新增的全局资格记录、设置页资格卡、测试数据清单与 `AGENTS.md` 均已随合并进入主线。

## M12 入口债务

- `npm audit --prefix app --audit-level=high` 仍未通过：当前 Electron / extract-zip 链路命中 high advisory。
- npm 的自动修复建议会把 Electron 升到 44，属于跨大版本安全升级；M12 必须把依赖升级、native module rebuild、
  Electron E2E、构建和打包风险作为同一条可验收路径处理。

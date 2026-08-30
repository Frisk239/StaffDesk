# M12 -> M13 Intake

裁决：**通过**。

## 合并状态

- M12 功能提交 `299e526` 已进入 `origin/main`，合并提交为 `b09480b`。
- M13 从 `origin/main` 新建 `codex/m13-runtime-security-hardening`，不叠在旧功能分支上。

## 验收抽查

- `npm audit --prefix app --audit-level=high` 通过，0 vulnerabilities。
- `npm run native:check --prefix app` 通过：Electron 44.0.0 / modules 149 / SQLite ok。
- `npm run typecheck --prefix app` 通过。
- `npm run eval` 通过：获取 / 抽取 / 召回 / 出站四阶段全部通过，核心质量指标保持 M11 口径。

## M13 入口债务

- M12 只解决 Electron / extract-zip 安全版本线与 SQLite 原生加载门禁；未改变 BrowserWindow sandbox、外部 URL
  allowlist、窗口权限策略或应用级 runtime security hardening。
- 当前主窗口仍显式 `sandbox: false`，并通过 `setWindowOpenHandler` 对任意新开 URL 直接 `shell.openExternal`。
  M13 需要把这部分收束成可测试、可说明的运行时边界，而不是继续把安全策略留在隐式行为里。

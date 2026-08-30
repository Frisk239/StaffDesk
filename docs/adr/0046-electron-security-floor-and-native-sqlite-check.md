# Electron 安全版本线与 SQLite 原生绑定验收

M11 收尾时 `npm audit --prefix app --audit-level=high` 命中 Electron / extract-zip 高危 advisory。
npm 当前修复目标为 Electron 44。Electron 44 同时把运行时提升到新的 Node / ABI 组合；原来的
`better-sqlite3` 12 需要按 Electron ABI 重新编译，在没有 Visual Studio C++ 工具链的 Windows
开发机上会失败。

StaffDesk 的 M12 安全底线升到 Electron 44 系列。CI 与本地开发使用 Node 22.12+ 或更高版本。只为
消除当前安全债，不顺手把 `electron-vite`、Vite 或 renderer 架构一起升级。

SQLite 绑定改用 `better-sqlite3` 13 系列的 N-API 预构建包。它随包携带各平台 `.node` 文件，Node
与 Electron 都应能加载同一平台预构建，不再把每次 Electron 升级都绑定到本机源码编译工具链。仓库新增
`npm run native:check`，用 Electron 的 `ELECTRON_RUN_AS_NODE` 实际加载 `better-sqlite3` 并写读
内存表；CI 在单测前跑这条检查。`npm run rebuild` 保留为兼容入口并委托到检查；真正需要源码重编时使用
`npm run rebuild:force`，这要求本机已有 C++ 编译工具链。

`electron-builder` 继续负责发布打包，`asarUnpack` 继续包含 `**/*.node` 与
`node_modules/better-sqlite3/**`。打包验收必须至少覆盖 build、Electron E2E 和本机 package 命令；
如果未来 package 过程重新触发源码编译，再单独收窄到 builder 配置处理。

本决策不包含 BrowserWindow sandbox 翻转、外部 URL allowlist、新权限策略或应用级安全硬化。这些属于
运行时安全策略变化，应另开 ADR 与产品验收路径。

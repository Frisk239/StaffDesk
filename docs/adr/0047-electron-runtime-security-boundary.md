# Electron 运行时安全边界

M12 只把 Electron 升到安全版本线，并确认 SQLite 原生绑定能被 Electron 44 加载。升级之后仍有一组
运行时边界没有产品化：主窗口可以在代码层保持非沙箱，外部链接由 `shell.openExternal` 接收任意 URL，
顶层导航、新窗口、权限请求和 IPC sender 的可信边界散落在默认行为里。
本刀参考 Electron 官方 Security checklist，把能被当前产品路径自动验收的边界先收进代码：
https://www.electronjs.org/docs/latest/tutorial/security

StaffDesk 是本机 BYOK 桌面应用，不是浏览器。渲染进程只负责展示本地 UI，并通过 preload 暴露的窄 API
请求主进程办事；它不应该获得 Node 能力，也不应该把窗口带离 StaffDesk 页面。因此主窗口必须启用
`contextIsolation: true`、`nodeIntegration: false`、`sandbox: true`，并显式保持 `webSecurity: true`
与 `allowRunningInsecureContent: false`。

主进程维护一组可测试的 URL 策略：生产态只信任打包后的本地 renderer 入口文件作为应用页面；资源由该
页面正常加载，但不作为可导航或可发 IPC 的页面被信任。开发态只允许 `ELECTRON_RENDERER_URL`
指向的同源页面。顶层导航离开 StaffDesk 页面时一律阻止；其中 `http:` 与
`https:` 链接可以交给系统浏览器，其余协议（如 `file:`、`javascript:`、`data:`、`vbscript:`、`about:`、
`chrome:`）直接拒绝。新窗口永远不创建新的 Electron 窗口，只在 URL 通过同一外链策略时外部打开。

本产品当前不需要嵌入 webview，也不需要 camera、mic、geolocation、notification 等页面权限。任何
`will-attach-webview` 与 session permission request 默认拒绝；未来若引入明确用户路径，必须另开 ADR，
列出权限、触发入口、用户可见说明和 E2E。

所有 privileged IPC handler 必须校验 sender frame 是否来自可信 StaffDesk 页面，再执行读写大脑、读写
密钥、文件选择、导出、调研或模型请求。preload 可以继续暴露 `window.staffdesk` 的稳定 API 名称，但
不能直接把 `ipcRenderer` 暴露给页面。

验收必须覆盖：纯函数测试 URL / sender 判定；Electron E2E 测试危险顶层导航不会改变应用页面，危险
`target=_blank` 不会外部打开或新建窗口，安全 `https:` 外链会交给系统浏览器且应用停留在本地 UI。

本决策不包含 Electron fuses、custom protocol、内容安全策略重写、模型配置变更或账本业务规则变更。

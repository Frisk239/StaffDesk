# 桌面用 Electron；主进程持有大脑和后台循环，渲染进程只做界面

个人 BYOK 参谋台要对齐 Cherry Studio、Claude Desktop：本机窗口、密钥和文件不出机器。Tauri 更轻、Rust 核更适合高安全本地应用，但 StaffDesk 已钉 TypeScript harness，还要拉起本机 Python 的 Agent Reach；Electron 主进程就是 Node，这条集成路径最短。业内把「更好」落在进程分工，而不是换壳：Cherry 规定 Main 持有持久化和 agent 运行时，渲染进程关掉也不丢写入、不中断流。StaffDesk：Electron + 已钉的 React；SQLite 和眼睛/抽取/dream/调研循环放主进程；渲染进程无 Node、只经 IPC 说话。contextIsolation 打开。不上 Tauri，不做成纯浏览器站点。

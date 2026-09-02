# M32 → M33 intake

## Verdict

M32 通过（PR #28 已合 main，5789b26；含 CI 事故修复 6b4978f——剪贴板 stub 化，事故与定位记 M32.md Deviations）。

## Merge state

- `origin/main` = `5789b26`；本地 main 已同步。

## Regression evidence

- M32 两轮门禁同数字全绿：45 文件 / 325 测试 / Lines 92.76% / eval 四阶段 / e2e 34（机械摘取）；修复后 CI 两运行（push + pull_request）均 success。

## M33 slice（恢复与可观测刀，按审计排期原文）

Must：
1. **F2 崩溃/断电防线**：openDatabase 遇损坏库 catch → 引导走 M14 备份恢复（不裸抛白屏）；main 挂 uncaughtException / render-process-gone 兜底 handler（记日志、不静默吞）；「中途杀进程→重开一致」中断一致性测试（WAL + 事务写已俱在，测试补口）。
2. **F3 持久日志**：日志文件滚动落盘（复用 redact 掩码纪律——日志里的请求内容必须先掩码）+ 设置页「导出诊断日志」；不引重型日志框架前先评估手写 fs append vs electron-log（探索者定）。
3. **F7 记忆管理面**：Settings 加记忆节——全局/对象记忆分区浏览、删除（REMOVE_MEMORY 底座已有）、禁写条目展示；纯 UI + 既有 action。
4. **F1 安装器终验**：CI package job 追加静默安装（NSIS `/S`）+ 启动进程断言窗口/brain.db 创建；若 CI 不可行则降级本地终验记录在档。
5. **markdown.tsx 复制修复**（M32 记账的新债）：CodeBlock 复制按钮改走 trusted clipboard IPC（同 brief:copy 姿势）。

红线：安全红线不破（日志掩码、密钥不入盘）；不动已裁决 ADR；F6 规模基线与 D2 拆分留 M34；D4 operations 保留策略本刀 intake 时盘问出 ADR（0063），实现看刀厚薄（可滑 M34）。

流程：探索者先行 → 单执行者（或按面拆二）→ Owner 门禁 + 双轴评审 + 整改 → 关刀。

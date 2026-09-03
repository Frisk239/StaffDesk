# M35 → M36 intake

## Verdict

M35 审计刀通过（PR #31 热修 + PR #32 审计文档均已合 main，05bb169）。

## Merge state

- `origin/main` = `05bb169`；本地已同步；两分支已清。
- **F1 落点钉死（#31 合并首跑诊断）**：真实安装目录 `Programs\staffdesk-app\`（package name 而非 productName）；userData 同理在 `%APPDATA%\staffdesk-app\`——brain.db 断言挂点顺移；exe 探测+启动+进程断言已过。
- **e2e 鬼魅三连变挂点**：brief-export 在 chip 落稳（默认 5s）/复制/导出三步先后闪挂——同根因=慢 runner 上异步链偶发超默认窗口；#32 重跑绿证明非确定性。
- main 连三红（#29/#30/#31 合并运行各剩一挂点）——本刀要恢复常绿。

## Regression evidence

- M35 审计基准门禁全绿：51 文件 / 359 测试 / Lines 92.82% / eval 四阶段 / e2e 38（机械摘取）。

## M36 slice（收尾面刀，审计五轮排期 + 新诊断）

Must：
1. **G1 README**：根目录中文 README——一句话定位 / 快速跑起来（前置、命令、BYOK 配置）/ 架构一图 / 质量数字 / 精选 10 份 ADR / docs 导览；GitHub description/topics 由用户侧补。
2. **G2 Release 链路**：package job 追加 tag 触发的 gh release 上传（permissions: contents: write）；收尾打 `v0.2.0`；README 挂 Releases 链接。
3. **G3 LICENSE**：MIT（2026, Frisk239）。
4. **G5 badge + dependabot**：README 顶部 CI badge；`.github/dependabot.yml`（npm + github-actions，weekly）。
5. **顺刀修复（审计 P2-1/E2/P3-1 + 新诊断）**：
   - P2-1：persist.ts 排序键 SQL 别名（`created_at AS createdAt`）+ 测试盲区（临时库构造 id 序与时间序分歧的行，断言按时间裁）；
   - E2：删 sourceActions fromUrl 死分支、objectChatActions SET_VIEW 自赋值；
   - 导出失败反馈：BriefView exportMarkdown 加 catch → TOAST「导出失败」（静默吞是健壮性缺口，M35 期间两度目击）；
   - P3-1：CONTEXT「简报」词条补主键来源标注与出站导出；
   - e2e 抗慢：brief-export 的 chip 落稳与主键标注断言放宽 15s；
   - **CI smoke brain.db 断言改探测双候选**（`%APPDATA%\StaffDesk` 与 `%APPDATA%\staffdesk-app`——真实落点后者）；注释记录 package name/productName 命名错位（产品侧改名会迁移用户数据，暂不动，记档）。

红线：不重开已裁决 ADR；README 数字全部从命令输出/审计档案机械摘取；产品行为变更仅限「导出失败反馈」（加法）；不动 userData 路径命名。

流程：审计五轮即勘察（M28 先例）→ Owner 直接实现（文档主导 + 定位明确的小修）→ 全量门禁 → 双轴评审 → 关刀。

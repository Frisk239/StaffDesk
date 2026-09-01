# 审计刀 → M27 intake

## Verdict

通过。

## Merge state

- `origin/main` = `61db3f0`（PR #19 M25 + PR #20 M26 已合入）；PR #21（审计刀）因基座叠加合入 M26 分支（`e8d4a73`），审计文档由本刀 cherry-pick 带回 main 线。
- main 抽查：scenario-template / slot-edit 23 测试通过。

## Regression evidence

- 审计刀 Owner 门禁（基准树 = M26 合并树同体）：37 文件 242 测试、eval 4 阶段、21 e2e、build 全绿（docs/audit-2026-09-01.md 第五节，机械摘取）。

## M27 slice（收尾刀，按审计排期）

Must 按序：
1. **F1-F5 修复头班车**：F1 删模板清 slot_defs.scenarios 悬挂（0058 补记删除级联口径）；F2 CONFIRM_WRITE 回退分支补 slotIsControlled + 级联撤/改写挂起 write_queue 整理行；F3 Settings Esc 双关；F4 persist-diff 补 scenario_templates 与新动作剧本；F5 e2e 隔离 user-data-dir 三处。
2. **AI 提议起草场景**（场景词条最后半块）：chat 意图 → 模型起草 → takeover「起草场景模板」卡（名/引导/说明书/简报块）→ 人确认 UPSERT_SCENARIO_TEMPLATE；新槽按 0025 只能引用受控表现有槽，人确认。
3. **资格收口**：Onboarding 步 2 进入即自动起跑（保留「稍后检查」=可跳过，0041 口径）；未认证徽章进 Chrome 顶栏（点击进设置），兑现「持续可见」。
4. **任务列表打磨 + 失败重跑**：种类/状态筛选、进行中置顶、雷达行显示 nextDueAt、失败/已停止任务行「再搜一轮」入口（带上轮语境）。
5. **关系面板搜索**：候选列表过滤 input。
6. **G8/G9**：候选记忆词条修订（每轮即抽，改词条一行对齐实现与 ADR 0022 补记）；eval 版本守护测试（floored 指标与政策版本对应有闸）。
范围裁决：费用维度（usage 回传 vs 调用次数近似）若当刀设计定不下则整块滑 M28（审计已预授权）。红线：AI 起草不走 grill（词条已定语义：draft 走 takeover、新槽人确认）；不动读路径债（M28 专属）。

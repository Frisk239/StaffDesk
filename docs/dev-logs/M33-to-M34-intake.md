# M33 → M34 intake

## Verdict

M33 通过（PR #29 已合 main，0bbc9b3；含三笔 CI 事故修复——check 单测纯 Node 化 / 错误框抑制 / 简报 chip 落稳，复盘在 M33.md）。

## Merge state

- `origin/main` = `0bbc9b3`；本地已同步；M33 分支已清。

## Regression evidence

- M33 门禁全绿（46 文件 / 338 测试 / Lines 92.67% / eval 四阶段 / e2e 37）+ CI 三运行终绿（机械摘取）。

## M34 slice（结构与护栏刀，审计四轮排期收尾刀）

Must：
1. **D2 拆 applyAction**：3289 行 / 80 case 单 switch 按域拆 reducer（建议面：来源/槽与模板/write_queue/任务与其余），**纯搬运不改行为**——dispatch-read seam 与既有等价/行为测试做护栏；拆完 applyAction.ts 只剩分发壳。连续三轮审计 P1 全落此文件，拆完后续修复面变窄。
2. **0063 operations 裁剪实现**（ADR 已落档）：纯函数（全局行数上限裁 (created_at, id) 最旧，豁免 {DELETE_SOURCE、纠正类、主键角色变更} 永不裁）+ dispatch 在 operations 引用变化时先裁再落库（对齐 taskAudits 纪律）；配套 listDeletedSourceRecoveries 走 operations(action) 索引收敛全扫。
3. **F5/D3 renderer 行为测试首批 + chat 失败 e2e**：Settings 记忆节/谓词表交互、ChatPane 失败 TOAST 与 busy 禁发态——补齐测试金字塔中层；chat 兜底有单测无 e2e，补一条。
4. **F6 规模基线进 CI**：5k claims 下 snapshot+dispatch 计时测试（阈值宽松防环境抖动，超线红），让全量广播的规模成本可观测、未来增量化有基线。
5. **D6 e2e 时长恢复记录**：closeout 恢复机械摘取 e2e 总时长趋势（本刀起连续记录）。

红线：D2 是纯搬运刀——不改任何 case 行为、不改导出面；若搬运中发现行为疑点停下报告，不顺手修；不动已裁决 ADR；下次审计 ~M36（本刀后第五刀到期）。

流程：探索者先行（applyAction 80 case 域分组清单 + operations/恢复查询现状 + renderer 测试基建现状）→ 实现者两批（第一批 0063+F5/F6/D6，第二批 D2 拆分——两批都可能碰 brain/index.ts，串行防冲突）→ Owner 门禁 + 双轴评审 + 整改 → 关刀。

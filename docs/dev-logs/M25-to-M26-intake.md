# M25 → M26 intake

## Verdict

通过（叠加态：PR #19 OPEN、CI 双绿未合并，M26 从 `codex/m25-slot-table-editing` 上叠，#19 合入后自动收敛）。

## Merge state

- origin/main 停在 `c37f847`（CI 加固）；M25 三提交在 `codex/m25-slot-table-editing`，PR #19 CI 双绿。
- Owner 已亲跑 M25 全门禁（36 文件 226 测试、覆盖 91.4%、eval 四阶段、19 e2e）。

## Debt carried

- M25 的 20 谓词保护与 brief.ts:63 双源漂移由本刀解除（见 ADR 0058）。
- 读路径债、taskAudits 无界、FTS 触发器不变。

## M26 slice

M26「场景四件套」——场景从五值枚举变为数据（ADR 0058 先行）：
- **数据层**：schema v8——新建 scenario_templates 表（name 主键、builtin 标记、hint 建对象引导、playbook 说明书、brief_spec 简报说明块 JSON）；重建 workspaces 去掉 scenario 枚举 CHECK；种子内置四模板 + '自定义' 空白基线（首启标记门）；旧 scenario_brief_specs 死表退役。
- **消费收口**：buildBrief 与 session 说明书注入改走 state（BRIEF_SPECS / DEFAULT_PLAYBOOK 常量降级为种子源）；M25 的 briefSpecPredicates 改查 state。
- **保护解除改级联改写**：UPDATE_SLOT 改名同步重写各模板 brief_spec 的谓词名；REMOVE_SLOT 从块中移除谓词，slots 块谓词清空则整块撤下——内置谓词的改名/删除保护解除。
- **模板 CRUD + UI**：UPSERT/REMOVE 模板 action（删除被工作区引用则拒）；设置页场景模板管理区与编辑器（hint / playbook / 简报块）；建对象表单 placeholder 按场景差异化（修 scenario.ts:4 注释漂移）。
- **范围裁决**：AI 提议起草场景顺延后刀（先有 CRUD 地基； CONTEXT 承诺不丢，记入 debt）。
红线：不动账本语义/任务/雷达；模板编辑不进撤销卡（对齐 0057 口径）。

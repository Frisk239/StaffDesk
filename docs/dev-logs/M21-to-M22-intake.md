# M21 → M22 intake

## Verdict

通过（叠加态：PR #14 尚未合并，M22 从 `codex/m21-quality-knife` 分支上叠，待 #14 合入后 PR 自动收敛为 M22 增量）。

## Merge state

- PR #14 OPEN、CI 双绿；origin/main 停在 M20（`2b58397`）。
- M21 三个提交（`819851d` / `dfb48aa` / `f3633ea`）在 `codex/m21-quality-knife`。

## Regression evidence

- 本会话在 M21 分支亲跑全套门禁：typecheck/lint 清、29 文件 136 测试、`npm run eval` 四阶段 12 指标、14 e2e 全绿。
- 第二轮三路审计（设计符合性/技术债/功能缺口）逐条对账：M18–M21 dev-log 声明无一虚报；ADR 0052/0056 落地、0053/0054/0055 诚实标注未实现；领域红线零泄漏。

## Debt carried（审计二审结论）

- **bug 级**：applyResearchRun 锁泄漏窗口（set :55 / try :66 之间 dispatch 抛错 → 对象永久 busy）；恢复路径 stale-brain 不让位；抽取尾段无停止检查点；编排零专测——M22 头班车修复。
- eval 闸不变量无守卫（第 13 个指标会静默不设闸）——M22 头班车补测试。
- 读路径风暴（dispatch 双 loadLedger + operations 无索引 + syncTable 全表 SELECT，已挂调研热路径）——不晚于 M24 拆。
- taskAudits 无界、FTS 触发器未接线、renderer 零行为测试、chat 兜底无 e2e、策略常量散落——后续刀。

## M22 slice

M22「关系刀」：①头班车修 applyResearchRun 锁泄漏（set 入 try、dispatch 全走 live() 现取、抽取尾段 checkpoint）+ 首个编排专测（busy/throw/restore 三路径）+ eval 闸不变量测试；②关系本体：ADD_RELATION / REMOVE_RELATION（裸边无标签——CONTEXT 词条按对象种类对定义边；仅允许 人↔组织、项目↔组织、人↔项目 三种跨种类边，同种类拒绝）+ 对象页档案区关系展示与跳转 + `recall_claims` 关系一跳（关联对象主张须标明来源对象，未绑定来源仍不进语境）+ 对象 note 写入搭车。依赖：0052（对象已全人确认）、M20（object_relations 持久化环已通）。红线：不动场景/整理/雷达。

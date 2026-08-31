# M22 → M23 intake

## Verdict

通过。

## Merge state

- `origin/main` 已合入 M21 与 M22：`488948a Merge pull request #15 from Frisk239/codex/m22-relations`；M21（PR #14）与 M22（PR #15）全部提交均为祖先。本地 main 已同步。
- 主 CI 在远端页面确认（本地 gh API 通道不可用，令牌问题由用户搁置：后续 PR 由用户手动开合，Owner 出 compare 链接）。

## Regression evidence

- M22 分支树与合并树同体：Owner 已亲跑全套门禁（typecheck/lint/native/build、32 文件 163 测试、eval 四阶段、16 e2e）。
- main 上冒烟：relations/applyResearchRun/persist-diff 三文件 20 测试通过。

## Debt carried

- 关系添加面板无搜索过滤、召回一跳无 e2e（单测已钉）——随收尾刀。
- 读路径债（dispatch 双 loadLedger + operations 无索引 + syncTable 全表 SELECT）——不晚于雷达常驻刀。
- taskAudits 无界、FTS 触发器未接线、renderer 零行为测试。

## M23 slice

M23「整理广度」第一段（三份裁决的落地刀，最重一块按审计建议拆两段）：
- **0053 归一化互斥**：新增 normalizeValue（大小写/空白/全半角），deriveConflicts 改为归一化取值差判互斥——「北京 vs 北京 」不再假冲突。
- **0054 禁写双路**：Memory 增结构化列（对象、谓词槽、归一化取值；schema 迁移），纠正写入双路落库；bannedHit 与提议生成闸口改双路拦截；金标「纠正复发」升级为双路断言；outbound 政策版本升 v3。
- **tidy 三提议器**：合并重复主张（复用 normalizeValue：同对象同槽归一化值相同 → 提议合并）、标可能过时（有效期窗口已过但仍成立 → 提议关窗）、未编目编目（未编目主张 → 提议卡人选拖槽并入）。
- 挂接点沿用抽取收尾的 tidy 钩子（不挡进料）；建新对象提议（0052）与补关系提议挪后刀（与雷达常驻刀同批），0055 scope 卡上可改随后刀。
红线：不动场景/雷达/谓词表；抽取入账仍不拦禁写（0054 裁决）。

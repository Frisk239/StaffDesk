# 场景是数据行，内置与自定义同构

场景至今是五值枚举（ScenarioKind），被 workspaces 与 slot_defs 的 SQL CHECK 锁死；简报说明（BRIEF_SPECS）与说明书（DEFAULT_PLAYBOOK）是代码常量，而库里那张 scenario_brief_specs 表从未被运行时读过——常量与数据双源漂移，自定义模板无从谈起，M25 只能用「禁改禁删」保护被常量引用的二十个谓词。

场景升为数据行：新表 `scenario_templates`（name 主键、builtin 标记、hint 建对象引导、playbook 说明书全文、brief_spec 简报说明块 JSON）。内置四模板（求职面试、求学申请、技术选型、尽调研究）与「自定义」空白基线由首启种子写入（0057 的标记门）；自定义模板与内置同表同构，可建可改可删（builtin 标记只保护身份来源，不阻止编辑内容）。工作区引用模板名，schema v8 重建 workspaces 去掉枚举 CHECK；槽的 scenarios 数组存模板名。

**双源收口**：buildBrief 与会话说明书注入改从 state 读模板；BRIEF_SPECS 与 DEFAULT_PLAYBOOK 常量降级为种子源，旧 scenario_brief_specs 死表退役。**保护解除改级联改写**：谓词改名同步重写各模板 brief_spec 里的谓词名；删除谓词从块中移除，slots 块谓词清空则整块撤下并 toast 说明——内置谓词由此恢复可改可删（M25 保护的本意是防常量失配，数据化后失配不复存在）。

模板编辑是人手设置动作：UPSERT / REMOVE 直接改账本，不进撤销卡（对齐 0057 口径），operations 留痕；删除被工作区引用的模板一律拒绝（先移除或改区再删）。模板的 brief_spec 只能引用受控谓词表内既有的槽名（不许自开槽，0025）；建对象引导（hint）与说明书（playbook）是纯文本，人维护。AI 提议起草场景随后刀落地：先有 CRUD 地基，起草才有处可落；起草走 takeover、新槽按谓词规矩人确认的词条口径不变。

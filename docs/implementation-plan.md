# StaffDesk 实施计划：Electron + SQLite 真链（开发阶段总纲）

> 状态：已批准（2026-08-29）。本文是开发阶段的**执行总纲**，写给负责实现的会话/工程师。
> 设计已封版：41 个 ADR + `CONTEXT.md` 术语表 + `prototype/` 已验证的 UI 形态。实现不再改设计；发现设计矛盾时停下来问用户，不要自行裁决。

---

## 0. 必读材料与阅读顺序

开工前按顺序通读（全部在本仓库内）：

1. `CONTEXT.md` —— 术语表，**最高权威**。所有命名、界面文案、注释用语以此为准。
2. `docs/engineering.md` —— **工程规范**：git 纪律、lint/类型规范、测试分层要求与覆盖率门槛、CI、本地钩子。M0 起生效，全程约束。
3. `docs/prototype.md` —— 原型主稿：形态、主链、内存状态模型、账本规则 8 条、验收清单。
4. `docs/adr/0001–0041` —— 全部架构决策。重点关注：0020（BYOK+SQLite）、0021/0028（工具三层与写提议）、0022–0025（记忆/抽取循环/谓词表）、0029–0033（冲突/状态/来源/删除/场景）、0034–0041（撤销/任务/BYOK/首启）。
5. `docs/audit-2026-08-28.md` —— 三路审计报告（了解每个设计的 why）。
6. `prototype/` —— UI 形态以这里**正在跑的界面为准**（0026）。组件迁移的参照物。

硬性边界：**不修改** `prototype/`、`docs/adr/`、`CONTEXT.md`（发现真实矛盾 → 停下问用户）。新决策走新 ADR（从 0042 编号）。

---

## 1. 已确认的决策

| 决策点 | 裁决 |
|---|---|
| LLM 协议 | 第一版只做 **chat-completions**（DeepSeek/OpenAI/国内中转全兼容）；anthropic-messages、responses 后续小迭代补 |
| 交付节奏 | **分批交付逐批验收**：每批完成停下，用户亲手验收通过才进下一批 |
| 工程纪律 | `docs/engineering.md` 全程约束；**M0 批次先搭工具链**（lint/测试门槛/CI/git 钩子），业务代码从 M1 起 |
| 技术栈 | Electron + electron-vite + electron-builder；better-sqlite3；React 19 + TypeScript（严格模式）；LLM 客户端自写（fetch 封装） |
| 框架禁区 | 不引入 LangChain / LlamaIndex / dsh 等运行时框架；dsh 只借鉴形态 |
| 产出位置 | `app/`（新目录）；`prototype/` 保留不动 |

## 2. 项目结构

```
app/
  package.json / electron.vite.config.ts / electron-builder.yml / tsconfig
  src/
    main/                  # 0023：大脑与循环都在主进程
      brain/               # SQLite：schema.sql、migrate、访问层（领域规则全在这，纯函数可测）
      llm/                 # chat-completions 客户端 + 结构化输出（JSON mode + zod 校验 + 有限重试）
      loops/               # 主会话循环、主张抽取循环(0024)、记忆抽取循环(0022)、dream
      tasks/               # 任务引擎：调研循环+硬顶(0009)、雷达(0038)、回放+任务审计(0008)
      adapters/            # Agent-Reach 适配层(0019)：搜 / 打开 / 体检 三个规范化工具
      tray.ts              # 0038：叉→托盘、单击唤起、右键退出
      keychain.ts          # 0040：safeStorage，密钥永不进 SQLite
      ipc.ts               # typed IPC 注册
    preload/               # contextBridge 暴露 typed API
    renderer/              # 原型组件迁移 + IPC 桥 store
      src/components/…     # 从 prototype/src 迁移，props 结构不变
      src/store.tsx        # 内存 reducer 改写为 IPC 桥
  tests/                   # vitest（brain 层单测）
```

## 3. SQLite Schema（字段级）

数据库单文件（0020），表按 CONTEXT.md 领域模型原创设计。**conflicts 不建表**（0029：派生关系，关窗/删除后自动消失）。密钥不落库（0040）。

```sql
-- 壳层
workspaces(id TEXT PK, name TEXT, scenario TEXT CHECK(求职面试|求学申请|技术选型|尽调研究|自定义), created_at TEXT)
objects(id TEXT PK, kind TEXT CHECK(人|组织|项目), name TEXT, note TEXT, workspace_id TEXT,
        archived INT DEFAULT 0, created_at TEXT)
object_relations(from_id TEXT, to_id TEXT)                      -- 0017：人↔组织、项目↔组织、人↔项目

-- 来源与绑定（0031：解绑=删 source_bindings 行；删除来源=级联关窗其主张）
sources(id TEXT PK, title TEXT, body TEXT, path TEXT CHECK(手给|调研),
        role TEXT CHECK(主键|转述), workspace_id TEXT, unparsed INT DEFAULT 0, created_at TEXT)
source_bindings(source_id TEXT, object_id TEXT)                 -- 多对多；'user-stmt' 虚拟来源不进此表

-- 受控谓词表（0025/0033）：首启按场景预设包预置，设置页可加槽
slot_defs(id TEXT PK, name TEXT, kind TEXT, arity TEXT CHECK(单值|多值),
          scenarios TEXT /*JSON 数组，空=通用槽*/, created_at TEXT, UNIQUE(name, kind))

-- 主张账本（0029/0030/0031/0032）
claims(id TEXT PK, object_id TEXT, predicate TEXT /*槽名或'未编目'*/, text TEXT,
       status TEXT CHECK(成立|过时), unverified INT DEFAULT 1,
       valid_from TEXT, valid_to TEXT,
       close_reason TEXT CHECK(世界已变|从未成立|来源删除|对象误建),
       source_id TEXT /*'user-stmt'=使用者陈述*/, span TEXT, superseded_by TEXT, created_at TEXT)
-- 冲突派生查询（0029）：同 object_id + 同 predicate(仅 arity=单值 的槽) + 双方 status='成立'
--                + 有效期重叠（COALESCE(valid_from,'') 区间比较）+ text 不同。写成 brain 层纯函数 + 单测。

-- 记忆（0022）：偏好/禁写/习惯与业务事实分库
memories(id TEXT PK, scope TEXT CHECK(全局|对象|会话), object_id TEXT,
         kind TEXT CHECK(偏好|禁写|习惯), text TEXT, created_at TEXT)

-- 提议（待确认页两段 + 0037 丢弃未核）
proposals(id TEXT PK, type TEXT CHECK(整理|候选记忆), payload TEXT /*JSON 可辨识联合*/,
          pending INT, decision TEXT, created_at TEXT)

-- 任务（0036 四态 + 0009 预算档 + 0008 审计）
tasks(id TEXT PK, object_id TEXT, kind TEXT CHECK(调研|出简报|再搜一轮|周期性雷达),
      status TEXT CHECK(待启动|进行中|已完成|已停止), stop_reason TEXT CHECK(手动|触顶|失败),
      budget_gear TEXT CHECK(快搜|深挖), created_at TEXT, finished_at TEXT)
task_audit(task_id TEXT, seq INT, kind TEXT /*搜索|打开|失败|触顶|停止*/, payload TEXT /*JSON*/, ts TEXT)

-- 出站物
briefs(id TEXT PK, object_id TEXT, task_id TEXT, blocks TEXT /*JSON：每句带 claimIds+unverified*/, created_at TEXT)

-- 操作日志（0034 一表三用：审计链/整理留痕/补偿写）。append-only，一切账本写动作都追加一行。
operations(id TEXT PK, action TEXT, payload TEXT /*JSON*/, undo_of TEXT /*被补偿的操作 id*/,
           chat_ref TEXT /*结果卡定位*/, created_at TEXT)

-- 评测认证（0039）
certs(id TEXT PK, provider_id TEXT, model_id TEXT, scores TEXT /*JSON：recall/faithful/unknown/fabrication*/,
      created_at TEXT)

-- 会话持久化（原型的 chatByObject 落库；刷新/重启不丢——这是与原型的本质区别）
chat_messages(id TEXT PK, object_id TEXT, role TEXT CHECK(user|desk|card), text TEXT,
              claim_refs TEXT /*JSON*/, card TEXT /*JSON，可空*/, created_at TEXT)

-- 召回（FTS5 先行；中文注意：unicode61 按字切分对中文可用，trigram tokenizer 备选，M2 实测定一种）
claims_fts USING fts5(text, object_id UNINDEXED, predicate UNINDEXED)
```

迁移机制：`brain/migrate.ts` + `schema_migrations(version)` 表，从 M1 起就有，禁止裸改历史 schema。

## 4. IPC 与渲染层

- **invoke 通道按领域分组**：`brain:*`（查询/写入）、`chat:*`（发送/历史）、`task:*`（启动/停止/回放）、`settings:*`（供应商/自检）、`undo:*`（补偿写）。
- **事件回推**：`state:changed`（账本变更摘要）、`chat:delta`（流式）、`task:progress`（回放步骤）、`cert:done`。渲染层 store 订阅刷新。
- **渲染层纪律**：IPC 层保持薄；账本规则（冲突派生、出站过滤、补偿写语义）全部在主进程 brain 层，渲染层只做展示与发起。
- **迁移策略**：prototype/src 组件整体拷入 renderer，然后逐组件把 `dispatch(Action)` 换成 IPC 调用；原型 `store.tsx` 的注释（账本规则 1–8）逐条变成 brain 层单测。

## 5. 里程碑（五批次，每批停下等用户验收）

### 批次零：M0 工程基座（纪律先行，不写业务代码）

规范细则见 `docs/engineering.md`，本批把它们全部搭成可执行的现实：

1. **仓库基线**：把当前未提交的设计产出（ADR 0026–0041、CONTEXT 修订、原型三轮改造、docs/）整体提交（Conventional Commits：`docs: …`），作为干净起点。
2. **app/ 脚手架**：electron-vite 工程模板（main/preload/renderer 三层 + `src/shared/` 类型区），根 `package.json` 聚合脚本（dev/build/lint/typecheck/test/e2e/package）。
3. **规范工具链**：ESLint（strictTypeChecked + react + import 边界限制）+ Prettier + tsconfig strict 全开 + husky（pre-commit：lint-staged + tsc --noEmit；commit-msg：commitlint）。
4. **测试基座**：vitest + coverage 配置（brain 层 80% 门槛先配好，测试随 M1 起写）；第一条烟雾测试（把原型 `scenario.ts` 的 `deriveConflicts` 搬进 `app/src/main/brain/` 并测正反例——同时验证纯函数迁移路径）。
5. **CI**：`.github/workflows/ci.yml`（lint → typecheck → test+coverage → build，详见 engineering.md §4），推分支验证一次全绿。
6. `.gitignore` 补齐（app/data/*.db、*.log、.env* 等）。

**验收 = 钩子真实生效**（故意提交违规 commit 被 lint/commitlint 拦下）、**CI 在 GitHub 上全绿**、`npm run lint / typecheck / test / build` 四绿。

### 批次一：M1 骨架 + M2 对话真连
- **M1**：electron-vite 工程、SQLite 建表+迁移、原型 UI 全量迁移、store 改 IPC 桥、首启建库（预置场景预设包：四个内置场景的槽表+简报说明，数据从 `prototype/src/scenario.ts` 迁移）。真链**不预置虚构种子数据**，验收时用户自己建对象丢材料。
  **验收 = 原型全部交互在真库重现；重启应用状态不丢。** better-sqlite3 × Electron ABI（electron-rebuild）在本批打通。
- **M2**：chat-completions 客户端（BYOK，流式）、设置自检 1–2 级真连（连通：免费；能力探测：微型结构化请求）、主会话循环（说明书开场 + FTS 召回 + 带引用回复 + **只问不写**）、0028 只读工具组（召回主张/读来源片段/列冲突/读简报/查空槽）。
  **验收 = 配真实 DeepSeek key 对话，回复引用能点回主张；闲聊后主张数为零。**

### 批次二：M3 抽取循环 + M4 调研任务
- **M3**：绑定确认 → 主张抽取循环真跑（0024：结构化输出映射受控槽、映射不上记未编目、幂等键=(来源片段,对象,谓词槽) 去重、默认未核入库）、投影真数据、场景槽表过滤（0033）。
- **M4**：Agent-Reach 适配层（**开工首验本机 agent-reach / mcporter 可用性**——搜索走 `mcporter call exa.web_search_exa`，打开走 web-reader / `r.jina.ai`，体检走 `agent-reach doctor --json`；不可用则设置页引导安装+降级）+ 任务引擎（快搜/深挖两档硬顶 0009、触顶入库纪律：已打开的照写未核、其余未知、失败 URL 记审计）+ 回放页 + 任务审计。
  **验收 = 丢真 URL→绑定→抽出真主张；开快搜任务→真检索→未核入库→回放可见每步与失败 URL。**

### 批次三：M5 出站与撤销 + M6 评测认证
- **M5**：简报生成（LLM 按场景简报说明出块、每句 claimIds 引用核对、未知占位、无出处不出站）、按条/批量晋升（0016：任务末批量卡是唯一批量白名单）、纠正（0037：未核=丢弃不写禁写；已晋升=关窗+禁写）、**操作日志+补偿写全路径**（0034/0035：结果卡撤销、批量回退 takeover、禁写移除；不可补偿清单=永久删除对象/移除工作区）、整理提议（含丢弃未核）。
- **M6**：内置虚构金标包（面试/求学/选型三包，虚构对象来源）、三级自检第 3 级真跑、编造率唯一红线（5%，警告不阻断）、指标卡。
  **验收 = 简报每句可点回出处；撤销全路径在真库重现（含重启后再撤）；认证跑分出数字。**

### 批次四：M7 桌面形态 + 打磨
- 托盘（0038：叉→托盘+首次提示、单击唤起、右键退出；雷达补跑只补最新一次）、首启向导五步（0041）、safeStorage 密钥（0040）、导出大脑 zip（不含密钥）、electron-builder 出安装包。
  **验收 = 安装包在全新目录跑通全链；托盘行为正确；雷达补跑有「迟跑」标记。**

## 6. 执行红线（每个批次都适用）

0. **工程规范全程约束**（`docs/engineering.md`）：Conventional Commits、main 常绿（CI 过才合）、brain 层测试覆盖 ≥ 80%、renderer 不许 import main、新决策先落 ADR。

1. 界面中文；不出现 Graphiti/Mem0/dream/LightRAG 等内部名当功能名。
2. 账本规则在主进程纯函数实现 + vitest 锁死：闲聊不写主张；未绑定不投影不进语境；绑定须人确认；「记下来」立刻写；纠正立刻关窗（未核则丢弃）；未编目不建冲突；简报无 claimId 的句子不准生成；未知格子不编造。
3. 写操作一律走操作日志；模型只能提议（0028），不可逆操作不给模型工具。
4. 不做原型「不做」清单之外的事，也不偷做后续里程碑的功能（每批聚焦）。
5. 每批收尾：单测绿 + 手动主链走查 + 冒烟截图，然后**停下交用户验收**，不要自行进入下一批。

## 7. 风险与对策

- **agent-reach 本机可用性未验证**：M4 首验；不可用 → 设置页引导安装（用户手动跑 install）、适配层降级；金标认证不依赖检索，不受影响。
- **better-sqlite3 × Electron ABI**：M1 就用 electron-builder 真打包验证，不拖到 M7。
- **LLM 结构化输出不稳**：JSON mode + zod 校验 + 有限重试（3 次）；失败的片段留未编目或丢弃，不硬写。
- **中文 FTS 质量**：M2 实测 unicode61 vs trigram，选型记入 ADR。
- **reducer→IPC 回归**：原型 8 条账本纪律全部单测化；组件迁移逐个走查原验收清单（prototype.md 验收 1–18）。

## 8. 验收流程（每批）

1. 实现会话自测：单测绿 + 主链走查 + 截图留证（放 `docs/dev-logs/` 或验收会话指定位置）。
2. 输出一份简短验收说明：做了什么、验收步骤、已知问题。
3. 用户亲手验收通过 → 下一批；不通过 → 修复后重交。

---

M0–M7 完成后的后续路线见 [`implementation-plan-phase-2.md`](./implementation-plan-phase-2.md)。

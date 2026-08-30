# AGENTS.md — StaffDesk

带主张账本的个人参谋台：Electron + React 19 + better-sqlite3 本机桌面应用（BYOK、大脑文件留本机）。单人简历项目，非商业产品。

## 必读文档（动手前先看）

- `CONTEXT.md` — 领域语言（词条 + 每条的 Avoid 列表）。**与其他一切文档冲突时以它为准**；UI 文案与术语逐字对齐词条。「Current implementation」一节是最新进度（M1–M17 已完成）。
- `docs/engineering.md` — 工程规范全文（Git / 代码 / 测试 / CI / 安全）。
- `docs/adr/` — 0001–0051 架构决策。新决策**先落 ADR（0052 起顺延）再写代码**；发现设计矛盾停下问用户，禁止口头裁决。
- `docs/dev-logs/` — 各里程碑验收记录；新批次完成要写对应的 MX.md。
- `docs/reference.md` — `reference/` 对照仓索引与产品边界。

## 目录与边界

- `app/` — 成品（electron-vite 三层）：`src/main`（brain 领域规则 / llm / adapters / loops / tasks / ingestion / eval / tray）、`src/preload`、`src/renderer`、`src/shared`（三层共享类型）。
- `prototype/` — 一次性纯前端原型，**已冻结，不再修改**。
- `reference/` — 本机只读对照克隆（gbrain、graphiti、Agent-Reach、mem0 等）：只参考思想，不 vendor 代码、不把对方产品名/模块/数据模型搬进 `src/`。
- `docs/` — ADR、规范、dev-log、对照仓索引。

## 常用命令（根目录聚合到 `app/`）

```bash
npm run dev         # electron-vite 开发
npm run lint        # eslint
npm run typecheck   # tsc -b（全部 tsconfig）
npm run test        # vitest run --coverage
npm run eval        # 内置虚构金标质量回归
npm run e2e         # Playwright 驱动 Electron，交付前必跑
npm run package     # electron-builder 打 Windows 安装包
npm run native:check # Electron 运行时加载 better-sqlite3 烟测
npm run rebuild     # 兼容入口：同 native:check
npm run rebuild:force # 有 C++ 工具链时强制源码重编 better-sqlite3
```

- 覆盖率硬门槛：`src/main/brain/**` 行覆盖 ≥ 80%（`app/vitest.config.ts`），不达标 CI 即红。
- CI（`.github/workflows/ci.yml`）：check job（ubuntu）跑 native:check/lint/typecheck/test/build；package job（windows）仅 main/tag。better-sqlite3 13 走 N-API prebuild，不要求常规重编译。
- 路径别名：`@shared` → `app/src/shared`。

## 架构规则（ESLint 强制）

- renderer 不得 import main 内部模块，main 不得 import renderer；跨层只走 preload 暴露的 API 与 `src/shared` 类型。
- brain 层规则（账本纪律、冲突派生 0029、补偿写 0034、简报出站、抽取幂等键）写成纯函数：SQLite 查询结果 → 纯函数 → 断言；数据库只在集成烟雾测试里碰。
- 抽取必须映射受控谓词表（0025）；映射不上进「未编目谓词」，不自动建冲突（0037）。

## 代码与测试约定

- TS strict 全开 + `noUncheckedIndexedAccess` / `exactOptionalPropertyTypes` 等；**禁 `any`、禁 `@ts-ignore`**（`@ts-expect-error` 必须带一行原因）。
- Prettier：单引号、100 列。组件文件 PascalCase，其余源文件 camelCase；标识符英文、UI 文案与领域术语中文。
- 注释只写约束（为什么这样、什么不能做），不写复读机注释；账本规则注释必须挂 ADR 编号。
- 单测在 `app/tests/`（目录镜像 `src/`），describe/it 用中文描述领域行为；**禁止快照测试**；llm/adapters 只测 mock 边界，**单测绝不真调外网**。
- E2E 在 `app/e2e/`（`playwright._electron.launch`）。

## Git 与提交

- Conventional Commits（commitlint 强制）：`feat(brain): …`，scope 用模块名（brain / llm / loops / tasks / adapters / renderer / tray…）；一个 commit = 一个可回滚单元。
- main 常绿：分支开发 → PR 自审自合，CI 绿才 merge。husky pre-commit 跑 lint-staged + tsc。
- 分支命名当前为 `codex/m<N>-<主题>`（如 `codex/m10-memory-research-radar`），合入后打 tag `v0.1.0-m<N>`。

## 安全红线

- API 密钥只进 safeStorage（0040）：不入 SQLite、不入日志、不入 git；日志打印请求必须掩码 `sk-***`。
- 大脑备份/恢复边界见 0048：备份 zip 只含业务账本和清单；模型端点、模型选择、思考强度、API Key、资格认证与运行缓存均属机器级产品设置，不得写回 `brain.db` 或随备份迁移。
- `app/data/*.db` 是用户大脑文件（已 gitignore），不得提交。
- Electron 运行时边界见 0047：主窗口 sandbox / contextIsolation / no nodeIntegration；外链只允许 http/https
  交给系统浏览器；顶层导航、新窗口、webview、权限请求和 privileged IPC sender 都要被显式守住。

## 视觉规则

- 全部 token 在 `app/src/renderer/src/styles.css`：白底 + DSH 灰蓝中性阶 + 近黑主按钮，品牌蓝只做点缀；rgba 分层边框、6px 级圆角、`cubic-bezier(0.4,0,0.2,1)` 三档时长、扫光/shimmer 动效。
- 视觉参考 `reference/deepseek-harness`（DSH）：**只抄结构与几何，不引它的包**；用户已明确否决暖纸风配色。布局骨架保持稳定，新 UI 一律取现有 token，不新造色值。

## 领域语言高频红线

- 「未知」是页面/简报的占位语义（0030），不是主张状态；主张状态只有 成立 / 过时（带关闭原因）。
- 检索失败、触顶、没搜到 → 保持未知并记任务审计；**不准编造来源，不准写负事实主张**。
- 未核主张可进账本、可见冲突，但不得当简报单边定论、不得盖过手给；晋升只翻核对轴、不消解冲突（0029）。
- 纠正 = 旧主张关窗 + 写禁写记忆（0006），不静默改写。
- 界面不准出现内部机制名：dream、Graphiti、Mem0、LightRAG、KAG 等；各词条的 Avoid 列表在 `CONTEXT.md`。

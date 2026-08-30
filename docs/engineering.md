# StaffDesk 工程规范

> 适用范围：`app/`（成品）与仓库级工具链。`prototype/` 是一次性原型，**不受本规范约束、不再修改**。
> 执行会话从 M0 开始必须遵守本文；与 `CONTEXT.md` 领域语言冲突时，以 CONTEXT.md 为准。
> 本规范本身也是简历素材：单人项目用工业级纪律，是工程素养的直接证据。

---

## 1. Git 纪律

- **main 常绿**：main 上永远保持 CI 绿、可构建、测试过。功能在分支开发，合入 main 走 PR（单人项目自己开 PR 自审自合，过程留痕）。
- **分支命名**：`m0/tooling`、`m1/electron-skeleton`、`m2/llm-client`（里程碑/主题）、`fix/…`、`docs/…`。每批合入 main 后打 tag：`v0.1.0-m0`、`v0.1.0-m1`…
- **Conventional Commits**（commitlint 强制）：`feat(brain): …`、`fix(llm): …`、`test`、`docs`、`refactor`、`chore`、`ci`。scope 用模块名（brain / llm / loops / tasks / adapters / renderer / tray…）。一个 commit = 一个可回滚的逻辑单元，禁止「顺手混装」。
- **开工前基线**：M0 的第一个 commit 是把当前未提交的设计产出（ADR、原型改造、docs）整体提交，之后再动工程。

## 2. 代码规范

### 2.1 TypeScript
- `strict` 全开，另加 `noUncheckedIndexedAccess`、`noImplicitOverride`、`noFallthroughCasesInSwitch`、`exactOptionalPropertyTypes`。
- **禁 `any`、禁 `@ts-ignore`**；`@ts-expect-error` 允许但必须带一行原因注释。
- main / preload / renderer 三层共享类型放 `app/src/shared/`；**renderer 不得 import main 内部模块**（只能经 preload 暴露的 API 与 shared 类型），main 不得 import renderer。用 ESLint `no-restricted-imports` 强制。

### 2.2 Lint / Format
- ESLint：`typescript-eslint` 的 `strictTypeChecked` 推荐集 + `eslint-plugin-react` + `eslint-plugin-react-hooks` + import 自动排序；Prettier 统一格式（配置对齐 prototype 现有风格：单引号、100 列）。
- 命名：React 组件文件 PascalCase（`Projection.tsx`，随原型惯例）；其余源文件 camelCase（`brain.ts`、`deriveConflicts.ts`）；标识符英文、UI 文案与领域术语中文（以 CONTEXT.md 词条为准）。
- 注释纪律：只写**约束性注释**（为什么这样、什么不能做），不写复读机注释（这行在干什么）。账本规则类注释必须挂 ADR 编号（照 `prototype/src/store.tsx` 头部 8 条规则的写法）。

## 3. 测试规范

### 3.1 分层要求（什么必须有测试）

| 层 | 要求 |
|---|---|
| `main/brain/`（领域规则） | **强制，CI 覆盖率门槛：行覆盖 ≥ 80%**。8 条账本纪律、冲突派生（0029）、补偿写（0034）、简报出站规则、抽取幂等键——每条规则至少正例 + 反例 |
| `main/llm/`、`main/adapters/` | 强制，但**只测 mock 边界**：fetch mock、subprocess mock，覆盖重试、schema 校验失败、降级路径；单测**绝不真调外网** |
| `main/loops/`、`main/tasks/` | 循环骨架与停止条件（硬顶、触顶入库）用注入 fake LLM/adapter 测 |
| `renderer/` | 不强制单测；关键交互由 E2E 覆盖 |

### 3.2 风格与工具
- vitest，单测文件放 `app/tests/`，目录镜像源码（`tests/brain/deriveConflicts.test.ts`）。
- `describe/it` 用中文描述领域行为（`it('闲聊不写主张：CHAT_SEND 后 claims 数量不变')`）；AAA 结构；**禁止快照测试**；断言领域事实而不是实现细节。
- 纯函数优先：brain 层一切规则写成「SQLite 查询结果 → 纯函数 → 断言」，数据库本身只在集成烟雾测试里碰。

### 3.3 E2E
- Playwright 驱动 Electron（`playwright._electron.launch`），脚本在 `app/e2e/`，每批次验收主链写成一条可重复跑的 spec（M1 起建，随批次累加）。
- `npm run e2e` 是每批交付前的必跑项，与手动验收并存：E2E 证明链路通，手动走查证明体验对。

## 4. CI（GitHub Actions）

仓库远端：`github.com/Frisk239/StaffDesk`（已配置）。M0 就位一个 workflow（`.github/workflows/ci.yml`）：

```
触发：push（main + 分支）与 pull_request
job check（ubuntu-latest 即可，Electron 打包作业才需要 windows）：
  1. npm ci（缓存 ~/.npm）
  2. native:check → Electron 运行时加载 better-sqlite3 并写读内存 SQLite
  3. lint      → eslint .
  4. typecheck → tsc -b（全部 tsconfig）
  5. test      → vitest run --coverage（brain 层 80% 门槛，不达标即红）
  6. build     → electron-vite build（不做安装包，安装包作业见下）
job package（仅 main / tag 触发，windows-latest）：
  electron-builder 打 win 安装包，产物上传 artifact（不上商店；M7 起启用）
```

- better-sqlite3 13 在 CI 与本机默认走 N-API prebuild，并用 `npm run native:check` 验证 Electron 可加载；只有排查源码构建问题时才运行 `npm run rebuild:force`。
- CI 红灯的 commit 不允许合入 main——PR 页面自己确认绿了再点 merge。

## 5. 本地钩子（husky + lint-staged，M0 配置）

- `pre-commit`：lint-staged（staged 文件 prettier + eslint --fix）+ `tsc --noEmit`。
- `commit-msg`：commitlint 校验 Conventional Commits。
- 根 `package.json` 聚合脚本：`npm run dev / build / lint / typecheck / test / test:watch / e2e / package`。

## 6. 文档与决策纪律

- **新决策必须落 ADR**（0042 起）：执行中遇到设计未覆盖的取舍，先写 ADR 再写代码；发现设计矛盾，停下问用户，禁止口头裁决。
- **dev-log**：每批次完成写 `docs/dev-logs/MX.md`——做了什么、验收步骤、已知问题、偏离计划之处。这是验收材料的一部分。
- 设计文档（CONTEXT.md / ADR）不因实现顺手而改；确需修订走「提案 + 用户确认」。

## 7. 安全

- API 密钥只进 safeStorage（0040）：不入 SQLite、不入日志、不入 git。日志打印请求时必须掩码 `sk-***`。
- Electron runtime boundary 见 0047：主窗口启用 sandbox / contextIsolation / no nodeIntegration；顶层导航和新窗口
  离开 StaffDesk 页面时必须拦截，只有 http/https 外链可交给系统浏览器；webview 与页面权限默认拒绝。
- privileged IPC handler 必须校验 sender frame 来自主窗口可信 StaffDesk 页面，再读写大脑、密钥、文件或外部工具。
- `.gitignore` 覆盖：`app/data/*.db`（用户大脑文件）、`*.log`、`dist/`、`node_modules/`、`.env*`。
- 锁文件提交；每批次收尾跑一次 `npm audit`，high 以上当日修。

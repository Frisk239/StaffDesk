# StaffDesk

[![CI](https://github.com/Frisk239/StaffDesk/actions/workflows/ci.yml/badge.svg)](https://github.com/Frisk239/StaffDesk/actions/workflows/ci.yml)

**带主张账本的个人参谋台**：盯住一个对象（公司、项目、人物），把材料变成可核对的判断，并据此办事。桌面应用，BYOK（自带模型 Key），大脑文件全部留在本机。

> 你问它「这家公司怎么样」，它只回答账本里**有出处**的主张——材料不够就说未知，不编。每条判断都能指回原文片段；冲突摊开双方，不替你选边。

## 核心概念

- **主张（Claim）**：一条去语境化后仍可单独核对的命题——对象、谓词、时间都在句内，挂证据与状态（成立/过时），未核是正交的核对标志。
- **主张账本**：SQLite 单文件（`brain.db`）里的业务事实源。界面是投影，规则是 reducer 纯函数；每次写操作留痕、可撤销、可回放。
- **来源角色**：主键（对象自己发出的原文，人标记系统可建议）/ 转述（二手报道）；转述不得自动过时主键主张。
- **简报**：出站快照——只读当时账本里能出站的主张，带引用脚注、未知与未核标记、主键来源标注，可整篇导出 Markdown。
- **任务**：调研 / 再搜一轮 / 出简报 / 周期性雷达——带硬顶（搜索、打开、步数、墙钟、费用 token 五维），过程全程审计可回放。

## 快速跑起来

前置：Node 22、npm（与 CI 一致）。模型自备（OpenAI 兼容端点 + Key），首启向导里配置；不配也能跑（简报走账本组装器，不出网）。

```bash
git clone https://github.com/Frisk239/StaffDesk.git
cd StaffDesk
npm install          # 根目录聚合脚本，自动装 app/
npm run dev          # electron-vite 开发模式
```

安装包（Windows NSIS）从 [Releases](https://github.com/Frisk239/StaffDesk/releases) 获取——CI 每次打 tag 会静默安装、启动、建库验证后发布。

## 工程质量

| 面 | 数字（2026-09，机械摘取自 CI） |
|---|---|
| 单元测试 | 51 文件 / 360 测试，brain 层行覆盖 **92.8%**（CI 门槛 ≥80%） |
| 端到端 | 38 条 Playwright 驱动真实 Electron（含强杀恢复、装机终验） |
| 质量回归 | 内置虚构金标四阶段（获取/抽取/召回/出站），指标低于下限即红 |
| 静态纪律 | TS strict 全开，0 `any` / 0 `@ts-ignore` / 0 TODO |
| 架构决策 | 63 份 ADR，全部先落档再写代码 |
| 工程流程 | slice-owner 模式 + 每约 5 刀一轮三路审计（已五轮） |

常用命令（根目录）：`npm run lint / typecheck / test / eval / e2e / package / native:check`。

## 架构一图

```
┌─ renderer (React 19) ─┐   preload (唯一 IPC 面)   ┌──── main (Electron) ────┐
│ 对象页投影 · 简报 ·    │ ◄──── contextBridge ────► │ brain/ 领域 reducer      │
│ 任务回放 · 设置        │      @shared 类型         │  ├─ 7 域 action 文件     │
└───────────────────────┘                           │  ├─ persist 脏表差异写   │
                                                    │  └─ FTS 触发器维护       │
                                                    │ loops/ 抽取·整理·起草    │
                                                    │ tasks/ 调研·雷达·费用    │
                                                    │ adapters/ 多路检索       │
                                                    └──────────┬──────────────┘
                                                        brain.db (SQLite)
```

分层纪律由 ESLint 强制：renderer 不得 import main；brain 规则全走「SQLite 查询 → 纯函数 → 断言」。

## 设计决策精选（10 / 63）

完整清单见 `docs/adr/`，领域语言见 [`CONTEXT.md`](CONTEXT.md)（与其他文档冲突时以它为准）。

| ADR | 一句话 |
|---|---|
| [0001](docs/adr/0001-claim-is-truth-page-is-projection.md) | 主张是事实、页面是投影 |
| [0008](docs/adr/0008-search-paths-are-not-writes.md) | 搜了几路不等于写入几条，失败表现为未知 |
| [0029](docs/adr/0029-conflict-resolves-only-by-closing-window.md) | 冲突只由关窗消解，晋升不消解冲突 |
| [0034](docs/adr/0034-undo-is-compensating-write-on-operation-log.md) | 撤销是操作账本上的补偿写 |
| [0047](docs/adr/0047-electron-runtime-security-boundary.md) | Electron 运行时安全边界（sandbox/导航/权限全拒） |
| [0056](docs/adr/0056-persist-writes-only-dirty-tables.md) | 持久化只写脏表，冻结时钟等价性证明 |
| [0059](docs/adr/0059-fee-cap-is-usage-tokens-per-task.md) | 费用顶按每任务 usage token 计 |
| [0061](docs/adr/0061-research-fans-out-zero-config-paths-only.md) | 检索多路并行走零配置工具清单 |
| [0062](docs/adr/0062-primary-source-role-is-per-binding-with-suggested-marking.md) | 主键标记是绑定级角色 |
| [0063](docs/adr/0063-operations-retention-row-cap-with-exemptions.md) | 操作账本有界裁旧，证据行豁免 |

## 文档导览

- [`CONTEXT.md`](CONTEXT.md) — 领域语言（词条 + Avoid 列表），一切文档冲突时以它为准
- [`docs/adr/`](docs/adr/) — 63 份架构决策记录
- [`docs/engineering.md`](docs/engineering.md) — 工程规范（Git / 代码 / 测试 / CI / 安全）
- [`docs/dev-logs/`](docs/dev-logs/) — 各里程碑验收记录（M1–M34；M31/M35 为审计刀，记录在审计报告）
- [`docs/audit-*.md`](docs/) — 五轮审计报告与排期

## 边界与红线

- API 密钥只进 safeStorage：不入 SQLite、不入日志、不入 git。
- 大脑文件（`app/data/*.db`）是用户数据，不进仓库；备份 zip 不含机器级配置。
- 界面不出现内部机制名；检索失败保持未知，不编造来源，不写负事实主张。

## License

[MIT](LICENSE)

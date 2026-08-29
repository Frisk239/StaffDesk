# 对照仓

`reference/` 是本机只读克隆，不是 StaffDesk 源码，也不进成品。克隆整仓是为了核对 ADR 出处；实现时只参考，不把对方的产品名、模块或数据模型搬进 `src/`。

本地目录被 `.gitignore` 忽略（`reference/README.md` 除外）。新机器按下面表格再克隆。更新用各仓自己的 `git pull`，不要 vendor 进本仓库。

## 目录

| 本地目录 | 对照 | 先读 | 钉进 StaffDesk 的用法 | 不要抄 |
|---|---|---|---|---|
| `reference/Agent-Reach` | 眼睛 / 适配层 | `README.md`，`agent_reach/skill/` | 本机 CLI：搜、打开、体检。harness 收成工具（0019、0021） | 不要把 Skill 当参谋台运行时；不要托管 Cookie |
| `reference/gbrain` | 账本、来源、dream 对照 | `docs/takes-vs-facts.md`，`docs/guides/compiled-truth.md`，`docs/guides/brain-first-lookup.md`，`DESIGN.md` | 手给/调研、未核、本人优先、关窗不删（0004–0007）。dream 更猛，账本更保守（0017、0022） | compiled truth；takes 的 weight/置信度；当第二大脑产品 |
| `reference/graphiti` | 时态边、矛盾不删 | `README.md`，`graphiti_core/edges.py`（`valid_at` / `invalid_at`） | 过时关窗、冲突是关系（0003） | 功能名、图数据库、自由文本边当判定键 |
| `reference/mem0` | 记忆抽取与幻觉 | `README.md`，上游 issue #4573（召回再抽会放大垃圾） | 记忆三仓、不把开场召回当新事实（0022） | 当档案/主张层；ADD/UPDATE 覆盖带出处的事实 |
| `reference/gbrain-evals` | 主张向评测 | `README.md`，`docs/eval/METRIC_GLOSSARY.md` | 金标对着主张；Recall 与 Precision 一起报（0010） | 当产品壳或仪表盘名 |
| `reference/ragas` | 指标叫法 | `README.md`（Context Recall / Precision / Faithfulness） | 评测用面试官能懂的名（0010） | 当 StaffDesk 评测产品 |
| `reference/deepeval` | 评测当测试跑 | `README.md` | 改召回或出站后复跑的跑法 | 整站文档、语音仿真、TypeScript SDK |
| `reference/RAGChecker` | 细粒度 RAG 诊断 | `README.md` | 按主张/片段诊断，比整段打分贴账本 | `data/` 金标不当本产品评测集 |
| `reference/FActScore` | 原子命题 | `README.md` | 主张是可核对命题（0002） | 百科金标、三元组当 UI |

## 克隆（新机器）

在 `E:\code\StaffDesk` 下：

```
git clone https://github.com/Panniantong/Agent-Reach.git reference/Agent-Reach
git clone https://github.com/garrytan/gbrain.git reference/gbrain
git clone https://github.com/getzep/graphiti.git reference/graphiti
git clone https://github.com/mem0ai/mem0.git reference/mem0
git clone https://github.com/garrytan/gbrain-evals.git reference/gbrain-evals
git clone https://github.com/vibrantlabsai/ragas.git reference/ragas
git clone https://github.com/confident-ai/deepeval.git reference/deepeval
git clone https://github.com/amazon-science/RAGChecker.git reference/RAGChecker
git clone https://github.com/shmsw25/FActScore.git reference/FActScore
```

写入本索引时的短 SHA（仅作当时核对锚，不是必须钉死）：

| 目录 | SHA |
|---|---|
| Agent-Reach | `06c202b` |
| gbrain | `a9ce8971c` |
| graphiti | `6673178` |
| mem0 | `fdfb763d` |
| gbrain-evals | `e08bf65` |
| ragas | `298b682` |
| deepeval | `eb6196872` |
| RAGChecker | `6091f08` |
| FActScore | `f28272d` |

本机大约 370 MB。最大的是 `gbrain` 和 `RAGChecker`（含对方评测数据）。不要为了省空间拆仓；要读就读原文。

## 和产品的边界

- 对照发现写入 `CONTEXT.md` / `docs/adr/`，不写进 `reference/`。
- 实现眼睛时包一层 TypeScript 工具，subprocess 调本机 Agent Reach，不 vendoring Python 源码。
- 评测集是本产品的对象/来源/主张/简报金标，先 2–3 个对象，不用对方 `data/`。
- 界面不准出现 Graphiti、Mem0、LightRAG、dream、KAG 当功能名。

# M36 → M38 intake

## Verdict

**通过。** M36 收尾面已合 main（#33 / `db3b79d`）；其后 CI/docs/e2e 护栏已叠到 `origin/main` `2cb8d15`（#47 路线图、#46 tag 触发、#50 onboarding overlay、dependabot 小版本）。产品行为未再开刀。下一刀按 `docs/roadmap.md` 为 **M38 正确性收口**（M37 编号作废，不新开 `codex/m37-*`）。

## Merge state

| ref | HEAD | 说明 |
|---|---|---|
| `origin/main` | `2cb8d15` | 现行默认线；CI run 187 绿 |
| 本地 `main` | `db3b79d` | 落后 9 commit，**禁止从这里开刀** |
| `fix/e2e-onboarding-overlay` | `de9a068` | #50 squash 合入，树与 main 等价、图分叉；弃用，新刀从 `origin/main` 开 |

- `v0.2.0` tag 在 `db3b79d`；**GitHub Release 仍空**（#46 合入前打的 tag，需用户侧重推）。
- `docs/manual-ux-test-2026-09-03.md` 仅工作区未跟踪，任何远程分支都没有。M38 开刀时一并纳入，路线图已引用它。
- CONTEXT.md 工作分支仍写 `codex/m36-closeout-face`，关 M38 时刷新。

## Regression evidence（M36 关刀数字，后续护栏未改单测计数）

- 51 文件 / 360 单测 / Lines 92.8% / eval 四阶段 / e2e 38
- 本 intake 未重跑门禁（上一刀证据在 `docs/dev-logs/M36.md`；main CI 187 绿）

## Numbering

M36 关刀队列写的是「M37 体验与叙事」。2026-09-03 路线图在实机走查之后重排：正确性收口升为 M38，体验打磨 M39，叙事门面在 M40 前，第六轮审计 + v1.0.0 为 M40。M37 空号。

## User-side leftover（不占刀位，阶段〇）

- 重推 `v0.2.0` 走通自动 Release
- GitHub description / topics 补一句话定位
- dependabot 主版本（typescript 7 / vite 8 / eslint 10 等）按路线图挂起，不混入 M38

## M38 slice（短对齐草案，等人拍板后开工）

用户路径：绑定来源 → 抽取 → 晋升一条 → 待确认不得误删已核主张；提问不泄漏 `[ref:]`；点一次出简报只落一份、未编目只包装一次、任务回放有步骤、时间是本地、批量卡口径不矛盾。

Must（路线图阶段一，全部带自动化测试 + 真机复走）：

1. **UX-001**（域难，先盘问 ADR 0064）：滞留阈值；提议随晋升/纠正/关窗/删除失效或刷新；接受端按 live claims 重算。
2. **UX-002**：正文剥离 `[ref:]`。
3. **UX-003**：未编目降级幂等。
4. **UX-004**：简报任务落审计步骤。
5. **UX-006**：时间语义 UTC 存、本地展。
6. **UX-009**：批量卡「待确认操作」vs「本操作含 M 条」拆口径。
7. **UX-007**（域难，与 0064 同场盘问）：维持 0027 或新 ADR 改判。
8. **双生成怪癖**：一次生成一份。

Out：M39 体验打磨、G4/G6/E3/E6 门面、未验证闭环走查（M40）、向量/登录态/费用折金额。

红线：滞留阈值与 0027 不得口头改判；账本规则纯函数测试先行；禁止快照；交付前真实 Electron 复走原路径。

建议分支：`codex/m38-correctness-closeout` ← `origin/main` `2cb8d15`。

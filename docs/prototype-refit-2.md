# 原型优化计划 · 第二轮（视觉系统 + AI 工具层）

来源：2026-08-28 对 refit 后的 `prototype/` 的复审（逐屏点过主链 + 读全部改动 + `npm run build` exit 0）。上一轮施工单是 `docs/prototype-refit.md`，它的 P0/P1/P2/P3 已经做完并验过，**不要重做**。

这一轮做三件事：修复复审新发现的 bug（P0）、把新卡片纳入一套视觉系统（P1）、落 AI 工具层与 composer takeover 形态（P2）。

口径：账本词条以 `CONTEXT.md` 为准，写纪律以 `docs/adr/` 为准，形态以 `prototype/` 正在跑的界面为准。新形态口径在 `docs/adr/0028-ai-writes-are-proposals-confirmed-in-composer.md`（**已写好，不要重写**），0027 末尾已加指向 0028 的一句。

视觉参考是仓库里的 `reference/deepseek-harness`（下称 DSH）。**只抄结构、几何与 token 关系，不抄它的组件代码，也不引它的包。** 原型必须继续是零依赖新增的 Vite + React。

跑法：`npm run prototype`。每阶段做完跑 `npm run build --prefix prototype`（必须 exit 0），再按文末验收手点一遍。

上一轮那九条「须主人拍板」仍然有效，代码里的 `TODO(待拍板 §n)` 原样保留，不许顺手决定。本轮新增两条待拍板，见文末。

---

## P0 · 复审新发现的 bug

### P0-1 `conflictsOf` 不对称：已关窗主张的审计卡还在显示冲突

`store.tsx` 的 `conflictsOf` 只过滤对手 `status === '过时'`，不过滤自己。实测：把「也在看 Java」关窗后，它的审计卡里冲突框仍在，还把自己和 Go 那条并排成冲突。CONTEXT 的冲突定义要求「有效期重叠」，关窗后不再重叠。

做法：`conflictsOf` 先判自身，过时直接返回空数组。档案投影里已经正确（`projectionClaims` 过滤了过时），只需改这一个函数。

### P0-2 候选记忆写错了仓位

`prop-2` 的 payload 有 `fromObjectId`、文案是「对着这家组织，回复用条目，别写长段」，但 `PROPOSAL_DECIDE` 一律写 `scope: '全局'`。CONTEXT 的三层记忆里这明显是对象记忆。

做法：`CandidatePayload` 加 `scope: MemoryScope`；种子这条给 `'对象'`；写入时带上 `objectId`（`Memory` 需要加可选 `objectId`）。待确认页和提议卡上把范围显示出来。**不要做「让人在卡上改范围」的下拉**——那是 §11 待拍板。

### P0-3 离开对象页再回来，思考行与工具行永久消失

`ChatPane` 的 `turns` 与 `seenIds` 是组件内 state/ref，而 `ChatPane` 在 `view.kind` 变成 `inbox`/`pending` 时会卸载。实测：去待确认页再回来，历史回答只剩正文，思考行和工具行没了。上一轮 P2-5 把 `seenIds` 提成 ref 是不够的。

做法：把每条 desk 消息的「已播放过」标记与 turn 视觉（tools、think）落进 store，跟着消息走（`ChatMessage` 加可选 `turn?: { tools, think, played: true }`，在 `CHAT_SEND` 时算好写进去），组件只负责播放动画。这样卸载重挂也不丢。

### P0-4 简报块四的多行没渲染出来

`brief.ts` 已改成 `\n` + `· ` 的多行文本，但 `.sentence-text` 没有 `white-space: pre-line`，实际还是挤成一行「…网络）；以及 · 栈桥科技后端主栈是 Go。」

做法：要么给 `.sentence-text` 加 `white-space: pre-line`，要么把 `BriefSentence` 的 text 改成 `lines: string[]` 由 `BriefView` 逐行渲染。**推荐后者**——简报句子是出站内容，用结构而不是靠空白字符表达换行更稳。

### P0-5 三处小的

- **原文片段带出孤立的「·」**：`highlightSpan` 从 span 前 40 个字符硬切，切进了上一行的「栈桥科技 · 官网首页摘录」。改成先按行边界收缩，再按字符数兜底。
- **「冲突」出现两次**：审计卡里 `deal-section` 的 `sec-title` 是「冲突」，里面 `conflict-label` 又是「冲突」。删掉外层标题，保留冲突框自己的标签。
- **绑定与抽取完成没有结果卡**：绑定确认后主栏还是空的，动的全是右栏——这跟 0027「主栏成交」相悖。`BIND_CONFIRMED` 落一张结果卡（「已绑定 2 个对象 · 抽取中」），`EXTRACT_DONE` 落一张（「抽出 4 条主张，全部未核」，或者抽不到时写「未抽出可核对命题，未写入账本」）。后者顺带解决现在粘贴进来的新来源抽不出主张时空态语义模糊的问题（分不清是抽不出还是坏了）。

---

## P1 · 视觉系统：让新卡片和 composer 说同一种话

主人的原话是「主会话交互太丑」。根因不是配色——`styles.css` 的 token 已经是 DSH 那一套（bluish 中性色、`--brand: rgb(65,118,230)`、`--radius-pill: 22px`、`--shadow-lv2`），composer 也已经是 r22 + border l2 + shadow-lv2、气泡是 r22 + padding 10/16。**脱队的是上一轮新加的 `.deal-card` 那批。**

### P1-1 一条内容宽度轴（先做这条，做完散乱会掉一半）

现在 `.chat-scroll` 是 `padding: 16px 20px` 撑满，`.deal-card` 是 `max-width: 720px` 左对齐，两者不同轴，卡片和输入框边缘对不上。

DSH 的做法在 `reference/deepseek-harness/packages/client/ui-conversation/src/client/skeleton/ConversationRoot.module.css`：

```
--dsh-chat-content-width: clamp(680px, calc(列宽 * 0.64), 920px)
--dsh-composer-card-max-width: calc(内容宽 + 32px)
--dsh-composer-side-clearance: 16px
```

transcript、卡片、takeover 都对齐内容宽 W 并居中，只有输入卡是 W + 32，两侧留 `clearance + 16px`。注意它是按**列宽**而不是视口宽算的（收起侧栏会加宽列而不改窗口）。

落到原型：在主栏容器上定义 `--sd-chat-width`（用主栏实测宽度 clamp，右栏开合会改变它，所以要跟着容器走而不是 `100vw`），消息与卡片 `max-width: var(--sd-chat-width)` 且水平居中，composer 卡 `calc(var(--sd-chat-width) + 32px)`。原型不必上 ResizeObserver，可以用 CSS 容器查询或者简单地按 `.work-row` 的 flex 宽度做 clamp，但**上下限与比例照抄 680 / 0.64 / 920**，那是可读行长调过的值。

### P1-2 卡片表面换成 DSH 的卡片语言

现在 `.deal-card` 是 `--radius-l: 12px` + `--md-code-bg` 灰底 + 无阴影，所以看着像贴进对话的代码块。

DSH 的 takeover 卡（`ui-approval/.../ApprovalPanel.module.css`、`ui-user-questions/.../QuestionComposer.module.css`）是：`border: 1px solid` l2 + `border-radius: 20px` + 背景用抬升面（`--dsw-specific-input-major`，亮色下就是纯白）+ `box-shadow: 0 4px 12px rgba(0,0,0,.02), 0 2px 8px rgba(0,0,0,.04)`（即原型已有的 `--shadow-lv2`）。

落法：`.deal-card` 圆角 20px、底色 `var(--bg)`、加 `--shadow-lv2`、border 用 `--line-2`。灰底 `--md-code-bg` 只留给真正的代码/原文块（`.io-card`、`.span-quote`），别当卡片底。

### P1-3 补一套按钮 primitive

现在 `.deal-actions button { font-size: 12px }` 就是全部样式，所以「晋升 这句不对 看来源全文」三个动作是纯文字并排，像面包屑。

DSH `ui-primitives/src/Button.module.css` 的胶囊几何：默认 `height 36 / border-radius 18 / padding 0 14px / gap 4 / 14px-22px`；紧凑档 `height 28 / radius 14 / padding 0 10px / 12px-18px`。三个变体：`primary` = 品牌深色填充 + 反色文字；`outline` = 1px l2 边框 + 透明底；`ghost` = 只有 hover 才出底色（`interactive-bg-hover`）。危险动作不做独立变体，而是给 `outline` 一个 hover 态转红（`.reject:hover` → danger 底 + error 字 + 透明边），这正好合我们「纠正不是删除」的口径。

落法：加 `.btn` / `.btn.sm` / `.btn.primary` / `.btn.outline` / `.btn.ghost` / `.btn.outline.danger-hover`。审计卡三个动作用 `outline sm`；takeover 的确认用 `primary`、拒绝用 `outline` + danger-hover；顶栏「出简报」保持现在的 primary。全局把裸 `<button>` 换过去，别只改卡片。

### P1-4 字号收敛到四档

现在有 10（deal-id）、11（kicker）、12（actions/meta-table）、13、15（claim-fulltext）五档。DSH 只有两条轴：`--dsh-content-font-size: 14px` 与 `--dsh-content-font-size-secondary: 13px`，行高一律 `calc(24px + delta)`。

落到原型四档，不再新增：15/24 主张正文 · 14/24 正文与按钮 · 13/20 次级（summary、mono detail、字段值） · 11/16 eyebrow 与标签。`deal-id` 用 11/16 且保持 hover 才显。

### P1-5 字段表改成键值行，eyebrow 去掉大写间距

审计卡的 `<table class="meta-table">` 是 84px 固定 th + 虚线下边框，和右栏卡片语言不搭。改成一列键值行：label 13px `--ink-3`、value 14px `--ink`、行距 24、无边框无虚线，label 用 `min-width` 而不是固定 width。

`.deal-kicker` 现在是 600 weight + 1.5px letter-spacing，像贴纸。改成 DSH 的 eyebrow：11/16、`--ink-3`、常规字重、无 letter-spacing、与标题间距 5px。

### P1-6 冲突并排的收口

审计卡里 `.conflict-pair.wide` 是 `1fr 1fr`，在主栏宽度下每侧约 480px，一行放得下句子，这条已经对了，保留。但两侧要对称：现在本条是 `.claim-card.static`（不可点）、对手是可点按钮，视觉不齐。改成两侧同样式，本条加一个「当前」标记而不是靠"不可点"来区分。

### P1-7 工具行的运行态可以更像 DSH（可选）

`ui-tool/.../ToolRow.module.css` 的运行态是一条 300px 宽的高光带在行上从左滑到右（`2.6s ease-out infinite`，末尾 10% 停顿），几何是 `[16 leading] gap6 [title 13/24] gap8 [2x2 圆点分隔] gap8 [summary 撑满并省略号]`。原型的 `.flow-row` 已经很接近，如果时间够，把分隔点做成 2×2px 圆点、summary 加 `text-overflow: ellipsis`，就完全对上了。这条不影响验收。

---

## P2 · AI 工具层与 composer takeover

形态口径在 0028，这里只讲原型怎么落。

### P2-1 底线：不接真模型

原型继续不发任何模型请求。「AI 调工具」用 `chat.ts` 的脚本回复模拟：用户在对话里说出意图，脚本判定并产出一个**提议**，界面进入待确认。执行者不许为了这条去接 OpenAI 兼容端点。

### P2-2 三层工具在原型里的样子

- **只读（模型直接调，不确认）**：现在 `planTools` 里那些行就是它——读取主张、打开来源、核对账本。保持只在流里留工具行。补一条：工具行的 IN 必须带作用域（workspace + objectId），把 0012「未绑定不进语境」显式画出来。
- **写账本 / 写记忆（只能提议）**：绑定、晋升、纠正、接受整理、写记忆。模型产出提议 → 进 takeover 等确认。
- **不可逆 / 越界（不给工具）**：永久删除对象、移除工作区、改设置、开深挖档。脚本遇到这类意图，回一句「这个我不代做，你在界面里操作」，不产提议。

### P2-3 composer takeover 形态

DSH 的 `ApprovalPanel` 是「一个待批准请求占用输入卡的位置」，注释写得很直白：composer takeover，一次一个。几何照抄：

- 外层 frame：`padding: 8px calc(clearance + 16px) 12px`，居中
- 卡片：`max-width: var(--sd-chat-width)`、`border-radius: 20px`、抬升底、`--shadow-lv2`、border 用状态色（等待用 amber）
- 顶部状态条：`padding: 10px 16px`、amber-tertiary 底、amber-primary 字、13/18、左侧一个 8px 圆点
- 正文：`padding: 12px 16px 0`、gap 6；headline 15/24 500 说「要做什么」
- 依据区：等宽字体 13/20、`--ink-3`，放 before → after 和原文片段引用
- 动作行：`padding: 14px 16px`、右对齐、gap 8、`outline` 拒绝（hover 转红）+ `primary` 确认

原型里：输入区在有待确认提议时被 takeover 替换（textarea 隐藏或禁用），确认/拒绝之后回到输入框，并在流里落一张结果卡。**流里不再放纠正卡与提议卡**（它们搬到 takeover），审计卡与结果卡留在流里。

### P2-4 必须一起落的约束（不是可选项）

- **一次一件**：同时有多条提议时排队，takeover 只显示队首，卡上标「还有 n 条待确认」。批量只允许「本任务未核全部晋升」这一种（0016），做成一条独立提议，卡上列出会被晋升的条目。
- **提议必带出处**：没有 claimId 或 span 依据的写提议，reducer 直接拒绝生成（和 `buildBrief` 不许生成无 claimId 的句子同一条纪律）。
- **确认卡要写清后果**：如果这条通过后该主张会成为简报里的单边定论（即晋升类），卡上明写一行「通过后可出站当定论」。这是防盲签的关键一行。
- **不给 Enter 直接通过**：takeover 里 Enter 不等于确认，必须点。
- **禁写也拦提议**：`bannedHit` 现在只在 `buildBrief` 里调。提议生成处也要过一遍，命中禁写就不许提议把那句话写回来。
- **不许自开谓词槽**：编目类提议只能并入 `Predicate` 里已有的槽；「加新槽」只能提示人去做。

### P2-5 建议的脚本触发词（可改文案不可改语义）

- 「把主栈那条晋升」→ 晋升提议
- 「这句不对」+ 选中主张 → 纠正提议（takeover 里填关闭原因）
- 「把平台化那条并入使用技术」→ 整理提议
- 「记下来：…」→ **保持现状，立刻写**。明确的使用者陈述不走确认（0022），这条不要改成提议。
- 「把这份 JD 绑到栈桥科技」→ 绑定提议
- 「删掉周若水」→ 不产提议，回「这个我不代做」

---

## 须主人拍板（新增两条，原九条照旧）

- **§10 确认粒度**：账本写入没有全局「以后都允许」（0028 已定）。但要不要有任务级白名单——「本任务内允许晋升」，对应 0016 的批量晋升？先不做，留 `TODO(待拍板 §10)`。
- **§11 记忆范围谁选**：候选记忆的 scope 由种子/提议给定（P0-2），还是让人在卡上选全局/对象/会话？现在按 payload 给定，不做下拉。

---

## 不要做

- 不要接真模型、不要真检索、不要真抓 URL。
- 不要引入 DSH 的任何包，也不要把它的 CSS Module 结构照搬进来——原型是单文件 `styles.css`。
- 不要引入状态持久化（刷新必须丢）。
- 不要重做 `docs/prototype-refit.md` 里已经做完的部分。
- 不要写 ADR 0028（已写好）；如果实现与它冲突，先问主人。
- 不要动九条 + 两条待拍板里的任何语义。
- 不要把 dream、评测仪表盘、雷达做上界面。

---

## 完工验收（自己点一遍再交）

`npm run build --prefix prototype` exit 0，且：

1. 关窗一条主张后，它的审计卡不再显示冲突框；档案里那一槽也不再有冲突框。
2. 接受候选记忆后，记忆列表里那条显示范围是「对象」，不是全局。
3. 去待确认页再回到对象页，历史回答的思考行与工具行还在。
4. 简报「可能问什么」块的多行真的分行显示。
5. 审计卡的原文片段不再出现孤立的「·」；卡里「冲突」只出现一次。
6. 绑定后主栏立刻出现结果卡；粘贴一份抽不出主张的来源，绑定后能看到「未抽出可核对命题，未写入账本」而不是空白。
7. 卡片、消息、输入卡三者左右边缘对齐（同一条内容宽度轴），拖动右栏宽度时仍然对齐。
8. 卡片是 20px 圆角 + 白底 + lv2 阴影，不再是灰底代码块观感。
9. 审计卡三个动作是胶囊按钮（outline sm），不是纯文字；拒绝类按钮 hover 才转红。
10. 页面上字号只有 15/14/13/11 四档（抽查审计卡、简报、待确认、设置）。
11. 对话里说「把主栈那条晋升」→ 输入区被 takeover 占用，卡上有等待条、依据、「通过后可出站当定论」一行、拒绝/确认两个按钮；Enter 不能通过。
12. 同时制造两条提议 → takeover 只显示一条，并标「还有 1 条待确认」。
13. 说「删掉周若水」→ 不产提议，回一句让人自己操作。
14. 「记下来：…」仍然立刻写，不进 takeover。
15. 确认或拒绝后回到正常输入框，流里留下结果卡。
16. 右栏仍然没有任何写入按钮；页面上没有模态遮罩（设置与永久删除那两个例外仍在）。
17. 刷新丢失全部状态。

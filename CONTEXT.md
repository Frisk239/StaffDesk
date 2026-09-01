# StaffDesk

带主张账本的个人参谋台：对象档案里的稳定判断能回到出处，再按任务生成简报。材料不足时结果是未知，而不是用模型常识把页面写满。

## Current implementation

- M8 closed the model-settings/mock cleanup slice: model configuration is product-global, and production paths no longer fall back to prototype model data.
- M9 added the real ingestion path: Inbox and onboarding now call main-process ingestion for pasted text, URL, text files, and PDF; failed ingestion remains an IngestJob and never becomes a business Source.
- Sources now carry origin, content hash, fetched time, and locatable segments. Claims can carry absolute source ranges and a segment/page locator while preserving legacy `span`.
- Extraction now runs over stable source chunks instead of the first 8000 characters only. A technical failure in a chunk keeps the whole extraction attempt terminal without writing partial new claims.
- Legacy `unparsed` sources are preserved for migration visibility, but they cannot be newly created through `ADD_SOURCE` and cannot be bound for extraction; users should re-import them through the real ingestion path.
- M10 added the memory/research/radar completion slice: candidate memories now come from traceable user-message excerpts and require confirmation; research tasks run doctor/search/open through the real reach adapter and record replayable failures; radar plans can be created and run through the same research path.
- Research Sources now carry `origin.kind=research`, final locator/hash/fetched metadata, and a body segment. Search failures, empty results, failed URLs, hard caps, late runs, and missed radar cycles stay in task audit rather than becoming Sources or Claims.
- M11 added one quality-regression runner for both Settings qualification and `npm run eval`: isolated fictional gold packs traverse acquisition, extraction, FTS recall, and outbound ledger rules, reporting extraction/span, Recall@k/Precision@k/MRR, faithfulness, unknown, conflict, correction, and fabrication metrics.
- Model qualification is product-global and fingerprinted by normalized endpoint, model, thinking effort, effective model parameters, and suite/policy versions. Records live in `userData/quality-qualification.json`, never in the brain file; changing the target immediately returns the current configuration to unqualified without deleting old history.
- M12 upgraded the desktop runtime security floor to Electron 44 and moved SQLite native validation to `native:check`: `better-sqlite3` 13 N-API prebuilds must load inside Electron before lint/typecheck/test/build. electron-builder packaging no longer forces local source rebuilds.
- M13 added the Electron runtime security boundary: sandboxed main window, explicit app-page URL policy, http/https-only external opens, denied in-app navigation/new windows/webviews/permission requests, and trusted-frame checks for privileged IPC.
- M14 added the data-safety backup/restore path: Settings can export a manifest-backed StaffDesk brain zip and restore it after inline confirmation; restore validates zip/hash/SQLite/schema, saves a pre-restore safety backup, removes stale WAL/SHM sidecars, and keeps product-global model settings/keychain/qualification outside the brain file.
- Model configuration actions are product-global only and no longer persist into the brain operation log; legacy model-setting operation rows are cleared when a brain opens.
- M15 added task run control: research/radar runs first create a visible `进行中` task, append process audit rows while running, can be manually stopped as `已停止 · 手动`, and can be opened from the object page replay surface during or after the run.
- M16 added task-scoped claim review after research extraction: research sources now carry `origin.taskId`; when all sources for a completed research/re-search task finish extraction, the object page takeover offers the 0016 batch choice for only this task’s live unverified claims. Confirming flips only `unverified`; keeping leaves the claims untouched and records a result card. Replay shows a lightweight pointer back to the object page when the decision is pending.
- M17 made takeover write proposals durable ledger state: pending `writeQueue` rows now live in SQLite `write_queue`, restore through `snapshot()`, survive app restart and brain backup/restore, and continue to confirm/reject by the same `writeId`. Legacy backups without the table are validated through a temporary migration before restore.
- M18 settled the four pending design decisions as ADR 0052–0055: objects are created only by human confirmation with tidy proposing new ones; conflict mutex is normalized value difference on single-value slots; ban-write intercepts on slot+value and original text; memory scope defaults from the proposal and is editable on the confirmation card. No behavior change in this slice.
- M19 opened the three missing task entries and paid main-process quick-win debt: the research button now offers 快搜/深挖/再搜一轮 (re-search creates a new task carrying the previous round's query and gear), the icon rail gains a task list view that browses every task and opens any replay, and chat failures now land as a redacted toast with the user message already visible instead of a hanging rejection. The dead `chat:delta` emitter was removed, IPC channels are single-sourced, debug logging was cleaned, and `ipc.ts` gained behavior tests.
- M20 demolished the full-rewrite persistence wall (ADR 0056): `Brain.dispatch` now writes only dirty tables via reference-checked, PK-based row diffs with self-healing against drifted rows; `created_at` semantics shifted to first-write time with order preserved by the no-reorder invariant; FTS rebuilds only when claims changed and now inside the transaction; the full-rewrite path remains as a repair/equivalence channel. A frozen-clock equivalence suite proves diff ≡ full across ~80-dispatch scripts, and pure-UI actions now issue zero business-table writes.
- M21 sharpened the quality knife: quality regression now enforces metric floors (low scores fail stages with named gaps, not just exceptions) and gained `uncatDiscipline` (uncatalogued predicates must stay flagged, never single-voice) and `undoCompensation` (promote→confirm→undo leaves compensating operation and unverified claim) gold cases with a sabotaged deterministic adapter proving the failure path; the outbound policy version bumped to v2. The duplicated research orchestration collapsed into `tasks/applyResearchRun.ts` with a shared single-flight lock (catchup skips with a toast on collision, and its failure toast is now redacted); eleven secret-masking copies consolidated into `redact.ts` and the state broadcast into one module.
- M22 turned `relationIds` into real edges and fixed the orchestration lock leak: relations are bare symmetric cross-kind edges (人↔组织/项目↔组织/人↔项目 only) with add/remove on the object page projection (chips jump to the other object, dangling ids tolerated, deletion cleans the other side), and recall now hops one edge — related objects' bound claims fill the recall pool and citation whitelist up to the same cap, tagged with their source object. Object notes became editable inline (empty clears). `applyResearchRun` no longer can strand an object busy on an early dispatch failure, writes always land on the live brain instance across quit/restore, and gained its first dedicated test suite plus an eval-gate invariant (every floored metric maps to a stage).
- M23 landed two ratified decisions and the first breadth of tidy: conflict mutex now judges by normalized value (NFKC/whitespace/case, 0053 — formatting differences no longer fake conflicts, 北京 vs 北京市 still does), and ban-write became dual-path (0054, schema v6): corrections store (object, slot, normalized value) alongside the original sentence, and both the outbound gate and the proposal gate intercept on either path — the eval's correction-recurrence gold now replays a formatting-variant restatement to prove the structured path catches what substring matching misses (outbound policy bumped to v3). Tidy gained three proposers at the extraction hook: merge-duplicates (same normalized value on the same slot proposes keep-first), mark-stale (claims older than 180 days propose a review that closes the window as 世界已变 on accept, undoable), and catalog-uncatalogued (human picks the slot on the card; uncontrolled slots rejected).
- M24 finished the proposal set and made radar resident: extraction now surfaces unknown object names as human-confirmed "new object" proposals (0052 fully landed — the object kind is chosen on the card, no auto-binding, no view stealing), and claim text mentioning another cross-kind object proposes an edge (reusing M22 relations, no undo per the standing verdict). Radar truly runs while the app lives (0038): a tested 60s watchdog serially runs due radars with the shared single-flight lock, power-monitor resume triggers an immediate tick, the tray menu shows the next due slot with a run-now action, and radar creation offers daily/3-day/weekly intervals. Candidate-memory cards gained the 0055 scope picker (human choice overrides the proposal default). operations.action gained an index (schema v7) cutting the per-dispatch deleted-source scans.
- M25 opened the slot table for editing under ADR 0057's cascade discipline: rename rewrites the slot's claims and the ban-write structured predicate in lockstep (and withdraws pending proposals targeting the old name), delete demotes live claims to 未编目 with the full existing degradation semantics, BRIEF_SPECS-referenced built-ins stay protected until scenarios become data, multi→single arity announces the conflicts it will derive, and the preset seeding gate became a first-run marker so an emptied table no longer resurrects defaults. The settings page gained per-row edit dialogs (name/arity/scenario checkboxes) and a delete confirmation showing affected claim and object counts. A test-forced deviation switched the slot_defs diff key from positional ids to the natural (name, kind) key — positional shifts on delete had violated the table's UNIQUE constraint, and the 0056 equivalence suite still passes.
- M26 turned scenarios into data rows (ADR 0058): a `scenario_templates` table holds name/builtin/hint/playbook/brief-spec for the four built-ins plus the 自定义 baseline, seeded under its own first-run key (independent of the slot-seeding key, so existing brains upgrade cleanly); schema v8 rebuilt workspaces without the enum CHECK and retired the dead spec table with REQUIRED_TABLES kept in lockstep. buildBrief and the session playbook now read state with an explicit fallback chain, killing the constant/table dual-source drift; custom templates are CRUD-able (renames cascade workspaces and slot references, deletes refuse while referenced, built-ins keep their names), the object-create placeholder finally follows the scenario hint, and the M25 brief-reference protection became cascade rewriting — renaming a slot rewrites every template's spec, deleting one prunes it and drops emptied blocks.
- M27 closed the audit's fix list and the last half of the scenario entry: template delete now cascades slot_defs.scenarios cleanup (0058 amendment), CONFIRM_WRITE fallbacks regained the kind-aware slot guard and UPDATE/REMOVE_SLOT cascade pending write_queue tidy rows, nested Settings dialogs Esc-close only the inner layer (capture+stopPropagation), and the e2e suite runs fully isolated from the dev machine's model config. Scenario drafting became AI-proposable: a chat intent routes to a zod-validated drafting loop whose slot list is whitelist-filtered (never invented), landing as a takeover card that confirms through the same UPSERT guard (write_queue carries template_json, schema v9). Qualification auto-runs on the onboarding check step (skippable per 0041) with a resident 未认证 badge in the top bar jumping to model settings; the task list gained status/kind filters, running-first ordering, radar next-due display, and re-search from failed rows; the relation panel gained name search. The 候选记忆 entry now says per-turn accumulation, matching the implementation and ADR 0022.
- M28 paid the read-path debt and landed the fee dimension (ADR 0059): dispatch now does a single ledger read per operation with the deleted-source recovery scan cached out of snapshot; syncTable reads full rows only by the in-memory key set (surplus detection keeps a PK-column scan); task_audits gained PK (task_id, seq), an index, and a 500-row-per-task retention with cap/failure audit rows exempt (schema v10 also rebuilt tasks to admit 费用触顶); claims FTS is now maintained by INSERT/UPDATE/DELETE triggers with the full rebuild kept as the 0056 repair channel. Research budgets track per-task usage tokens (快搜 120k / 深挖 400k plus missing-usage call caps; the dead hops dimension is deleted), fee-cap stops write what already opened and leave the rest unknown, task rows and replay show token spend, endpoints that omit usage degrade to call-count approximation with an audit note, and radar cycles each carry their own sub-task budget while user chat stays outside task budgets.
- Current working branch for this cut: `codex/m28-read-path-debt`. Previous merged branch: `codex/m27-closeout`.

## Language

**StaffDesk**:
带主张账本的个人参谋台。维护人、组织、项目这类对象的档案，稳定判断可核对，并据此办事。
_Avoid_: 知识库问答, 第二大脑, 面试工具, 审核机器人, 企业知识库

**主张**:
一条去语境化后仍可单独核对的命题：对象、时间、谓词都在句内，一个谓词槽，挂证据与状态。来源没说的推论不准写入。用户看见完整句子，不是槽名。
_Avoid_: 知识点, chunk, 摘要, compiled truth, 结论段落, 综合判断, 三元组（用户可见形态）

**谓词**:
受控槽位，用来判定冲突、合并重复和抽取幂等。表由人维护（设置页有管理界面）；抽取必须映射到表内。槽按对象种类分区，各带单值/多值声明（互斥判定只用单值槽）与可选场景适用标记，对象页投影按当前场景过滤。不是用户看见的标签。
_Avoid_: 三元组, 自由文本谓词（若当判定键）, 属性名展览, 每场景一套独立表

**未编目谓词**:
映射不上受控表的抽取结果。可以进账本、默认可未核，不自动建冲突，不当简报单边定论。整理里提议并入某槽、加新槽或丢掉。
_Avoid_: 谓词, 自动判冲突

**综合**:
由多条主张推出的读法，只出现在简报或对象页的组织层，且必须指回主张。不是账本条目。
_Avoid_: 主张, 概述（若当账本用）

**主张状态**:
成立、过时（带关闭原因）。单条主张只回答自己作为世界命题的状态；未核是正交的核对标志，不在此列。状态变化是产品语言。
_Avoid_: 未知（页面占位，不是状态）, 部分成立（v1 已删）, 冲突（不是单条状态）, 置信度分数, 有效/无效

**过时**:
主张在世界中的有效期被关闭，记录仍保留。用于世界已变或记录被纠正为从来不对；不是删除。
_Avoid_: 冲突, 覆盖, 过期删除

**冲突**:
同一对象、同一单值谓词槽上，有效期重叠且取值互斥的多条主张之间的派生关系，不存独立状态。两侧都留在账本，页面并排展示。唯一消解路径是任一方关窗；晋升不消解冲突、只改出站资格，未消解的冲突在简报始终摊开双方。未编目谓词不自动建冲突。未核调研不能盖过手给；调研侧晋升后解除未核限制，并排保留到手给一方关窗。取值互斥按归一化取值判定（大小写、空白、全半角），不做语义判断。
_Avoid_: 裁决动作（没有判某方胜的操作）, 主张状态, 多值槽上的并存, 综合成「目前有争议」, 按新覆盖, 按网页覆盖手给

**有效期**:
主张在世界中为真的时间区间。与写入账本的时间不是同一件事。
_Avoid_: 过期时间（若指删除）, 入库时间（若当作世界时间）

**来源**:
进入大脑的原始材料。出处指向来源中的片段。渠道类型用于引用，不是可信度分数。先支持粘贴文本、URL、PDF；仓库说明当网页或文本，不单独做 Git 产品。
_Avoid_: 文档, 语料, 知识库, 域名权重, Git 集成

**进料路径**:
来源怎么进大脑：手给，或调研。调研不得自动过时手给。
_Avoid_: 来源等级（若当成单一排行）

**手给**:
使用者提交的原文、文件或链接。
_Avoid_: 主键（进料路径与材料角色不是同一轴）

**调研**:
受任务约束自动获取的外部材料。默认未核。检索走了几路，与最终写入几条来源无关。
_Avoid_: 搜索引擎, 通用爬虫, 按搜索路数凑写入

**检索**:
任务里向外搜、打开、跟踪链接的动作。多路并行，路径由体检通过的零配置检索工具决定（0061）；需登录态的平台不在 v1。检索命中不等于来源。
_Avoid_: 入库, 主张, 召回

**召回**:
对着已经入库的来源和主张找证据。承诺找全、找对。关键词（trigram FTS）加关系跳对象；向量不在 v1 范围（0060）。不是对外检索。
_Avoid_: 检索, LightRAG, KAG, Graphiti（若当功能名）, 向量（当 v1 承诺）

**入库**:
成功获取到原文、能指向片段，才写成来源。搜不到、打不开则不写来源，不准用模型常识补来源，也不准把「没搜到」写成世界上不存在。抽主张是主张抽取循环的事。
_Avoid_: 编一条凑数, 按检索路数对齐写入条数, 负事实（仅因检索失败）, 主张账本（入库写的是来源）

**未核**:
自动写入后尚未被使用者晋升的标志，与主张状态正交：状态答「命题在世界里真不真」，未核答「这句经没经人核对」。未核主张可进账本、可见冲突，但不能作为简报里的单边定论，也不能盖过手给。
_Avoid_: 草稿, 待生成, 低分来源, 主张状态的一种

**晋升**:
使用者把未核主张标为可出站定论的动作，只翻核对轴、不动状态轴，也不消解冲突。默认按条；任务结束可对本任务未核全部晋升或全部保持。没有整站一键全过。
_Avoid_: 审核, 发布, 入库批准, 全库一键通过, 消解冲突

**主键**:
对象自己发出的原文，如官网、官方 JD、公告。由使用者标记；系统可建议，不自动定。转述不得自动过时主键；同一主键体系的新版可以过时旧版。
_Avoid_: 权威分数, Domain Authority, 自动定官方

**转述**:
对主键的二手报道或聚合，如媒体、博客。
_Avoid_: 调研（转述也可以是手给）

**对象**:
可打开档案的主体，种类为人、组织、项目。组织是你要搞清楚的机构，不是产品的企业客户。对象只由人确认建立，整理可提议新对象；v1 不做别名。
_Avoid_: 实体, 节点, 词条, 笔记, 公司（易听成租户）

**人**:
你研究的自然人：面试官、作者、同事。
_Avoid_: 用户（若当成登录账号）

**组织**:
你研究的机构：要面的雇主、要对比的团队、开源基金会等。不是多租户里的「一家客户」。
_Avoid_: 企业客户, 租户, Account（若当成 CRM 销售对象）

**项目**:
你盯的这一次事：一场面试岗位、一个仓库、一次技术选型。不另开主题类型。
_Avoid_: 主题, 笔记, 看板任务（若当成待办软件）, 工作区

**工作区**:
壳层分组，下面挂本区的对象会话，建区时选定场景。不是账本实体，不是第四种对象。可新建、切换、移除（二次确认）；移除后该区对象归档、可从「全部对象」找回并恢复进其他工作区，主张仍按关窗规则留在账本。
_Avoid_: 项目（对象种类）, 笔记本, 租户, 文件夹当知识库, 找不回的孤儿对象

**场景**:
工作区级的预设包，四件套：按对象种类的谓词槽表预设、简报说明模板、建对象引导、默认说明书。建区时选定，区内对象继承。内置求职面试、求学申请、技术选型、尽调研究；自定义模板可建可改可删，AI 可提议起草（走 takeover，新槽按谓词的规矩人确认）。不是第四种对象，不是任务种类，不产生新账本结构。
_Avoid_: 模板（若当产品名）, 第四种对象, 行业包, 分支代码, AI 直接定槽

**会话**:
左侧列出的入口：当前工作区里某个对象上的对话。不是任务。不能开成不属于任何对象的空白聊天。
_Avoid_: 任务, 全局聊天, 新对话（无对象）

**归档**:
对象从当前工作区会话列表拿开，可恢复。永久删除只作用于已归档对象，且须确认；删除时名下主张级联关窗（对象误建），简报留为孤儿快照，会话随之删除。主张不走归档，走关窗。
_Avoid_: 过时, 删除主张, 回收站当账本, 挂空对象的幽灵主张

**对象页**:
当前对象的工作面。主栏是挂在该对象下的对话；档案投影、已绑定来源、简报按需在右栏打开。投影仍是主张按谓词槽编，冲突并排，未知空着，不准出现账本里没有的新判断。顶栏办事：调研、出简报、任务回放。
_Avoid_: wiki, 档案正文, compiled truth, 简介, 无对象的首页对话, 把档案做成主表

**对话**:
挂在当前对象下，打开对象后占主栏。默认只问、只解释、带引用。明确「这句不对 / 记下来」才写入纠正或使用者陈述。闲聊不自动抽主张。出站纪律与简报相同。
_Avoid_: 全局聊天, 知识库问答框, 闲聊入库, 无对象首页会话

**Inbox**:
丢入原文、文件或链接的进料口，允许未绑定。未绑定可打开、可被召回，不投影到对象页，不进入对象对话的默认语境。上页必须绑定到至少一个对象；可同时挂多个对象。不自动乱绑。已绑定可解绑回 Inbox（该对象下的主张随撤）；来源可删除（主张级联关窗，须列出受影响条数）。
_Avoid_: 首页, 对话, 未绑定就当档案, 只进不出

**绑定**:
把来源归到一个或多个对象。绑定后由主张抽取循环抽取并投影到对象页。系统可以建议对象，须人确认。
_Avoid_: 自动归类（无人确认）, 对话里抽主张

**简报**:
挂在对象和任务下的出站快照，不是第四种对象。当时账本里能出站的主张，带着引用、未知和未核标记。对象页继续长；同一对象上可留多份历史简报。
_Avoid_: 报告, 问答回复, 生成文章, 总结, wiki 页, 来源（默认不把简报当新出处）

**任务**:
从对象上开的办事意图。种类：调研、出简报、再搜一轮、周期性雷达。再搜一轮与失败重跑都是带上轮语境的新任务，不是旧任务续帧。生成简报不自动重跑调研。雷达须显式创建，不是隐式爬虫。不是左侧的对象会话。
_Avoid_: 把任务叫成会话, 提示词, 工作流, 常驻爬虫, 取消（待启动撤回即删记录，不设取消态）

**未知**:
材料不足以支撑判断时的合法结果，是页面与简报的占位语义：槽内无主张、检索失败时格子空着。不是主张状态的枚举值。页面和简报必须能停在未知。检索失败时列出搜过什么，不编，也不写成负事实主张。
_Avoid_: 主张状态（不是账本字段的值）, 空状态, 生成失败, 待补全, 用常识填满, 「没搜到所以没有」

**任务审计**:
一次任务里实际搜过的查询、平台、打开结果、失败 URL、停止原因。属于过程回放，不是来源，不能当主张出处。
_Avoid_: 来源, 检索命中列表（若直接当入库）

**快搜**:
调研任务的默认档。过程有硬顶（搜索次数、打开次数、跳数、步数、墙钟、费用）。不是「必须写入 N 条」。
_Avoid_: 浅检索（若当成不入库）

**深挖**:
任务里显式打开的高预算档，硬顶更高，仍顶过程不顶写入条数。
_Avoid_: 无上限爬虫

**硬顶**:
任务过程的停止闸。触顶后已成功打开的照写入库，没拿到的保持未知，原因写入任务审计。不因触顶编造或作废半成品。
_Avoid_: 写入配额, 触顶即整任务失败

**评测集**:
产品内的金标包：对象、来源、主张、出处片段、简报该出/不该出的结论、该为未知的格子。内置包用虚构对象、按场景选材，不随真实世界腐烂。改召回、抽取或出站纪律后必须复跑。
_Avoid_: 通用问答集, 合成灌水题, 真实公司金标（会过时）

**资格认证**:
对当前模型配置跑内置虚构金标包的检验，出分数卡。首启默认跑、可跳过；未认证的配置徽章持续可见，换模型或端点后回落未认证，直到补跑。不是模型排行榜。
_Avoid_: 排行榜, 通用基准, 硬闸（未认证仍可用）

**评测**:
主链上可回归的质量：证据 Recall@k、Precision@k 与 MRR、简报对引用的忠实、未知遵守、冲突检出、纠正复发。结果在产品里可见。
_Avoid_: 只有作者知道的脚本, 向量库展览仪表盘

**记忆**:
关于使用者的偏好、纠正、禁写和简报习惯。与来源上的业务事实分开存放。纠正必须写入记忆，否则同样错误会再出站。世界事实不进记忆。
_Avoid_: 长期记忆, 知识, 用户画像, 主张

**纠正**:
使用者否定一条主张。旧主张关窗且不改原文；若有可核对的新命题，则新增主张，出处为使用者陈述。对象页当前投影可重写，账本旧句保留。
_Avoid_: 静默改写, 覆盖原行, 只改这一次生成

**撤销**:
结果卡上的回退入口：对已发生的写动作追加一条补偿写，不抹历史。单条日常动作一键可撤、不限时；批量晋升的补偿须确认。永久删除对象与移除工作区不可撤销。
_Avoid_: 删日志, 回滚快照, 撤销历史, 时间窗

**补偿**:
一个写动作的逆动作，本身也是写操作、也进操作日志，可再补偿。补偿覆盖该动作的全部下游效果（纠正的补偿连带其禁写与配套新主张）；下游已被晋升出站的，补偿须确认。关窗的补偿是重开，重开不改写原关闭原因，历史完整。内部机制名，界面上一律叫撤销或回退。
_Avoid_: 删除原操作, 覆盖, rollback, dream（不进界面同理）

**关闭原因**:
关窗时必填：世界已变、从未成立、来源删除、对象误建。世界已变的旧主张在有效期内仍是历史事实；后三种默认不再作为出站定论，留下是为了防止再写入。
_Avoid_: 一律叫过时, 命题为假（来源删除与对象误建不是真假判断）

**使用者陈述**:
使用者亲口给出的判断或纠正。进料路径为手给，冲突优先级最高。
_Avoid_: 第四级来源, 无出处主张

**审计卡**:
点开对象页或简报上的一句后在主栏看到的账本：正文、状态、关闭原因、冲突双方、原文片段、进料路径、是否未核。这就是审计。旧名「主张抽屉」，抽屉形态已被 0027 否决。
_Avoid_: 主张抽屉（旧名）, 浮层抽屉, 合规模块, 引用列表（无原文）

**关系**:
对象之间可跳转的边：人↔组织、项目↔组织、人↔项目。不是展览图谱。
_Avoid_: 知识图谱（若当功能名）, 全量可视化

**整理**:
任务后或空闲时的提议：合并重复主张、补关系、标可能过时、给未编目谓词编目、丢弃滞留的未核、提议建新对象。人确认才改账本。不挡进料。不是 dream。
_Avoid_: 静默改写, dream, 记忆整理, 夜间（本机形态应用没开就不跑）

**回放**:
挂在任务上的过程：步骤、搜索、打开、抽取、停止原因。能停、能看。雷达错过的周期如实记未跑，补跑的轮次标迟跑。不是对话历史。
_Avoid_: 聊天记录, trace（若当产品名）, 假装跑过

**简报说明**:
由工作区场景决定的某类简报必须有的块、禁止写死的结论、未知如何占位。内置场景各带一份；面试预设含：组织是谁、在招什么、技术信号、可能问什么、材料缺口。
_Avoid_: 提示词模板（若当产品名）, 全局唯一一份

**适配层**:
眼睛这一组工具的实现：把本机 Agent Reach 收成搜、打开、体检。返回规范化结果。不抽主张、不写对象页。
_Avoid_: 重写爬虫, 让模型直接拼上游 CLI, 眼睛（那是工具组名）

**用户侧**:
本机桌面应用。用户自配 OpenAI 兼容端点、密钥和模型。大脑文件留在本机。不是你们运营账号和模型的 C 端。
_Avoid_: 多租户, 托管 Cookie, 充值套餐, 浏览器网站（若当产品形态）

**说明书**:
每次开场必读的规矩：出站纪律、未知如何占位、简报说明。按场景预置默认稿，人维护；会话里冒出来的偏好不写进去。不是记忆。
_Avoid_: 空稿起步, 记忆, 提示词模板（若当产品名）, CLAUDE.md, AGENTS.md（若当产品名）

**眼睛**:
harness 的获取工具组。实现是适配层。只有调研任务才重用。不抽主张、不写记忆。
_Avoid_: 记忆工具, 直接拼上游 CLI, 账本工具

**主会话**:
使用者对着对象问、调研、出简报的那条循环。继续跑，不把抽记忆和 dream 塞进同一轮。
_Avoid_: 抽取循环, dream

**抽取循环**:
主会话背后专门从本会话抽取并写入记忆的 agent 循环。只看本会话原文，不把已经召回的记忆再抽一遍。闲聊不产候选。不管主张。
_Avoid_: 主会话顺手抽, 每句入库, 世界事实进记忆, 主张抽取循环

**主张抽取循环**:
来源绑定或调研成功打开之后，主会话背后专门从原文抽主张的循环。默认未核，须能指回片段，谓词须映射到受控表；映射不上则未编目。不挡对话，不抽闲聊，不把记忆当主张。
_Avoid_: 对话里抽主张, 抽取循环, 每打开即阻塞等待抽完

**候选记忆**:
抽取循环从本会话扫出、尚未并入耐久记忆的条目，带着会话出处。逐轮即产、随会话累积，不等会话结束；明确「记下来」和纠正不走候选，立刻写耐久。范围默认由提议给定，确认卡上可改。
_Avoid_: 主张, 已生效记忆

**dream**:
对记忆（不是主张）的后台整理循环：合并重复、让已写入的禁写保持生效、丢掉噪声候选。单独加锁，不挡主会话，不改账本。吃不准的合并不自动覆盖。这是内部循环名，不出现在界面。
_Avoid_: 整理, 静默删主张, 主会话里整理记忆, 功能名展览

**禁写**:
纠正写入的记忆：以后出站不得再写出那句错的。纠正当时立即生效，不等 dream。只保护已出过站的定论；未核主张被纠正直接丢弃，不写禁写。拦截按「对象+谓词槽+归一化取值」与被纠正原句双路，作用于出站与提议生成；抽取入账不拦。
_Avoid_: 删除主张, 只改这一次生成, 等整理才生效, 拦截未核垃圾（丢掉就好，不值得永久拦截）

**全局记忆**:
跨对象仍成立的偏好、禁写、简报习惯。
_Avoid_: 项目记忆（易和对象种类「项目」混）, 主张

**对象记忆**:
只关于当前这个人、组织或项目怎么用系统的习惯。不自动从会话升上来。
_Avoid_: 项目记忆（若指 git 仓库）, 主张

**会话记忆**:
这一次对话的摘要与候选。不自动升到对象或全局。
_Avoid_: 长期记忆, 主张

# 持久化按脏表差异写入，全量重写只留修复路径

`Brain.dispatch` 的写路径是「每次全量 DELETE-all/INSERT-all 14 表 + FTS 全量重建」（persist.ts 的 persistLedger）。账本一大，每个点击、每条任务审计都在同步重写全部数据：来源正文单条可达百万字符，调研每个审计事件触发一次全量重写。这是本仓唯一随数据量复利的技术债。

写路径改为**按表差异写入**：dispatch 内 prev 与 next 都在内存（prev 每次从库现读，单写者、全程同步，diff(prev,next) ≡ diff(DB,next)），逐表比较后只写脏表——行级按主键三分：prev 有 next 无则 DELETE，next 有 prev 无则 INSERT，两侧都有但序列化行值不等则 UPDATE。判脏标准是**序列化行值相等**，引用相等只作跳过的 fast-path：引用相同必未变（不可变性审计已确认无就地改集合的写路径），引用不同未必真变（`MARK_TURN_PLAYED` 等只改不落库字段）。子表（object_relations、source_bindings）与派生序（chat_messages.seq、write_queue.position）纳入各自父表的脏粒度。

约束一：**UPDATE 保留 created_at 原值**，stateStamp 只给新 INSERT 行。created_at 列语义从「最后全量重写时间」变为「首次落库时间」；排序等价由「reducer 不重排持久化集合」的不变量保证（现状满足，升格为红线：禁止对 loadLedger/snapshot 产物与 reducer 入参的就地修改，engine.ts 的「先拷贝再改自己的副本」是唯一合法模式）。write_queue 的 position 跟随数组下标重排例外。约束二：operations、certs、scenario_brief_specs 与 app_meta 中 persist 不认识的键不在 diff 删除射程。约束三：FTS 只在 claims 脏时重建（首版仍用全量 rebuildFts，并移入同一事务收窄崩溃窗口）；触发器化留后续刀，前置是 claims 行 UPDATE 保 rowid。约束四：写路径唯一漏斗保持 `Brain.dispatch → persist*`，persist.ts 之外不得新增集合写。

全量重写路径保留为修复与等价性验证通道（迁移后修复、测试对照）。读路径（每次 dispatch 两次 loadLedger）本刀不动，留后续刀。等价性由 `tests/brain/persist-diff.test.ts` 钉死：同一动作剧本在冻结时钟下分别灌全量库与 diff 库，断言 loadLedger 深相等、operations 序列相等、FTS 语义相等，且纯 UI 动作（SET_VIEW/TOAST）在 diff 路径下业务表写语句数趋零。备份/恢复/迁移语义不变：文件级备份、open 时迁移与种子仍在 dispatch 之外，diff 的 prev 永远现读 DB。

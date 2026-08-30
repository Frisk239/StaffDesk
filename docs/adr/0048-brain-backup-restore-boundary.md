# 大脑备份与恢复边界

ADR 0020 把 StaffDesk 定为本机 SQLite 单文件大脑，ADR 0040 与 0043 又把 API Key、模型端点、当前模型、
思考强度和资格认证提升为机器上的产品级设置。此前设置页只有“导出 zip 不含密钥”的弱入口；如果没有恢复
边界，用户迁移或回滚大脑时容易把模型配置、认证记录、测试残留或运行缓存也误认为“大脑”的一部分。

StaffDesk 的大脑备份是一个 StaffDesk 自有 zip：必须包含 `manifest.json` 与 `brain.db`，清单声明产品、
格式版本、创建时间、schemaVersion、数据库大小与 sha256。备份只覆盖业务账本：工作区、对象、来源、主张、
记忆、任务、简报、操作日志、预设表和必要索引。备份显式不包含 API Key、模型设置、资格认证、运行缓存、
构建产物或 Electron/userData 中的其它机器级文件。

模型设置类动作也不属于大脑操作日志：`UPSERT_PROVIDER`、`REMOVE_PROVIDER`、`SET_ACTIVE_PROVIDER`、
`SET_ACTIVE_MODEL`、`SET_THINKING` 只写产品级设置存储，不再追加进 `brain.db.operations`。旧库若曾把这些
动作写进操作日志，打开时应清理，避免端点 URL 或模型选择随大脑备份迁移。

导出不能直接读可能带 WAL 的 SQLite 主文件；必须从当前打开的 SQLite 连接生成一致性备份，再写入 zip。
恢复必须先验证 zip 中央目录、条目名、store-only 条目、CRC、manifest、sha256、SQLite header、integrity
和 StaffDesk 必要表，再替换当前 `brain.db`。恢复前必须自动导出当前大脑安全副本，恢复替换时要移除旧
`brain.db-wal` / `brain.db-shm` sidecar，避免旧库 WAL 叠到新库上。恢复完成后应用继续使用同一个机器级
secret store、model-settings store 与 quality-qualification store。

设置页是这条用户路径的入口：导出给用户一个可保存的 StaffDesk 备份 zip；恢复必须有二次确认，并明确说明
会替换大脑文件、会自动保存恢复前副本、不会覆盖模型端点/API Key/资格认证。恢复失败不得半开新库；能回滚
则回到恢复前大脑，并把失败原因显示为可行动短句。

本决策不包含第三方知识库导入、Markdown/PDF 简报导出、云同步、多大脑切换器、模型配置迁移向导、旧原型
mock 数据导入，也不改变模型配置唯一入口仍在设置页“模型”页的裁决。

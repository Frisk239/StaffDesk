# 中文主张召回用 FTS5 trigram，不用 unicode61 默认切分

FTS5 先行（实施计划 §3）。unicode61 按 Unicode 词边界切；中文没有空格，整句常被当成一个 token。trigram 按三字符切片，三字及以上查询能命中。二字查询 trigram 常为空，退回当前对象 `text LIKE`。StaffDesk：`claims_fts` 使用 `tokenize='trigram'`，短查询走片段包含。迁移版本 2 重建该虚表。不在 M2 引入向量索引。

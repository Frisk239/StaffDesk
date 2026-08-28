# 用户侧 BYOK 本机软件；SQLite 一份文件；不上 Redis

做成运营型 C 端会变成多租户和模型转售，并要把 Agent Reach 的浏览器登录态放到你们机器上。Cherry Studio、Open WebUI 一类是用户填自己的 Key；NotebookLM 才是 C 端。个人 Agent 记忆默认 SQLite；Postgres 在多人同时写或云托管时才必要；Redis 给多实例队列用。StaffDesk：Node + React，本机跑，用户配置兼容端点。大脑用 SQLite 单文件（可加 FTS/向量扩展）。不上 Redis、不上开题必装的 Postgres。表结构留以后迁 Postgres 的缝，产品先不碰托管。

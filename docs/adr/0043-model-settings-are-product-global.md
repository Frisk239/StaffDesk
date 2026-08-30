# 模型配置属于产品级设置，不属于大脑文件或工作区

ADR 0020 确定 StaffDesk 是本机 BYOK，ADR 0040 确定 API Key 不进大脑文件，但此前没有裁决供应商、当前模型与思考强度应挂在哪里。把这些字段放进 `brain.db` 会让使用者每换一个大脑文件或工作区就重复配置，还会让原型默认项覆盖真实端点。

StaffDesk：模型供应商、当前模型与思考强度是产品级全局设置，设置一次供所有工作区和大脑文件共用。非敏感元数据存放在 Electron `userData/model-settings.json`，API Key 继续由 `safeStorage` 加密并独立存放。设置页是唯一完整管理入口；首启向导只能复用同一份状态与写入路径，不得建立第二套配置。

旧大脑文件若含真实配置，在全局设置为空时迁移一次；迁移成功后删除 `providers`、`activeProviderId`、`activeModelId`、`thinkingEffort` 的库内副本。随原型写入、未配置密钥且未修改的默认供应商不迁移。模型调用统一通过一个运行时 interface 取得当前可调用模型；业务 module 不自行读取设置文件或创建协议客户端。

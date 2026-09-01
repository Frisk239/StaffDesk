# 检索多路并行走零配置工具清单；登录态平台不进 v1

「检索」词条写「可以多平台、多路并行」，实现一直是单路硬编码（mcporter call exa.web_search_exa 一条路）。架构事实：agent-reach CLI 是认证与配置管理层（setup/doctor/configure，无 search 命令），查询执行统一走 mcporter 调 MCP 工具；零配置渠道约六个（Exa 全网搜索免费无 Key、GitHub 公开仓库、YouTube 等），Reddit/Twitter/小红书等要 Cookie 或登录态。拍板：reach 适配器从单后端抽象为多路清单——每路 =（mcporter 工具名、参数、解析器），doctor 按路体检，引擎同一查询并行扇出体检通过的路、按 URL 去重合并，任务审计记路径与各路成败；searches 硬顶按路计（多路一次查询消耗多路预算，费用触顶口径 0059 不变）。登录态平台明确不进 v1：产品可用性不得绑死在机器认证配置上，doctor 红的路静默跳过并在审计标注。词条同步改写为「多路并行，路径由体检通过的零配置检索工具决定」。起步清单 = Exa + GitHub 公开搜索两路；实现排 M30。

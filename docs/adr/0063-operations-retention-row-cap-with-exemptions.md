# operations 留痕按行数上限裁旧，证据类行豁免永不裁

operations 操作账本无界增长（审计 D4）：每次 dispatch 一行、payload 含快照，撤销/回放/已删除来源恢复（listDeletedSourceRecoveries 全表扫描 JSON.parse）都靠它。拍板：仿 taskAudits 保留策略（M28 v10 先例）——**全局行数上限裁旧**：超限按 (created_at, id) 最旧先裁，恰好等于上限不动手；**豁免集合永不裁**：DELETE_SOURCE（删除恢复依赖其快照 payload，恢复入口在它就在）、纠正类（关窗+禁写的操作证据）、主键角色变更（0062 的角色历史）。裁剪做成纯函数（内存态裁 → persist 落库），dispatch 在 operations 引用变化时先裁再写，与 taskAudits 同款纪律。默认上限取单人年使用量级（如 20k 行）作常量并注释依据；豁免行占比失控属异常场景，不做二级兜底（上限兜住的是规模不是语义）。配套优化：恢复快照查询走既有 operations(action) 索引收敛全扫。实现排 M34。

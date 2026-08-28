# 评测是产品能力；金标对着主张主链，指标用面试官能懂的名

没有可回归的金标，召回率和 faithfulness 只能临场编。业内 RAGAS 给出 Context Recall / Precision / Faithfulness 的通行叫法；DeepEval 把评测当 pytest；RAGChecker 与 FActScore 按主张/原子命题做细粒度诊断，比整段打分更贴账本；GBrain-evals 测的是「对的记忆在不在前 k」，并同时报 Precision，避免堆一堆结果假装召回高。StaffDesk 不把 RAGAS 做成产品壳：评测集是本产品的对象/来源/主张/Brief 金标，先 2–3 个对象即可。召回报金标证据的 Recall@k、Precision@k、MRR；生成报 Brief 句子对所引 span 的忠实、未知遵守率；账本报冲突检出与纠正复发。改召回或出站后复跑，页面能看见升降。实现可参考上述仓库的指标定义与跑法，判定标准仍是本仓库的主张与出站纪律。冲突只在受控谓词上计算；未编目谓词不计入冲突检出。

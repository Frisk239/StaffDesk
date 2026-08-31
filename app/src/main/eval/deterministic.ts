import type { ModelCompletion } from '../llm/runtime';
import type { GoldPack } from './goldPacks';

export interface DeterministicEvalOptions {
  /**
   * healthy：默认，把金标期望原样吐回。
   * sabotaged：制造低分但抽取仍“成功”的材料——丢一半 claims、其余 span 换成正文中
   * 不存在的失效片段（置 null 会被草稿 schema 整单拒收，异常失败测不到合格线路径）、
   * 注入一条 negatives 文本伪主张（span 用对象名，指得回原文，真会落账）。
   */
  mode?: 'healthy' | 'sabotaged' | undefined;
}

/** 命令行回归 adapter：只按内置虚构金标返回确定性结构，不进入产品运行时。 */
export function createDeterministicEvalCompletion(
  packs: readonly GoldPack[],
  options?: DeterministicEvalOptions,
): ModelCompletion {
  const sabotaged = options?.mode === 'sabotaged';
  return async (request) => {
    const material = request.messages.map((message) => message.content).join('\n');
    const pack = packs.find((candidate) => material.includes(candidate.source.body));
    if (!pack) {
      return { content: '{"claims":[]}', toolCalls: [] };
    }
    const claims = pack.expected.map((item) => ({
      objectName: pack.object.name,
      predicate: item.predicate,
      text: `${pack.object.name}${item.predicate}是${item.textIncludes}`,
      span: item.spanIncludes,
    }));
    if (!sabotaged) {
      return { content: JSON.stringify({ claims }), toolCalls: [] };
    }
    const kept = claims
      .slice(0, Math.ceil(claims.length / 2))
      .map((claim) => ({ ...claim, span: `（失效出处）${claim.span}` }));
    const fabricated = {
      objectName: pack.object.name,
      predicate: pack.expected[0]?.predicate ?? '未编目',
      text: `${pack.object.name}${pack.negatives[0] ?? '未经证实的夸大结论'}`,
      span: pack.object.name,
    };
    return { content: JSON.stringify({ claims: [...kept, fabricated] }), toolCalls: [] };
  };
}

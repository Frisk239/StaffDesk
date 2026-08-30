import type { ModelCompletion } from '../llm/runtime';
import type { GoldPack } from './goldPacks';

/** 命令行回归 adapter：只按内置虚构金标返回确定性结构，不进入产品运行时。 */
export function createDeterministicEvalCompletion(packs: readonly GoldPack[]): ModelCompletion {
  return async (request) => {
    const material = request.messages.map((message) => message.content).join('\n');
    const pack = packs.find((candidate) => material.includes(candidate.source.body));
    if (!pack) {
      return { content: '{"claims":[]}', toolCalls: [] };
    }
    return {
      content: JSON.stringify({
        claims: pack.expected.map((item) => ({
          objectName: pack.object.name,
          predicate: item.predicate,
          text: `${pack.object.name}${item.predicate}是${item.textIncludes}`,
          span: item.spanIncludes,
        })),
      }),
      toolCalls: [],
    };
  };
}

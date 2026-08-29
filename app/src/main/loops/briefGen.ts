import { z } from 'zod';
import type { Brief, BriefBlock, State } from '@shared/types';
import { outboundBrief, verifyBrief } from '../brain/briefOut';
import type { ChatMessageParam, CompleteResult } from '../llm/chatCompletions';

const LlmBriefSchema = z.object({
  blocks: z.array(
    z.object({
      title: z.string(),
      sentences: z.array(
        z.object({
          text: z.string(),
          claimIds: z.array(z.string()).default([]),
        }),
      ),
    }),
  ),
});

/** 有模型时按场景说明组句，仍必须过出站闸；没有模型用账本组装器。 */
export async function generateBrief(args: {
  state: State;
  objectId: string;
  briefId: string;
  taskId: string;
  complete?: ((req: { messages: ChatMessageParam[]; jsonMode?: boolean | undefined }) => Promise<CompleteResult>) | undefined;
}): Promise<Brief> {
  const base = outboundBrief(args.state, args.objectId, args.briefId, args.taskId);
  if (!args.complete) return base;
  try {
    const allowed = args.state.claims.filter((c) => c.objectId === args.objectId && c.status === '成立');
    const result = await args.complete({
      jsonMode: true,
      messages: [
        {
          role: 'system',
          content: [
            '按给定块标题写简报。每句必须带 claimIds，ID 只能用清单里的。',
            '没有出处就写未知占位，claimIds 为空。不准编新事实。',
            '主张清单：',
            ...allowed.map((c) => `${c.id}｜${c.predicate}｜${c.text}`),
          ].join('\n'),
        },
        {
          role: 'user',
          content: JSON.stringify(base.blocks.map((b) => b.title)),
        },
      ],
    });
    const parsed = LlmBriefSchema.parse(JSON.parse(result.content));
    const blocks: BriefBlock[] = base.blocks.map((block) => {
      const hit = parsed.blocks.find((b) => b.title === block.title);
      if (!hit) return block;
      return {
        title: block.title,
        sentences: hit.sentences.map((s) => ({
          text: s.text,
          claimIds: s.claimIds,
          unverified: false,
          kind: s.claimIds.length ? 'claim' : 'unknown',
        })),
      };
    });
    return verifyBrief({ ...base, blocks }, args.state.claims);
  } catch {
    return base;
  }
}

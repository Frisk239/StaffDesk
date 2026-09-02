import { buildBrief } from '@shared/brief';
import type { Brief, BriefSentence, Claim, State } from '@shared/types';

/** 无 claimId 的句子只能是未知占位，未编目不当单边定论。 */
export function outboundBrief(
  state: State,
  objectId: string,
  briefId?: string,
  taskId?: string,
): Brief {
  const brief = buildBrief(state, objectId, briefId, taskId);
  return verifyBrief(brief, state.claims);
}

export function enforceUnknownPlaceholder(sentence: BriefSentence): BriefSentence {
  if (sentence.claimIds.length === 0) {
    return { ...sentence, kind: 'unknown', unverified: false };
  }
  return sentence;
}

export function sentenceIsUnknownPlaceholder(sentence: BriefSentence): boolean {
  return sentence.claimIds.length === 0 && sentence.kind === 'unknown';
}

/**
 * 出站闸：句子必须能指回仍成立的主张；对不上的降为未知；
 * 未编目不得当单边定论。
 */
export function verifyBrief(brief: Brief, claims: Claim[]): Brief {
  const live = new Map(claims.filter((c) => c.status === '成立').map((c) => [c.id, c]));
  return {
    ...brief,
    blocks: brief.blocks.map((block) => ({
      ...block,
      sentences: block.sentences.map((sentence) => sanitizeSentence(sentence, live)),
    })),
  };
}

function sanitizeSentence(sentence: BriefSentence, live: Map<string, Claim>): BriefSentence {
  const ids = sentence.claimIds.filter((id) => live.has(id));
  if (ids.length === 0) {
    const keep = sentence.kind === 'unknown' && sentence.text.startsWith('未知');
    return {
      text: keep ? sentence.text : '未知：没有可核对出处，本句不出站。',
      claimIds: [],
      unverified: false,
      kind: 'unknown',
    };
  }
  const pointed = ids.map((id) => live.get(id)).filter((c): c is Claim => Boolean(c));
  const onlyUncataloged = pointed.every((c) => c.predicate === '未编目');
  if (onlyUncataloged && sentence.kind !== 'unknown') {
    return {
      text: `材料提到：${sentence.text.replace(/。$/, '')}（未编目，不作定论）`,
      claimIds: ids,
      unverified: pointed.some((c) => c.unverified),
      kind: 'claim',
      flag: '未编目·不作定论',
      // 0062：出站闸重写 flag 时不得吞掉主键标注——降级不改主张的来源绑定。
      primarySourceIds: sentence.primarySourceIds,
    };
  }
  return enforceUnknownPlaceholder({
    ...sentence,
    claimIds: ids,
    unverified: pointed.some((c) => c.unverified),
  });
}

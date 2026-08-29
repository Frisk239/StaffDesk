import type { Brief, BriefBlock, BriefSentence, Claim, State } from './types';
import { BRIEF_SPECS, deriveConflicts, scenarioOfWorkspace } from './scenario';

// 简报组装（纯函数，出站纪律都在这里）：
// - 简报说明由工作区场景决定（0033）：BRIEF_SPECS 给块清单，本组装器按块 kind 装内容。
// - 只读当时账本里能出站的主张：status 成立、未被禁写命中。
// - 每个主张句必须带 claimIds；unknown 句是占位，不是世界判断，绝不伪装成主张。
// - 冲突派生（0029）后按谓词摊开在对应槽块里，不合成「目前有争议」。
// - 未核必须带标记；未编目不作单边定论（降级为「材料提到」，收进材料缺口）。
// - 未知保持未知，缺口写清楚缺什么。

/** 禁写命中的措辞，不得再当单边定论。提议生成处也要过。 */
export function bannedHit(state: State, claim: Claim): boolean {
  return state.memories.some(
    (m) => m.kind === '禁写' && m.text.includes('：「') && m.text.includes(claim.text),
  );
}

/** 当时能出站的主张 */
function outstationClaims(state: State, objectId: string): Claim[] {
  return state.claims.filter(
    (c) => c.objectId === objectId && c.status === '成立' && !bannedHit(state, c),
  );
}

function claimSentence(claim: Claim, flag?: BriefSentence['flag']): BriefSentence {
  return {
    text: claim.text,
    claimIds: [claim.id],
    unverified: claim.unverified,
    kind: 'claim',
    flag,
  };
}

function unknownSentence(text: string): BriefSentence {
  return { text, claimIds: [], unverified: false, kind: 'unknown' };
}

export function buildBrief(state: State, objectId: string, briefId?: string, taskId?: string): Brief {
  const obj = state.objects.find((o) => o.id === objectId);
  const scenario = obj ? scenarioOfWorkspace(state.workspaces, obj.workspaceId) : '求职面试';
  const spec = BRIEF_SPECS[scenario];
  const out = outstationClaims(state, objectId);
  const slotPredicates = new Set(spec.flatMap((b) => b.predicates ?? []));
  const conflicts = deriveConflicts(state.claims, state.slotDefs);
  const conflictedIds = new Set(conflicts.flatMap((c) => [c.claimIdA, c.claimIdB]));

  const blocks: BriefBlock[] = spec.map((blockSpec) => {
    if (blockSpec.kind === 'background') {
      // 背景块：不落入任何槽位块的主张；没有就停在未知。
      const background = out.filter((c) => !slotPredicates.has(c.predicate) && c.predicate !== '未编目');
      return {
        title: blockSpec.title,
        sentences: background.length
          ? background.map((c) => claimSentence(c))
          : [unknownSentence(`未知：账本中暂无关于「${blockSpec.title}」的主张，本块不编。`)],
      };
    }

    if (blockSpec.kind === 'slots') {
      // 槽块：指定谓词的主张；冲突派生后两侧都在本块谓词内才摊开；空则未知。
      const sentences: BriefSentence[] = [];
      const preds = blockSpec.predicates ?? [];
      for (const pred of preds) {
        const inSlot = out.filter((c) => c.predicate === pred);
        for (const c of inSlot) {
          if (conflictedIds.has(c.id)) {
            const pair = conflicts.find((p) => p.claimIdA === c.id || p.claimIdB === c.id);
            const otherId = pair ? (pair.claimIdA === c.id ? pair.claimIdB : pair.claimIdA) : null;
            const other = out.find((x) => x.id === otherId);
            if (other && other.predicate === pred) {
              // 每条冲突句只摊一次（取字典序靠前那条开场）
              if (c.id < other.id) {
                sentences.push(claimSentence(c, '冲突·并排'));
                sentences.push(claimSentence(other, '冲突·并排'));
              }
            } else {
              sentences.push(claimSentence(c));
            }
          } else {
            sentences.push(claimSentence(c));
          }
        }
      }
      return {
        title: blockSpec.title,
        sentences: sentences.length
          ? sentences
          : [unknownSentence(`未知：账本中暂无「${blockSpec.title}」相关主张。`)],
      };
    }

    if (blockSpec.kind === 'synthesis') {
      // 综合块：由多条主张推的读法，必须指回主张；主张不足就停在未知。
      const base = out.filter((c) => slotPredicates.has(c.predicate) && !conflictedIds.has(c.id));
      if (base.length === 0) {
        return {
          title: blockSpec.title,
          sentences: [unknownSentence(`未知：账本主张不足，给不出「${blockSpec.title}」的读法，不编。`)],
        };
      }
      return {
        title: blockSpec.title,
        sentences: [
          {
            text: `按账本现有 ${base.length} 条主张，「${blockSpec.title}」的读法：`,
            lines: base.map((c) => c.text),
            claimIds: base.map((c) => c.id),
            unverified: base.some((c) => c.unverified),
            kind: 'synthesis',
          },
        ],
      };
    }

    // gaps：材料缺口。未编目降级句、空槽未知、未核计数。
    const sentences: BriefSentence[] = [];
    const uncataloged = out.filter((c) => c.predicate === '未编目');
    for (const c of uncataloged) {
      sentences.push({
        text: `材料提到：${c.text.replace(/。$/, '')}（未编目，不作定论）`,
        claimIds: [c.id],
        unverified: c.unverified,
        kind: 'claim',
        flag: '未编目·不作定论',
      });
    }
    for (const pred of slotPredicates) {
      if (out.filter((c) => c.predicate === pred).length === 0) {
        sentences.push(unknownSentence(`${pred}：未知（账本内无主张，未编造）。`));
      }
    }
    const unverifiedCount = out.filter((c) => c.unverified).length;
    if (unverifiedCount > 0) {
      sentences.push({
        text: `未核主张 ${unverifiedCount} 条：出站时均带「未核」标记，可按条晋升后再出简报。`,
        claimIds: out.filter((c) => c.unverified).map((c) => c.id),
        unverified: true,
        kind: 'synthesis',
      });
    }
    if (sentences.length === 0) sentences.push(unknownSentence('暂无明显材料缺口。'));
    return { title: blockSpec.title, sentences };
  });

  return {
    id: briefId ?? `brief-${state.seq}`,
    objectId,
    taskId: taskId ?? `task-brief-${state.seq}`,
    createdAt: new Date().toISOString().replace('T', ' ').slice(0, 16),
    blocks,
  };
}

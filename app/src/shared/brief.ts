import type { Brief, BriefBlock, BriefSentence, Claim, State } from './types';
import { deriveConflicts, normalizeValue, scenarioOfWorkspace } from './scenario';
import { isPrimaryBacked } from './primarySource';

// 简报组装（纯函数，出站纪律都在这里）：
// - 0058：简报说明改读场景模板（state.scenarioTemplates，数据行）；
//   本组装器按块 kind 装内容。
// - 只读当时账本里能出站的主张：status 成立、未被禁写命中。
// - 每个主张句必须带 claimIds；unknown 句是占位，不是世界判断，绝不伪装成主张。
// - 冲突派生（0029）后按谓词摊开在对应槽块里，不合成「目前有争议」。
// - 未核必须带标记；未编目不作单边定论（降级为「材料提到」，收进材料缺口）。
// - 0062：主张句的主键标注按当前对象视角填 primarySourceIds（主张级：其来源绑定是主键才标）。
// - 未知保持未知，缺口写清楚缺什么。

/**
 * 0054：禁写按双路判定，任一命中即拦——
 * 结构化路：同对象、同谓词槽、同归一化取值（拦换措辞复述与再抽取的同一结论）；
 * 原句路：禁写文本对被纠正原句的精确子串命中。
 * 原句路绝不能删：升级前的历史禁写行没有结构化列，只剩它兜住；只查新列即升级即静默解除历史禁写。
 * 出站闸与提议生成（enqueueWrite）两处共用此判定。提议生成处也要过。
 */
export function bannedHit(state: State, claim: Claim): boolean {
  const value = normalizeValue(claim.text);
  return state.memories.some((m) => {
    if (m.kind !== '禁写') return false;
    if (
      m.bannedObjectId === claim.objectId &&
      m.bannedPredicate === claim.predicate &&
      m.bannedValue === value
    ) {
      return true;
    }
    return m.text.includes('：「') && m.text.includes(claim.text);
  });
}

/** 当时能出站的主张 */
function outstationClaims(state: State, objectId: string): Claim[] {
  return state.claims.filter(
    (c) => c.objectId === objectId && c.status === '成立' && !bannedHit(state, c),
  );
}

function claimSentence(state: State, claim: Claim, flag?: BriefSentence['flag']): BriefSentence {
  return {
    text: claim.text,
    claimIds: [claim.id],
    unverified: claim.unverified,
    kind: 'claim',
    flag,
    primarySourceIds: primarySourceIdsOf(state, [claim.id]),
  };
}

/**
 * 0062：句子的主键标注——claimIds 涉及的主张里，其来源绑定（按当前对象视角）
 * 是主键的来源 id 集合；没有主键背书时返回 undefined（不写空数组占位）。
 * buildBrief 与 briefGen 的 LLM 分支共用此函数，两条组句路径的标注不漂移。
 */
export function primarySourceIdsOf(
  state: State,
  claimIds: readonly string[],
): string[] | undefined {
  const ids: string[] = [];
  for (const id of claimIds) {
    const claim = state.claims.find((c) => c.id === id);
    if (!claim || claim.status !== '成立') continue;
    if (isPrimaryBacked(state, claim) && !ids.includes(claim.sourceId)) {
      ids.push(claim.sourceId);
    }
  }
  return ids.length > 0 ? ids : undefined;
}

function unknownSentence(text: string): BriefSentence {
  return { text, claimIds: [], unverified: false, kind: 'unknown' };
}

export function buildBrief(
  state: State,
  objectId: string,
  briefId?: string,
  taskId?: string,
): Brief {
  const obj = state.objects.find((o) => o.id === objectId);
  const scenario = obj ? scenarioOfWorkspace(state.workspaces, obj.workspaceId) : '求职面试';
  // 0058：spec 改读场景模板；缺模板回落「自定义」基线模板，再缺回落空块数组——
  // 旧备份（无模板表数据）/删光模板的第二道保险，简报永远可组装、绝不因缺模板报错。
  const spec =
    state.scenarioTemplates.find((t) => t.name === scenario)?.briefSpec ??
    state.scenarioTemplates.find((t) => t.name === '自定义')?.briefSpec ??
    [];
  const out = outstationClaims(state, objectId);
  const slotPredicates = new Set(spec.flatMap((b) => b.predicates ?? []));
  const conflicts = deriveConflicts(state.claims, state.slotDefs);
  const conflictedIds = new Set(conflicts.flatMap((c) => [c.claimIdA, c.claimIdB]));

  const blocks: BriefBlock[] = spec.map((blockSpec) => {
    if (blockSpec.kind === 'background') {
      // 背景块：不落入任何槽位块的主张；没有就停在未知。
      const background = out.filter(
        (c) => !slotPredicates.has(c.predicate) && c.predicate !== '未编目',
      );
      return {
        title: blockSpec.title,
        sentences: background.length
          ? background.map((c) => claimSentence(state, c))
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
                sentences.push(claimSentence(state, c, '冲突·并排'));
                sentences.push(claimSentence(state, other, '冲突·并排'));
              }
            } else {
              sentences.push(claimSentence(state, c));
            }
          } else {
            sentences.push(claimSentence(state, c));
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
          sentences: [
            unknownSentence(`未知：账本主张不足，给不出「${blockSpec.title}」的读法，不编。`),
          ],
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
            primarySourceIds: primarySourceIdsOf(
              state,
              base.map((c) => c.id),
            ),
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
        primarySourceIds: primarySourceIdsOf(state, [c.id]),
      });
    }
    for (const pred of slotPredicates) {
      if (out.filter((c) => c.predicate === pred).length === 0) {
        sentences.push(unknownSentence(`${pred}：未知（账本内无主张，未编造）。`));
      }
    }
    const unverifiedIds = out.filter((c) => c.unverified).map((c) => c.id);
    if (unverifiedIds.length > 0) {
      sentences.push({
        text: `未核主张 ${unverifiedIds.length} 条：出站时均带「未核」标记，可按条晋升后再出简报。`,
        claimIds: unverifiedIds,
        unverified: true,
        kind: 'synthesis',
        primarySourceIds: primarySourceIdsOf(state, unverifiedIds),
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

import type { Brief, Claim, Source } from '@shared/types';

// 审计 F4（2026-09-02）：简报出站出口唯一的 Markdown 组装——复制与导出共用这一份，
// 防两处格式漂移。引用一律转脚注：句后 [^n]，文末按首次出现顺序列 claim 的来源定位
// （谓词、来源标题/定位、原文片段）作审计指针。未知句没有 claimIds，不挂脚注。

function sourceLabelOf(claim: Claim, sources: readonly Source[]): string {
  if (claim.sourceId === 'user-stmt') return '使用者陈述';
  const source = sources.find((item) => item.id === claim.sourceId);
  if (!source) return '来源已删除';
  const parts: string[] = [source.title || source.id];
  const locator = source.origin?.locator;
  if (locator && locator !== source.title) parts.push(locator);
  if (claim.span) parts.push(`片段「${claim.span}」`);
  else if (claim.sourceLocator?.label) parts.push(claim.sourceLocator.label);
  return parts.join('，');
}

function sentenceAnnotations(sentence: Brief['blocks'][number]['sentences'][number]): string {
  const marks: string[] = [];
  if (sentence.flag) marks.push(sentence.flag);
  if (sentence.primarySourceIds && sentence.primarySourceIds.length > 0) marks.push('主键来源');
  if (sentence.unverified) marks.push('未核');
  return marks.length > 0 ? `（${marks.join('·')}）` : '';
}

/** 简报 → Markdown（纯函数）。复制与导出走同一份输出。 */
export function briefToMarkdown(args: {
  brief: Brief;
  objectName: string;
  headLine: string;
  claims: readonly Claim[];
  sources: readonly Source[];
}): string {
  const { brief, objectName, headLine, claims, sources } = args;
  const lines: string[] = [`# ${objectName}`, '', `> ${headLine}`, ''];
  const footnoteIds = new Map<string, number>();
  const footnotes: string[] = [];

  const footnoteRefs = (claimIds: readonly string[]): string => {
    const refs: string[] = [];
    for (const id of claimIds) {
      let no = footnoteIds.get(id);
      if (no === undefined) {
        no = footnoteIds.size + 1;
        footnoteIds.set(id, no);
        const claim = claims.find((item) => item.id === id);
        if (claim) {
          const label = sourceLabelOf(claim, sources);
          footnotes.push(`[^${no}]: 〔${claim.predicate}〕${claim.text} —— 来源：${label}`);
        } else {
          footnotes.push(`[^${no}]: 主张 ${id} 已不在账本`);
        }
      }
      refs.push(`[^${no}]`);
    }
    return refs.join('');
  };

  for (const block of brief.blocks) {
    lines.push(`## ${block.title}`, '');
    for (const sentence of block.sentences) {
      const refs = footnoteRefs(sentence.claimIds);
      const annotations = sentenceAnnotations(sentence);
      const suffix = `${annotations}${refs}`;
      if (sentence.lines && sentence.lines.length > 0) {
        lines.push(`- ${sentence.text}${suffix}`);
        for (const line of sentence.lines) lines.push(`  - ${line}`);
      } else {
        lines.push(`- ${sentence.text}${suffix}`);
      }
    }
    lines.push('');
  }

  if (footnotes.length > 0) {
    lines.push('---', '');
    lines.push(...footnotes, '');
  }
  return lines.join('\n');
}

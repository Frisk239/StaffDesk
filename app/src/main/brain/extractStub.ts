import type { Claim, DeskObject, SlotDef, Source } from '@shared/types';

const KEYWORD_SLOTS: { re: RegExp; name: string }[] = [
  { re: /主栈|Go\b|Java\b|Rust\b|Python\b|TypeScript/, name: '后端主栈' },
  { re: /招聘|在招|实习|岗位职责/, name: '在招岗位' },
  { re: /办公地点|工作地点|总部|坐落/, name: '办公地点' },
  { re: /融资|A 轮|B 轮|种子轮/, name: '融资轮次' },
  { re: /许可证|Apache|MIT|GPL/, name: '许可证' },
  { re: /发布节奏|例行发布|两周一次/, name: '发布节奏' },
  { re: /活跃贡献|社区热度|趋于冷清|活跃度/, name: '活跃度' },
  { re: /主营|流处理|基础设施/, name: '主营业务' },
  { re: /任职于|就职|面试官/, name: '任职于' },
  { re: /研究方向|导师/, name: '研究方向' },
];

function sentencesOf(body: string): string[] {
  return body
    .split(/[。！？\n]+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 8 && !/^【/.test(s) && !s.startsWith('#'));
}

function mapPredicate(sentence: string, kind: DeskObject['kind'], slotDefs: SlotDef[]): string {
  const slots = slotDefs.filter((d) => d.kind === kind);
  for (const slot of slots) {
    if (sentence.includes(slot.name)) return slot.name;
  }
  for (const hint of KEYWORD_SLOTS) {
    if (hint.re.test(sentence) && slots.some((s) => s.name === hint.name)) return hint.name;
  }
  return '未编目';
}

/**
 * M1 桩：绑定确认后按原文切句写入未核主张。不是 0024 真循环。
 * 幂等键 = (来源片段, 对象, 谓词槽)，重跑不追加。
 */
export function stubExtract(args: {
  source: Source;
  objects: DeskObject[];
  slotDefs: SlotDef[];
  now: string;
  existing: Claim[];
}): Claim[] {
  const bound = args.objects.filter((o) => args.source.boundObjectIds.includes(o.id));
  const sentences = sentencesOf(args.source.body);
  const out: Claim[] = [];
  const seen = new Set(
    args.existing.map((c) => `${c.sourceId}\0${c.objectId}\0${c.predicate}\0${c.span ?? c.text}`),
  );
  let i = 0;
  for (const obj of bound) {
    let wrote = 0;
    for (const sentence of sentences) {
      const predicate = mapPredicate(sentence, obj.kind, args.slotDefs);
      const text = /[。！？]$/.test(sentence) ? sentence : `${sentence}。`;
      const span = sentence.slice(0, 80);
      const key = `${args.source.id}\0${obj.id}\0${predicate}\0${span}`;
      if (seen.has(key)) continue;
      // 同一对象同一槽只留互斥所需的不同取值；多值槽可多条。
      const arity = args.slotDefs.find((d) => d.name === predicate && d.kind === obj.kind)?.arity;
      if (arity === '单值') {
        const sameSlotKeyPrefix = `${args.source.id}\0${obj.id}\0${predicate}\0`;
        const already = [...seen].some((k) => k.startsWith(sameSlotKeyPrefix) && k !== key);
        // 单值槽允许不同 text 并存（冲突派生），同源同句不重复。
        if (already && [...out, ...args.existing].some((c) => c.objectId === obj.id && c.predicate === predicate && c.text === text)) {
          continue;
        }
      }
      seen.add(key);
      i += 1;
      out.push({
        id: `cl-stub-${args.source.id}-${obj.id}-${String(i)}`,
        objectId: obj.id,
        predicate,
        text,
        status: '成立',
        unverified: true,
        validFrom: args.now.slice(0, 10),
        sourceId: args.source.id,
        span,
        createdAt: args.now.slice(0, 10),
      });
      wrote += 1;
      if (wrote >= 6) break;
    }
    if (wrote === 0 && sentences[0]) {
      const span = sentences[0].slice(0, 80);
      const text = /[。！？]$/.test(sentences[0]) ? sentences[0] : `${sentences[0]}。`;
      i += 1;
      out.push({
        id: `cl-stub-${args.source.id}-${obj.id}-${String(i)}`,
        objectId: obj.id,
        predicate: '未编目',
        text,
        status: '成立',
        unverified: true,
        validFrom: args.now.slice(0, 10),
        sourceId: args.source.id,
        span,
        createdAt: args.now.slice(0, 10),
      });
    }
  }
  return out;
}

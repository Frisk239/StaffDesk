import type { Claim, MemoryKind, State, WriteProposal } from './types';

// 对话脚本：默认只问、只解释、带引用。回复是 markdown，给 DSH 式渲染用。
// 硬规则：闲聊绝不 push claim（本文件没有任何写主张的出口）；
// 只从当前对象已入账的主张里挑引用；材料不够就答「未知」，不现场编。

export type ChatEffect =
  | { type: 'remember'; text: string; kind: MemoryKind }
  | { type: 'correct'; claimId: string }
  | { type: 'propose'; draft: Omit<WriteProposal, 'id'> }
  | { type: 'refuse' }
  | { type: 'toast'; text: string };

export interface ChatReply {
  replyText: string;
  claimRefs: string[];
  note?: string | undefined;
  effect?: ChatEffect | undefined;
}

/** 会改账本或记忆的入口，不走主会话只读循环。 */
export function isWriteIntent(text: string): boolean {
  const t = text.trim();
  if (/^记下来[:：]/.test(t)) return true;
  if (/这句不对|纠正/.test(t)) return true;
  if (/删掉|永久删除|移除工作区/.test(t)) return true;
  if (/把主栈那条晋升|晋升.*主栈|把.*Go.*晋升/.test(t)) return true;
  if (/并入使用技术|平台化.*并入|把平台化/.test(t)) return true;
  return false;
}

export function scriptReply(state: State, objectId: string, text: string): ChatReply {
  const t = text.trim();

  const rememberMatch = t.match(/^记下来[:：]\s*(.+)$/);
  if (rememberMatch) {
    const content = rememberMatch[1] ?? '';
    if (!content) {
      return unknownReply();
    }
    const kind: MemoryKind = /简报|出站/.test(content) ? '习惯' : '偏好';
    return {
      replyText: [
        '已记下，立刻生效，不走候选记忆。',
        '',
        `- 范围：全局${kind === '习惯' ? '（简报习惯）' : ''}`,
        `- 正文：「${content}」`,
      ].join('\n'),
      claimRefs: [],
      note: '已写入全局记忆',
      effect: { type: 'remember', text: content, kind },
    };
  }

  if (/删掉|永久删除|移除工作区|删了周若水/.test(t)) {
    return {
      replyText: '这个我不代做，永久删除和工作区移除请你在界面里操作。',
      claimRefs: [],
      effect: { type: 'refuse' },
    };
  }

  if (/把主栈那条晋升|晋升.*主栈|把.*Go.*晋升/.test(t)) {
    const c = claimsOf(state, objectId).find((x) => x.predicate === '后端主栈' && /Go/.test(x.text) && x.status !== '过时');
    if (!c) return unknownReply();
    return {
      replyText: '晋升要你确认。通过后可出站当定论。',
      claimRefs: [c.id],
      effect: {
        type: 'propose',
        draft: {
          objectId,
          kind: '晋升',
          claimId: c.id,
          headline: `晋升「${c.text}」`,
          evidence: c.span ?? c.text,
          outbound: true,
        },
      },
    };
  }

  if (/并入使用技术|平台化.*并入|把平台化/.test(t)) {
    const c = claimsOf(state, objectId).find((x) => x.predicate === '未编目');
    if (!c) return unknownReply();
    return {
      replyText: '整理提议：把未编目并入「使用技术」，等你确认。',
      claimRefs: [c.id],
      effect: {
        type: 'propose',
        draft: {
          objectId,
          kind: '整理',
          claimId: c.id,
          targetPredicate: '使用技术',
          headline: '把「内部平台化」并入「使用技术」',
          evidence: c.span ?? c.text,
        },
      },
    };
  }

  // 绑定意图：说「绑」就算明确意图，指不出对象名会反问，不怕误绑。
  if (/绑/.test(t)) {
    const src = state.sources.find((s) => (s.id === 'src-jd' || /JD|jd/.test(s.title)) && s.boundObjectIds.length === 0)
      ?? state.sources.find((s) => s.boundObjectIds.length === 0 && !s.virtual);
    if (!src) {
      return { replyText: '没有未绑定的来源可绑。', claimRefs: [] };
    }
    const named = namedObject(state, t);
    if (!named) {
      return {
        replyText: '你要绑到哪个对象？说出名字。',
        claimRefs: [],
      };
    }
    return {
      replyText: `绑定要你确认。确认后把「${src.title}」归到「${named.name}」，再入队抽取。`,
      claimRefs: [],
      effect: {
        type: 'propose',
        draft: {
          objectId: named.id,
          kind: '绑定',
          sourceId: src.id,
          objectIds: [named.id],
          headline: `把「${src.title}」绑到「${named.name}」`,
          evidence: src.body.slice(0, 80),
        },
      },
    };
  }

  if (/这句不对|不对，?这句/.test(t)) {
    if (state.selectedClaimId) {
      const c = state.claims.find((x) => x.id === state.selectedClaimId);
      return {
        replyText: c
          ? [
              `好，对「**${c.text}**」走纠正。`,
              '',
              c.unverified ? '这条还是未核：' : '这条已晋升出过站：',
              '',
              c.unverified ? '- 直接丢弃，不写禁写（0037）' : '- 关窗 + 必填关闭原因 + 写禁写',
              '- 可选新主张（使用者陈述）',
              '',
              '表单已打开。闲聊抽取不会走这条路。',
            ].join('\n')
          : '选中的主张不在账本里，先在投影里点一句。',
        claimRefs: c ? [c.id] : [],
        effect: c ? { type: 'correct', claimId: c.id } : undefined,
      };
    }
    return {
      replyText: [
        '要先选中一句主张，再说「这句不对」。',
        '',
        '- 在投影里点它',
        '- 或点回复里的引用',
        '',
        '纠正不走闲聊抽取。',
      ].join('\n'),
      claimRefs: [],
    };
  }

  const claims = claimsOf(state, objectId);
  const pick = (pred: string) => claims.filter((c) => c.predicate === pred);

  if (/go|语言|技术栈|主栈|java/i.test(t)) {
    const tech = [...pick('后端主栈'), ...pick('使用技术')];
    if (tech.length === 0) return unknownReply();
    const lines = tech.map((c) => `- 「${c.text}」${badge(c)}`);
    const head =
      tech.filter((c) => c.predicate === '后端主栈').length >= 2
        ? '两条互斥主张并排挂着，我不合成「目前有争议」：'
        : '账本里这条技术主张：';
    return {
      replyText: [head, '', ...lines, '', '点下面的引用可看原文片段。'].join('\n'),
      claimRefs: tech.map((c) => c.id),
    };
  }

  // 技术选型场景的常见问题：许可证 / 活跃度 / 发布节奏 / 社区信号。
  if (/许可证|活跃|发布|社区|贡献者|维护/.test(t)) {
    const picks = [...pick('许可证'), ...pick('活跃度'), ...pick('发布节奏'), ...pick('维护方')];
    if (picks.length === 0) return unknownReply();
    const conflicted = picks.some((c) => c.predicate === '活跃度' && picks.filter((x) => x.predicate === '活跃度').length >= 2);
    return {
      replyText: [
        conflicted ? '活跃度上两条主张并排挂着（主键对转述），我不合成「目前有争议」：' : '账本里的选型信号：',
        '',
        ...picks.map((c) => `- 「${c.text}」${badge(c)}`),
      ].join('\n'),
      claimRefs: picks.map((c) => c.id),
    };
  }

  if (/招|岗位|实习|校招|秋招/.test(t)) {
    const jobs = pick('在招岗位');
    if (jobs.length === 0) return unknownReply();
    return {
      replyText: [
        '在招岗位：',
        '',
        ...jobs.map((c) => `- 「${c.text}」${badge(c)}`),
        '',
        '点引用可看原文片段。',
      ].join('\n'),
      claimRefs: jobs.map((c) => c.id),
    };
  }

  if (/地点|办公|城市|在哪|远程/.test(t)) {
    return {
      replyText: [
        '**未知**',
        '',
        '账本里没有办公地点主张，两份来源都没写。我不会用常识补一句。',
        '',
        '> 未知格子保持空，禁止用模型常识假句子。',
      ].join('\n'),
      claimRefs: [],
    };
  }

  if (/平台|内部平台|平台化/.test(t)) {
    const un = claims.filter((c) => c.predicate === '未编目');
    if (un.length === 0) return unknownReply();
    return {
      replyText: [
        '未编目主张（映射不上受控谓词表）：',
        '',
        ...un.map((c) => `- 「${c.text}」${badge(c)} · 不作定论`),
        '',
        '未编目不进冲突，等整理提议编目。',
      ].join('\n'),
      claimRefs: un.map((c) => c.id),
    };
  }

  if (/简报/.test(t)) {
    const habit = state.memories.find((m) => m.text.includes('简报'));
    return {
      replyText: [
        habit ? `按你的全局记忆「**${habit.text}**」执行。` : '简报只收当时能出站的主张。',
        '',
        '| 纪律 | 做法 |',
        '| --- | --- |',
        '| 出处 | 每句带引用 |',
        '| 未核 | 必须带标记 |',
        '| 冲突 | 摊开双方，不合成 |',
        '| 未知 | 占位，不编 |',
        '',
        '顶栏「出简报」可生成。',
      ].join('\n'),
      claimRefs: [],
    };
  }

  if (/你是谁|能做什么|帮助|怎么用|样例/.test(t)) {
    return {
      replyText: [
        '我是挂在这个对象下的对话：默认只问、只解释、带引用。',
        '',
        '### 会写账本的入口',
        '',
        '- 「记下来：…」立刻写全局记忆',
        '- 「这句不对」走纠正',
        '',
        '闲聊不进账本。',
        '',
        '### 可以这样问',
        '',
        '- 技术栈是什么',
        '- 在招什么岗位',
        '- 办公地点在哪',
        '',
        '```text',
        '记下来：简报用条目，别写长',
        '```',
      ].join('\n'),
      claimRefs: [],
    };
  }

  if (/有什么|都有什么|概况|全部/.test(t)) {
    if (claims.length === 0) return unknownReply();
    const rows = claims.map((c) => `| ${c.predicate} | ${c.text} | ${c.unverified ? '未核' : '已晋升'} |`);
    return {
      replyText: [
        `当前对象账本里有 **${claims.length}** 条未关窗主张。`,
        '',
        '| 谓词 | 主张 | 核 |',
        '| --- | --- | --- |',
        ...rows,
        '',
        '逐条引用如下。',
      ].join('\n'),
      claimRefs: claims.map((c) => c.id),
    };
  }

  return {
    replyText: [
      '当前对象的账本里没有能回答这句话的主张：**未知，不编**。',
      '',
      '可以往 Inbox 丢材料，或在成品里开调研任务。',
    ].join('\n'),
    claimRefs: [],
  };
}

function claimsOf(state: State, objectId: string): Claim[] {
  return state.claims.filter((c) => c.objectId === objectId && c.status !== '过时');
}

function namedObject(state: State, sentence: string) {
  const live = state.objects.filter((o) => !o.archived);
  const hits = live.filter((o) => sentence.includes(o.name));
  if (hits.length === 0) return null;
  return [...hits].sort((a, b) => b.name.length - a.name.length)[0];
}

function badge(c: Claim): string {
  return c.unverified ? '（未核）' : '（已晋升）';
}

function unknownReply(): ChatReply {
  return {
    replyText: [
      '账本里暂无相关主张：**未知，不编**。',
      '',
      '绑定新来源后抽取循环会补进来（默认未核）。',
    ].join('\n'),
    claimRefs: [],
  };
}

export function claimChipLabel(claim: Claim): string {
  return `${claim.predicate}·${claim.text.slice(0, 12)}…`;
}

import type { ChatEffect } from './chat';
import type { ChatMessage, Claim, Source, State, ThinkCopy, ToolCall } from './types';

export function thinkMs(effort: State['thinkingEffort']): number {
  if (effort === '关闭') return 0;
  if (effort === '低') return 360;
  if (effort === '高') return 1100;
  return 640;
}

export function thinkCopy(msg: ChatMessage, effect?: ChatEffect): ThinkCopy {
  if (effect?.type === 'propose' || effect?.type === 'correct') {
    return {
      runningTitle: '正在拟提议',
      doneTitle: '已拟提议',
      summary: '要动账本，等你确认',
      body: '写账本只能提议。确认占用输入区，一次一件。',
    };
  }
  if (effect?.type === 'refuse') {
    return {
      runningTitle: '正在核对权限',
      doneTitle: '不代做',
      summary: '这个动作不给工具',
      body: '永久删除、移除工作区、改密钥，模型最多建议人自己去做。',
    };
  }
  if (msg.note?.includes('记忆') || effect?.type === 'remember') {
    return {
      runningTitle: '正在记下',
      doneTitle: '已记下',
      summary: '立刻写记忆，不走候选',
      body: '明确「记下来」才写。闲聊抽取不会走这条路。',
    };
  }
  if (msg.claimRefs && msg.claimRefs.length > 0) {
    return {
      runningTitle: '正在核对账本',
      doneTitle: '已核对',
      summary: `从当前对象挑了 ${msg.claimRefs.length} 条主张`,
      body: '只解释已入账的主张，带引用。不现场编新句子，不合成「目前有争议」。',
    };
  }
  return {
    runningTitle: '正在核对账本',
    doneTitle: '已核对',
    summary: '账本无匹配，按未知处理',
    body: '材料不够就答未知。不会用常识补一句。',
  };
}

export function planTools(msg: ChatMessage, state: State, objectId: string, ask: string): ToolCall[] {
  const obj = state.objects.find((o) => o.id === objectId);
  const ws = state.workspaces.find((w) => w.id === (obj?.workspaceId ?? state.currentWorkspaceId));
  const claims = (msg.claimRefs ?? [])
    .map((id) => state.claims.find((c) => c.id === id))
    .filter((c): c is Claim => Boolean(c));
  const scope = JSON.stringify(
    { workspace: ws?.name ?? ws?.id, objectId, object: obj?.name, unbound: false },
    null,
    2,
  );

  if (msg.note?.includes('记忆')) {
    return [
      {
        id: `${msg.id}-mem`,
        title: '写入记忆',
        summary: '立刻生效',
        icon: 'disk',
        input: scope,
        output: msg.note,
      },
    ];
  }

  const tools: ToolCall[] = [
    {
      id: `${msg.id}-read`,
      title: '读取主张',
      summary: claims.length ? `${obj?.name} · ${claims.length} 条` : `${obj?.name} · 无匹配`,
      icon: 'book',
      input: JSON.stringify({ workspace: ws?.name, objectId, object: obj?.name, ask: ask || msg.text.slice(0, 40) }, null, 2),
      output: claims.length
        ? claims.map((c) => `[${c.predicate}] ${c.text}${c.unverified ? ' · 未核' : ''}`).join('\n')
        : '（账本无匹配主张）',
    },
  ];

  const sourceIds = [...new Set(claims.map((c) => c.sourceId))];
  const sources = sourceIds
    .map((id) => state.sources.find((s) => s.id === id))
    .filter((s): s is Source => s !== undefined && !s.virtual);
  if (sources.length > 0) {
    tools.push({
      id: `${msg.id}-src`,
      title: '打开来源',
      summary: sources.map((s) => s.title).join(' · '),
      icon: 'file',
      input: JSON.stringify({ workspace: ws?.name, objectId, sources: sources.map((s) => s.id) }, null, 2),
      output: sources
        .map((s) => {
          const span = claims.find((c) => c.sourceId === s.id)?.span;
          return `${s.title}\n${span ?? s.body.slice(0, 120)}`;
        })
        .join('\n\n'),
    });
  }

  if (claims.length === 0 && !msg.note) {
    const first = tools[0];
    if (first) {
      first.icon = 'search';
      first.title = '核对账本';
    }
  }
  return tools;
}

export function attachTurn(
  state: State,
  objectId: string,
  msg: ChatMessage,
  ask: string,
  effect?: ChatEffect,
): ChatMessage {
  const thinkWait = thinkMs(state.thinkingEffort);
  const think = thinkWait > 0 ? thinkCopy(msg, effect) : { runningTitle: '', doneTitle: '', summary: '', body: '' };
  return {
    ...msg,
    turn: { tools: planTools(msg, state, objectId, ask), think, played: false },
  };
}

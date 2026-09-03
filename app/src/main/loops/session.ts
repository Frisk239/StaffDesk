import { isWriteIntent, scriptReply, type ChatReply } from '@shared/chat';
import { CUSTOM_BASELINE_PLAYBOOK } from '@shared/playbook';
import { scenarioOfWorkspace } from '@shared/scenario';
import type { State } from '@shared/types';
import type { ModelCompletion } from '../llm/runtime';
import type { ChatMessageParam } from '../llm/chatCompletions';
import { searchClaimsFts, resolveFtsHits } from '../brain/fts';
import type Database from 'better-sqlite3';
import {
  executeReadonlyTool,
  READONLY_TOOL_DEFS,
  recallClaims,
  fillOneHop,
  RECALL_LIMIT,
  type RecallEntry,
} from './readonlyTools';
import { projectionFrom } from '../brain/projection';
import type { Claim } from '@shared/types';

export interface SessionDeps {
  db?: Database.Database;
  complete?: ModelCompletion | undefined;
}

const REF_RE = /\[ref:([^\]]*)\]/g;

/** 正文剥离内部引用协议；合法/非法/空标记一律不进用户可见文本。 */
export function stripClaimRefs(text: string): string {
  return text
    .replace(/\[ref:[^\]]*\]/g, '')
    .replace(/[ \t]+([。，、；：！？,.!?;:])/g, '$1')
    .replace(/([。，、；：！？])[ \t]+/g, '$1')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/[ \t]*\n[ \t]*/g, '\n')
    .trim();
}

/** 主会话：说明书开场 + 召回 + 只读工具 + 带引用回复。不写主张。 */
export async function runSessionTurn(
  state: State,
  objectId: string,
  text: string,
  deps: SessionDeps = {},
): Promise<ChatReply> {
  if (isWriteIntent(text)) {
    return scriptReply(state, objectId, text);
  }

  if (!deps.complete) {
    return scriptReply(state, objectId, text);
  }

  const obj = state.objects.find((o) => o.id === objectId);
  const scenario = obj ? scenarioOfWorkspace(state.workspaces, obj.workspaceId) : '求职面试';
  // 0058：说明书改读场景模板；缺模板回落「自定义」基线模板，再缺回落种子常量兜底
  // （种子源常量可接受：内容与首启种子同源，只在异常态旧备份上触达）。
  const playbook =
    state.scenarioTemplates.find((t) => t.name === scenario)?.playbook ??
    state.scenarioTemplates.find((t) => t.name === '自定义')?.playbook ??
    CUSTOM_BASELINE_PLAYBOOK;
  const recalled = recallForPrompt(state, objectId, text, deps.db);
  const allowed = new Set(recalled.map((c) => c.id));
  const system = [
    playbook,
    `当前对象：${obj ? `${obj.kind}「${obj.name}」` : objectId}`,
    '只根据下列主张回答。没有就说未知，不准编造新事实。',
    '引用只能写成 [ref:主张ID]，ID 必须出现在下列清单。',
    '带「（关联·对象名）」前缀的条目来自关联对象，引用时注意口径。',
    recalled.length
      ? recalled
          .map(
            (c) =>
              `- ${c.id}｜${c.objectName ? `（关联·${c.objectName}）` : ''}${c.predicate}｜${c.text}${c.unverified ? '（未核）' : ''}`,
          )
          .join('\n')
      : '（当前没有可引用的主张）',
  ].join('\n');

  const history = (state.chatByObject[objectId] ?? [])
    .filter((m) => m.role === 'user' || m.role === 'desk')
    .slice(-8)
    .map((m) => ({
      role: (m.role === 'user' ? 'user' : 'assistant') as 'user' | 'assistant',
      content: m.text,
    }));

  const messages: ChatMessageParam[] = [
    { role: 'system', content: system },
    ...history,
    { role: 'user', content: text },
  ];

  const complete = deps.complete;

  let result = await complete({
    messages,
    tools: READONLY_TOOL_DEFS,
  });

  for (let i = 0; i < 4 && result.toolCalls.length > 0; i += 1) {
    messages.push({
      role: 'assistant',
      content: result.content,
      tool_calls: result.toolCalls,
    });
    for (const call of result.toolCalls) {
      const output = executeReadonlyTool(
        state,
        objectId,
        call.function.name,
        call.function.arguments,
      );
      messages.push({ role: 'tool', content: output, tool_call_id: call.id });
    }
    result = await complete({ messages, tools: READONLY_TOOL_DEFS });
  }

  const claimRefs = [...result.content.matchAll(REF_RE)]
    .map((m) => m[1])
    .filter((id): id is string => Boolean(id && allowed.has(id)));

  return {
    replyText: stripClaimRefs(result.content) || '未知：模型没有给出可核对的回答。',
    claimRefs,
  };
}

/**
 * 引用白名单只认这里返回的 id（runSessionTurn 的 allowed），所以一跳条目必须在此带出，
 * 否则 recall_claims 工具里的一跳引用会不可点。本对象优先、一跳补位，总上限仍 12。
 */
function recallForPrompt(
  state: State,
  objectId: string,
  text: string,
  db?: Database.Database,
): RecallEntry[] {
  const projected = projectionFrom(state.claims, state.sources, objectId);
  if (db) {
    const hits = searchClaimsFts(db, objectId, text);
    const resolved = resolveFtsHits(projected, hits);
    if (resolved.length > 0) {
      return fillOneHop(state, objectId, text, resolved.slice(0, RECALL_LIMIT).map(entryOf));
    }
  }
  const recalled = recallClaims(state, objectId, text);
  if (recalled.length > 0) return recalled;
  return fillOneHop(state, objectId, '', projected.slice(0, RECALL_LIMIT).map(entryOf));
}

function entryOf(c: Claim): RecallEntry {
  return { id: c.id, text: c.text, predicate: c.predicate, unverified: c.unverified };
}

export { isWriteIntent };

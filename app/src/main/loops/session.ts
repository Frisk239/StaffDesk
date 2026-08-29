import { isWriteIntent, scriptReply, type ChatReply } from '@shared/chat';
import { DEFAULT_PLAYBOOK } from '@shared/playbook';
import { scenarioOfWorkspace } from '@shared/scenario';
import type { LlmProvider, State } from '@shared/types';
import type { ChatMessageParam, CompleteResult, FetchFn, ToolDef } from '../llm/chatCompletions';
import { chatComplete } from '../llm/chatCompletions';
import { searchClaimsFts, resolveFtsHits } from '../brain/fts';
import type Database from 'better-sqlite3';
import { executeReadonlyTool, READONLY_TOOL_DEFS, recallClaims } from './readonlyTools';
import { projectionFrom } from '../brain/projection';

export interface SessionDeps {
  fetch?: FetchFn;
  db?: Database.Database;
  complete?:
    | ((req: {
        messages: ChatMessageParam[];
        jsonMode?: boolean | undefined;
        tools?: ToolDef[] | undefined;
        onDelta?: ((chunk: string) => void) | undefined;
      }) => Promise<CompleteResult>)
    | undefined;
  onDelta?: ((chunk: string) => void) | undefined;
}

const REF_RE = /\[ref:([^\]]+)\]/g;

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

  const provider = activeProvider(state);
  const canCall = Boolean(deps.complete || (provider && provider.apiKey.trim()));
  if (!canCall) {
    return scriptReply(state, objectId, text);
  }

  const obj = state.objects.find((o) => o.id === objectId);
  const scenario = obj ? scenarioOfWorkspace(state.workspaces, obj.workspaceId) : '求职面试';
  const playbook = DEFAULT_PLAYBOOK[scenario];
  const recalled = recallForPrompt(state, objectId, text, deps.db);
  const allowed = new Set(recalled.map((c) => c.id));
  const system = [
    playbook,
    `当前对象：${obj ? `${obj.kind}「${obj.name}」` : objectId}`,
    '只根据下列主张回答。没有就说未知，不准编造新事实。',
    '引用只能写成 [ref:主张ID]，ID 必须出现在下列清单。',
    recalled.length
      ? recalled.map((c) => `- ${c.id}｜${c.predicate}｜${c.text}${c.unverified ? '（未核）' : ''}`).join('\n')
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

  const complete =
    deps.complete ??
    (async (req) => {
      if (!provider) throw new Error('没有提供商');
      return chatComplete({
        baseUrl: provider.baseUrl,
        apiKey: provider.apiKey,
        model: state.activeModelId,
        messages: req.messages,
        jsonMode: req.jsonMode,
        tools: req.tools,
        stream: Boolean(req.onDelta),
        onDelta: req.onDelta,
        fetch: deps.fetch,
      });
    });

  let result = await complete({
    messages,
    tools: READONLY_TOOL_DEFS,
    onDelta: deps.onDelta,
  });

  for (let i = 0; i < 4 && result.toolCalls.length > 0; i += 1) {
    messages.push({
      role: 'assistant',
      content: result.content,
      tool_calls: result.toolCalls,
    });
    for (const call of result.toolCalls) {
      const output = executeReadonlyTool(state, objectId, call.function.name, call.function.arguments);
      messages.push({ role: 'tool', content: output, tool_call_id: call.id });
    }
    result = await complete({ messages, tools: READONLY_TOOL_DEFS });
  }

  const claimRefs = [...result.content.matchAll(REF_RE)]
    .map((m) => m[1])
    .filter((id): id is string => Boolean(id && allowed.has(id)));

  return {
    replyText: result.content.trim() || '未知：模型没有给出可核对的回答。',
    claimRefs,
  };
}

function recallForPrompt(state: State, objectId: string, text: string, db?: Database.Database) {
  const projected = projectionFrom(state.claims, state.sources, objectId);
  if (db) {
    const hits = searchClaimsFts(db, objectId, text);
    const resolved = resolveFtsHits(projected, hits);
    if (resolved.length > 0) return resolved.slice(0, 12);
  }
  const recalled = recallClaims(state, objectId, text);
  if (recalled.length > 0) {
    return projected.filter((c) => recalled.some((r) => r.id === c.id));
  }
  return projected.slice(0, 12);
}

function activeProvider(state: State): LlmProvider | undefined {
  return state.providers.find((p) => p.id === state.activeProviderId && p.enabled);
}

export { isWriteIntent };

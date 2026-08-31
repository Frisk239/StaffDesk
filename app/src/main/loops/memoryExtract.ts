import { z } from 'zod';
import { isWriteIntent } from '@shared/chat';
import type { CandidatePayload, ChatMessage, MemoryKind, MemoryScope, State } from '@shared/types';
import type { ModelCompletion } from '../llm/runtime';
import { safeDetail } from '../redact';

const CandidateSchema = z.object({
  candidates: z
    .array(
      z.object({
        text: z.string(),
        memoryKind: z.enum(['偏好', '禁写', '习惯']),
        scope: z.enum(['全局', '对象', '会话']),
        sourceExcerpt: z.string(),
      }),
    )
    .default([]),
});

type CandidateDraft = z.infer<typeof CandidateSchema>['candidates'][number];

export type MemoryExtractStatus =
  'success' | 'skipped' | 'unconfigured' | 'invalid-output' | 'failed';

export interface MemoryExtractResult {
  status: MemoryExtractStatus;
  candidates: CandidatePayload[];
  detail?: string | undefined;
}

const MEMORY_SIGNAL_RE =
  /(我|我的|本人|以后|下次|始终|总是|请|希望|偏好|习惯|喜欢|不喜欢|讨厌|别|不要|回复|回答|简报|出站|叫我|称呼我|prefer|always|never|call me|my preference)/i;

const CASUAL_ONLY_RE =
  /^(你好|您好|hello|hi|在吗|谢谢|多谢|辛苦了|哈哈|哈哈哈|天气|早|早上好|晚上好|晚安)[。！？!?.\s]*$/i;

/** 闲聊和明确写意图不进入候选记忆抽取。 */
export function shouldConsiderMemoryCandidate(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length < 6) return false;
  if (isWriteIntent(trimmed)) return false;
  if (CASUAL_ONLY_RE.test(trimmed)) return false;
  if (!MEMORY_SIGNAL_RE.test(trimmed)) return false;
  if (
    /^(.+[？?])$/.test(trimmed) &&
    !/(希望|以后|下次|别|不要|prefer|always|never)/i.test(trimmed)
  ) {
    return false;
  }
  return true;
}

export async function extractCandidateMemories(args: {
  state: State;
  objectId: string;
  userMessages: ChatMessage[];
  complete?: ModelCompletion | undefined;
}): Promise<MemoryExtractResult> {
  const object = args.state.objects.find((item) => item.id === args.objectId);
  if (!object) return { status: 'skipped', candidates: [] };
  const messages = args.userMessages
    .filter((message) => message.role === 'user')
    .filter((message) => shouldConsiderMemoryCandidate(message.text));
  if (messages.length === 0) return { status: 'skipped', candidates: [] };
  if (!args.complete) {
    return {
      status: 'unconfigured',
      candidates: [],
      detail: '未配置模型：本轮不会生成候选记忆',
    };
  }

  const raw = messages.map((message) => `消息 ${message.id}：${message.text}`).join('\n\n');
  try {
    const result = await args.complete({
      jsonMode: true,
      messages: [
        {
          role: 'system',
          content: [
            '你是 StaffDesk 的候选记忆抽取器，只从使用者原文中找偏好、习惯、称呼、出站/简报要求。',
            '不要抽业务事实、世界事实、对象事实，也不要抽使用者的普通问题或闲聊。',
            '明确“记下来：...”不会来到这里；如果看到类似直接记忆命令，也输出空数组。',
            'sourceExcerpt 必须逐字复制使用者原文中的连续片段。',
            'scope 只能是 全局、对象、会话；不确定就输出空数组。',
            '只输出 JSON：{"candidates":[{"text":"记忆正文","memoryKind":"偏好|习惯|禁写","scope":"全局|对象|会话","sourceExcerpt":"原文片段"}]}',
          ].join('\n'),
        },
        {
          role: 'user',
          content: [
            `当前对象：${object.kind}「${object.name}」`,
            '只看下面这些使用者消息，不要使用任何召回记忆或助手回复：',
            raw,
          ].join('\n'),
        },
      ],
    });
    const parsed = parseCandidateDrafts(result.content);
    if (!parsed.ok) {
      return { status: 'invalid-output', candidates: [], detail: parsed.detail };
    }
    const candidates = draftsToCandidates(parsed.drafts, messages, args.objectId);
    return { status: 'success', candidates };
  } catch (error) {
    return { status: 'failed', candidates: [], detail: safeDetail(error) };
  }
}

function draftsToCandidates(
  drafts: CandidateDraft[],
  messages: ChatMessage[],
  objectId: string,
): CandidatePayload[] {
  const out: CandidatePayload[] = [];
  const seen = new Set<string>();
  for (const draft of drafts) {
    const text = draft.text.trim();
    const excerpt = draft.sourceExcerpt.trim();
    if (!text || !excerpt) continue;
    const message = messages.find((item) => item.text.includes(excerpt));
    if (!message) continue;
    if (!shouldConsiderMemoryCandidate(message.text)) continue;
    const key = `${draft.scope}\0${draft.memoryKind}\0${text.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      kind: '候选记忆',
      text,
      memoryKind: draft.memoryKind as MemoryKind,
      scope: draft.scope as MemoryScope,
      fromObjectId: objectId,
      fromMessageIds: [message.id],
      sourceExcerpt: excerpt,
    });
  }
  return out;
}

function parseCandidateDrafts(
  content: string,
): { ok: true; drafts: CandidateDraft[] } | { ok: false; detail: string } {
  const trimmed = content.trim().replace(/^\uFEFF/, '');
  if (!trimmed) return { ok: false, detail: '模型返回了空内容' };
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim();
  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  const sliced =
    firstBrace >= 0 && lastBrace > firstBrace ? trimmed.slice(firstBrace, lastBrace + 1) : '';
  const candidates = [trimmed, fenced, sliced].filter((candidate): candidate is string =>
    Boolean(candidate),
  );
  let sawJson = false;
  for (const candidate of candidates) {
    try {
      const json: unknown = JSON.parse(candidate);
      sawJson = true;
      const parsed = CandidateSchema.safeParse(json);
      if (parsed.success) return { ok: true, drafts: parsed.data.candidates };
    } catch {
      // 继续尝试安全截取。
    }
  }
  return {
    ok: false,
    detail: sawJson ? '模型返回的 JSON 不符合候选记忆结构' : '模型没有返回可解析的 JSON',
  };
}

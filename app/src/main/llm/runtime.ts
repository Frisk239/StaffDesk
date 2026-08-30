import type { LlmProvider, State } from '@shared/types';
import {
  chatComplete,
  type ChatMessageParam,
  type CompleteResult,
  type ToolDef,
} from './chatCompletions';

export interface ModelCompletionRequest {
  messages: ChatMessageParam[];
  jsonMode?: boolean | undefined;
  tools?: ToolDef[] | undefined;
  onDelta?: ((chunk: string) => void) | undefined;
}

export type ModelCompletion = (request: ModelCompletionRequest) => Promise<CompleteResult>;

export function activeModelCompletion(state: State): ModelCompletion | undefined {
  const provider = state.providers.find(
    (item) => item.id === state.activeProviderId && item.enabled,
  );
  return provider ? completionForProvider(provider, state.activeModelId) : undefined;
}

export function completionForProvider(
  provider: LlmProvider,
  modelId: string,
): ModelCompletion | undefined {
  const model = provider.models.find((item) => item.id === modelId);
  if (!provider.enabled || !provider.baseUrl.trim() || !provider.apiKey.trim() || !model) {
    return undefined;
  }

  return (request) =>
    chatComplete({
      baseUrl: provider.baseUrl,
      apiKey: provider.apiKey,
      model: model.id,
      messages: request.messages,
      jsonMode: request.jsonMode,
      tools: request.tools,
      stream: Boolean(request.onDelta),
      onDelta: request.onDelta,
    });
}

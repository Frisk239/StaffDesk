import { createHash } from 'node:crypto';
import type { LlmProvider, ThinkingEffort } from '@shared/types';

export const QUALITY_SUITE_VERSION = 'staffdesk-quality-v1';
export const QUALITY_POLICY_VERSIONS = {
  extraction: 'extract-v1',
  recall: 'fts-trigram-bm25-v1',
  outbound: 'ledger-outbound-v1',
} as const;

export interface QualificationTarget {
  endpoint: string;
  endpointIdentity: string;
  modelId: string;
  thinkingEffort: ThinkingEffort;
  modelParams: {
    contextWindow: number;
    maxOutput: number;
  };
  suiteVersion: string;
  policyVersions: {
    extraction: string;
    recall: string;
    outbound: string;
  };
}

export function buildQualificationTarget(
  provider: LlmProvider,
  modelId: string,
  thinkingEffort: ThinkingEffort,
): QualificationTarget {
  const model = provider.models.find((item) => item.id === modelId);
  if (!model) throw new Error(`没有模型 ${modelId}`);
  const endpoint = normalizeEndpoint(provider.baseUrl);
  return {
    endpoint,
    endpointIdentity: safeEndpointIdentity(endpoint),
    modelId: model.id.trim(),
    thinkingEffort,
    modelParams: {
      contextWindow: model.contextWindow,
      maxOutput: model.maxOutput,
    },
    suiteVersion: QUALITY_SUITE_VERSION,
    policyVersions: { ...QUALITY_POLICY_VERSIONS },
  };
}

export function qualificationFingerprint(target: QualificationTarget): string {
  const canonical = {
    endpoint: target.endpoint,
    modelId: target.modelId.trim(),
    thinkingEffort: target.thinkingEffort,
    modelParams: target.modelParams,
    suiteVersion: target.suiteVersion,
    policyVersions: target.policyVersions,
  };
  return createHash('sha256').update(stableJson(canonical)).digest('hex');
}

export function normalizeEndpoint(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, '');
  try {
    const url = new URL(trimmed);
    url.protocol = url.protocol.toLowerCase();
    url.hostname = url.hostname.toLowerCase();
    if (
      (url.protocol === 'https:' && url.port === '443') ||
      (url.protocol === 'http:' && url.port === '80')
    ) {
      url.port = '';
    }
    url.hash = '';
    url.search = '';
    url.pathname = url.pathname.replace(/\/+$/, '');
    return url.toString().replace(/\/+$/, '');
  } catch {
    return trimmed;
  }
}

export function safeEndpointIdentity(endpoint: string): string {
  try {
    const url = new URL(endpoint);
    return `${url.host}${url.pathname}`.replace(/\/+$/, '');
  } catch {
    return endpoint.replace(/^https?:\/\//i, '').slice(0, 120);
  }
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

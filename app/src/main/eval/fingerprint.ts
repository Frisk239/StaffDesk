import { createHash } from 'node:crypto';
import type { LlmProvider, QualityMetricSet, ThinkingEffort } from '@shared/types';

export const QUALITY_SUITE_VERSION = 'staffdesk-quality-v1';
// 0045：出站策略新增未编目纪律（0037 降级句）与撤销补偿（0034 takeover 回退）两条出站规则，
// 换政策版本即让旧资格认证回落「未认证」——这是设计内行为，不许为兼容旧记录而保留 v1。
export const QUALITY_POLICY_VERSIONS = {
  extraction: 'extract-v1',
  recall: 'fts-trigram-bm25-v1',
  outbound: 'ledger-outbound-v2',
} as const;

/**
 * 0045 合格分数线的「政策」面：指标低于下限即对应 stage 失败，认证报告不再只看异常。
 * fabrication 是「越低越好」，其 floor 语义为上限（编造率超过即失败，与 0039 的 5% 强警告并存）。
 */
export const QUALITY_METRIC_FLOORS: Record<keyof QualityMetricSet, number> = {
  extractionRecall: 70,
  spanHit: 60,
  ftsRecallAtK: 60,
  ftsPrecisionAtK: 60,
  mrr: 0.5,
  briefFaithfulness: 90,
  unknownAdherence: 90,
  conflictDetection: 80,
  correctionRecurrence: 90,
  uncatDiscipline: 90,
  undoCompensation: 90,
  fabrication: 10,
};

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

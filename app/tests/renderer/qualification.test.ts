import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('设置页资格认证结构', () => {
  it('顶部展示当前配置、四阶段、指标、失败位置，并由模型行显式传 modelId', () => {
    const source = readFileSync('src/renderer/src/components/Settings.tsx', 'utf8');
    const shared = readFileSync('src/shared/api.ts', 'utf8');
    const preload = readFileSync('src/preload/index.ts', 'utf8');
    const ipc = readFileSync('src/main/ipc.ts', 'utf8');

    expect(source).toContain('当前模型资格');
    expect(source).toContain('运行资格认证');
    expect(source).toContain('失败位置：');
    expect(source).toContain('qualification.report.stages.map');
    expect(source).toContain('Recall@k');
    expect(source).toContain('Precision@k');
    expect(source).toContain('纠正复发');
    expect(source).toContain('window.staffdesk.testProvider(provider.id, modelId)');
    expect(shared).toContain('testProvider: (providerId: string, modelId: string)');
    expect(preload).toContain('{ providerId, modelId }');
    expect(ipc).toContain('payload: { providerId: string; modelId: string }');
  });
});

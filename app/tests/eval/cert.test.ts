import { describe, expect, it } from 'vitest';
import { fabricationLine, runCert, scorePack } from '../../src/main/eval/cert';
import { GOLD_PACKS } from '../../src/main/eval/goldPacks';

describe('资格认证金标', () => {
  it('三包都能跑出分数，编造率红线是 5%', () => {
    expect(fabricationLine()).toBe(5);
    for (const pack of GOLD_PACKS) {
      const scores = runCert(pack);
      expect(scores.recall).toBeGreaterThanOrEqual(0);
      expect(scores.faithful).toBeGreaterThanOrEqual(0);
      expect(scores.unknown).toBeGreaterThanOrEqual(0);
      expect(scores.fabrication).toBeGreaterThanOrEqual(0);
    }
  });

  it('注入负例主张时编造率升高并超过红线', () => {
    const pack = GOLD_PACKS[0]!;
    const clean = runCert(pack);
    const dirty = runCert(pack, ['年薪百万']);
    expect(dirty.fabrication).toBeGreaterThan(clean.fabrication);
    expect(dirty.fabrication).toBeGreaterThan(5);
  });

  it('简报无出处句子会拉低忠实度', () => {
    const pack = GOLD_PACKS[0]!;
    const scores = scorePack(
      pack,
      [{ predicate: '后端主栈', text: '主栈是 TypeScript。', status: '成立', sourceId: 's' }],
      { blocks: [{ sentences: [{ claimIds: [], kind: 'claim' }] }] },
    );
    expect(scores.faithful).toBe(0);
  });
});

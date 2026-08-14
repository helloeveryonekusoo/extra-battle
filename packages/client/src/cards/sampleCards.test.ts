import { describe, expect, it } from 'vitest';
import { sampleCardIndex } from './sampleCards';

describe('sampleCards', () => {
  it('クライアント側からもサンプルカードを索引として読める', () => {
    expect(sampleCardIndex.all.length).toBeGreaterThanOrEqual(38);
    expect(sampleCardIndex.byName.get('リザードンex')?.[0]?.ruleBox).toBe('ex');
  });
});

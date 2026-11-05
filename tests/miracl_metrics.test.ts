import {describe, expect, it} from 'vitest';
import {hitMetrics} from '../quality/japanese-human-retrieval-datasets/miracl_metrics.js';

describe('MIRACL top-K metrics', () => {
  it('does not count a rank-11 result as Hit@10 or MRR@10', () => {
    const top50 = Array.from({length: 50}, (_, index) => `doc-${index + 1}`);
    expect(hitMetrics(top50, ['doc-11'])).toEqual({
      hit1: false,
      hit10: false,
      hit50: true,
      rr10: 0,
      ndcg10: 0,
    });
  });

  it('uses the first relevant result within the top ten for reciprocal rank', () => {
    const top50 = Array.from({length: 50}, (_, index) => `doc-${index + 1}`);
    expect(hitMetrics(top50, ['doc-4', 'doc-20'])).toEqual({
      hit1: false,
      hit10: true,
      hit50: true,
      rr10: 0.25,
      ndcg10: expect.any(Number),
    });
  });
});

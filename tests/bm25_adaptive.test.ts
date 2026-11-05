import { describe, expect, it } from 'vitest';
import { buildAdaptiveTermModels, scoreAdaptiveBm25, type Posting } from '../scripts/bench/bm25_adaptive_tf.js';
import { scorePl2 } from '../scripts/bench/pl2.js';
import { reciprocalRankFusion } from '../scripts/bench/rrf.js';
import { buildBo1ExpansionWeights, scoreWeightedStandardBm25 } from '../scripts/bench/bo1_expansion.js';

describe('BM25 adaptive TF experiment', () => {
  it('keeps the standard mode equal to positive-smoothed BM25 on a fixed corpus', () => {
    const lengths = [2, 3, 4, 5];
    const postings = new Map<string, Posting[]>([['alpha', [
      { docIndex: 0, tf: 2 },
      { docIndex: 1, tf: 1 },
      { docIndex: 3, tf: 3 },
    ]]]);
    const averageLength = lengths.reduce((sum, length) => sum + length, 0) / lengths.length;
    const models = buildAdaptiveTermModels(4, averageLength, lengths, postings);
    const scored = scoreAdaptiveBm25(['alpha'], 4, averageLength, lengths, postings, models, 'standard');
    const idf = Math.log(1 + (4 - 3 + 0.5) / (3 + 0.5));
    const expected = [
      [0, 2], [1, 1], [3, 3],
    ].map(([docIndex, tf]) => {
      const normalizedTf = tf! / (1 - 0.75 + 0.75 * lengths[docIndex!]! / averageLength);
      return { docIndex: docIndex!, score: idf * ((normalizedTf * 2.2) / (normalizedTf + 1.2)) };
    }).sort((left, right) => right.score - left.score || left.docIndex - right.docIndex);
    expect(scored).toEqual(expected);
  });

  it('produces finite corpus-adaptive term parameters and deterministic ranks', () => {
    const lengths = Array.from({ length: 10 }, (_, index) => index + 1);
    const postings = new Map<string, Posting[]>([['repeat', [
      { docIndex: 1, tf: 6 },
      { docIndex: 3, tf: 8 },
      { docIndex: 5, tf: 10 },
      { docIndex: 7, tf: 12 },
    ]]]);
    const averageLength = lengths.reduce((sum, length) => sum + length, 0) / lengths.length;
    const models = buildAdaptiveTermModels(lengths.length, averageLength, lengths, postings);
    const model = models.get('repeat')!;
    expect(model.df).toBe(4);
    expect(Number.isFinite(model.adaptiveK1)).toBe(true);
    expect(model.adaptiveK1).toBeGreaterThanOrEqual(0.05);
    expect(model.adaptiveK1).toBeLessThanOrEqual(20);
    const first = scoreAdaptiveBm25(['repeat'], lengths.length, averageLength, lengths, postings, models, 'bm25-adpt');
    const second = scoreAdaptiveBm25(['repeat'], lengths.length, averageLength, lengths, postings, models, 'bm25-adpt');
    expect(first).toEqual(second);
    expect(first.every(row => Number.isFinite(row.score))).toBe(true);
  });

  it('matches the official PL2 equation for a fixed corpus and rejects invalid c', () => {
    const lengths = [2, 3, 4];
    const postings = new Map<string, Posting[]>([['alpha', [
      { docIndex: 0, tf: 2 }, { docIndex: 1, tf: 1 }, { docIndex: 2, tf: 3 },
    ]]]);
    const collectionFrequencies = new Map([['alpha', 6]]);
    const averageLength = 3;
    const actual = scorePl2(['alpha', 'alpha'], 3, averageLength, lengths, collectionFrequencies, postings, 1);
    const expected = [0, 1, 2].map(docIndex => {
      const tf = postings.get('alpha')!.find(row => row.docIndex === docIndex)!.tf;
      const mean = 6 / 3;
      const normalizedTf = tf * (Math.log2(1 + averageLength / lengths[docIndex]!));
      const p1 = mean / Math.LN2 + 0.5 * Math.log2(2 * Math.PI);
      const p2 = Math.log2(mean) + 1 / Math.LN2;
      const divergence = p1 + (normalizedTf + 0.5) * Math.log2(normalizedTf) - p2 * normalizedTf;
      return { docIndex, score: divergence > 0 ? divergence / (normalizedTf + 1) : 0 };
    }).filter(row => row.score > 0).sort((left, right) => right.score - left.score || left.docIndex - right.docIndex);
    expect(actual.map(row => row.docIndex)).toEqual(expected.map(row => row.docIndex));
    actual.forEach((row, index) => expect(row.score).toBeCloseTo(expected[index]!.score, 12));
    expect(() => scorePl2([], 3, averageLength, lengths, collectionFrequencies, postings, 0)).toThrow(/positive/u);
  });

  it('fuses ranked lists by reciprocal rank with deterministic tie handling', () => {
    const fused = reciprocalRankFusion([
      [{ docIndex: 2, score: 3 }, { docIndex: 1, score: 2 }, { docIndex: 2, score: 1 }],
      [{ docIndex: 1, score: 4 }, { docIndex: 3, score: 3 }, { docIndex: 2, score: 2 }],
    ], 60);
    expect(fused.map(row => row.docIndex)).toEqual([1, 2, 3]);
    expect(fused[0]!.score).toBeCloseTo(1 / 62 + 1 / 61, 12);
    expect(() => reciprocalRankFusion([], -1)).toThrow(/non-negative/u);
  });

  it('ranks Bo1 expansion terms by the documented formula and retains weighted BM25 scores', () => {
    const expanded = buildBo1ExpansionWeights(
      new Map([['original', 2], ['rare', 3], ['common', 3], ['missing', 9]]),
      new Map([['original', 20], ['rare', 2], ['common', 100]]), 100, new Set(['original']), 2,
    );
    expect([...expanded.keys()]).toEqual(['rare', 'common']);
    expect(expanded.get('rare')).toBe(1);
    expect(expanded.get('common')).toBeLessThan(1);

    const lengths = [2, 3, 4];
    const postings = new Map<string, Posting[]>([['rare', [{ docIndex: 0, tf: 2 }, { docIndex: 2, tf: 1}]]]);
    const ranked = scoreWeightedStandardBm25(new Map([['rare', 0.5]]), 3, 3, lengths, postings);
    const idf = Math.log(1 + (3 - 2 + 0.5) / (2 + 0.5));
    const normalizedTf = 2 / (1 - 0.75 + 0.75 * 2 / 3);
    expect(ranked[0]!.docIndex).toBe(0);
    expect(ranked[0]!.score).toBeCloseTo(0.5 * idf * normalizedTf * 2.2 / (normalizedTf + 1.2), 12);
  });
});

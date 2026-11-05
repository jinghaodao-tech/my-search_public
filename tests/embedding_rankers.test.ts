import { describe, expect, it } from 'vitest';
import { exactTopK, reciprocalRankFusion } from '../scripts/bench/embedding_rankers.js';

describe('exactTopK', () => {
  it('matches a full deterministic sort for varied scores', () => {
    const scores = Float32Array.from([0.2, -1, 0.8, 0.8, 0.1, 0.55, 1.2, 0]);
    const actual = exactTopK(scores, 5);
    const expected = [...scores].map((score, docIndex) => ({ docIndex, score }))
      .sort((left, right) => right.score - left.score || left.docIndex - right.docIndex).slice(0, 5);
    expect(actual).toEqual(expected);
  });

  it('uses ascending document index to break ties', () => {
    expect(exactTopK(Float32Array.from([1, 1, 1, 1]), 2)).toEqual([
      { docIndex: 0, score: 1 }, { docIndex: 1, score: 1 },
    ]);
  });

  it('rejects invalid limits and non-finite scores', () => {
    expect(() => exactTopK(new Float32Array([1]), 0)).toThrow(/positive integer/u);
    expect(() => exactTopK(new Float32Array([Number.NaN]), 1)).toThrow(/Non-finite/u);
  });
});

describe('reciprocalRankFusion', () => {
  it('fuses rankings deterministically and respects the result limit', () => {
    expect(reciprocalRankFusion([['a', 'b', 'c'], ['b', 'd', 'a']], 60, 3)).toEqual(['b', 'a', 'd']);
  });
});

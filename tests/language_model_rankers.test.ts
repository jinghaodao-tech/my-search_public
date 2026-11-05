import { describe, expect, it } from 'vitest';
import { reciprocalRankFusion, scoreQueryLikelihood } from '../scripts/bench/language_model_rankers.js';

describe('query likelihood ranking experiments', () => {
  const lengths = [4, 4, 20, 0];
  const frequencies = new Map([['alpha', 3], ['beta', 2]]);
  const postings = new Map([
    ['alpha', [{ docIndex: 0, tf: 2 }, { docIndex: 1, tf: 1 }, { docIndex: 2, tf: 1 }]],
    ['beta', [{ docIndex: 1, tf: 2 }]],
  ]);

  it('ranks exact query likelihood across the full document set and returns exact top-k', () => {
    const all = scoreQueryLikelihood(['alpha', 'beta'], lengths, 30, frequencies, postings, { method: 'dirichlet', mu: 1000 }, 10);
    const topTwo = scoreQueryLikelihood(['alpha', 'beta'], lengths, 30, frequencies, postings, { method: 'dirichlet', mu: 1000 }, 2);
    expect(all).toHaveLength(4);
    expect(topTwo).toEqual(all.slice(0, 2));
    expect(all[0]!.docIndex).toBe(1);
  });

  it('uses stable index ordering for equal zero-match documents', () => {
    const result = scoreQueryLikelihood(['alpha'], lengths, 30, frequencies, postings, { method: 'jelinek-mercer', lambda: 0.2 }, 4);
    expect(result.map(row => row.docIndex)).toEqual([0, 1, 2, 3]);
  });

  it('omits OOV terms as BM25 does and returns no results for an all-OOV query', () => {
    const partial = scoreQueryLikelihood(['alpha', 'missing'], lengths, 30, frequencies, postings, { method: 'dirichlet', mu: 1000 });
    const alphaOnly = scoreQueryLikelihood(['alpha'], lengths, 30, frequencies, postings, { method: 'dirichlet', mu: 1000 });
    expect(partial).toEqual(alphaOnly);
    expect(scoreQueryLikelihood(['missing'], lengths, 30, frequencies, postings, { method: 'dirichlet', mu: 1000 })).toEqual([]);
  });

  it('rejects invalid parameters and postings', () => {
    expect(() => scoreQueryLikelihood(['alpha'], lengths, 30, frequencies, postings, { method: 'dirichlet', mu: 0 })).toThrow(/mu/u);
    expect(() => scoreQueryLikelihood(['alpha'], lengths, 30, frequencies, postings, { method: 'jelinek-mercer', lambda: 0 })).toThrow(/lambda/u);
    expect(() => scoreQueryLikelihood(['alpha'], lengths, 30, frequencies,
      new Map([['alpha', [{ docIndex: 9, tf: 1 }]]]), { method: 'dirichlet', mu: 1000 })).toThrow(/posting/u);
  });

  it('fuses ranks with deterministic ties and ignores duplicate IDs within an input rank list', () => {
    expect(reciprocalRankFusion([['a', 'a', 'b'], ['b', 'c', 'a']], 60, 3)).toEqual(['a', 'b', 'c']);
    expect(() => reciprocalRankFusion([['a']], 0, 1)).toThrow(/constant/u);
    expect(() => reciprocalRankFusion([['a']], 60, 0)).toThrow(/limit/u);
  });
});

import { describe, expect, it } from 'vitest';
import { rerankWithE5Rrf } from '../services/e5_rrf_ranker.js';

const article = (id: string) => ({ id, title: id, body: '', publishedAt: new Date(0), sourceAuthority: 1, url: '' });

describe('E5 and BM25 reciprocal-rank fusion', () => {
  it('combines semantic order with BM25 order and retains score provenance', async () => {
    const candidates = ['a', 'b', 'c', 'd', 'e'].map((id, index) => ({ article: article(id), score: 10 - index }));
    const semanticVectors = new Map([
      ['passage: a', new Float32Array([0, 1])],
      ['passage: b', new Float32Array([1, 0])],
      ['passage: c', new Float32Array([0.9, 0.1])],
      ['passage: d', new Float32Array([0.8, 0.2])],
      ['passage: e', new Float32Array([0.7, 0.3])],
    ]);
    const embed = async (texts: readonly string[]) => texts.map(text => text === 'query: sqlite wal'
      ? new Float32Array([1, 0])
      : semanticVectors.get(text)!);

    const result = await rerankWithE5Rrf(candidates, 'sqlite wal', embed);

    expect(result[0]?.item.article.id).toBe('b');
    expect(result.map(row => row.bm25Rank)).toEqual([2, 3, 1, 4, 5]);
    expect(result[0]).toMatchObject({ e5Rank: 1, normalizedScore: 1 });
    expect(result.every(row => row.normalizedScore > 0 && row.normalizedScore <= 1)).toBe(true);
  });

  it('keeps BM25 ordering when semantic scores tie', async () => {
    const candidates = ['a', 'b', 'c'].map((id, index) => ({ article: article(id), score: 3 - index }));
    const embed = async (texts: readonly string[]) => texts.map(() => new Float32Array([1, 0]));

    const result = await rerankWithE5Rrf(candidates, 'sqlite', embed);

    expect(result.map(row => row.item.article.id)).toEqual(['a', 'b', 'c']);
  });
});

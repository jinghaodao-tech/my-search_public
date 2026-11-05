import { describe, expect, it } from 'vitest';
import { buildRm3QueryWeights, scoreWeightedBm25, type Rm3Document } from '../scripts/bench/bm25_rm3.js';
import type { Posting } from '../scripts/bench/bm25_adaptive_tf.js';

describe('BM25 relevance-model expansion experiment', () => {
  it('interpolates a normalized original query with feedback terms and excludes query terms from expansion', () => {
    const documents: Rm3Document[] = [
      { length: 3, termFrequencies: new Map([['alpha', 1], ['related', 2]]) },
      { length: 2, termFrequencies: new Map([['alpha', 1], ['related', 1]]) },
    ];
    const weights = buildRm3QueryWeights(['alpha', 'alpha'], [{ docIndex: 0 }, { docIndex: 1 }], documents,
      2, 5, new Map([['alpha', 2], ['related', 3]]), 2, 1, 0.5, 1000);
    expect(weights.get('alpha')).toBe(0.5);
    expect(weights.get('related')).toBe(0.5);
    expect([...weights.values()].reduce((sum, weight) => sum + weight, 0)).toBeCloseTo(1, 12);
  });

  it('retains an original-only query when feedback cannot add terms', () => {
    const documents: Rm3Document[] = [{ length: 1, termFrequencies: new Map([['alpha', 1]]) }];
    expect(buildRm3QueryWeights(['alpha'], [{ docIndex: 0 }], documents, 1, 1,
      new Map([['alpha', 1]]))).toEqual(new Map([['alpha', 1]]));
  });

  it('falls back to the original query when every query term is out of vocabulary', () => {
    const documents: Rm3Document[] = [{ length: 1, termFrequencies: new Map([['alpha', 1]]) }];
    expect(buildRm3QueryWeights(['unknown'], [{ docIndex: 0 }], documents, 1, 1,
      new Map([['alpha', 1]]))).toEqual(new Map([['unknown', 1]]));
  });

  it('rejects invalid fixed parameters', () => {
    expect(() => buildRm3QueryWeights(['alpha'], [], [], 1, 1, new Map(), 0)).toThrow(/feedbackDocumentCount/u);
    expect(() => buildRm3QueryWeights(['alpha'], [], [], 1, 1, new Map(), 1, -1)).toThrow(/expansionTermLimit/u);
    expect(() => buildRm3QueryWeights(['alpha'], [], [], 1, 1, new Map(), 1, 10, 1.1)).toThrow(/originalQueryWeight/u);
  });

  it('uses standard BM25 scoring with query-term weights', () => {
    const lengths = [2, 4];
    const postings = new Map<string, Posting[]>([['related', [{ docIndex: 1, tf: 2 }]]]);
    const ranked = scoreWeightedBm25(new Map([['related', 1]]), 2, 3, lengths, postings);
    expect(ranked.map(row => row.docIndex)).toEqual([1]);
    expect(ranked[0]!.score).toBeGreaterThan(0);
  });

  it('returns the exact top-k order, including stable document-index tie breaking', () => {
    const lengths = [2, 2, 2, 2];
    const postings: Map<string, Posting[]> = new Map([
      ['alpha', [{ docIndex: 0, tf: 1 }, { docIndex: 1, tf: 1 }, { docIndex: 2, tf: 1 }, { docIndex: 3, tf: 1 }]],
      ['beta', [{ docIndex: 2, tf: 1 }]],
    ]);
    const weights = new Map([['alpha', 1], ['beta', 1]]);
    const full = scoreWeightedBm25(weights, 4, 2, lengths, postings);
    expect(scoreWeightedBm25(weights, 4, 2, lengths, postings, 1.2, 0.75, 3)).toEqual(full.slice(0, 3));
    expect(scoreWeightedBm25(weights, 4, 2, lengths, postings, 1.2, 0.75, 10)).toEqual(full);
    expect(() => scoreWeightedBm25(weights, 4, 2, lengths, postings, 1.2, 0.75, 0)).toThrow(/limit/u);
  });

  it('matches full sorting for deterministic randomized posting lists and every cutoff', () => {
    let state = 0x5eed1234;
    const random = () => ((state = (Math.imul(state, 1664525) + 1013904223) >>> 0) / 0x1_0000_0000);
    for (let sample = 0; sample < 20; sample++) {
      const documentCount = 50;
      const lengths = Array.from({ length: documentCount }, () => 1 + Math.floor(random() * 100));
      const postings = new Map<string, Posting[]>();
      const weights = new Map<string, number>();
      for (let termIndex = 0; termIndex < 8; termIndex++) {
        const term = `term-${termIndex}`;
        weights.set(term, random());
        const rows: Posting[] = [];
        for (let docIndex = 0; docIndex < documentCount; docIndex++) {
          if (random() < 0.35) rows.push({ docIndex, tf: 1 + Math.floor(random() * 5) });
        }
        postings.set(term, rows);
      }
      const full = scoreWeightedBm25(weights, documentCount, 42, lengths, postings);
      for (let cutoff = 1; cutoff <= documentCount + 1; cutoff++) {
        expect(scoreWeightedBm25(weights, documentCount, 42, lengths, postings, 1.2, 0.75, cutoff)).toEqual(full.slice(0, cutoff));
      }
    }
  });
});

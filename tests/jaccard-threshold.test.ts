import { expect, it } from 'vitest';
import { meetsJaccardThreshold } from '../bm25_engine.js';

it('matches exhaustive Jaccard for empty, unequal, boundary and deterministic varied sets', () => {
  for (let seed = 0; seed < 200; seed += 1) {
    const a = new Set(Array.from({ length: seed % 37 }, (_, i) => (i * 7 + seed) % 61));
    const b = new Set(Array.from({ length: seed % 53 }, (_, i) => (i * 11 + seed * 3) % 61));
    const intersection = [...a].filter(value => b.has(value)).length;
    const union = a.size + b.size - intersection;
    const exact = union ? intersection / union : 1;
    for (const threshold of [0, 0.1, 0.5, 0.8, 0.85, 1, exact, exact + Number.EPSILON]) {
      expect(meetsJaccardThreshold(a, b, threshold)).toBe(exact >= threshold);
      expect(meetsJaccardThreshold(b, a, threshold)).toBe(exact >= threshold);
    }
  }
});

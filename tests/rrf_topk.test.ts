import { describe, expect, it } from 'vitest';
import { exactRrfTopK } from '../scripts/bench/rrf_topk.js';

const asIterator = (ids: string[]) => ids.map(id => ({ id }))[Symbol.iterator]();
const reference = (first: string[], second: string[], limit: number, offset: number) => {
  const scores = new Map<string, number>();
  for (const [rank, id] of first.entries()) scores.set(id, (scores.get(id) ?? 0) + 1 / (offset + rank + 1));
  for (const [rank, id] of second.entries()) scores.set(id, (scores.get(id) ?? 0) + 1 / (offset + rank + 1));
  return [...scores].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, limit).map(([id]) => id);
};

describe('exactRrfTopK', () => {
  it('matches full RRF for disjoint, overlapping, empty, and tied rank lists', () => {
    const cases = [
      { first: ['a', 'b', 'c'], second: ['d', 'e', 'f'] },
      { first: ['a', 'b', 'c', 'd'], second: ['b', 'a', 'e', 'd'] },
      { first: [], second: ['x', 'y'] },
      { first: ['c', 'a', 'b'], second: ['b', 'a', 'c'] },
      { first: ['a', 'b', 'c', 'd', 'e'], second: ['f', 'g', 'h', 'i', 'j'] },
    ];
    for (const { first, second } of cases) for (const limit of [1, 2, 5, 20]) {
      expect(exactRrfTopK(asIterator(first), asIterator(second), limit)).toEqual(reference(first, second, limit, 60));
    }
  });

  it('matches full RRF across deterministic randomized lists', () => {
    let state = 0x51f15e;
    const random = () => ((state = (Math.imul(state, 1664525) + 1013904223) >>> 0) / 0x1_0000_0000);
    for (let trial = 0; trial < 250; trial++) {
      const universe = Array.from({ length: 5 + Math.floor(random() * 80) }, (_, i) => `d${i}`);
      const shuffled = () => [...universe].sort(() => random() - 0.5);
      const first = shuffled().slice(0, Math.floor(random() * universe.length));
      const second = shuffled().slice(0, Math.floor(random() * universe.length));
      const limit = 1 + Math.floor(random() * 20);
      const offset = Math.floor(random() * 100);
      expect(exactRrfTopK(asIterator(first), asIterator(second), limit, offset)).toEqual(reference(first, second, limit, offset));
    }
  });
});

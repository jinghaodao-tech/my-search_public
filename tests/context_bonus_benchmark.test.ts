import { describe, expect, it } from 'vitest';
import {
  allQueryTokenContextBonus,
  currentContextBonus,
  currentContextBonusNaive,
  keywordUnitContextBonus,
} from '../scripts/bench/context_bonus.js';

describe('benchmark-only context bonus variants', () => {
  it('matches the naive current definition for edge cases and deterministic token sequences', () => {
    const cases = [
      { tokens: ['sqlite', 'locking'], terms: ['sqlite'] },
      { tokens: ['sqlite', 'locking', 'mechanism'], terms: ['sqlite', 'locking', 'mechanism'] },
      { tokens: ['sqlite', 'noise', 'locking'], terms: ['sqlite', 'locking', 'absent'] },
      { tokens: ['sqlite', ...Array.from({ length: 60 }, (_, i) => `filler${i}`), 'locking'], terms: ['sqlite', 'locking'] },
      { tokens: ['ja', '保存', 'search', '検索', '保存', 'ja'], terms: ['保存', 'search', '検索'] },
      { tokens: ['x', 'x', 'y', 'x', 'z', 'y'], terms: ['x', 'y', 'z'] },
    ];
    let seed = 73421;
    const random = () => { seed = (seed * 48271) % 2147483647; return seed; };
    const vocab = ['a', 'b', 'c', '日本語', '保存', 'search', 'query'];
    for (let sample = 0; sample < 100; sample += 1) {
      const tokens = Array.from({ length: random() % 120 }, () => vocab[random() % vocab.length]!);
      const terms = [...new Set(Array.from({ length: 1 + random() % 6 }, () => vocab[random() % vocab.length]!))];
      cases.push({ tokens, terms });
    }
    for (const { tokens, terms } of cases) {
      expect(currentContextBonus(tokens, terms, 1.2, 11)).toBeCloseTo(currentContextBonusNaive(tokens, terms, 1.2, 11), 12);
    }
  });

  it('does not give a multi-token query the maximum bonus for one matching token', () => {
    expect(currentContextBonus(['sqlite'], ['sqlite'], 1.2)).toBe(1.2);
    expect(allQueryTokenContextBonus(['sqlite'], ['sqlite', 'locking', 'mechanism'], 1.2)).toBeCloseTo(1 + 0.2 / 3);
    expect(allQueryTokenContextBonus(['sqlite', 'locking', 'mechanism'], ['sqlite', 'locking', 'mechanism'], 1.2)).toBeCloseTo(1.2);
  });

  it('requires full keyword-unit matches and rewards units rather than overlapping n-grams', () => {
    const groups = [['保存', '検索'], ['SQLite']];
    expect(keywordUnitContextBonus(['保存'], groups, 1.2)).toBe(1);
    expect(keywordUnitContextBonus(['保存', '検索'], groups, 1.2)).toBeCloseTo(1.1);
    expect(keywordUnitContextBonus(['保存', '検索', 'SQLite'], groups, 1.2)).toBeCloseTo(1.2);
  });
});

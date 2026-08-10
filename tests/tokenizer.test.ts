import { describe, expect, it } from 'vitest';
import { computeJapanesePhraseWeight, expandJapaneseTokens, looksLikeMojibake } from '../bm25_engine.js';

describe('Japanese tokenizer safeguards', () => {
  it('adds character bigrams to unknown Japanese terms', () => {
    expect(expandJapaneseTokens(['再発見'])).toEqual(expect.arrayContaining(['再発', '発見']));
  });

  it('detects mojibake signals without flagging valid Japanese', () => {
    expect(looksLikeMojibake('保存済みカードの検索')).toBe(false);
    expect(looksLikeMojibake('\uFFFD')).toBe(true);
    expect(looksLikeMojibake('Ã¦\u2013\u2022')).toBe(true);
  });

  it('caps Japanese compound-word amplification at the English phrase weight ceiling', () => {
    expect(computeJapanesePhraseWeight(2, 5)).toBe(3);
    expect(computeJapanesePhraseWeight(2, 5)).not.toBeGreaterThan(3);
    expect(computeJapanesePhraseWeight(1, 1)).toBe(1);
  });
});

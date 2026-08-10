import { describe, expect, it } from 'vitest';
import { computeJapanesePhraseWeight, expandJapaneseTokens, looksLikeMojibake } from '../bm25_engine.js';

describe('Japanese tokenizer safeguards', () => {
  it('adds character bigrams to unknown Japanese terms', () => {
    const unknownJapanese = '\u672A\u77E5\u8A9E\u691C\u7D22';
    expect(expandJapaneseTokens([unknownJapanese])).toEqual(expect.arrayContaining(['\u672A\u77E5', '\u77E5\u8A9E', '\u8A9E\u691C', '\u691C\u7D22']));
  });

  it('detects mojibake signals without flagging valid Japanese', () => {
    expect(looksLikeMojibake('\u65E5\u672C\u8A9E\u691C\u7D22')).toBe(false);
    expect(looksLikeMojibake('\uFFFD')).toBe(true);
    expect(looksLikeMojibake('\u00C3\u00A6\u2013\u2022')).toBe(true);
  });

  it('caps Japanese compound-word amplification at the English phrase weight ceiling', () => {
    expect(computeJapanesePhraseWeight(2, 5)).toBe(3);
    expect(computeJapanesePhraseWeight(2, 5)).not.toBeGreaterThan(3);
    expect(computeJapanesePhraseWeight(1, 1)).toBe(1);
  });
});

import { expect, test } from 'vitest';
import { excludesArticle, parseSearchQuery } from './search/query_parser.ts';

test('query parser preserves raw query, phrases, Japanese terms, synonyms and exclusions', () => {
  const parsed = parseSearchQuery('"SQLite BM25" 保存済みカード -UI', { bm25: ['ranking'] });
  expect(parsed.rawQuery).toBe('"SQLite BM25" 保存済みカード -UI');
  expect(parsed.phrases).toEqual(['sqlite bm25']);
  expect(parsed.terms).toContain('sqlite');
  expect(parsed.terms).toContain('保存済みカード');
  expect(parsed.excludedTerms).toEqual(['ui']);
  expect(parsed.parsedKeywords.find((item) => item.term === 'bm25')?.synonyms).toEqual(['ranking']);
  expect(excludesArticle({ title: 'BM25 UI memo', body: 'colors', tokens: ['ui'] }, parsed.excludedTerms)).toBe(true);
  expect(excludesArticle({ title: 'SQLite BM25', body: 'token cache', tokens: ['sqlite', 'bm25'] }, parsed.excludedTerms)).toBe(false);
  expect(excludesArticle({ title: 'Suite memo', body: 'user interface notes', tokens: ['suite', 'memo'] }, parsed.excludedTerms)).toBe(false);
});

import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { app } from './helpers.js';
import { analyzeQuery, detectIntent } from '../services/query_analysis.js';
import { purposeWords } from '../services/discover_service.js';
import { tokenizeQuery } from '../bm25_engine.js';

const analyze = async (text: string) => analyzeQuery(text, await purposeWords(text));

describe('broad questions and generic words', () => {
  it('a question without a topic word is broad; generic words count for little', async () => {
    const it1 = await analyze('IT業界での現在問題になっていること');
    expect(it1.broad).toBe(true);
    expect(it1.intent).toBe('trend');
    expect(it1.keywords.find(k => k.term === '問題')?.weight).toBeLessThan(1);
    const it2 = await analyze('現代のプログラマーが勉強すべきこと');
    expect(it2).toMatchObject({ broad: true, intent: 'learn' });
  });

  it('specific questions are not broad, and short capitalised names are kept', async () => {
    expect((await analyze('Istio OperatorからHelmへの移行')).broad).toBe(false);
    expect((await analyze('過熱商品の負荷軽減')).broad).toBe(false);
    const rustGo = await analyze('RustとGoの比較');
    expect(rustGo.broad).toBe(false);
    expect(rustGo.keywords.map(k => k.term)).toContain('go');
  });

  it('katakana words written together are searched as one word', async () => {
    expect((await analyze('ページラッチ')).keywords.map(k => k.term)).toEqual(['ページラッチ']);
  });

  it('keeps important terms after the former six-word cutoff', async () => {
    const words = await purposeWords('5% of perinatal mortality is due to low birth weight.');
    expect(words).toContain('5%');
    expect(words).toContain('low');
    expect(words).toContain('birth');
    expect(words).toContain('weight');
  });

  it('drops English function words while preserving topic terms and intentional short names', async () => {
    const result = await analyze('What is the best book about SQLite transactions?');
    const terms = result.keywords.map(keyword => keyword.term);
    expect(terms).toContain('sqlite');
    expect(terms).toContain('transactions');
    expect(terms).not.toContain('what');
    expect(terms).not.toContain('is');
    expect(terms).not.toContain('the');
    expect(terms).not.toContain('about');
    expect((await analyze('Go and IT')).keywords.map(keyword => keyword.term)).toEqual(expect.arrayContaining(['go', 'it']));
  });

  it('ignores leading bracketed source labels before extracting search terms', async () => {
    const terms = await purposeWords('[TOMT] [Book] What is the SQLite WAL write lock?');
    expect(terms).not.toContain('tomt');
    expect(terms).not.toContain('book');
    expect(terms).toContain('sqlite');
    expect(terms).toContain('wal');
    expect(terms).toContain('write');
    expect(terms).toContain('lock');
  });

  it('returns tail terms from the local-search analysis endpoint', async () => {
    const response = await request(app).post('/api/search/terms').send({ text: '5% of perinatal mortality is due to low birth weight.' });
    expect(response.status).toBe(200);
    expect(response.body.keywords.map((keyword: { term: string }) => keyword.term)).toEqual(expect.arrayContaining(['low', 'birth', 'weight']));
  });

  it('accepts natural-language search text longer than 500 characters', async () => {
    const text = 'SQLite WAL concurrency '.repeat(30);
    const response = await request(app).post('/api/search/terms').send({ text });
    expect(response.status).toBe(200);
    expect(response.body.keywords.map((keyword: { term: string }) => keyword.term)).toEqual(expect.arrayContaining(['sqlite', 'wal', 'concurrency']));
  });

  it('keeps technical spellings and mixed Japanese-number terms intact', async () => {
    const words = await purposeWords('Node.js C++ 200系 database is locked');
    expect(words).toContain('node.js');
    expect(words).toContain('c++');
    expect(words).toContain('200系');
    expect(words).toContain('database');
    expect(words).toContain('locked');
  });

  it('normalizes full-width digits and keeps Japanese numeric units as search terms', async () => {
    expect(await purposeWords('８億')).toContain('8億');
    expect(await purposeWords('8億円')).toContain('8億円');
    expect(await purposeWords('２００系')).toContain('200系');
    expect(await purposeWords('２憶')).toContain('2億');
  });

  it('kinds of questions', () => {
    expect(detectIntent('Kubernetesとは')).toBe('overview');
    expect(detectIntent('なぜDBが遅くなるのか')).toBe('why');
    expect(detectIntent('他社の導入事例')).toBe('case');
    expect(detectIntent('前に読んだWALの記事')).toBe('mine');
  });

  it('a long katakana query word is not split into 2-character pieces', async () => {
    const tokens = await tokenizeQuery('プログラマー');
    expect(tokens).toContain('プログラマー');
    expect(tokens).not.toContain('プロ');
    expect(await tokenizeQuery('データ')).toContain('デー'); // short words keep their pieces (データベース)
  });
});

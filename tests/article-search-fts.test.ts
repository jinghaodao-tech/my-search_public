import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { app, database } from './helpers.js';
import { buildStoredTokenSet } from '../bm25_engine.js';
import { rerankByTitleCoverage } from '../services/title_rerank.js';
import { articleSearchFtsAvailable, articleSearchIndexStatus, deleteArticle, invalidateArticleSearchIndexStatus, loadArticlesFromDbByIds, saveArticlesToDb, searchArticleIdsFts5, searchArticleIdsFts5MorphologicalTopK, searchArticleIdsFts5Rrf, storeReaderContent } from '../repositories/articles_repository.js';

process.env.ARTICLE_SEARCH_ENGINE = 'fts5-rerank';

const db = database.db;
const ids = ['fts-ja', 'fts-other', 'fts-reader', 'fts-ngram-only', 'fts-empty', 'fts-topk-status-a', 'fts-topk-status-b', 'fts-topk-status-c'];
const rrfIds = Array.from({ length: 300 }, (_, index) => `fts-rrf-doc-${index}`);

beforeEach(() => {
  const allIds = [...ids, ...rrfIds];
  db.prepare(`DELETE FROM articles WHERE id IN (${allIds.map(() => '?').join(',')})`).run(...allIds);
  invalidateArticleSearchIndexStatus();
});

describe('article FTS5 derived indexes', () => {
  it('checks for the migrated FTS tables without counting indexed documents', () => {
    expect(articleSearchFtsAvailable()).toBe(true);
  });

  it('adds an opt-in title coverage signal while preserving the default score order on ties', () => {
    const items = [
      { score: 10, article: { id: 'body', title: '別の話題' } },
      { score: 9.9, article: { id: 'title', title: 'SQLiteの同時書き込み' } },
      { score: 0, article: { id: 'low', title: '無関係' } },
    ];
    const ranked = rerankByTitleCoverage(items, ['SQLite', '同時書き込み'], 0.2);

    expect(ranked.map(item => item.article.id)).toEqual(['title', 'body', 'low']);
    expect(ranked[0].scoreSources).toMatchObject({ method: 'title-coverage', titleCoverage: 1, weight: 0.2 });
    expect(rerankByTitleCoverage(items, [], 0).map(item => item.article.id)).toEqual(['body', 'title', 'low']);
    expect(() => rerankByTitleCoverage(items, ['SQLite'], Number.NaN)).toThrow();
  });

  it('retains complete per-mode ranks needed for exact RRF scoring', async () => {
    const tokenSets = await Promise.all(Array.from({ length: 10 }, (_, index) =>
      buildStoredTokenSet(`SQLite WAL locking ${'locking '.repeat(index + 1)}`)));
    saveArticlesToDb(rrfIds.map((id, index) => {
      const tokens = tokenSets[index % tokenSets.length];
      return {
        id, title: 'SQLite WAL', body: `locking ${index % 10 + 1}`,
        url: `https://example.test/${id}`, sourceAuthority: 1, publishedAt: new Date(),
        ...tokens, tokens: tokens.ngramTokens, docLength: tokens.ngramDocLength,
      };
    }));
    const query = await buildStoredTokenSet('SQLite WAL locking');
    const full = searchArticleIdsFts5(query.morphologicalTokens, query.ngramTokens);
    const bounded = searchArticleIdsFts5MorphologicalTopK(query.morphologicalTokens, 25);
    const exact = searchArticleIdsFts5Rrf(query.morphologicalTokens, query.ngramTokens, 50);
    const match = (tokens: string[]) => [...new Set(tokens)].map(token => `"${token.replace(/"/g, '""')}"`).join(' OR ');
    const morphExpression = match(query.morphologicalTokens);
    const ngramExpression = match(query.ngramTokens);
    const morphTop25 = db.prepare(`SELECT id FROM articles_morph_fts WHERE articles_morph_fts MATCH ? ORDER BY bm25(articles_morph_fts), id LIMIT 25`).all(morphExpression) as Array<{id:string}>;
    const sqlFused = db.prepare(`
      WITH morph AS MATERIALIZED (
        SELECT articles_morph_fts.id AS id,
          ROW_NUMBER() OVER (ORDER BY bm25(articles_morph_fts), articles_morph_fts.id) AS rank
        FROM articles_morph_fts WHERE articles_morph_fts MATCH ?
      ),
      ngram AS MATERIALIZED (
        SELECT articles_ngram_fts.id AS id,
          ROW_NUMBER() OVER (ORDER BY bm25(articles_ngram_fts), articles_ngram_fts.id) AS rank
        FROM articles_ngram_fts WHERE articles_ngram_fts MATCH ?
      ),
      ids AS MATERIALIZED (
        SELECT id FROM morph UNION SELECT id FROM ngram
      ),
      fused AS (
        SELECT ids.id, morph.rank AS morph_rank, ngram.rank AS ngram_rank,
          COALESCE(1.0 / (60 + morph.rank), 0) + COALESCE(1.0 / (60 + ngram.rank), 0) AS rrf
        FROM ids LEFT JOIN morph ON morph.id=ids.id LEFT JOIN ngram ON ngram.id=ids.id
      )
      SELECT *, COUNT(*) OVER() AS matched_count FROM fused
      ORDER BY rrf DESC, MIN(COALESCE(morph_rank, 2147483647), COALESCE(ngram_rank, 2147483647)), id
      LIMIT ?
    `).all(morphExpression, ngramExpression, 50) as Array<{id:string; morph_rank:number; ngram_rank:number; rrf:number; matched_count:number}>;
    const score = (row: {morphRank: number | null; ngramRank: number | null}) =>
      (row.morphRank ? 1 / (60 + row.morphRank) : 0) + (row.ngramRank ? 1 / (60 + row.ngramRank) : 0);
    const topIds = (rows: typeof full.ranks) => [...rows].sort((a, b) => score(b) - score(a)).slice(0, 50).map(row => row.id);

    expect(full.matchedCount).toBe(300);
    expect(full.ranks).toHaveLength(300);
    expect(bounded.ranks).toHaveLength(25);
    expect(bounded.matchedCount).toBe(25);
    expect(bounded.matchedCountIsLowerBound).toBe(true);
    expect(bounded.ranks.every(row => row.ngramRank === null)).toBe(true);
    expect(bounded.ranks.map(row => row.id)).toEqual(morphTop25.map(row => row.id));
    expect(full.ranks.every(row => row.morphRank !== null && row.ngramRank !== null)).toBe(true);
    expect(exact.matchedCount).toBe(full.matchedCount);
    expect(exact.ranks).toHaveLength(50);
    expect(topIds(full.ranks)).toHaveLength(50);
    expect(sqlFused).toHaveLength(50);
    expect(sqlFused[0].matched_count).toBe(300);
    expect(sqlFused.map(row => row.id)).toEqual(topIds(full.ranks));
    expect(exact.ranks.map(row => row.id)).toEqual(topIds(full.ranks));
    expect(exact.ranks.every(row => row.rrfScore === score(row))).toBe(true);
  });

  it('filters expired items after morphology Top-K and extends the window to fill valid results', async () => {
    const term = 'ftsTopKStatusNeedle';
    const tokenSets = await Promise.all([1, 2, 3].map(count => buildStoredTokenSet(`${term} `.repeat(count))));
    const testIds = ids.slice(-3);
    saveArticlesToDb(testIds.map((id, index) => ({
      id, title: `Top K status ${index}`, body: `${term} `.repeat(index + 1),
      url: `https://example.test/${id}`, sourceAuthority: 1, publishedAt: new Date(),
      ...tokenSets[index], tokens: tokenSets[index].ngramTokens, docLength: tokenSets[index].ngramDocLength,
    })));
    const query = await buildStoredTokenSet(term);
    const match = [...new Set(query.morphologicalTokens)].map(token => `"${token.replace(/"/g, '""')}"`).join(' OR ');
    const allRanked = db.prepare(`SELECT id FROM articles_morph_fts WHERE articles_morph_fts MATCH ? ORDER BY bm25(articles_morph_fts), id`).all(match) as Array<{id: string}>;
    expect(allRanked.filter(row => testIds.includes(row.id))).toHaveLength(3);

    const expiredId = allRanked.find(row => testIds.includes(row.id))!.id;
    db.prepare("UPDATE articles SET candidate_status='expired' WHERE id=?").run(expiredId);
    const expected = allRanked.filter(row => row.id !== expiredId).slice(0, 2).map(row => row.id);
    const actual = searchArticleIdsFts5MorphologicalTopK(query.morphologicalTokens, 2).ranks.map(row => row.id);

    expect(actual).toEqual(expected);
    expect(actual).not.toContain(expiredId);
  });

  it('indexes morphology and n-gram tokens and retrieves Japanese and mixed-script terms', async () => {
    const targetTokens = await buildStoredTokenSet('SQLiteの同時書き込みとロック WAL database');
    const otherTokens = await buildStoredTokenSet('Rust ownership and memory safety');
    saveArticlesToDb([
      { id: 'fts-ja', title: 'SQLite同時書き込み', body: 'ロックとWAL', url: 'https://example.test/fts-ja', sourceAuthority: 1, publishedAt: new Date(), source: 'test:fts', ...targetTokens, tokens: targetTokens.ngramTokens, docLength: targetTokens.ngramDocLength },
      { id: 'fts-other', title: 'Rust', body: 'memory safety', url: 'https://example.test/fts-other', sourceAuthority: 1, publishedAt: new Date(), source: 'test:fts', ...otherTokens, tokens: otherTokens.ngramTokens, docLength: otherTokens.ngramDocLength },
    ]);
    const japanese = await buildStoredTokenSet('同時書き込み');
    const ranks = searchArticleIdsFts5(japanese.morphologicalTokens, japanese.ngramTokens).ranks;
    expect(ranks.map(row => row.id)).toContain('fts-ja');
    expect(ranks.map(row => row.id)).not.toContain('fts-other');
    const mixed = await buildStoredTokenSet('SQLite WAL');
    expect(searchArticleIdsFts5(mixed.morphologicalTokens, mixed.ngramTokens).ranks.map(row => row.id)).toContain('fts-ja');
    expect(loadArticlesFromDbByIds(['fts-ja']).map(article => article.id)).toEqual(['fts-ja']);
  });

  it('tracks article updates, Reader token refreshes, and deletes', async () => {
    const tokens = await buildStoredTokenSet('initial index phrase');
    saveArticlesToDb([{ id: 'fts-reader', title: 'Reader', body: 'short', url: 'https://example.test/fts-reader', sourceAuthority: 1, publishedAt: new Date(), ...tokens, tokens: tokens.ngramTokens, docLength: tokens.ngramDocLength }]);
    expect(searchArticleIdsFts5([], ['initial']).ranks.map(row => row.id)).toContain('fts-reader');

    const replacement = await buildStoredTokenSet('reader replacement keyword');
    storeReaderContent({ articleId: 'fts-reader', body: 'reader replacement keyword', hash: 'reader-hash', tokens: replacement }, new Date().toISOString());
    expect(searchArticleIdsFts5([], ['initial']).ranks.map(row => row.id)).not.toContain('fts-reader');
    expect(searchArticleIdsFts5([], ['replacement']).ranks.map(row => row.id)).toContain('fts-reader');

    db.prepare('DELETE FROM articles WHERE id=?').run('fts-reader');
    expect(searchArticleIdsFts5([], ['replacement']).ranks.map(row => row.id)).not.toContain('fts-reader');
  });

  it('uses FTS candidates for DB-backed searches without changing full-corpus scope totals', async () => {
    const wanted = await buildStoredTokenSet('SQLite concurrency WAL locking');
    const irrelevant = await buildStoredTokenSet('Gardening flowers spring');
    saveArticlesToDb([
      { id: 'fts-ja', title: 'SQLite WAL', body: 'concurrency locking', url: 'https://example.test/fts-ja', sourceAuthority: 1, publishedAt: new Date(), source: 'test:fts', ...wanted, tokens: wanted.ngramTokens, docLength: wanted.ngramDocLength },
      { id: 'fts-other', title: 'Spring garden', body: 'flowers', url: 'https://example.test/fts-other', sourceAuthority: 1, publishedAt: new Date(), source: 'test:other', ...irrelevant, tokens: irrelevant.ngramTokens, docLength: irrelevant.ngramDocLength },
    ]);
    const config = { label: 'sqlite', description: 'sqlite', k1: 1.2, b: 0.75, lambda: 0, contextBonus: 1, keywords: [{ term: 'SQLite', weight: 1 }] };
    const response = await request(app).post('/api/run').send({ config, options: { archiveScoreThreshold: -1 }, filters: { status: 'all' } }).expect(200);
    expect(response.body.scope).toMatchObject({ searchMethod: 'fts5-rerank', candidateCount: 1, totalCount: 2, searchedCount: 2 });
    expect(response.body.active.map((item: {article: {id: string}}) => item.article.id)).toContain('fts-ja');
    process.env.ARTICLE_SEARCH_ENGINE = 'fts5-rrf';
    const fused = await request(app).post('/api/run').send({ config, options: { resultLimit: 10 }, filters: { status: 'all' } }).expect(200);
    expect(fused.body.scope.searchMethod).toBe('fts5-rrf');
    expect(fused.body.active[0].scoreSources).toMatchObject({ method: 'rrf', morphologicalRank: 1, ngramRank: 1 });
    process.env.ARTICLE_SEARCH_ENGINE = 'fts5-title-rerank';
    const titled = await request(app).post('/api/run').send({ config, options: { resultLimit: 10, archiveScoreThreshold: -1 }, filters: { status: 'all' } }).expect(200);
    expect(titled.body.scope.searchMethod).toBe('fts5-title-rerank');
    expect(titled.body.scope).toMatchObject({ scopeCountsExact: false, totalCount: null, searchedCount: null });
    expect(titled.body.active[0].scoreSources).toMatchObject({ method: 'title-coverage', titleCoverage: 1, weight: 0.2 });
    process.env.ARTICLE_SEARCH_TITLE_RERANK_WEIGHT = '0';
    const titleDisabled = await request(app).post('/api/run').send({ config, options: { resultLimit: 10, archiveScoreThreshold: -1 }, filters: { status: 'all' } }).expect(200);
    expect(titleDisabled.body.active[0].scoreSources).toMatchObject({ method: 'title-coverage', weight: 0 });
    const queryTokens = await buildStoredTokenSet('SQLite');
    const expectedFts = searchArticleIdsFts5MorphologicalTopK(queryTokens.morphologicalTokens, 10).ranks;
    expect(titleDisabled.body.active.map((item: {article: {id: string}}) => item.article.id)).toEqual(expectedFts.map(row => row.id));
    expect(titleDisabled.body.active[0].scoreSources.baseScore).toBe(expectedFts[0].score);
    delete process.env.ARTICLE_SEARCH_TITLE_RERANK_WEIGHT;
    process.env.ARTICLE_SEARCH_ENGINE = 'fts5-rerank';
    expect(articleSearchIndexStatus().missingTokenRows).toBe(0);
  });

  it('keeps FTS enabled when a Japanese document has only searchable n-gram tokens', async () => {
    const ngramOnly = await buildStoredTokenSet('兼六園 徽軫灯籠');
    expect(ngramOnly.morphologicalTokens).toEqual([]);
    expect(ngramOnly.ngramTokens.length).toBeGreaterThan(0);
    saveArticlesToDb([{
      id: 'fts-ngram-only', title: '兼六園', body: '徽軫灯籠', url: 'https://example.test/fts-ngram-only',
      sourceAuthority: 1, publishedAt: new Date(), ...ngramOnly,
      tokens: ngramOnly.ngramTokens, docLength: ngramOnly.ngramDocLength,
    }]);

    const config = { label: 'ngram-only', description: '', k1: 1.2, b: 0.75, lambda: 0, contextBonus: 1,
      keywords: [{ term: '徽軫灯籠', weight: 1 }] };
    const exactRrf = searchArticleIdsFts5Rrf(ngramOnly.morphologicalTokens, ngramOnly.ngramTokens, 10);
    expect(exactRrf.matchedCount).toBe(1);
    expect(exactRrf.ranks[0]).toMatchObject({ id: 'fts-ngram-only', morphRank: null, ngramRank: 1 });
    const response = await request(app).post('/api/run').send({
      config, options: { archiveScoreThreshold: -1 }, filters: { status: 'all' },
    }).expect(200);

    expect(['fts5-rerank', 'fts5-rrf']).toContain(response.body.scope.searchMethod);
    expect(response.body.scope.candidateCount).toBe(1);
    expect(response.body.active.map((item: {article: {id: string}}) => item.article.id)).toContain('fts-ngram-only');
    expect(articleSearchIndexStatus().missingTokenRows).toBe(0);
  });

  it('invalidates cached index completeness after article writes and deletes', async () => {
    const before = articleSearchIndexStatus();
    saveArticlesToDb([{
      id: 'fts-empty', title: 'No cached terms', body: '', url: 'https://example.test/fts-empty',
      sourceAuthority: 1, publishedAt: new Date(), tokens: [], morphologicalTokens: [], ngramTokens: [],
      docLength: 0, morphologicalDocLength: 0, ngramDocLength: 0,
    }]);
    expect(articleSearchIndexStatus()).toMatchObject({ articles: before.articles + 1, missingTokenRows: before.missingTokenRows + 1 });
    expect(deleteArticle('fts-empty')).toBe(true);
    expect(articleSearchIndexStatus()).toEqual(before);
  });
});

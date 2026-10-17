import { describe, expect, it } from 'vitest';
import request from 'supertest';
import Database from 'better-sqlite3';
import { app, database, searchMode } from './helpers.js';
import { buildSearchSnippet } from '../services/search_match_service.js';
import { saveArticlesToDb } from '../repositories/articles_repository.js';

const config = searchMode([{ term: 'SQLite', weight: 1 }]);
const settings = { name: 'SQLite調査', source: 'articles', config, options: { resultLimit: 10 }, filters: { excludedTerms: ['広告'], sources: ['rss:test'], status: 'deferred' } };

describe('search workflow', () => {
  it('persists named conditions in SQLite, updates and deletes them', async () => {
    const saved = await request(app).post('/api/saved-searches').send(settings).expect(201);
    const reopened = new Database(process.env.DB_PATH!);
    expect(JSON.parse((reopened.prepare('SELECT payload FROM saved_searches WHERE id = ?').get(saved.body.id) as { payload: string }).payload)).toEqual(settings);
    reopened.close();
    await request(app).put(`/api/saved-searches/${saved.body.id}`).send({ ...settings, name: '続き' }).expect(200);
    const list = await request(app).get('/api/saved-searches').expect(200);
    expect(list.body.find((item: { id: string }) => item.id === saved.body.id).name).toBe('続き');
    await request(app).post('/api/saved-searches').send({ ...settings, config: { ...config, k1: -1 } }).expect(400);
    await request(app).delete(`/api/saved-searches/${saved.body.id}`).expect(200);
    expect(database.db.prepare('SELECT * FROM saved_searches WHERE id = ?').get(saved.body.id)).toBeUndefined();
  });
  it('keeps deferred candidates beyond retention and saves them only once', async () => {
    const id = 'deferred-workflow';
    saveArticlesToDb([{ id, title: 'SQLite', body: 'SQLite concurrency', url: 'https://example.test/deferred-workflow', publishedAt: new Date(), sourceAuthority: 1 }]);
    const deferred = await request(app).put(`/api/candidates/${id}/defer`).send({}).expect(200);
    expect(deferred.body.status).toBe('deferred');
    database.db.prepare("UPDATE articles SET reviewed_at = '2000-01-01T00:00:00Z' WHERE id = ?").run(id);
    await request(app).post('/api/candidates/expire-reviewed').send({ candidateRetentionDays: 1 }).expect(200);
    const list = await request(app).get('/api/candidates?status=deferred').expect(200);
    expect(list.body.some((item: { candidateId: string }) => item.candidateId === id)).toBe(true);
    const saved = await request(app).post(`/api/candidates/${id}/save`).send({}).expect(201);
    await request(app).post(`/api/candidates/${id}/save`).send({}).expect(409);
    database.db.prepare('DELETE FROM articles WHERE id = ?').run(id);
    database.db.prepare('DELETE FROM cards WHERE id = ?').run(saved.body.card.id);
  });
  it('returns the actual search scope after source and exclusion filtering', async () => {
    const articles = [
      { id: 'scope-a', title: 'SQLite', body: 'concurrency', tokens: ['sqlite', 'concurrency'], docLength: 2, sourceAuthority: 1, source: 'rss:test', publishedAt: new Date().toISOString() },
      { id: 'scope-b', title: 'SQLite 広告', body: 'concurrency', tokens: ['sqlite', 'concurrency'], docLength: 2, sourceAuthority: 1, source: 'rss:test', publishedAt: new Date().toISOString() },
      { id: 'scope-c', title: 'SQLite', body: 'concurrency', tokens: ['sqlite', 'concurrency'], docLength: 2, sourceAuthority: 1, source: 'rss:other', publishedAt: new Date().toISOString() },
    ];
    const response = await request(app).post('/api/run').send({ config, articles, options: { archiveScoreThreshold: -1 }, filters: { ...settings.filters, status: 'all' } }).expect(200);
    expect(response.body.scope).toMatchObject({ totalCount: 3, searchedCount: 1, sources: ['rss:test'] });
    expect(response.body.active.map((item: { article: { id: string } }) => item.article.id)).toEqual(['scope-a']);
    const empty = await request(app).post('/api/run').send({ config, articles, filters: { excludedTerms: ['SQLite'] } }).expect(200);
    expect(empty.body.scope.searchedCount).toBe(0);
    expect(empty.body.active).toEqual([]);
  });
  it('extracts a matching passage beyond the introduction', () => {
    const snippet = buildSearchSnippet({ body: '前置き。'.repeat(150) + 'SQLiteの同時書き込みについて説明します。' + '補足。'.repeat(150) }, ['同時書き込み']);
    expect(snippet).toContain('同時書き込み');
    expect(snippet.startsWith('…')).toBe(true);
    expect(snippet.length).toBeLessThanOrEqual(242);
  });
});

describe('continued research', () => {
  it('uses reader text after RSS refresh without changing discovery time', async () => {
    const id = 'reader-search-copy';
    const article = { id, title: '資料', body: '短い紹介', url: 'https://example.test/reader-search-copy', publishedAt: new Date(), sourceAuthority: 1, firstSeenAt: '2020-01-01T00:00:00.000Z' };
    saveArticlesToDb([article]);
    database.db.prepare('INSERT INTO article_reader_content VALUES (?, ?, ?)').run(id, 'SQLite concurrency 本文の途中', new Date().toISOString());
    saveArticlesToDb([article]);
    const { loadArticlesFromDb } = await import('../repositories/articles_repository.js');
    expect(loadArticlesFromDb().find(item => item.id === id)?.body).toContain('concurrency');
    const found = await request(app).post('/api/run').send({ config, options: { archiveScoreThreshold: -1 } }).expect(200);
    expect(found.body.active.some((item: { article: { id: string } }) => item.article.id === id)).toBe(true);
    const response = await request(app).post('/api/run').send({ config, filters: { since: '2021-01-01T00:00:00.000Z' } }).expect(200);
    expect([...response.body.active, ...response.body.archived].some((item: { article: { id: string } }) => item.article.id === id)).toBe(false);
    database.db.prepare('DELETE FROM articles WHERE id = ?').run(id);
  });
  it('records explicit checkpoints and preserves them when conditions are renamed', async () => {
    const saved = await request(app).post('/api/saved-searches').send(settings).expect(201);
    const checkedAt = '2025-01-01T00:00:00.000Z';
    await request(app).post(`/api/saved-searches/${saved.body.id}/checkpoint`).send({ checkedAt }).expect(200);
    await request(app).put(`/api/saved-searches/${saved.body.id}`).send({ ...settings, name: '改名' }).expect(200);
    const list = await request(app).get('/api/saved-searches').expect(200);
    expect(list.body.find((item: { id: string; checkedAt: string }) => item.id === saved.body.id).checkedAt).toBe(checkedAt);
    await request(app).delete(`/api/saved-searches/${saved.body.id}`).expect(200);
  });
  it('saves a source without article text and supports a later pasted copy', async () => {
    const saved = await request(app).post('/api/reader/save').send({ url: 'https://example.test/unavailable', title: '取得できない記事', fetchedAt: new Date().toISOString(), paragraphs: [] }).expect(201);
    await request(app).put(`/api/reader/cards/${saved.body.card.id}`).send({ title: '取得できない記事', paragraphs: ['後から貼り付けた本文'] }).expect(200);
    const read = await request(app).get(`/api/reader/cards/${saved.body.card.id}`).expect(200);
    expect(read.body.paragraphs).toEqual(['後から貼り付けた本文']);
    database.db.prepare('DELETE FROM cards WHERE id = ?').run(saved.body.card.id);
  });
});

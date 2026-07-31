import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { app, database } from './helpers.js';
import { saveArticlesToDb } from '../repositories/articles_repository.js';

const db = database.db;

describe('candidate lifecycle', () => {
  it('reviews, saves, and protects saved candidates from expiry', async () => {
    const id = `candidate-${Date.now()}`;
    saveArticlesToDb([{
      id,
      title: 'Candidate lifecycle article',
      body: 'Collected article body',
      url: `https://example.test/${id}`,
      publishedAt: new Date('2026-07-01T00:00:00.000Z'),
      sourceAuthority: 0.8,
      summary: 'Candidate summary',
      tags: ['candidate'],
    }]);
    try {
      const initial = await request(app).get(`/api/candidates/${id}`);
      expect(initial.status).toBe(200);
      expect(initial.body.title).toBe('Candidate lifecycle article');
      const list = await request(app).get('/api/candidates?status=unreviewed');
      expect(list.body.some((candidate: { candidateId: string }) => candidate.candidateId === id)).toBe(true);
      const reviewed = await request(app).put(`/api/candidates/${id}/review`).send({});
      expect(reviewed.status).toBe(200);
      expect(reviewed.body.status).toBe('reviewed_not_saved');
      const saved = await request(app).post(`/api/candidates/${id}/save`).send({});
      expect(saved.status).toBe(201);
      expect(saved.body.candidate.status).toBe('saved_as_card');
      expect(saved.body.card.title).toBe('Candidate lifecycle article');
      const expired = await request(app).put(`/api/candidates/${id}/expire`).send({});
      expect(expired.status).toBe(200);
      expect(expired.body.status).toBe('saved_as_card');
      const card = db.prepare('SELECT title, type FROM cards WHERE id = ?').get(saved.body.card.id) as { title: string; type: string };
      expect(card).toEqual({ title: 'Candidate lifecycle article', type: 'article' });
    } finally {
      db.prepare('DELETE FROM articles WHERE id = ?').run(id);
      db.prepare('DELETE FROM cards WHERE title = ?').run('Candidate lifecycle article');
    }
  });

  it('adds lifecycle columns and migration indexes to SQLite', () => {
    const columns = db.prepare('PRAGMA table_info(articles)').all() as Array<{ name: string }>;
    expect(columns.map(column => column.name)).toEqual(expect.arrayContaining(['candidate_status', 'first_seen_at', 'reviewed_at', 'saved_at', 'expired_at']));
    const indexes = db.prepare('PRAGMA index_list(articles)').all() as Array<{ name: string }>;
    expect(indexes.map(index => index.name)).toEqual(expect.arrayContaining(['idx_articles_candidate_status', 'idx_articles_first_seen_at']));
  });
});

describe('candidate refresh and retention boundaries', () => {
  it('keeps lifecycle timestamps while updating the same source article', () => {
    const id = `candidate-refresh-${Date.now()}`;
    const url = `https://example.test/refresh-${id}`;
    saveArticlesToDb([{ id, title: 'Before update', body: 'old body', url, publishedAt: new Date('2026-07-01T00:00:00.000Z'), sourceAuthority: 0.8 }]);
    const first = db.prepare('SELECT first_seen_at FROM articles WHERE id = ?').get(id) as { first_seen_at: string };
    saveArticlesToDb([{ id, title: 'After update', body: 'new body', url, publishedAt: new Date('2026-07-02T00:00:00.000Z'), sourceAuthority: 0.8 }]);
    const updated = db.prepare('SELECT title, body, first_seen_at FROM articles WHERE id = ?').get(id) as { title: string; body: string; first_seen_at: string };
    expect(updated.title).toBe('After update');
    expect(updated.body).toBe('new body');
    expect(updated.first_seen_at).toBe(first.first_seen_at);
    db.prepare('DELETE FROM articles WHERE id = ?').run(id);
  });

  it('expires reviewed candidates at the retention boundary but not saved cards', async () => {
    const id = `candidate-retention-${Date.now()}`;
    saveArticlesToDb([{ id, title: 'Retention candidate', body: 'body', url: `https://example.test/retention-${id}`, publishedAt: new Date(), sourceAuthority: 0.8, tokens: ['sqlite', 'bm25', 'article'], docLength: 3 }]);
    await request(app).put(`/api/candidates/${id}/review`).send({});
    db.prepare('UPDATE articles SET reviewed_at = ? WHERE id = ?').run(new Date(Date.now() - 14 * 86_400_000 - 1).toISOString(), id);
    const expired = await request(app).post('/api/candidates/expire-reviewed').send({ candidateRetentionDays: 14 });
    expect(expired.status).toBe(200);
    expect(expired.body.expired).toContain(id);
    db.prepare('DELETE FROM articles WHERE id = ?').run(id);
  });
});

describe('candidate ranking metadata', () => {
  it('stores latest BM25 score and match reason for candidate UI', async () => {
    const id = `candidate-score-${Date.now()}`;
    saveArticlesToDb([{ id, title: 'SQLite BM25 article', body: 'ranking body', url: `https://example.test/score-${id}`, publishedAt: new Date(), sourceAuthority: 0.8, tokens: ['sqlite', 'bm25', 'article'], docLength: 3 }]);
    const response = await request(app).post('/api/run').send({ modeId: 'custom', config: { k1: 1.5, b: 0.75, lambda: 0.1, contextBonus: 1.5, keywords: [{ term: 'sqlite', weight: 1, synonyms: [] }] }, articles: [{ id, title: 'SQLite BM25 article', body: 'ranking body', publishedAt: new Date().toISOString(), sourceAuthority: 0.8, url: `https://example.test/score-${id}`, tokens: ['sqlite', 'bm25', 'article'], docLength: 3 }], options: { resultLimit: 5, archiveScoreThreshold: 0 } });
    expect(response.status).toBe(200);
    const candidate = await request(app).get(`/api/candidates/${id}`);
    expect(candidate.status).toBe(200);
    expect(candidate.body.score).toBeTypeOf('number');
    expect(candidate.body.matchReason).toContain('title');
    db.prepare('DELETE FROM articles WHERE id = ?').run(id);
  });
});

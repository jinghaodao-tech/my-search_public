import fs from 'fs';
import path from 'path';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';

process.env.NODE_ENV = 'test';
process.env.MOCK_AI_SUMMARY = 'true';
process.env.CORS_ORIGIN = 'http://localhost:3000';
process.env.IMPORT_RATE_LIMIT = '3';
process.env.DB_PATH = path.join(process.cwd(), 'data', 'test-cards.db');

fs.rmSync(process.env.DB_PATH, { force: true });

const { app } = await import('./server.js');
const { db } = await import('./db/database.js');

beforeEach(() => {
  db.prepare('DELETE FROM cards').run();
});

async function createCard(overrides: Record<string, unknown> = {}) {
  const response = await request(app)
    .post('/api/cards')
    .send({
      title: 'Test card',
      body: 'body',
      tags: ['api'],
      ...overrides,
    });

  expect(response.status).toBe(201);
  return response.body as { id: string };
}

function bm25Config(term: string) {
  return {
    k1: 1.5,
    b: 0.75,
    lambda: 0.1,
    contextBonus: 1.5,
    keywords: [{ term, weight: 1, synonyms: [] }],
  };
}

async function runSearch(cardId: string, term: string) {
  return request(app)
    .post('/api/run')
    .send({
      modeId: 'custom',
      config: bm25Config(term),
      articles: [{
        id: cardId,
        title: 'fallback title',
        body: 'fallback body',
        publishedAt: new Date().toISOString(),
        sourceAuthority: 0.8,
        url: '',
      }],
      options: { resultLimit: 5, archiveScoreThreshold: 0 },
    });
}

describe('cards API validation', () => {
  it('returns health status', async () => {
    const response = await request(app).get('/healthz');

    expect(response.status).toBe(200);
    expect(response.body.ok).toBe(true);
    expect(response.body.db).toBe('ok');
    expect(typeof response.body.cardCount).toBe('number');
    expect(response.headers['x-request-id']).toBeTruthy();
  });

  it('echoes X-Request-Id response header', async () => {
    const response = await request(app)
      .get('/healthz')
      .set('X-Request-Id', 'test-request-id');

    expect(response.status).toBe(200);
    expect(response.headers['x-request-id']).toBe('test-request-id');
  });

  it('creates a card', async () => {
    const response = await request(app)
      .post('/api/cards')
      .send({ title: 'Card title', body: 'hello', tags: ['typescript'] });

    expect(response.status).toBe(201);
    expect(response.body.title).toBe('Card title');
    expect(response.body.tags).toEqual(['typescript']);
  });

  it('rejects an empty title', async () => {
    const response = await request(app)
      .post('/api/cards')
      .send({ title: '', body: 'hello' });

    expect(response.status).toBe(400);
    expect(response.body.error).toBe('Invalid request');
  });

  it('rejects an oversized body', async () => {
    const response = await request(app)
      .post('/api/cards')
      .send({ title: 'Large', body: 'a'.repeat(20001) });

    expect(response.status).toBe(400);
    expect(response.body.error).toBe('Invalid request');
  });

  it('returns 404 for a missing card id', async () => {
    const response = await request(app).get('/api/cards/missing-card');

    expect(response.status).toBe(404);
  });

  it('updates a card without changing its id', async () => {
    const card = await createCard();

    const response = await request(app)
      .put(`/api/cards/${card.id}`)
      .send({ title: 'Updated title', body: 'updated body', tags: ['sqlite'] });

    expect(response.status).toBe(200);
    expect(response.body.id).toBe(card.id);
    expect(response.body.title).toBe('Updated title');
    expect(response.body.tags).toEqual(['sqlite']);
  });

  it('deletes a card', async () => {
    const card = await createCard();

    const response = await request(app).delete(`/api/cards/${card.id}`);
    const missing = await request(app).get(`/api/cards/${card.id}`);

    expect(response.status).toBe(200);
    expect(response.body.ok).toBe(true);
    expect(missing.status).toBe(404);
  });

  it('removes deleted card ids from other cards links', async () => {
    const first = await createCard({ title: 'First' });
    const second = await createCard({ title: 'Second' });

    await request(app)
      .post(`/api/cards/${first.id}/links`)
      .send({ targetId: second.id });

    const deleted = await request(app).delete(`/api/cards/${second.id}`);
    const firstAfterDelete = await request(app).get(`/api/cards/${first.id}`);

    expect(deleted.status).toBe(200);
    expect(firstAfterDelete.status).toBe(200);
    expect(firstAfterDelete.body.links).not.toContain(second.id);
  });

  it('rejects bulk operations when ids is not an array', async () => {
    const response = await request(app)
      .post('/api/cards/bulk-archive')
      .send({ ids: 'not-array' });

    expect(response.status).toBe(400);
    expect(response.body.error).toBe('Invalid request');
  });

  it('archives, restores, and bulk deletes cards', async () => {
    const first = await createCard({ title: 'First' });
    const second = await createCard({ title: 'Second' });

    const archived = await request(app)
      .post('/api/cards/bulk-archive')
      .send({ ids: [first.id, second.id] });
    expect(archived.status).toBe(200);
    expect(archived.body.updated).toEqual([first.id, second.id]);

    const restored = await request(app)
      .post('/api/cards/bulk-restore')
      .send({ ids: [first.id] });
    expect(restored.status).toBe(200);
    expect(restored.body.updated).toEqual([first.id]);

    const deleted = await request(app)
      .post('/api/cards/bulk-delete')
      .send({ ids: [first.id, second.id] });
    expect(deleted.status).toBe(200);
    expect(deleted.body.deleted).toEqual([first.id, second.id]);

    expect((await request(app).get(`/api/cards/${first.id}`)).status).toBe(404);
    expect((await request(app).get(`/api/cards/${second.id}`)).status).toBe(404);
  });

  it('removes bulk-deleted card ids from remaining cards links', async () => {
    const first = await createCard({ title: 'First' });
    const second = await createCard({ title: 'Second' });
    const third = await createCard({ title: 'Third' });

    await request(app)
      .post(`/api/cards/${first.id}/links`)
      .send({ targetId: second.id });
    await request(app)
      .post(`/api/cards/${first.id}/links`)
      .send({ targetId: third.id });

    const deleted = await request(app)
      .post('/api/cards/bulk-delete')
      .send({ ids: [second.id, third.id] });
    const firstAfterDelete = await request(app).get(`/api/cards/${first.id}`);

    expect(deleted.status).toBe(200);
    expect(deleted.body.deleted).toEqual([second.id, third.id]);
    expect(firstAfterDelete.body.links).not.toContain(second.id);
    expect(firstAfterDelete.body.links).not.toContain(third.id);
    expect((await request(app).get(`/api/cards/${second.id}`)).status).toBe(404);
    expect((await request(app).get(`/api/cards/${third.id}`)).status).toBe(404);
  });

  it('rejects self links', async () => {
    const card = await createCard();

    const response = await request(app)
      .post(`/api/cards/${card.id}/links`)
      .send({ targetId: card.id });

    expect(response.status).toBe(400);
    expect(response.body.error).toBe('Invalid request');
  });

  it('creates and removes bidirectional links', async () => {
    const first = await createCard({ title: 'First' });
    const second = await createCard({ title: 'Second' });

    const linked = await request(app)
      .post(`/api/cards/${first.id}/links`)
      .send({ targetId: second.id });
    expect(linked.status).toBe(200);

    const firstAfterLink = await request(app).get(`/api/cards/${first.id}`);
    const secondAfterLink = await request(app).get(`/api/cards/${second.id}`);
    expect(firstAfterLink.body.links).toContain(second.id);
    expect(secondAfterLink.body.links).toContain(first.id);
    expect((await request(app).get(`/api/cards/${second.id}/backlinks`)).body.map((card: { id: string }) => card.id)).toContain(first.id);

    const unlinked = await request(app).delete(`/api/cards/${first.id}/links/${second.id}`);
    expect(unlinked.status).toBe(200);

    const firstAfterUnlink = await request(app).get(`/api/cards/${first.id}`);
    const secondAfterUnlink = await request(app).get(`/api/cards/${second.id}`);
    expect(firstAfterUnlink.body.links).not.toContain(second.id);
    expect(secondAfterUnlink.body.links).not.toContain(first.id);
    expect((await request(app).get(`/api/cards/${second.id}/backlinks`)).body.map((card: { id: string }) => card.id)).not.toContain(first.id);
  });

  it('assigns and removes a card from a KJ group', async () => {
    const card = await createCard();
    const group = await request(app)
      .post('/api/kj/groups')
      .send({ name: `Group ${Date.now()}`, color: '#4D96FF' });

    expect(group.status).toBe(201);

    const assigned = await request(app)
      .post(`/api/kj/groups/${group.body.id}/cards`)
      .send({ cardId: card.id });
    expect(assigned.status).toBe(200);
    expect((await request(app).get(`/api/cards/${card.id}`)).body.kjGroupId).toBe(group.body.id);

    const removed = await request(app).delete(`/api/kj/groups/${group.body.id}/cards/${card.id}`);
    expect(removed.status).toBe(200);
    expect((await request(app).get(`/api/cards/${card.id}`)).body.kjGroupId).toBeUndefined();

    await request(app).delete(`/api/kj/groups/${group.body.id}`);
  });

  it('filters card lists by archived state', async () => {
    const active = await createCard({ title: 'Active list card' });
    const archived = await createCard({ title: 'Archived list card' });

    const archiveResponse = await request(app).put(`/api/cards/${archived.id}/archive`);
    expect(archiveResponse.status).toBe(200);

    const activeList = await request(app).get('/api/cards?archived=false');
    const archivedList = await request(app).get('/api/cards?archived=true');

    expect(activeList.status).toBe(200);
    expect(archivedList.status).toBe(200);
    expect(activeList.body.map((card: { id: string }) => card.id)).toContain(active.id);
    expect(activeList.body.map((card: { id: string }) => card.id)).not.toContain(archived.id);
    expect(archivedList.body.map((card: { id: string }) => card.id)).toEqual([archived.id]);
  });

  it('filters card lists by type', async () => {
    const memo = await createCard({ title: 'Memo card', type: 'memo' });
    const article = await createCard({ title: 'Article card', type: 'article' });

    const response = await request(app).get('/api/cards?type=memo');

    expect(response.status).toBe(200);
    const ids = response.body.map((card: { id: string }) => card.id);
    expect(ids).toContain(memo.id);
    expect(ids).not.toContain(article.id);
  });

  it('filters card lists by tag', async () => {
    const tagged = await createCard({ title: 'Tagged card', tags: ['sql-filter', 'api'] });
    const other = await createCard({ title: 'Other card', tags: ['other'] });

    const response = await request(app).get('/api/cards?tag=sql-filter');

    expect(response.status).toBe(200);
    const ids = response.body.map((card: { id: string }) => card.id);
    expect(ids).toContain(tagged.id);
    expect(ids).not.toContain(other.id);
  });

  it('filters card lists by KJ group id', async () => {
    const grouped = await createCard({ title: 'Grouped card' });
    const ungrouped = await createCard({ title: 'Ungrouped card' });
    const group = await request(app)
      .post('/api/kj/groups')
      .send({ name: `Filter Group ${Date.now()}`, color: '#4D96FF' });

    expect(group.status).toBe(201);
    const assigned = await request(app)
      .post(`/api/kj/groups/${group.body.id}/cards`)
      .send({ cardId: grouped.id });
    expect(assigned.status).toBe(200);

    const response = await request(app).get(`/api/cards?kjGroupId=${group.body.id}`);

    expect(response.status).toBe(200);
    const ids = response.body.map((card: { id: string }) => card.id);
    expect(ids).toContain(grouped.id);
    expect(ids).not.toContain(ungrouped.id);
  });

  it('keeps GET /api/cards backward compatible as an array without pagination params', async () => {
    await createCard({ title: 'Array response card' });

    const response = await request(app).get('/api/cards');

    expect(response.status).toBe(200);
    expect(Array.isArray(response.body)).toBe(true);
    expect(response.body[0]).toHaveProperty('tags');
    expect(response.body[0]).toHaveProperty('links');
  });

  it('applies paged limit and offset after sorting by createdAt', async () => {
    const oldest = await createCard({ title: 'Oldest card', tags: ['paging'] });
    const middle = await createCard({ title: 'Middle card', tags: ['paging'] });
    const newest = await createCard({ title: 'Newest card', tags: ['paging'] });
    db.prepare('UPDATE cards SET created_at = ? WHERE id = ?').run('2026-01-01T00:00:00.000Z', oldest.id);
    db.prepare('UPDATE cards SET created_at = ? WHERE id = ?').run('2026-01-02T00:00:00.000Z', middle.id);
    db.prepare('UPDATE cards SET created_at = ? WHERE id = ?').run('2026-01-03T00:00:00.000Z', newest.id);

    const response = await request(app).get('/api/cards?limit=1&offset=1');

    expect(response.status).toBe(200);
    expect(response.body.total).toBe(3);
    expect(response.body.limit).toBe(1);
    expect(response.body.offset).toBe(1);
    expect(response.body.items.map((card: { id: string }) => card.id)).toEqual([middle.id]);
    expect(response.body.items[0].tags).toEqual(['paging']);
    expect(response.body.items[0].links).toEqual([]);
  });

  it('uses SQL-backed q filtering across title, body, summary, and tags', async () => {
    const titleMatch = await createCard({ title: 'Needle title', body: 'plain', tags: ['alpha'] });
    const bodyMatch = await createCard({ title: 'Plain title', body: 'body needle', tags: ['beta'] });
    const summaryMatch = await createCard({ title: 'Summary card', body: 'plain', summary: 'summary needle', tags: ['gamma'] });
    const tagMatch = await createCard({ title: 'Tag card', body: 'plain', tags: ['needle-tag'] });
    const other = await createCard({ title: 'Other card', body: 'plain', tags: ['other'] });

    const response = await request(app).get('/api/cards?q=needle&limit=20');

    expect(response.status).toBe(200);
    expect(response.body.total).toBe(4);
    const ids = response.body.items.map((card: { id: string }) => card.id);
    expect(ids).toEqual(expect.arrayContaining([titleMatch.id, bodyMatch.id, summaryMatch.id, tagMatch.id]));
    expect(ids).not.toContain(other.id);
  });

  it('treats LIKE wildcard and escape characters as literals in q filters', async () => {
    const percent = await createCard({ title: 'Literal percent 100% done', body: 'plain', tags: ['literal-percent'] });
    const underscore = await createCard({ title: 'Literal underscore key_value', body: 'plain', tags: ['literal-underscore'] });
    const tilde = await createCard({ title: 'Literal tilde home~user', body: 'plain', tags: ['literal-tilde'] });
    const other = await createCard({ title: 'Plain wildcard card', body: 'plain', tags: ['plain'] });

    const percentResponse = await request(app).get('/api/cards?q=%25&limit=20');
    const underscoreResponse = await request(app).get('/api/cards?q=_&limit=20');
    const tildeResponse = await request(app).get('/api/cards?q=~&limit=20');

    expect(percentResponse.status).toBe(200);
    expect(underscoreResponse.status).toBe(200);
    expect(tildeResponse.status).toBe(200);
    expect(percentResponse.body.items.map((card: { id: string }) => card.id)).toEqual([percent.id]);
    expect(underscoreResponse.body.items.map((card: { id: string }) => card.id)).toEqual([underscore.id]);
    expect(tildeResponse.body.items.map((card: { id: string }) => card.id)).toEqual([tilde.id]);
    expect(percentResponse.body.items.map((card: { id: string }) => card.id)).not.toContain(other.id);
  });

  it('caps oversized limits and safely handles invalid offsets', async () => {
    for (let i = 0; i < 105; i += 1) {
      await createCard({ title: `Bulk page card ${i}`, tags: ['bulk-page'] });
    }

    const response = await request(app).get('/api/cards?tag=bulk-page&limit=999&offset=-10');

    expect(response.status).toBe(200);
    expect(response.body.total).toBe(105);
    expect(response.body.limit).toBe(100);
    expect(response.body.offset).toBe(0);
    expect(response.body.items).toHaveLength(100);
  });

  it('pages over more than 100 cards with limit and offset', async () => {
    for (let i = 0; i < 105; i += 1) {
      const card = await createCard({ title: `Window card ${i.toString().padStart(3, '0')}`, tags: ['window-page'] });
      db.prepare('UPDATE cards SET created_at = ? WHERE id = ?').run(new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(), card.id);
    }

    const response = await request(app).get('/api/cards?tag=window-page&limit=20&offset=40');

    expect(response.status).toBe(200);
    expect(response.body.total).toBe(105);
    expect(response.body.items).toHaveLength(20);
    expect(response.body.items[0].title).toBe('Window card 064');
    expect(response.body.items[19].title).toBe('Window card 045');
  });

  it('rejects invalid CSV imports', async () => {
    const response = await request(app)
      .post('/api/cards/import-csv')
      .send({ csv: 'title,body' });

    expect(response.status).toBe(400);
    expect(response.body.error).toBe('Invalid request');
  });

  it('rejects invalid JSON imports', async () => {
    const response = await request(app)
      .post('/api/cards/import-json')
      .send({ json: '{not-json' });

    expect(response.status).toBe(400);
    expect(response.body.error).toBe('Invalid request');
  });

  it('applies rate limiting to import APIs', async () => {
    for (let i = 0; i < 3; i += 1) {
      await request(app)
        .post('/api/cards/import-csv')
        .send({ csv: `title,body\nrow-${i},body` });
    }

    const limited = await request(app)
      .post('/api/cards/import-csv')
      .send({ csv: 'title,body\nlimited,body' });

    expect(limited.status).toBe(429);
  });
});


describe('BM25 search match metadata', () => {
  it('returns title match fields and keywords', async () => {
    const card = await createCard({ title: 'SQLite migration', body: 'plain body', tags: ['database'] });

    const response = await runSearch(card.id, 'SQLite');

    expect(response.status).toBe(200);
    expect(response.body.active[0].matchedFields).toContain('title');
    expect(response.body.active[0].matchedKeywords).toContain('SQLite');
  });

  it('returns body match fields and keywords', async () => {
    const card = await createCard({ title: 'Search note', body: 'BM25 ranking details', tags: ['database'] });

    const response = await runSearch(card.id, 'BM25');

    expect(response.status).toBe(200);
    expect(response.body.active[0].matchedFields).toContain('body');
    expect(response.body.active[0].matchedKeywords).toContain('BM25');
  });

  it('returns tag match fields and keywords', async () => {
    const card = await createCard({ title: 'Search note', body: 'plain body', tags: ['sqlite-tag'] });

    const response = await runSearch(card.id, 'sqlite-tag');

    expect(response.status).toBe(200);
    expect(response.body.active[0].matchedFields).toContain('tags');
    expect(response.body.active[0].matchedKeywords).toContain('sqlite-tag');
  });
});


describe('remaining API validation', () => {
  it('rejects an empty scheduler cron expression', async () => {
    const response = await request(app)
      .post('/api/scheduler/start')
      .send({ cronExpr: '' });

    expect(response.status).toBe(400);
    expect(response.body.error).toBe('Invalid request');
  });

  it('rejects non-boolean collect background flag', async () => {
    const response = await request(app)
      .post('/api/collect')
      .send({ background: 'true' });

    expect(response.status).toBe(400);
    expect(response.body.error).toBe('Invalid request');
  });

  it('rejects invalid collect config', async () => {
    const response = await request(app)
      .post('/api/collect/config')
      .send({ rss: 'invalid', arxiv: [], github: [] });

    expect(response.status).toBe(400);
    expect(response.body.error).toBe('Invalid request');
  });

  it('rejects an empty run mode id', async () => {
    const response = await request(app)
      .post('/api/run')
      .send({
        modeId: '',
        config: {
          k1: 1.5,
          b: 0.75,
          lambda: 0.1,
          contextBonus: 1.5,
          keywords: [{ term: 'api', weight: 1, synonyms: [] }],
        },
        articles: [],
      });

    expect(response.status).toBe(400);
    expect(response.body.error).toBe('Invalid request');
  });
});

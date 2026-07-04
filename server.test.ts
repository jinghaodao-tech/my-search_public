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

describe('cards API validation', () => {
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

    const unlinked = await request(app).delete(`/api/cards/${first.id}/links/${second.id}`);
    expect(unlinked.status).toBe(200);

    const firstAfterUnlink = await request(app).get(`/api/cards/${first.id}`);
    const secondAfterUnlink = await request(app).get(`/api/cards/${second.id}`);
    expect(firstAfterUnlink.body.links).not.toContain(second.id);
    expect(secondAfterUnlink.body.links).not.toContain(first.id);
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

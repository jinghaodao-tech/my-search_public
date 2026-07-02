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

  it('rejects bulk operations when ids is not an array', async () => {
    const response = await request(app)
      .post('/api/cards/bulk-archive')
      .send({ ids: 'not-array' });

    expect(response.status).toBe(400);
    expect(response.body.error).toBe('Invalid request');
  });

  it('rejects self links', async () => {
    const card = await createCard();

    const response = await request(app)
      .post(`/api/cards/${card.id}/links`)
      .send({ targetId: card.id });

    expect(response.status).toBe(400);
    expect(response.body.error).toBe('Invalid request');
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

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from 'vitest';
import type { Article } from './bm25_engine.js';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'my-search-first-seen-'));
process.env.DB_PATH = path.join(directory, 'articles.sqlite3');
const { db } = await import('./db/database.ts');
const { saveArticlesToDb } = await import('./repositories/articles_repository.ts');

const article = (overrides: Partial<Article> = {}): Article => ({ id: 'article-1', title: 'Initial title', body: 'Initial body', url: 'https://example.test/article-1', sourceAuthority: 1, publishedAt: new Date('2026-08-01T00:00:00.000Z'), createdAt: '2026-08-01T01:00:00.000Z', firstSeenAt: '2026-07-01T01:00:00.000Z', updatedAt: '2026-08-01T01:00:00.000Z', tokens: ['initial'], docLength: 1, ...overrides });

test('first_seen_at is set on insert and preserved across recollection', () => {
  saveArticlesToDb([article()], '2026-08-01T02:00:00.000Z');
  const first = db.prepare('SELECT first_seen_at,created_at,updated_at,last_fetched_at FROM articles WHERE id=?').get('article-1') as any;
  expect(first.first_seen_at).toBe('2026-07-01T01:00:00.000Z');
  expect(first.created_at).toBe('2026-08-01T01:00:00.000Z');
  saveArticlesToDb([article({ title: 'Updated title', body: 'Updated body', createdAt: '2026-08-02T01:00:00.000Z', firstSeenAt: '2026-08-02T01:00:00.000Z', updatedAt: '2026-08-02T01:00:00.000Z' })], '2026-08-02T02:00:00.000Z');
  const recollected = db.prepare('SELECT first_seen_at,created_at,title,updated_at,last_fetched_at FROM articles WHERE id=?').get('article-1') as any;
  expect(recollected.first_seen_at).toBe(first.first_seen_at);
  expect(recollected.created_at).toBe(first.created_at);
  expect(recollected.title).toBe('Updated title');
  expect(recollected.updated_at).not.toBe(first.updated_at);
  expect(recollected.last_fetched_at).toBe('2026-08-02T02:00:00.000Z');
  db.close();
  fs.rmSync(directory, { recursive: true, force: true });
});
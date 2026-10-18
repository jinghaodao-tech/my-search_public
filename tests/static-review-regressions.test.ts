import { describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { app, article, database } from './helpers.js';
import { getArticleById, loadArticlesFromDb, saveArticlesToDb } from '../repositories/articles_repository.js';
import { bulkDeleteCards, deleteCard } from '../repositories/cards_repository.js';
import { getCandidate } from '../repositories/candidates_repository.js';
import Database from 'better-sqlite3';
import { runMigrations } from '../db/migrate.js';
import { searchMode } from './helpers.js';
import { JSDOM } from 'jsdom';
import fs from 'node:fs';
import { HybridSearchEngine } from '../search/search_engine.js';
import dns from 'node:dns';
import { fetchReadable } from '../services/reader_service.js';

const db = database.db;
const input = (id: string) => ({ title: 'Reader title', url: `https://example.test/${id}`, fetchedAt: new Date().toISOString(), paragraphs: ['new searchable reader text'], memo: 'keep my memo', tags: ['reader'], candidateId: id });

describe('static review: data and reader integrity', () => {
  it.each(['single', 'bulk'])('allows re-saving after %s card deletion', async kind => {
    const id = `review-delete-${kind}`;
    saveArticlesToDb([article(id, 'Candidate', 'body')]);
    const saved = await request(app).post(`/api/candidates/${id}/save`).send({});
    expect(saved.status).toBe(201);
    db.prepare("UPDATE articles SET reviewed_at='2000-01-01T00:00:00.000Z' WHERE id=?").run(id);
    if (kind === 'single') deleteCard(saved.body.card.id);
    else bulkDeleteCards([saved.body.card.id]);
    expect(getCandidate(id)?.status).toBe('reviewed_not_saved');
    await request(app).post('/api/candidates/expire-reviewed').send({ candidateRetentionDays: 14 });
    expect(getCandidate(id)?.status).toBe('reviewed_not_saved');
    expect((await request(app).post(`/api/candidates/${id}/save`).send({})).status).toBe(201);
  });

  it('imports persisted articles only once, independently of the last collection cache', async () => {
    const id = 'review-import';
    saveArticlesToDb([article(id, 'Persisted article', 'body')]);
    const first = await request(app).post('/api/cards/import-articles').send({ articleIds: [id] });
    const second = await request(app).post('/api/cards/import-articles').send({ articleIds: [id] });
    expect(first.body.count).toBe(1);
    expect(second.body.count).toBe(0);
  });

  it('updates reader title and URL in card metadata', async () => {
    const id = 'review-edit';
    saveArticlesToDb([article(id, 'Before', 'excerpt')]);
    const saved = await request(app).post('/api/reader/save').send(input(id));
    expect(saved.status).toBe(201);
    const edited = await request(app).put(`/api/reader/cards/${saved.body.card.id}`).send({ ...input(id), candidateId: undefined, title: 'Changed title', url: 'https://example.test/changed', paragraphs: ['Changed full text'] });
    expect(edited.status).toBe(200);
    expect(edited.body).toMatchObject({ title: 'Changed title', url: 'https://example.test/changed' });
  });

  it('does not change the article cache on a rejected reader save', async () => {
    const id = 'review-conflict';
    saveArticlesToDb([article(id, 'Candidate', 'excerpt')]);
    await request(app).post(`/api/candidates/${id}/save`).send({});
    const response = await request(app).post('/api/reader/save').send(input(id));
    expect(response.status).toBe(409);
    expect(db.prepare('SELECT * FROM article_reader_content WHERE article_id = ?').get(id)).toBeUndefined();
  });

  it.each([true, false])('rolls back reader save failures (candidate=%s) and allows retry', async withCandidate => {
    const id = `review-rollback-${withCandidate}`;
    saveArticlesToDb([article(id, 'Candidate', 'excerpt')]);
    const before = (db.prepare('SELECT COUNT(*) AS n FROM cards').get() as { n: number }).n;
    db.exec("CREATE TRIGGER review_fail_reader BEFORE INSERT ON reader_texts BEGIN SELECT RAISE(ABORT, 'injected reader failure'); END");
    try {
      expect((await request(app).post('/api/reader/save').send({ ...input(id), candidateId: withCandidate ? id : undefined })).status).toBe(500);
      expect((db.prepare('SELECT COUNT(*) AS n FROM cards').get() as { n: number }).n).toBe(before);
      expect(getCandidate(id)?.status).toBe('unreviewed');
      expect(db.prepare('SELECT * FROM article_reader_content WHERE article_id = ?').get(id)).toBeUndefined();
    } finally { db.exec('DROP TRIGGER review_fail_reader'); }
    expect((await request(app).post('/api/reader/save').send({ ...input(id), candidateId: withCandidate ? id : undefined })).status).toBe(201);
  });

  it('rolls back all reader edits if full-text persistence fails', async () => {
    const id = 'review-edit-rollback';
    saveArticlesToDb([article(id, 'Candidate', 'excerpt')]);
    const saved = await request(app).post('/api/reader/save').send(input(id));
    const cardId = saved.body.card.id;
    const before = await request(app).get(`/api/reader/cards/${cardId}`);
    db.exec("CREATE TRIGGER review_fail_reader_update BEFORE UPDATE ON reader_texts BEGIN SELECT RAISE(ABORT, 'injected update failure'); END");
    try {
      expect((await request(app).put(`/api/reader/cards/${cardId}`).send({ ...input(id), candidateId: undefined, title: 'Do not commit', paragraphs: ['Do not commit'] })).status).toBe(500);
      expect((await request(app).get(`/api/reader/cards/${cardId}`)).body).toEqual(before.body);
      expect(getArticleById(id)?.body).toBe('new searchable reader text');
    } finally { db.exec('DROP TRIGGER review_fail_reader_update'); }
  });

  it('allows only one concurrent reader save of the same candidate', async () => {
    const id = 'review-concurrent-reader';
    saveArticlesToDb([article(id, 'Candidate', 'excerpt')]);
    const responses = await Promise.all([request(app).post('/api/reader/save').send(input(id)), request(app).post('/api/reader/save').send(input(id))]);
    expect(responses.map(response => response.status).sort()).toEqual([201, 409]);
    expect(db.prepare('SELECT COUNT(*) AS n FROM cards WHERE url = ?').get(input(id).url)).toEqual({ n: 1 });
  });

  it('returns the same reader body and matching token caches by ID and list', async () => {
    const id = 'review-body';
    saveArticlesToDb([{ ...article(id, 'Candidate', 'obsolete excerpt'), tokens: ['obsolete'], ngramTokens: ['obsolete'], morphologicalTokens: ['obsolete'] }]);
    expect((await request(app).post('/api/reader/save').send(input(id))).status).toBe(201);
    const single = getArticleById(id)!;
    const listed = loadArticlesFromDb().find(item => item.id === id)!;
    expect(single.body).toBe('new searchable reader text');
    expect(listed.body).toBe(single.body);
    expect(listed.ngramTokens).toContain('searchable');
    expect(listed.ngramTokens).not.toContain('obsolete');
  });

  it('rejects color values that can escape an HTML attribute', async () => {
    const response = await request(app).post('/api/cards').send({ title: 'Unsafe', body: '', color: 'red\" onmouseover=\"alert(1)' });
    expect(response.status).toBe(400);
    expect((await request(app).post('/api/cards').send({ title: 'Unsafe URL', body: '', url: 'javascript:alert(1)' })).status).toBe(400);
  });

  it('blocks hosts whose DNS response mixes public and private addresses', async () => {
    const lookup = vi.spyOn(dns, 'lookup').mockImplementation(((_host: string, _options: unknown, callback: (error: null, addresses: Array<{address: string; family: number}>) => void) => {
      callback(null, [{ address: '93.184.216.34', family: 4 }, { address: '127.0.0.1', family: 4 }]);
    }) as typeof dns.lookup);
    try { await expect(fetchReadable('https://rebind.example.test/')).rejects.toMatchObject({ status: 400 }); }
    finally { lookup.mockRestore(); }
  });

  it('does not execute previously stored unsafe colors when rendering cards', () => {
    const dom = new JSDOM('<div id="card-grid"></div><div id="count-badge"></div>', { runScripts: 'outside-only' });
    try {
      dom.window.eval(`const allCards = [{id:'safe', title:'T', body:'', type:'article', tags:[], links:[], createdAt:'2026-01-01', color:'red\\" onmouseover=\\"alert(1)'}];
        const selectedCards = new Set(); const currentFilter = {}; const showCardSummaries = false;\n` + fs.readFileSync('public/js/cards_ui.js', 'utf8') + '\nrenderCardGrid();');
      expect(dom.window.document.querySelector('[onmouseover]')).toBeNull();
      expect(dom.window.document.querySelector('.card-color-strip')).toBeNull();
    } finally { dom.window.close(); }
  });

  it('keeps external URLs and imported IDs inside handler arguments, and hides script URLs', async () => {
    const dom = new JSDOM('<div id="candidate-grid"></div><div id="candidate-count"></div>', { runScripts: 'outside-only' });
    const id = "external');window.pwned=true;//";
    const url = "https://example.test/article');window.pwned=true;//";
    try {
      dom.window.eval(fs.readFileSync('public/js/cards_ui.js', 'utf8'));
      dom.window.eval(`window.api = { get: async () => ${JSON.stringify([
        { candidateId: id, title: '<script>window.pwned=true</script>', body: '<img onerror=alert(1)>', status: 'unreviewed', url, firstSeenAt: '2026-01-01', lastSeenAt: '2026-01-01' },
        { candidateId: 'bad-url', title: 'Bad URL', body: '', status: 'unreviewed', url: 'javascript:alert(1)', firstSeenAt: '2026-01-01', lastSeenAt: '2026-01-01' },
      ])} }; window.openReader = (url, id) => { window.received = {url,id}; };`);
      dom.window.eval(fs.readFileSync('public/js/candidate_ui.js', 'utf8'));
      await dom.window.eval('loadCandidates()');
      expect(dom.window.document.querySelector('#candidate-grid script')).toBeNull();
      expect(dom.window.document.querySelector('a[href^="javascript:"]')).toBeNull();
      const button = dom.window.document.querySelector('button[onclick^="openReader"]')!;
      dom.window.eval(button.getAttribute('onclick')!);
      expect(dom.window.eval('window.received.id')).toBe(id);
      expect(dom.window.eval('window.pwned')).toBeUndefined();
    } finally { dom.window.close(); }
  });

  it('keeps article and card corpora separate even when their IDs happen to match', async () => {
    const id = 'review-shared-id';
    saveArticlesToDb([article(id, 'Article needle', 'article-specific-needle')]);
    const { createCard } = await import('../repositories/cards_repository.js');
    await createCard({ id, title: 'Unrelated card', body: 'unrelated content' });
    const result = await request(app).post('/api/run').send({ config: searchMode([{ term: 'needle', weight: 1 }]), options: { archiveScoreThreshold: 0, resultLimit: 100 } });
    expect(result.status).toBe(200);
    expect(result.body.active.find((item: {article: {id: string}}) => item.article.id === id)?.article.title).toBe('Article needle');
    const hybrid = await new HybridSearchEngine().run([{ ...article(id, 'Article needle', 'article-specific-needle'), tokens: ['needle'], morphologicalTokens: ['needle'], ngramTokens: ['needle'] }], searchMode([{ term: 'needle', weight: 1 }]), 'custom', { corpus: 'articles', archiveScoreThreshold: -1 });
    expect(hybrid.active).toHaveLength(1);
    expect(hybrid.active[0]).not.toHaveProperty('scoreSources');
  });

  it('upgrades an old DB, repairs dangling saved status, and preserves cards and reader copies', () => {
    const old = new Database(':memory:');
    try {
      old.pragma('foreign_keys = ON');
      old.exec('CREATE TABLE schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
      old.prepare('INSERT INTO schema_migrations VALUES (?, ?)').run('021_collection_reader_integrity', 'skip-for-fixture');
      old.prepare('INSERT INTO schema_migrations VALUES (?, ?)').run('022_site_article_integration', 'skip-for-fixture');
      runMigrations(old);
      old.exec(`CREATE TABLE article_reader_content(article_id TEXT PRIMARY KEY REFERENCES articles(id) ON DELETE CASCADE, body TEXT NOT NULL, fetched_at TEXT NOT NULL);
        INSERT INTO cards(id,title,body,created_at,updated_at) VALUES ('keep','Keep','memo','now','now');
        INSERT INTO reader_texts(card_id,paragraphs_json,updated_at) VALUES ('keep','["full"]','now');
        INSERT INTO articles(id,title,body,url,created_at,updated_at,candidate_status) VALUES ('dangling','T','excerpt','https://example.test/old','now','now','saved_as_card');
        DELETE FROM schema_migrations WHERE id IN ('021_collection_reader_integrity','022_site_article_integration');`);
      expect(runMigrations(old)).toEqual(['021_collection_reader_integrity','022_site_article_integration']);
      expect(runMigrations(old)).toEqual([]);
      expect(old.prepare('SELECT body FROM cards WHERE id=?').get('keep')).toEqual({ body: 'memo' });
      expect(old.prepare('SELECT paragraphs_json FROM reader_texts WHERE card_id=?').get('keep')).toEqual({ paragraphs_json: '["full"]' });
      expect(old.prepare('SELECT candidate_status FROM articles WHERE id=?').get('dangling')).toEqual({ candidate_status: 'reviewed_not_saved' });
    } finally { old.close(); }
  });
});

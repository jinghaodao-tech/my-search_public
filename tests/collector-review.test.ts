import { afterEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ fetch: vi.fn(), tick: undefined as undefined | (() => Promise<void>), stop: vi.fn() }));
vi.mock('../services/safe_fetch.js', () => ({ safeFetch: mocks.fetch }));
vi.mock('node-cron', () => ({ default: { validate: () => true, schedule: (_expr: string, tick: () => Promise<void>) => { mocks.tick = tick; return { stop: mocks.stop }; } } }));
import { app, article, database } from './helpers.js';
import request from 'supertest';
import { collectAll, collectArxiv, collectRSS, DEFAULT_CONFIG, ensureArticleTokens, saveArticles, startScheduler, type CollectResult, type CollectorConfig } from '../collector.js';
import { createCollectorService } from '../services/collector_service.js';
import { getArticleById, getArticleByUrl, saveArticlesToDb } from '../repositories/articles_repository.js';
import { createCardWithTransaction, loadCards, saveCards } from '../repositories/cards_repository.js';
import { getCandidate, saveCandidate } from '../repositories/candidates_repository.js';

const db = database.db;
const config: CollectorConfig = { rss: [], arxiv: [], github: [] };
const result = (): CollectResult => ({ articles: [], errors: [], stats: { rss: 0, arxiv: 0, github: 0, total: 0, fetchedAt: new Date().toISOString() } });
const rss = (items: string) => `<rss version="2.0"><channel><title>Feed</title>${items}</channel></rss>`;
const source = { url: 'https://feed.example.test/rss', label: '日本語', authority: 0.8 };
afterEach(() => vi.clearAllMocks());

describe('collector review: identity and failure semantics', () => {
  it('uses URLs rather than Japanese title slugs and remains stable after title changes', async () => {
    mocks.fetch.mockResolvedValue({ text: () => rss('<item><title>日本語の記事</title><link>https://example.test/a</link></item><item><title>別の日本語記事</title><link>https://example.test/b</link></item>') });
    const first = await collectRSS([source], []);
    expect(new Set(first.map(a => a.id)).size).toBe(2);
    expect(Number.isNaN(first[0].publishedAt.getTime())).toBe(true);
    mocks.fetch.mockResolvedValue({ text: () => rss('<item><title>更新された題名</title><link>https://example.test/a?utm_source=feed#top</link></item>') });
    expect((await collectRSS([source], []))[0].id).toBe(first[0].id);
  });

  it('uses source-scoped GUIDs when a feed omits article links', async () => {
    mocks.fetch.mockResolvedValue({ text: () => rss('<item><title>同じ題名</title><guid>first</guid></item><item><title>同じ題名</title><guid>second</guid></item>') });
    const articles = await collectRSS([source], []);
    expect(new Set(articles.map(a => a.id)).size).toBe(2);
    saveArticlesToDb(articles);
    expect(getArticleById(articles[0].id)).toBeTruthy();
    expect(getArticleById(articles[1].id)).toBeTruthy();
    expect(db.prepare('SELECT published_at FROM articles WHERE id=?').get(articles[0].id)).toEqual({ published_at: null });
  });

  it('uses the arXiv paper ID, not its title', async () => {
    mocks.fetch.mockResolvedValue({ text: () => '<feed><entry><id>http://arxiv.org/abs/1234.00001v1</id><title>同じ題名</title></entry><entry><id>http://arxiv.org/abs/1234.00002v1</id><title>同じ題名</title></entry></feed>' });
    const articles = await collectArxiv([{ query: 'test', maxResults: 2, authority: 0.8 }], []);
    expect(new Set(articles.map(a => a.id)).size).toBe(2);
  });

  it('matches legacy IDs by canonical URL without losing state or first discovery', async () => {
    const legacy = article('rss_legacy____', 'Before', 'old');
    saveArticlesToDb([legacy]);
    const first = getArticleById(legacy.id)!.firstSeenAt;
    const saved = await createCardWithTransaction({ title: 'Saved memo', body: 'memo' }, card => { saveCandidate(legacy.id, card.id); });
    saveArticlesToDb([{ ...legacy, id: 'rss_new_stable', title: 'After', url: `${legacy.url}?utm_source=x#part` }]);
    expect(getArticleById('rss_new_stable')).toMatchObject({ id: legacy.id, title: 'After', firstSeenAt: first });
    expect(getCandidate(legacy.id)).toMatchObject({ status: 'saved_as_card', savedCardId: saved.id });
    expect(getArticleByUrl(`${legacy.url}#other`)?.id).toBe(legacy.id);
  });

  it('does not overwrite a legacy title-slug collision with another URL', () => {
    const first = article('rss_legacy_collision', 'One', 'first');
    saveArticlesToDb([first]);
    saveArticlesToDb([{ ...first, title: 'Two', body: 'second', url: 'https://example.test/different' }]);
    expect(getArticleById(first.id)?.body).toBe('first');
    expect(getArticleByUrl('https://example.test/different')?.body).toBe('second');
  });

  it('preserves content query parameters and explicit duplicate manual cards', async () => {
    saveArticlesToDb([article('review-q1', 'One', 'one'), { ...article('review-q2', 'Two', 'two'), url: 'https://example.test/review-q1?page=2' }]);
    expect(getArticleById('review-q2')).toBeTruthy();
    const a = await createCardWithTransaction({ title: 'Manual', body: 'one', url: 'https://example.test/manual' }, () => {});
    const b = await createCardWithTransaction({ title: 'Manual', body: 'two', url: 'https://example.test/manual' }, () => {});
    expect(a.id).not.toBe(b.id);
  });

  it('keeps successful sources when another source fails', async () => {
    mocks.fetch.mockImplementation(async (url: string) => {
      if (url.includes('bad')) throw new Error('feed unavailable');
      return { text: () => rss('<item><title>Success</title><link>https://example.test/partial</link></item>') };
    });
    const collected = await collectAll({ ...config, rss: [source, { ...source, url: 'https://bad.example.test/rss' }] });
    expect(collected.errors).toHaveLength(1);
    expect(collected.articles).toHaveLength(1);
    expect(getArticleByUrl('https://example.test/partial')).toBeTruthy();
  });

  it('propagates SQLite persistence errors', () => {
    db.exec("CREATE TRIGGER review_fail_articles BEFORE INSERT ON articles BEGIN SELECT RAISE(ABORT, 'save failed'); END");
    try { expect(() => saveArticles({ ...result(), articles: [article('review-db-fail', 'T', 'body')] })).toThrow('save failed'); }
    finally { db.exec('DROP TRIGGER review_fail_articles'); }
    expect(getArticleById('review-db-fail')).toBeNull();
  });

  it('really rebuilds token caches when requested', async () => {
    const rebuilt = await ensureArticleTokens({ ...result(), articles: [{ ...article('review-force', 'SQLite', '検索'), tokens: ['stale'], ngramTokens: ['stale'], morphologicalTokens: ['stale'] }] }, true);
    expect(rebuilt.articles[0].ngramTokens).not.toContain('stale');
    expect(rebuilt.articles[0].ngramTokens).toContain('sqlite');
  });

  it('does not reset saved candidates or erase reader copies when replacing retained cards', async () => {
    const a = article('review-retain', 'Retained', 'body');
    saveArticlesToDb([a]);
    const card = await createCardWithTransaction({ title: 'Keep', body: 'memo' }, card => saveCandidate(a.id, card.id));
    db.prepare('INSERT INTO reader_texts(card_id, paragraphs_json, updated_at) VALUES (?,?,?)').run(card.id, '["full"]', 'now');
    saveCards(loadCards());
    expect(getCandidate(a.id)?.status).toBe('saved_as_card');
    expect(db.prepare('SELECT paragraphs_json FROM reader_texts WHERE card_id=?').get(card.id)).toBeTruthy();
  });
});

describe('collector review: configuration and scheduling', () => {
  it('keeps configured sources manageable even before collecting their first article', async () => {
    const previous = (await request(app).get('/api/collect/config')).body;
    try {
      await request(app).post('/api/collect/config').send({ ...config, rss: [{ ...source, label: 'Uncollected source' }] }).expect(200);
      const targets = (await request(app).get('/api/search/targets').expect(200)).body;
      expect(targets.collected.find((target: {value: string}) => target.value === 'rss:Uncollected source')).toMatchObject({ count: 0 });
    } finally { await request(app).post('/api/collect/config').send(previous).expect(200); }
  });
  it('persists configuration and exposes fresh settings after service recreation', () => {
    const service = createCollectorService();
    service.setCollectorConfig(config);
    expect(createCollectorService().getCollectorConfig()).toEqual(config);
    service.setCollectorConfig(DEFAULT_CONFIG);
  });

  it('prevents concurrent collection and records failure before retry', async () => {
    let finish!: (r: CollectResult) => void;
    const collect = vi.fn(() => new Promise<CollectResult>(resolve => { finish = resolve; }));
    const service = createCollectorService(collect);
    const pending = service.collectAll(config);
    await expect(service.collectAll(config)).rejects.toThrow('already running');
    expect(collect).toHaveBeenCalledTimes(1);
    finish(result()); await pending;
    expect(service.getCollectRunning()).toBe(false);
    expect(service.getCollectionStatus().lastSuccessAt).toBeTruthy();
    expect(createCollectorService().getCollectionStatus().latestFetchedCount).toBe(0);
    const failed = createCollectorService(async () => { throw new Error('SQLite failed'); });
    await expect(failed.collectAll(config)).rejects.toThrow('SQLite failed');
    expect(failed.getCollectionStatus().lastError).toBe('SQLite failed');
    expect(failed.getCollectRunning()).toBe(false);
  });

  it('uses live configuration, skips overlapping ticks, and handles startup failures', async () => {
    let finish!: (r: CollectResult) => void;
    let current = config;
    const collect = vi.fn((_config: typeof config) => new Promise<CollectResult>(resolve => { finish = resolve; }));
    const stop = startScheduler({ getConfig: () => current, collect });
    await mocks.tick!();
    expect(collect).toHaveBeenCalledTimes(1);
    finish(result()); await Promise.resolve(); await Promise.resolve();
    current = { ...config, rss: [] };
    const next = mocks.tick!();
    expect(collect).toHaveBeenLastCalledWith(current);
    finish(result()); await next;
    stop(); await mocks.tick!();
    expect(collect).toHaveBeenCalledTimes(2);
    const onError = vi.fn();
    const failStop = startScheduler({ collect: async () => { throw new Error('startup failed'); }, onError });
    await Promise.resolve(); await Promise.resolve();
    expect(onError).toHaveBeenCalledTimes(1);
    failStop();
  });
});

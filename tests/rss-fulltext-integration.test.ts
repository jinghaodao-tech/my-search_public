import fs from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';

const mocks = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock('../services/safe_fetch.js', async importOriginal => ({
  ...await importOriginal<typeof import('../services/safe_fetch.js')>(),
  safeFetch: mocks.fetch,
}));

import { app, database, searchMode } from './helpers.js';
import { collectAll } from '../collector.js';
import { getArticleById, getArticleByUrl, prepareReaderContent, saveArticlesToDb, storeReaderContent } from '../repositories/articles_repository.js';
import { createCardWithTransaction } from '../repositories/cards_repository.js';
import { saveCandidate } from '../repositories/candidates_repository.js';
import { createSite, getSite, knownSiteArticles, updateSite } from '../repositories/site_sources_repository.js';
import { listArticles } from '../services/site_adapters.js';
import { syncSite } from '../services/site_collector.js';
import { parseRobots } from '../services/site_parsing.js';
import { SafeFetchError, type SafeFetcher } from '../services/safe_fetch.js';
import { RSS_INDEX_BODY_MAX_CHARS } from '../services/rss_content.js';

const db = database.db;
const needle = 'CVE-2026-92392';
const config = (label: string) => ({ rss: [{ url: 'https://rss-p0.example.test/feed', label, authority: 0.8 }], arxiv: [], github: [] });
const response = (url: string, text: string, contentType = 'application/rss+xml') => ({ url, status: 200, contentType, headers: {}, bytes: Buffer.from(text), text: () => text });
const feed = (host: string, full = true) => `<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel><title>RSS regression</title>${Array.from({ length: 10 }, (_, index) => `<item><guid>${host}-${index}</guid><title>Article ${index}</title><link>https://${host}/post/${index}</link><pubDate>Mon, 19 Oct 2026 00:00:00 GMT</pubDate><description>${index === 0 ? needle : 'Short update'}</description>${index === 1 && full ? `<content:encoded><![CDATA[<p>${'Background. '.repeat(150)} ${needle}</p>]]></content:encoded>` : ''}</item>`).join('')}</channel></rss>`;

function siteFeed(host: string, xml: string, pageBody?: string) {
  const urls: string[] = [];
  const fetch: SafeFetcher = async raw => {
    const url = String(raw); urls.push(url);
    if (url.endsWith('/robots.txt')) return response(url, '', 'text/plain');
    if (url.endsWith('/feed')) return response(url, xml);
    if (pageBody !== undefined) return response(url, `<html><head><title>Article</title></head><body><article><p>${pageBody}</p></article></body></html>`, 'text/html');
    throw new SafeFetchError('HTTP 503', 'http', 503);
  };
  const registered = createSite({ siteUrl: `https://${host}/`, name: host, scope: { hosts: [host], pathPrefix: '/' }, adapter: { type: 'feed', feedUrl: `https://${host}/feed` }, bodyPolicy: 'pending', maxInitial: 20 });
  return { fetch, urls, registered };
}

async function search(source: string) {
  const terms = await request(app).post('/api/search/terms').send({ text: needle });
  expect(terms.status).toBe(200);
  const result = await request(app).post('/api/run').send({
    config: searchMode(terms.body.keywords),
    filters: { sources: [source], excludedTerms: [] },
    options: { archiveScoreThreshold: 0, resultLimit: 100 },
  });
  expect(result.status).toBe(200);
  return result.body.active as Array<{ article: { id: string; url: string; body: string } }>;
}

afterEach(() => vi.clearAllMocks());

describe('RSS fulltext through collection, SQLite and the search API', () => {
  it('upgrades the same ten articles from one hit to two without changing IDs, review state or saved memos', async () => {
    const host = 'rss-upgrade.example.test';
    mocks.fetch.mockResolvedValue(response('https://rss-p0.example.test/feed', feed(host, false)));
    const before = await collectAll(config('RSS P0 upgrade'));
    const second = before.articles.find(item => item.url.endsWith('/1'))!;
    const firstSeen = getArticleById(second.id)!.firstSeenAt;
    db.prepare("UPDATE articles SET candidate_status='deferred' WHERE id=?").run(second.id);
    const first = before.articles.find(item => item.url.endsWith('/0'))!;
    const saved = await createCardWithTransaction({ title: 'User memo', body: 'Keep this memo', url: first.url }, card => saveCandidate(first.id, card.id));
    expect(await search('rss:RSS P0 upgrade')).toHaveLength(1);

    mocks.fetch.mockResolvedValue(response('https://rss-p0.example.test/feed', feed(host)));
    const after = await collectAll(config('RSS P0 upgrade'));
    expect(after.errors).toEqual([]);
    expect(after.articles).toHaveLength(10);
    expect(after.articles.map(item => item.id).sort()).toEqual(before.articles.map(item => item.id).sort());
    const found = await search('rss:RSS P0 upgrade');
    expect(found).toHaveLength(2);
    expect(found.map(item => item.article.id)).toContain(second.id);
    expect(db.prepare('SELECT body_kind,summary,candidate_status,first_seen_at FROM articles WHERE id=?').get(second.id))
      .toMatchObject({ body_kind: 'fulltext', summary: 'Short update', candidate_status: 'deferred', first_seen_at: firstSeen });
    const tokens = db.prepare('SELECT morphological_tokens_json,ngram_tokens_json FROM articles WHERE id=?').get(second.id) as Record<string, string>;
    expect(tokens.morphological_tokens_json).toContain('92392');
    expect(tokens.ngram_tokens_json).toContain('92392');
    expect(db.prepare('SELECT body FROM cards WHERE id=?').get(saved.id)).toEqual({ body: 'Keep this memo' });
    expect(db.prepare('SELECT candidate_status,saved_card_id FROM articles WHERE id=?').get(first.id)).toEqual({ candidate_status: 'saved_as_card', saved_card_id: saved.id });
  }, 60_000);

  it('uses full feed bodies only after the site policy is enabled, and upgrades existing excerpts without a new publication date', async () => {
    const host = 'rss-policy.example.test';
    const web = siteFeed(host, feed(host));
    await syncSite(web.registered, web.fetch);
    const id = getArticleByUrl(`https://${host}/post/1`)!.id;
    expect(await search(`site:${web.registered.id}`)).toHaveLength(1);
    expect(getArticleById(id)?.body).toBe('Short update');
    expect(web.urls.every(url => url.endsWith('/feed') || url.endsWith('/robots.txt'))).toBe(true);

    updateSite(web.registered.id, { bodyPolicy: 'body' });
    await syncSite(getSite(web.registered.id)!, web.fetch);
    expect(await search(`site:${web.registered.id}`)).toHaveLength(2);
    expect(getArticleById(id)?.body).toContain(needle);
    expect([...knownSiteArticles(web.registered.id).values()].find(item => item.articleId === id)?.hasBody).toBe(true);
    // Only description-only articles may need their pages; the embedded full copy does not.
    expect(web.urls).not.toContain(`https://${host}/post/1`);
    expect(db.prepare('SELECT COUNT(*) AS count FROM articles WHERE source=?').get(`site:${web.registered.id}`)).toEqual({ count: 10 });
  }, 60_000);

  it('does not claim a truncated payload was fetched in full, and retries the article page later', async () => {
    const host = 'rss-cap.example.test';
    const xml = `<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel><item><title>Bounded</title><link>https://${host}/post/1</link><content:encoded><![CDATA[<p>${'Background. '.repeat(Math.ceil(RSS_INDEX_BODY_MAX_CHARS / 12) + 10)}</p>]]></content:encoded></item></channel></rss>`;
    const web = siteFeed(host, xml);
    updateSite(web.registered.id, { bodyPolicy: 'body' });
    await syncSite(getSite(web.registered.id)!, web.fetch);
    const known = [...knownSiteArticles(web.registered.id).values()][0];
    expect(known.hasBody).toBe(false);
    expect(db.prepare('SELECT body_kind,length(body) AS length FROM articles WHERE id=?').get(known.articleId))
      .toEqual({ body_kind: 'excerpt', length: RSS_INDEX_BODY_MAX_CHARS });
    expect(web.urls).toContain(`https://${host}/post/1`);
    await syncSite(getSite(web.registered.id)!, web.fetch);
    expect(web.urls.filter(url => url === `https://${host}/post/1`)).toHaveLength(2);
  }, 60_000);

  it('retains Reader copies when a syndicated body changes', async () => {
    const url = 'https://rss-reader.example.test/article';
    saveArticlesToDb([{ id: 'rss-reader-copy', title: 'Reader', body: 'Original', url, sourceAuthority: 0.8, publishedAt: new Date(), source: 'rss:Reader P0' }]);
    storeReaderContent(await prepareReaderContent(url, 'Independent Reader copy'), new Date().toISOString());
    saveArticlesToDb([{ id: 'rss-reader-copy', title: 'Reader', body: 'Changed syndicated full body', bodyKind: 'fulltext', url, sourceAuthority: 0.8, publishedAt: new Date(), source: 'rss:Reader P0' }]);
    expect(getArticleById('rss-reader-copy')?.body).toBe('Independent Reader copy');
  });

  it('keeps Atom summaries separate and preserves updated dates, relative links and scope checks', async () => {
    const host = 'rss-atom.example.test';
    const xml = `<feed xmlns="http://www.w3.org/2005/Atom"><title>Atom</title><entry><title>Entry</title><link href="/post/1"/><published>2026-10-01T00:00:00Z</published><updated>2026-10-19T00:00:00Z</updated><summary>Short Atom summary</summary><content type="html">&lt;p&gt;${'Long. '.repeat(250)} ${needle}&lt;/p&gt;</content></entry><entry><title>Outside</title><link href="https://outside.example.test/x"/></entry></feed>`;
    const web = siteFeed(host, xml);
    const env = { fetch: web.fetch, scope: web.registered.scope, robots: parseRobots('') };
    const full = await listArticles(env, web.registered.adapter, { includeBody: true });
    expect(full.articles).toHaveLength(1);
    expect(full.articles[0]).toMatchObject({ url: `https://${host}/post/1`, summary: 'Short Atom summary', publishedAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-19T00:00:00.000Z', bodyKind: 'excerpt' });
    expect(full.articles[0].body).toContain(needle);
    const pending = await listArticles(env, web.registered.adapter, { includeBody: false });
    expect(pending.articles[0].body).toBeUndefined();
    expect(pending.articles[0].summary).not.toContain(needle);
  });

  it.skipIf(!process.env.RSS_REGRESSION_FEED_FILE)('replays the separately supplied ten-article real RSS through SQLite and the API', async () => {
    const xml = fs.readFileSync(process.env.RSS_REGRESSION_FEED_FILE!, 'utf8');
    mocks.fetch.mockResolvedValue(response('https://rss-p0.example.test/feed', xml));
    const result = await collectAll(config('RSS P0 real snapshot'));
    expect(result.errors).toEqual([]);
    expect(result.articles).toHaveLength(10);
    const matching = result.articles.filter(item => item.body.includes(needle));
    expect(matching).toHaveLength(2);
    expect(matching.map(item => item.title)).toEqual(expect.arrayContaining(['A UAF turned RCE', 'Twenty-two pending curl vulnerabilities']));
    const hits = await search('rss:RSS P0 real snapshot');
    for (const item of matching) expect(hits.map(hit => hit.article.id)).toContain(item.id);
  }, 90_000);
});

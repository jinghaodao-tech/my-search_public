import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import Database from 'better-sqlite3';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { app, article, database, searchMode } from './helpers.js';
import { buildStoredTokenSet } from '../bm25_engine.js';
import { articleIdentityKey } from '../services/article_identity.js';
import { getArticleById, loadArticleStats, saveArticlesToDb, prepareReaderContent, storeReaderContent } from '../repositories/articles_repository.js';
import { createSite, deleteSite, getSite, knownSiteArticles, recordSiteArticles, siteSourceTag } from '../repositories/site_sources_repository.js';
import { assessSiteRun, fetchPageMeta, syncSite } from '../services/site_collector.js';
import { SafeFetchError, createSafeFetcher, type SafeFetcher } from '../services/safe_fetch.js';
import { listArticles } from '../services/site_adapters.js';
import { articleKey, parseRobots } from '../services/site_parsing.js';
import { runMigrations } from '../db/migrate.js';

const db = database.db;
const response = (url: string, body: string, contentType = 'text/html', status = 200) => ({ url, status, contentType, headers: {}, bytes: Buffer.from(body), text: () => body });
function site(host: string, bodyPolicy: 'body' | 'pending' = 'body') {
  return createSite({ siteUrl: `https://${host}/blog/`, name: host, scope: { hosts: [host], pathPrefix: '/blog/' }, adapter: { type: 'feed', feedUrl: `https://${host}/feed` }, bodyPolicy, maxInitial: 10 });
}
function feedFetch(host: string, page?: (url: string) => ReturnType<typeof response>): SafeFetcher {
  return async raw => {
    const url = String(raw);
    if (url.endsWith('/robots.txt')) return response(url, '', 'text/plain');
    if (url.endsWith('/feed')) return response(url, `<rss><channel><item><title>Integration needle</title><link>https://${host}/blog/post</link></item></channel></rss>`, 'application/rss+xml');
    return page?.(url) ?? response(url, `<html><body><article><p>${'Integration needle full text. '.repeat(30)}</p></article></body></html>`);
  };
}

describe('site integration regressions', () => {
  // The diagnostics live in notes/ (kept out of commits). Skip, saying so, when that folder is not there.
  it.skipIf(!fs.existsSync('notes/site-integration-probes.ts'))('passes all eleven unchanged integration diagnostics in a separate process (needs notes/site-integration-probes.ts)', () => {
    const run = spawnSync(process.execPath, [path.join(process.cwd(), 'node_modules/tsx/dist/cli.mjs'), 'notes/site-integration-probes.ts'], { encoding: 'utf8', timeout: 60_000, env: { ...process.env } });
    expect(run.status, run.error?.message ?? run.stderr ?? run.stdout).toBe(0);
    const report = JSON.parse(fs.readFileSync('artifacts/site-integration-probes.json', 'utf8'));
    expect(report.results).toHaveLength(11);
    expect(report.passed).toBe(11);
    expect(report.failed).toBe(0);
  }, 65_000);

  it('shares URL identity without discarding semantic queries', () => {
    expect(articleIdentityKey('https://www.example.test/blog/post/?b=2&a=1&utm_source=x#part')).toBe(articleIdentityKey('http://example.test/blog/post?a=1&b=2'));
    expect(articleIdentityKey('https://example.test/blog/post?a=1')).not.toBe(articleIdentityKey('https://example.test/blog/post?a=2'));
    expect(articleIdentityKey('https://example.test/blog/post?ref=one')).not.toBe(articleIdentityKey('https://example.test/blog/post?ref=two'));
  });

  it('upgrades excerpts, accepts shorter newer full text, and retains caches, IDs and user content', async () => {
    const initial = { ...article('integrity-original', 'Original', 'excerpt'), source: 'rss:Original', publishedAt: new Date('2026-01-01') };
    saveArticlesToDb([initial]);
    db.prepare("UPDATE articles SET candidate_status='reviewed_not_saved' WHERE id=?").run(initial.id);
    const reader = await prepareReaderContent(initial.url, 'Reader snapshot remains independent');
    storeReaderContent(reader, '2026-01-02T00:00:00Z');
    const { createCard } = await import('../repositories/cards_repository.js');
    await createCard({ id: 'integration-user-memo', title: 'My memo', body: 'Never replace this memo', url: initial.url });
    const longBody = 'Authoritative body '.repeat(20);
    const longTokens = await buildStoredTokenSet(longBody);
    const upgraded = saveArticlesToDb([{ ...initial, id: 'integration-site-alias', body: longBody, bodyKind: 'fulltext', source: 'site:integration', sourceUpdatedAt: '2026-01-03T00:00:00Z', ...longTokens }]);
    expect(upgraded.canonicalIds['integration-site-alias']).toBe(initial.id);
    expect(db.prepare('SELECT body,body_kind FROM articles WHERE id=?').get(initial.id)).toEqual({ body: longBody, body_kind: 'fulltext' });
    const shortBody = 'New concise full text';
    const shortTokens = await buildStoredTokenSet(shortBody);
    saveArticlesToDb([{ ...initial, body: shortBody, bodyKind: 'fulltext', sourceUpdatedAt: '2026-01-04T00:00:00Z', ...shortTokens }]);
    saveArticlesToDb([{ ...initial, body: 'Old stale full text', bodyKind: 'fulltext', sourceUpdatedAt: '2026-01-02T00:00:00Z' }]);
    saveArticlesToDb([{ ...initial, body: 'Long but only an excerpt '.repeat(100), publishedAt: new Date(NaN) }]);
    const raw = db.prepare('SELECT body,ngram_tokens_json,morphological_tokens_json,candidate_status,published_at FROM articles WHERE id=?').get(initial.id) as any;
    expect(raw.body).toBe(shortBody);
    expect(JSON.parse(raw.ngram_tokens_json)).toEqual(shortTokens.ngramTokens);
    expect(JSON.parse(raw.morphological_tokens_json)).toEqual(shortTokens.morphologicalTokens);
    expect(raw.candidate_status).toBe('reviewed_not_saved');
    expect(raw.published_at).toBe('2026-01-01T00:00:00.000Z');
    expect(getArticleById('integration-site-alias')?.body).toBe('Reader snapshot remains independent');
    expect(db.prepare('SELECT body FROM cards WHERE id=?').get('integration-user-memo')).toEqual({ body: 'Never replace this memo' });
  });

  it('searches either membership without duplicating results and retains RSS articles after unregister', async () => {
    const registered = site('members.integration.test');
    await syncSite(registered, feedFetch('members.integration.test'));
    const collected = [...knownSiteArticles(registered.id).values()][0];
    const saved = getArticleById(collected.articleId)!;
    saveArticlesToDb([{ ...saved, source: 'rss:Membership', body: 'RSS excerpt' }]);
    const targets = (await request(app).get('/api/search/targets')).body;
    expect(targets.collected.find((target: any) => target.value === 'rss:Membership')).toMatchObject({ count: 1, searchable: 'fulltext' });
    expect(targets.collectedTotal).toBe((db.prepare("SELECT COUNT(*) AS count FROM articles WHERE COALESCE(candidate_status,'unreviewed')!='expired'").get() as {count: number}).count);
    for (const sources of [[siteSourceTag(registered.id)], ['rss:Membership'], [siteSourceTag(registered.id), 'rss:Membership']]) {
      const result = await request(app).post('/api/run').send({ config: searchMode([{ term: 'needle', weight: 1 }]), filters: { sources }, options: { archiveScoreThreshold: -1, resultLimit: 100 } });
      expect(result.status).toBe(200);
      expect(result.body.active.filter((item: any) => item.article.id === collected.articleId)).toHaveLength(1);
    }
    expect(deleteSite(registered.id, { removeUnsavedArticles: true })).toMatchObject({ deleted: true, removedArticles: 0 });
    expect(getArticleById(collected.articleId)?.sources).toEqual(['rss:Membership']);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  it('does not delete a manually saved card URL differing only by tracking parameters', async () => {
    const registered = site('manual.integration.test', 'pending');
    await syncSite(registered, feedFetch('manual.integration.test'));
    const item = [...knownSiteArticles(registered.id).values()][0];
    const { createCard } = await import('../repositories/cards_repository.js');
    await createCard({ id: 'integration-manual-url', title: 'User memo', body: 'Retain', url: `${item.url}?utm_source=manual` });
    expect(deleteSite(registered.id, { removeUnsavedArticles: true }).removedArticles).toBe(0);
    expect(getArticleById(item.articleId)).not.toBeNull();
  });

  it('rolls back articles, membership, aliases and checkpoints and releases the lock after a DB failure', async () => {
    const registered = site('rollback.integration.test');
    db.exec(`CREATE TRIGGER integration_fail_association BEFORE INSERT ON site_articles WHEN NEW.site_id='${registered.id}' BEGIN SELECT RAISE(ABORT,'integration rollback'); END`);
    try {
      const failed = await syncSite(registered, feedFetch('rollback.integration.test'));
      expect(assessSiteRun(failed).status).toBe('failed');
      expect(failed.added).toBe(0);
      expect(db.prepare('SELECT id FROM articles WHERE url=?').get('https://rollback.integration.test/blog/post')).toBeUndefined();
      expect(db.prepare('SELECT article_id FROM article_sources WHERE source=?').all(siteSourceTag(registered.id))).toEqual([]);
      expect(getSite(registered.id)?.lastSuccessAt).toBeNull();
    } finally { db.exec('DROP TRIGGER integration_fail_association'); }
    expect((await syncSite(registered, feedFetch('rollback.integration.test'))).status).toBe('ok');
  });

  it('rolls back an update and URL move together with the success checkpoint', async () => {
    const host = 'move-rollback.integration.test';
    const registered = createSite({ siteUrl: `https://${host}/blog/`, name: host, scope: { hosts: [host], pathPrefix: '/blog/' }, adapter: { type: 'wordpress', apiBase: `https://${host}/wp-json/` }, bodyPolicy: 'body', maxInitial: 10 });
    let moved = false;
    const fetch: SafeFetcher = async raw => {
      const url = String(raw);
      if (url.endsWith('/robots.txt')) return response(url, '', 'text/plain');
      return response(url, JSON.stringify([{ id: 1, link: `https://${host}/blog/${moved ? 'new' : 'old'}`, title: {rendered: moved ? 'New' : 'Old'}, content: {rendered: moved ? 'New full text' : 'Old full text'}, date_gmt: '2026-01-01T00:00:00', modified_gmt: moved ? '2099-01-01T00:00:00' : '2026-01-02T00:00:00' }]), 'application/json');
    };
    await syncSite(registered, fetch);
    const before = [...knownSiteArticles(registered.id).values()][0];
    const checkpoint = getSite(registered.id)!.lastSuccessAt;
    moved = true;
    db.exec(`CREATE TRIGGER integration_fail_move BEFORE UPDATE ON site_articles WHEN NEW.site_id='${registered.id}' BEGIN SELECT RAISE(ABORT,'move failure'); END`);
    try {
      expect((await syncSite(registered, fetch)).status).toBe('error');
      expect(getArticleById(before.articleId)).toMatchObject({ url: before.url, body: 'Old full text' });
      expect([...knownSiteArticles(registered.id).values()]).toEqual([before]);
      expect(getSite(registered.id)!.lastSuccessAt).toBe(checkpoint);
    } finally { db.exec('DROP TRIGGER integration_fail_move'); }
    expect((await syncSite(registered, fetch)).moved).toBe(1);
    expect(getArticleById(before.articleId)).toMatchObject({ url: `https://${host}/blog/new`, body: 'New full text' });
    expect(knownSiteArticles(registered.id).size).toBe(1);
  });

  it('coalesces the same site while allowing different sites to fetch concurrently', async () => {
    const a = site('parallel-a.integration.test');
    const b = site('parallel-b.integration.test');
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const feedRequests: string[] = [];
    const fetch: SafeFetcher = async (raw, options) => {
      const url = String(raw);
      if (url.endsWith('/feed')) { feedRequests.push(url); await gate; }
      return feedFetch(new URL(url).hostname)(raw, options);
    };
    const first = syncSite(a, fetch);
    expect(syncSite(a, fetch)).toBe(first);
    const second = syncSite(b, fetch);
    try {
      for (let count = 0; count < 20 && feedRequests.length < 2; count++) await new Promise(resolve => setTimeout(resolve, 5));
      expect(feedRequests).toHaveLength(2);
    } finally { release(); }
    expect((await Promise.all([first, second])).map(result => result.status)).toEqual(['ok', 'ok']);
  });

  it.each(['redirect', 'canonical'])('rejects out-of-path %s even on the same public host', async kind => {
    const host = `${kind}.integration.test`;
    const registered = site(host);
    const result = await syncSite(registered, feedFetch(host, url => response(kind === 'redirect' ? `https://${host}/private/post` : url, `<html><head>${kind === 'canonical' ? `<link rel="canonical" href="https://${host}/private/post">` : ''}</head><body><article><p>${'Foreign content '.repeat(30)}</p></article></body></html>`)));
    expect(result.status).toBe('error');
    expect(knownSiteArticles(registered.id).size).toBe(0);
  });

  it('checks redirect scope before issuing the redirected HTTP request', async () => {
    let forbiddenRequests = 0;
    const server = http.createServer((req, res) => {
      if (req.url === '/blog/start') { res.writeHead(302, { location: '/private/secret' }); res.end(); }
      else { forbiddenRequests++; res.writeHead(200, { 'content-type': 'text/html' }); res.end('forbidden'); }
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as {port: number};
    const fetch = createSafeFetcher({ isAllowed: () => true, checkUrl: raw => new URL(raw) });
    try {
      await expect(fetchPageMeta(fetch, `http://127.0.0.1:${address.port}/blog/start`, false, {}, url => {
        if (!url.pathname.startsWith('/blog/')) throw new SafeFetchError('outside scope', 'blocked');
      })).rejects.toMatchObject({ code: 'blocked' });
      expect(forbiddenRequests).toBe(0);
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  });

  it.each(['feed', 'wordpress', 'sitemap', 'listpage'] as const)('rejects an inappropriate Content-Type for %s', async type => {
    const fetch: SafeFetcher = async raw => response(String(raw), '[]', 'application/octet-stream');
    const scope = { hosts: ['types.integration.test'], pathPrefix: '/' };
    const env = { fetch, scope, robots: parseRobots(null) };
    const config = { type, feedUrl: 'https://types.integration.test/feed', apiBase: 'https://types.integration.test/wp-json/', listUrl: 'https://types.integration.test/', sitemaps: ['https://types.integration.test/sitemap.xml'] };
    if (type === 'sitemap') {
      const result = await listArticles(env, config, { includeBody: false });
      expect(result.complete).toBe(false);
      expect(result.warnings[0]).toContain('対応していない種類のファイルです');
    } else await expect(listArticles(env, config, { includeBody: false })).rejects.toMatchObject({ status: 415 });
  });

  it('keeps successful partial results and retries a failed full-text fetch', async () => {
    const registered = site('partial.integration.test');
    let broken = true;
    const fetch: SafeFetcher = async (raw, options) => {
      if (String(raw).endsWith('/blog/post') && broken) throw new SafeFetchError('Temporary failure', 'http', 503);
      return feedFetch('partial.integration.test')(raw, options);
    };
    const first = await syncSite(registered, fetch);
    expect(first.status).toBe('partial');
    expect(assessSiteRun(first).status).toBe('succeeded');
    expect(getSite(registered.id)?.lastSuccessAt).toBeNull();
    expect([...knownSiteArticles(registered.id).values()][0]).toMatchObject({ hasBody: false, state: 'error' });
    broken = false;
    const second = await syncSite(registered, fetch);
    expect(second.status).toBe('ok');
    expect([...knownSiteArticles(registered.id).values()][0]).toMatchObject({ hasBody: true, state: 'active' });
  });

  it('does not turn an unknown publication date into a fabricated date when hydrated articles are saved', async () => {
    const original = { ...article('integration-undated', 'Undated', 'body'), publishedAt: new Date(NaN), source: 'rss:Undated' };
    saveArticlesToDb([original]);
    saveArticlesToDb([{ ...getArticleById(original.id)!, source: 'rss:UndatedAgain' }]);
    expect(db.prepare('SELECT published_at FROM articles WHERE id=?').get(original.id)).toEqual({ published_at: null });
  });

  it('keeps an Atom update timestamp separate from an unknown publication date', async () => {
    const scope = { hosts: ['atom.integration.test'], pathPrefix: '/blog/' };
    const fetch: SafeFetcher = async raw => response(String(raw), '<feed><entry><title>Undated</title><link href="https://atom.integration.test/blog/post"/><updated>2026-10-18T00:00:00Z</updated></entry></feed>', 'application/atom+xml; charset=utf-8');
    const listed = await listArticles({ fetch, scope, robots: parseRobots(null) }, { type: 'feed', feedUrl: 'https://atom.integration.test/feed' }, { includeBody: false });
    expect(listed.articles[0]).toMatchObject({ publishedAt: undefined, updatedAt: '2026-10-18T00:00:00.000Z' });
  });

  it('counts distinct articles rather than RSS memberships in aggregate statistics', () => {
    const before = loadArticleStats()?.rss ?? 0;
    const original = { ...article('integration-rss-stats', 'RSS stats', 'body'), source: 'rss:StatsOne' };
    saveArticlesToDb([original]);
    saveArticlesToDb([{ ...original, source: 'rss:StatsTwo' }]);
    expect(loadArticleStats()?.rss).toBe(before + 1);
  });

  it('repairs legacy associations by alias and URL, quarantines unresolved rows, and adds cascading FKs', () => {
    const old = new Database(':memory:');
    old.pragma('foreign_keys = ON');
    try {
      old.exec("CREATE TABLE schema_migrations(id TEXT PRIMARY KEY, applied_at TEXT NOT NULL); INSERT INTO schema_migrations VALUES ('022_site_article_integration','fixture')");
      runMigrations(old);
      old.exec(`INSERT INTO site_sources(id,site_url,name,hosts_json,scope_path,adapter_json,status,body_policy,max_initial,enabled,created_at,updated_at)
        VALUES ('legacy','https://legacy.test/','Legacy','["legacy.test"]','/','{"type":"feed"}','ok','pending',10,1,'now','now');
        INSERT INTO articles(id,title,body,url,created_at,updated_at) VALUES ('preserve','T','Body','https://legacy.test/post?a=1&b=2','now','now');
        INSERT INTO article_aliases(alias_id,article_id) VALUES ('old-alias','preserve');
        INSERT INTO site_articles(site_id,article_key,article_id,url,first_seen_at) VALUES
          ('legacy','alias-key','old-alias','https://legacy.test/alias','now'),
          ('legacy','url-key','missing-url-id','https://legacy.test/post?b=2&a=1','now'),
          ('legacy','orphan-key','unresolvable','https://legacy.test/nowhere','now');
        INSERT INTO cards(id,title,body,created_at,updated_at) VALUES ('keep','User memo','Never change','now','now');
        INSERT INTO reader_texts(card_id,paragraphs_json,updated_at) VALUES ('keep','["Reader copy"]','now');
        DELETE FROM schema_migrations WHERE id='022_site_article_integration';`);
      expect(runMigrations(old)).toEqual(['022_site_article_integration']);
      expect(runMigrations(old)).toEqual([]);
      expect(old.prepare('SELECT DISTINCT article_id FROM site_articles').all()).toEqual([{ article_id: 'preserve' }]);
      expect(old.prepare('SELECT reason FROM site_article_repairs ORDER BY id').all()).toEqual([{ reason: 'resolved_alias' }, { reason: 'resolved_url' }, { reason: 'unresolved_article' }]);
      expect(old.prepare('SELECT body FROM cards WHERE id=?').get('keep')).toEqual({ body: 'Never change' });
      expect(old.prepare('SELECT paragraphs_json FROM reader_texts WHERE card_id=?').get('keep')).toEqual({ paragraphs_json: '["Reader copy"]' });
      expect(old.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
      expect(() => old.prepare('INSERT INTO site_articles(site_id,article_key,article_id,url,first_seen_at) VALUES (?,?,?,?,?)').run('legacy', 'bad', 'missing', 'https://legacy.test/bad', 'now')).toThrow(/FOREIGN KEY/);
      old.prepare('DELETE FROM articles WHERE id=?').run('preserve');
      expect(old.prepare('SELECT article_id FROM site_articles').all()).toEqual([]);
    } finally { old.close(); }
  });
});

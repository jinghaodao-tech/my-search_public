import fs from 'node:fs';
import http from 'node:http';
import express from 'express';
import request from 'supertest';
import { app, database, searchMode } from '../tests/helpers.js';
import { createSiteRouter } from '../routes/site_routes.js';
import { createRouteContext } from '../services/route_context.js';
import { errorHandler } from '../services/http_service.js';
import { fetchPageMeta, syncSite } from '../services/site_collector.js';
import { createSite, getSite, knownSiteArticles } from '../repositories/site_sources_repository.js';
import { getArticleById, getArticleByUrl, saveArticlesToDb } from '../repositories/articles_repository.js';
import { buildStoredTokenSet } from '../bm25_engine.js';
import { assertPublicUrl, createSafeFetcher, safeFetch, SafeFetchError, type SafeFetcher } from '../services/safe_fetch.js';

// Diagnostic only: isolated test DB, explicit invocation, not a change to production or release tests.
const db = database.db;
const results: Array<{ id: string; expectation: string; pass: boolean; observed: unknown }> = [];
async function probe(id: string, expectation: string, run: () => Promise<{ pass: boolean; observed: unknown }>) {
  try { results.push({ id, expectation, ...await run() }); }
  catch (error) { results.push({ id, expectation, pass: false, observed: { unexpectedError: (error as Error).message } }); }
}
const page = (title: string, text = '統合検証 本文に固有の integrationdeepneedle を含みます。') => `<html><head><title>${title}</title></head><body><article><h1>${title}</h1><p>${text.repeat(8)}</p><p>検索と保存の統合を確認するための十分な長さの第二段落です。</p></article></body></html>`;
const feed = (base: string, links: string[], dated = true) => `<rss version="2.0"><channel><title>Integration</title>${links.map((link, i) => `<item><title>統合検証の記事${i}</title><link>${link.replace(/&/g, '&amp;')}</link><description>短い紹介</description>${dated ? '<pubDate>Thu, 01 Oct 2026 00:00:00 GMT</pubDate>' : ''}</item>`).join('')}</channel></rss>`;
function web(base: string, links: string[], options: { dated?: boolean; finalUrl?: string } = {}) {
  const calls: string[] = [];
  const fetch: SafeFetcher = async raw => {
    const url = String(raw); calls.push(url);
    let body: string;
    let contentType = 'text/html; charset=utf-8';
    let finalUrl = url;
    if (url === `${base}/robots.txt`) { body = 'User-agent: *\nAllow: /'; contentType = 'text/plain'; }
    else if (url === `${base}/blog/`) body = `<html><head><title>Integration blog</title><link rel="alternate" type="application/rss+xml" href="${base}/blog/feed"></head></html>`;
    else if (url === `${base}/blog/feed`) { body = feed(base, links, options.dated ?? true); contentType = 'application/rss+xml'; }
    else if (links.includes(url)) { body = page('統合検証の記事'); finalUrl = options.finalUrl ?? url; }
    else throw new SafeFetchError('HTTP 404', 'http', 404);
    const bytes = Buffer.from(body);
    return { url: finalUrl, status: 200, contentType, headers: {}, bytes, text: () => bytes.toString() };
  };
  return { fetch, calls };
}
function siteFor(base: string, bodyPolicy: 'body' | 'metadata' = 'body') {
  return createSite({ siteUrl: `${base}/blog/`, name: base, scope: { hosts: [new URL(base).hostname], pathPrefix: '/blog/' }, adapter: { type: 'feed', feedUrl: `${base}/blog/feed` }, bodyPolicy, maxInitial: 10 });
}
const mode = searchMode([{ term: 'integrationdeepneedle', weight: 1 }]);
async function search(source: string) {
  return (await request(app).post('/api/run').send({ config: mode, filters: { sources: [source] }, options: { archiveScoreThreshold: 0, resultLimit: 100 } })).body;
}

await probe('registration-to-card', 'API登録→初回ジョブ→SQLite→日本語/英語検索→候補保存→削除後再保存が成立する', async () => {
  const base = 'https://registration.audit.test';
  const transport = web(base, [`${base}/blog/post`]);
  const noop: express.RequestHandler = (_req, _res, next) => next();
  const ctx = createRouteContext({ apiLimiter: noop, aiLimiter: noop, readerLimiter: noop, importLimiter: noop });
  const api = express().use(express.json()).use('/api', createSiteRouter(ctx, transport.fetch)).use(errorHandler);
  const registered = await request(api).post('/api/sites').send({ url: `${base}/blog/`, bodyPolicy: 'body', maxInitial: 10 });
  if (registered.status !== 201) return { pass: false, observed: { status: registered.status, body: registered.body } };
  let job = ctx.getJob(registered.body.jobId);
  for (let i = 0; i < 500 && !['succeeded', 'failed'].includes(job?.status ?? ''); i++) {
    await new Promise(resolve => setTimeout(resolve, 10)); job = ctx.getJob(registered.body.jobId);
  }
  const siteId = registered.body.site.id;
  const known = [...knownSiteArticles(siteId).values()];
  const article = known[0] ? getArticleById(known[0].articleId) : null;
  const english = await search(`site:${siteId}`);
  const japanese = (await request(app).post('/api/run').send({ config: searchMode([{ term: '統合検証', weight: 1 }]), filters: { sources: [`site:${siteId}`] }, options: { archiveScoreThreshold: 0 } })).body;
  const saved = article ? await request(app).post(`/api/candidates/${article.id}/save`).send({}) : null;
  const repeat = article ? await request(app).post(`/api/candidates/${article.id}/save`).send({}) : null;
  if (saved?.status === 201) await request(app).delete(`/api/cards/${saved.body.card.id}`);
  const resaved = article ? await request(app).post(`/api/candidates/${article.id}/save`).send({}) : null;
  return { pass: job?.status === 'succeeded' && known.length === 1 && english.active?.length === 1 && japanese.active?.length === 1 && saved?.status === 201 && repeat?.status === 409 && resaved?.status === 201,
    observed: { registrationStatus: registered.status, jobStatus: job?.status, articleCount: known.length, englishHits: english.active?.length, japaneseHits: japanese.active?.length, dualTokens: !!article?.morphologicalTokens?.length && !!article?.ngramTokens?.length, save: saved?.status, repeat: repeat?.status, resave: resaved?.status } };
});

await probe('cross-source-fulltext', 'サイト取得済みの全文は、後から来た同一URLのRSS抜粋で失われない', async () => {
  const base = 'https://shared.audit.test';
  const url = `${base}/blog/post`;
  const site = siteFor(base);
  await syncSite(site, web(base, [url]).fetch);
  const before = getArticleByUrl(url)!;
  const tokens = await buildStoredTokenSet(`${before.title} RSS excerpt only`);
  saveArticlesToDb([{ ...before, id: 'rss_integration_shared', body: 'RSS excerpt only', source: 'rss:Integration', ...tokens, tokens: tokens.ngramTokens, docLength: tokens.ngramDocLength }]);
  const after = getArticleById(before.id)!;
  return { pass: after.body.includes('integrationdeepneedle'), observed: { idPreserved: before.id === after.id, beforeLength: before.body.length, afterBody: after.body, source: after.source } };
});

await probe('cross-source-search', 'RSS再収集後も登録サイトを選んで全文を検索できる', async () => {
  const site = db.prepare("SELECT id FROM site_sources WHERE site_url='https://shared.audit.test/blog/'").get() as { id: string };
  const response = await search(`site:${site.id}`);
  const targets = (await request(app).get('/api/search/targets')).body;
  const target = targets.collected.find((item: {value: string}) => item.value === `site:${site.id}`);
  return { pass: response.active?.length === 1 && target?.count === 1, observed: { siteIndexRows: knownSiteArticles(site.id).size, target, scope: response.scope, hits: response.active?.length } };
});

await probe('query-order-id-join', '同じ意味のクエリ順序違いでサイト索引が存在しない記事IDを参照しない', async () => {
  const base = 'https://query.audit.test';
  const urls = [`${base}/blog/post?a=1&b=2`, `${base}/blog/post?b=2&a=1`];
  const site = siteFor(base, 'metadata');
  const result = await syncSite(site, web(base, urls).fetch);
  const orphans = db.prepare('SELECT s.article_id FROM site_articles s LEFT JOIN articles a ON a.id=s.article_id WHERE s.site_id=? AND a.id IS NULL').all(site.id);
  return { pass: orphans.length === 0 && knownSiteArticles(site.id).size === 1, observed: { result, siteIndexRows: knownSiteArticles(site.id).size, orphanReferences: orphans, sqliteForeignKeyCheck: db.prepare('PRAGMA foreign_key_check').all() } };
});

await probe('site-save-atomicity', 'サイト索引の保存に失敗したら、新規記事本体もロールバックされる', async () => {
  const base = 'https://atomic.audit.test';
  const url = `${base}/blog/post`;
  const site = siteFor(base, 'metadata');
  db.exec(`CREATE TRIGGER integration_fail_site_index BEFORE INSERT ON site_articles WHEN NEW.site_id='${site.id}' BEGIN SELECT RAISE(ABORT, 'injected association failure'); END`);
  try {
    const result = await syncSite(site, web(base, [url]).fetch);
    const persisted = getArticleByUrl(url);
    return { pass: result.status === 'error' && !persisted && knownSiteArticles(site.id).size === 0, observed: { result, articleStillPersisted: !!persisted, siteIndexRows: knownSiteArticles(site.id).size } };
  } finally { db.exec('DROP TRIGGER integration_fail_site_index'); }
});

await probe('site-job-failure-status', 'サイト収集でSQLite保存が失敗したジョブはfailedとして記録する', async () => {
  const base = 'https://job-error.audit.test';
  const transport = web(base, [`${base}/blog/post`]);
  const noop: express.RequestHandler = (_req, _res, next) => next();
  const ctx = createRouteContext({ apiLimiter: noop, aiLimiter: noop, readerLimiter: noop, importLimiter: noop });
  const api = express().use(express.json()).use('/api', createSiteRouter(ctx, transport.fetch)).use(errorHandler);
  db.exec(`CREATE TRIGGER integration_fail_site_article BEFORE INSERT ON articles WHEN NEW.url LIKE '${base}/%' BEGIN SELECT RAISE(ABORT, 'injected article failure'); END`);
  try {
    const registered = await request(api).post('/api/sites').send({ url: `${base}/blog/`, bodyPolicy: 'metadata', maxInitial: 10 });
    let job = ctx.getJob(registered.body.jobId);
    for (let i = 0; i < 500 && !['succeeded', 'failed'].includes(job?.status ?? ''); i++) {
      await new Promise(resolve => setTimeout(resolve, 10)); job = ctx.getJob(registered.body.jobId);
    }
    return { pass: job?.status === 'failed', observed: { registrationStatus: registered.status, jobStatus: job?.status, jobResult: job?.result, siteStatus: getSite(registered.body.site.id)?.status } };
  } finally { db.exec('DROP TRIGGER integration_fail_site_article'); }
});

await probe('site-unknown-date', 'サイト記事の不明な公開日はSQLiteでもNULLのまま', async () => {
  const base = 'https://undated.audit.test';
  const url = `${base}/blog/post`;
  const site = siteFor(base, 'metadata');
  await syncSite(site, web(base, [url], { dated: false }).fetch);
  const stored = db.prepare('SELECT published_at FROM articles WHERE url=?').get(url) as {published_at: string | null};
  return { pass: stored?.published_at === null, observed: stored };
});

await probe('site-concurrent-sync', '同じサイトを手動/定期から同時実行しても取得は一回だけ', async () => {
  const base = 'https://concurrent.audit.test';
  const site = siteFor(base, 'metadata');
  const transport = web(base, [`${base}/blog/post`]);
  let calls = 0;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const fetch: SafeFetcher = async (raw, options) => {
    if (String(raw) === `${base}/blog/feed`) { calls++; await gate; }
    return transport.fetch(raw, options);
  };
  const first = syncSite(site, fetch);
  const second = syncSite(site, fetch);
  await new Promise(resolve => setTimeout(resolve, 50));
  const inFlightRequests = calls;
  release();
  const runs = await Promise.all([first, second]);
  return { pass: inFlightRequests <= 1, observed: { inFlightRequests, statuses: runs.map(r => r.status) } };
});

await probe('site-redirect-scope', '登録サイト外へ転送された記事本文を元サイトの許可だけで保存しない', async () => {
  const base = 'https://redirect.audit.test';
  const url = `${base}/blog/post`;
  const site = siteFor(base);
  const result = await syncSite(site, web(base, [url], { finalUrl: 'https://outside.audit.test/foreign' }).fetch);
  const stored = getArticleByUrl(url);
  return { pass: !stored?.body.includes('integrationdeepneedle'), observed: { status: result.status, requestedUrl: url, finalUrl: 'https://outside.audit.test/foreign', storedForeignBody: !!stored?.body.includes('integrationdeepneedle') } };
});

const server = http.createServer((req, res) => {
  if (req.url === '/badtype') { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"message":"not HTML"}'); }
  else { res.writeHead(200, { 'content-type': 'text/html', 'content-length': String(2 * 1024 * 1024) }); res.end('x'.repeat(2 * 1024 * 1024)); }
});
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
const port = (server.address() as {port: number}).port;
const localFetch = createSafeFetcher({ isAllowed: address => address === '127.0.0.1' || address === '::1', checkUrl: raw => new URL(String(raw)) });
const transport: SafeFetcher = (url, options) => localFetch(url, { ...options, hostIntervalMs: 0, retries: 0 });
try {
  await probe('site-http-content-type', '共通HTTP取得を使うサイトページ取得が非HTMLの応答を拒否する', async () => {
    try {
      const result = await fetchPageMeta(transport, `http://127.0.0.1:${port}/badtype`, false);
      return { pass: false, observed: { accepted: true, result } };
    } catch (error) { return { pass: (error as SafeFetchError).status === 415, observed: { accepted: false, code: (error as SafeFetchError).code, status: (error as SafeFetchError).status } }; }
  });
  await probe('site-http-safety', 'サイトページ取得にもprivate URL拒否・ストリーム容量制限が効く', async () => {
    const observed: Record<string, string> = {};
    try { await fetchPageMeta(safeFetch, 'http://127.0.0.1/secret', false); }
    catch (error) { observed.private = (error as SafeFetchError).code; }
    try { await fetchPageMeta(transport, `http://127.0.0.1:${port}/huge`, false); }
    catch (error) { observed.size = (error as SafeFetchError).code; }
    return { pass: observed.private === 'blocked' && observed.size === 'too_large', observed };
  });
} finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }

const report = { scope: 'site integration verification; no production code changes', passed: results.filter(r => r.pass).length, failed: results.filter(r => !r.pass).length, results };
fs.writeFileSync('artifacts/site-integration-probes.json', JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
db.close();
if (report.failed) process.exitCode = 1;

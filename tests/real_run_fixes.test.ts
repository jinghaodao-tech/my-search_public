// Regressions for problems found by the real-world execution test (2026-10-18).
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { database } from './helpers.js';
import { SafeFetchError, type SafeFetcher } from '../services/safe_fetch.js';
import { syncSite } from '../services/site_collector.js';
import { inspectUrl } from '../services/site_adapters.js';
import { createSite, getSite, knownSiteArticles, markSiteChecking, resetInterruptedSiteChecks } from '../repositories/site_sources_repository.js';
import { isValidCardTimestamp, runMigrations } from '../db/migrate.js';

type Reply = { status?: number; body: string; type?: string };
function web(pages: () => Record<string, Reply | 'timeout'>) {
  const requests: string[] = [];
  const fetch: SafeFetcher = async raw => {
    const url = String(raw);
    requests.push(url);
    const page = pages()[url];
    if (page === 'timeout') throw new SafeFetchError('時間内に応答がありませんでした', 'timeout');
    if (!page) throw new SafeFetchError('HTTP 404', 'http', 404);
    if ((page.status ?? 200) >= 400) throw new SafeFetchError(`HTTP ${page.status}`, 'http', page.status);
    const bytes = Buffer.from(page.body);
    return { url, status: page.status ?? 200, contentType: page.type ?? 'text/html; charset=utf-8', headers: {}, bytes, text: () => page.body };
  };
  return { fetch, requests };
}
const articleHtml = (title: string) => ({ body: `<html><head><title>${title}</title><meta property="og:title" content="${title}"><meta property="article:published_time" content="2026-10-01T00:00:00Z"></head><body><article><h1>${title}</h1><p>${title}の本文です。</p></article></body></html>` });
const urlset = (urls: string[]) => ({ body: `<urlset>${urls.map(u => `<url><loc>${u}</loc><lastmod>2026-10-01</lastmod></url>`).join('')}</urlset>`, type: 'application/xml' });

describe('a check that cannot read the article list is a failure (E-1)', () => {
  it('sitemap timeout / 500 after a good first run: status error, last success kept, articles kept', async () => {
    const S = 'https://e1.example.com';
    let mode: 'ok' | 'timeout' | '500' = 'ok';
    const w = web(() => ({
      [`${S}/robots.txt`]: { body: '', type: 'text/plain' },
      [`${S}/sitemap.xml`]: mode === 'ok' ? urlset([`${S}/blog/a`, `${S}/blog/b`]) : mode === 'timeout' ? 'timeout' : { status: 500, body: '' },
      [`${S}/blog/a`]: articleHtml('記事A'), [`${S}/blog/b`]: articleHtml('記事B'),
    }));
    const site = createSite({ siteUrl: `${S}/blog/`, name: 'E1', scope: { hosts: ['e1.example.com'], pathPrefix: '/blog/' }, adapter: { type: 'sitemap', sitemaps: [`${S}/sitemap.xml`] }, bodyPolicy: 'pending', maxInitial: 10 });
    expect((await syncSite(site, w.fetch)).status).toBe('ok');
    const lastSuccess = getSite(site.id)!.lastSuccessAt;
    for (const failure of ['timeout', '500'] as const) {
      mode = failure;
      const result = await syncSite(getSite(site.id)!, w.fetch);
      expect(result.status, failure).toBe('error');
      expect(result.error).toContain('記事の一覧を読めませんでした');
      expect(getSite(site.id)!.lastSuccessAt).toBe(lastSuccess);
      expect(knownSiteArticles(site.id).size).toBe(2);
    }
  });
});

describe('a check interrupted by closing the app (E-2)', () => {
  it('is not left as "checking" after a restart', () => {
    const site = createSite({ siteUrl: 'https://e2.example.com/', name: 'E2', scope: { hosts: ['e2.example.com'], pathPrefix: '/' }, adapter: { type: 'feed', feedUrl: 'https://e2.example.com/feed' }, bodyPolicy: 'pending', maxInitial: 10 });
    markSiteChecking(site.id);
    expect(resetInterruptedSiteChecks()).toBeGreaterThanOrEqual(1);
    expect(getSite(site.id)).toMatchObject({ status: 'error' });
    expect(getSite(site.id)!.lastError).toContain('中断');
  });
});

describe('card timestamps (D-1)', () => {
  it('numbers such as "60" are not dates, and migration 023 repairs them', () => {
    expect(isValidCardTimestamp('60')).toBe(false);
    expect(isValidCardTimestamp('2026-10-18T02:38:57.616Z')).toBe(true);
    const db = new Database(':memory:');
    runMigrations(db);
    db.prepare("INSERT INTO cards (id, title, body, created_at, updated_at) VALUES ('card_1781571824003_x', 't', 'b', '2026-06-16T01:03:44.003Z', '60')").run();
    db.prepare("DELETE FROM schema_migrations WHERE id = '023_repair_numeric_card_timestamps'").run();
    expect(runMigrations(db)).toEqual(['023_repair_numeric_card_timestamps']);
    expect(db.prepare("SELECT updated_at FROM cards WHERE id = 'card_1781571824003_x'").get()).toEqual({ updated_at: '2026-06-16T01:03:44.003Z' });
  });
});

describe('registering from a URL', () => {
  it('a shared site top page says to give a user page, without fetching (A06a)', async () => {
    const w = web(() => ({}));
    const result = await inspectUrl('https://note.com/', w.fetch);
    expect(result.error).toContain('共通のサイト');
    expect(w.requests).toHaveLength(0);
  });

  it('a page drawn by JavaScript that says og:type=article but has its own feed is a list (Zenn publication, A04)', async () => {
    const P = 'https://pub2.example.com';
    const w = web(() => ({
      [`${P}/p/team`]: { body: `<html><head><title>Team</title><meta property="og:type" content="article"><link href="${P}/p/team/feed" rel="alternate" type="application/rss+xml"></head><body><div id="app"></div></body></html>` },
      [`${P}/robots.txt`]: { body: '', type: 'text/plain' },
    }));
    expect((await inspectUrl(`${P}/p/team`, w.fetch)).kind).toBe('source');
  });

  it('a list page that says og:type=article is a list, not an article (A04)', async () => {
    const P = 'https://pub.example.com';
    const links = Array.from({ length: 20 }, (_, i) => `<a href="${P}/writer${i}/articles/post-${i}">記事${i}</a>`).join('');
    const w = web(() => ({
      [`${P}/p/team`]: { body: `<html><head><title>Team</title><meta property="og:type" content="article"></head><body>${links}</body></html>` },
      [`${P}/robots.txt`]: { body: '', type: 'text/plain' },
    }));
    const result = await inspectUrl(`${P}/p/team`, w.fetch);
    expect(result.kind).toBe('source');
    expect(result.article).toBeNull();
  });
});

describe('sitemaps split by month (A03)', () => {
  it('each check also reads a few older files, so past articles are found over time', async () => {
    const H = 'https://monthly.example.com';
    const months = Array.from({ length: 24 }, (_, i) => `${H}/sitemap_${String(2026 - Math.floor(i / 12))}-${String(12 - (i % 12)).padStart(2, '0')}.xml`);
    const pages: Record<string, Reply> = {
      [`${H}/robots.txt`]: { body: '', type: 'text/plain' },
      [`${H}/sitemap_index.xml`]: { body: `<sitemapindex>${months.map((m, i) => `<sitemap><loc>${m}</loc><lastmod>2026-${String(12 - (i % 12)).padStart(2, '0')}-01</lastmod></sitemap>`).join('')}</sitemapindex>`, type: 'application/xml' },
    };
    months.forEach((m, i) => { pages[m] = urlset([`${H}/entry/${i}`]); pages[`${H}/entry/${i}`] = articleHtml(`記事${i}`); });
    const w = web(() => pages);
    const site = createSite({ siteUrl: `${H}/`, name: 'Monthly', scope: { hosts: ['monthly.example.com'], pathPrefix: '/entry/' }, adapter: { type: 'sitemap', sitemaps: [`${H}/sitemap_index.xml`] }, bodyPolicy: 'pending', maxInitial: 50 });
    await syncSite(site, w.fetch);
    const first = knownSiteArticles(site.id).size;
    expect(first).toBeLessThan(24);
    for (let run = 0; run < 3; run += 1) await syncSite(getSite(site.id)!, w.fetch);
    expect(knownSiteArticles(site.id).size).toBe(24);
  });
});

void database;

import fs from 'node:fs';
import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';
import { clearDiscoverCache, discover } from '../services/discover_service.js';
import { extractPageMeta, looksLikeArticle, parseRobots } from '../services/site_parsing.js';
import { listArticles } from '../services/site_adapters.js';
import type { SafeFetcher } from '../services/safe_fetch.js';

describe('sitemap article candidates', () => {
  const scope = { hosts: ['tech.example.com'], pathPrefix: '/blog/' };

  it('excludes taxonomies, date archives, index pages and pagination without rejecting article slugs', () => {
    for (const path of ['category/db', '%63ategory/db', 'topics/db', 'index.html', '2026/', '2026/10/', '?offset=20', 'sqlite?Page=2']) {
      expect(looksLikeArticle(`https://tech.example.com/blog/${path}`, scope), path).toBe(false);
    }
    for (const path of ['category-theory', 'index-performance', '2026/10/sqlite', '?p=123']) {
      expect(looksLikeArticle(`https://tech.example.com/blog/${path}`, scope), path).toBe(true);
    }
    expect(looksLikeArticle('https://tech.example.com/category/db/article', { ...scope, pathPrefix: '/category/db/' })).toBe(false);
    expect(looksLikeArticle('https://tech.example.com/users/alice/blog/sqlite', { ...scope, pathPrefix: '/users/alice/blog/' })).toBe(true);
  });

  it('distinguishes explicit collection metadata from articles and unknown pages', () => {
    const url = 'https://tech.example.com/blog/landing';
    expect(extractPageMeta('<script type="application/ld+json">{"@graph":[{"@type":"CollectionPage"},{"@type":"BlogPosting"}]}</script>', url).pageKind).toBe('listing');
    expect(extractPageMeta('<script type="application/ld+json">{"@type":["WebPage","BlogPosting"]}</script>', url).pageKind).toBe('article');
    expect(extractPageMeta('<meta property="og:type" content="article">', url).pageKind).toBe('article');
    expect(extractPageMeta('<title>Unknown</title>', url).pageKind).toBe('unknown');
  });

  it('deduplicates candidate counts and ignores malformed child-sitemap URLs', async () => {
    const index = '<sitemapindex><sitemap><loc>http://[invalid</loc></sitemap><sitemap><loc>/posts.xml</loc></sitemap></sitemapindex>';
    const urls = ['category/db', 'index.html', '2026/10/', 'sqlite-wal', 'sqlite-wal', 'sqlite-wal/', 'sqlite-wal?utm_source=feed', 'locking'];
    const xml = `<urlset>${urls.map(path => `<url><loc>https://tech.example.com/blog/${path}</loc></url>`).join('')}</urlset>`;
    const fetch: SafeFetcher = async raw => {
      const url = String(raw);
      const text = url.endsWith('sitemap.xml') ? index : xml;
      return { url, status: 200, contentType: 'application/xml', headers: {}, bytes: Buffer.from(text), text: () => text };
    };
    const result = await listArticles({ fetch, scope, robots: parseRobots('') }, { type: 'sitemap', sitemaps: ['https://tech.example.com/sitemap.xml'] }, { includeBody: false });
    expect(result.total).toBe(2);
    expect(result.pathGroups?.get('/blog/')).toBe(2);
    expect(result.articles.map(item => item.url)).toEqual(['https://tech.example.com/blog/sqlite-wal', 'https://tech.example.com/blog/locking']);
  });

  it('labels sitemap counts as candidates and initial imports as a maximum', () => {
    const dom = new JSDOM('', { url: 'http://localhost/', runScripts: 'outside-only' });
    try {
      const w = dom.window;
      w.eval(fs.readFileSync('public/js/site_sources_ui.js', 'utf8'));
      const box = w.renderSiteCandidate({ ok: true, name: 'Tech', siteUrl: 'https://tech.example.com/blog/', adapter: { type: 'sitemap' }, adapterLabel: 'Sitemap', availableLabels: ['Sitemap'], pathGroups: [{ prefix: '/blog/', count: 999, inScope: true }], scope, prefixes: ['/blog/'], estimatedCount: 2, plan: { pastArticles: true, pagesAllowed: true }, samples: [], notes: [], policyLinks: [], needsScopeConfirm: false }, 0, 1);
      expect(box.textContent).toContain('記事候補の数');
      expect(box.textContent).toContain('最初に最大 2件の候補を確認');
      expect(box.textContent).not.toContain('999');
    } finally { dom.window.close(); }
  });
});

describe('first Web search relevance', () => {
  it('accounts for every missing technical term, and does not match Go inside Google', async () => {
    clearDiscoverCache();
    const qiita = JSON.stringify([
      { title: 'SQLite PostgreSQL WAL', url: 'https://qiita.com/p0/items/both', body: 'SQLite PostgreSQL WAL concurrency locking.', user: { id: 'p0' }, tags: [] },
      { title: 'SQLite WAL', url: 'https://qiita.com/p0/items/partial', body: 'SQLite WAL concurrency locking.', user: { id: 'p0' }, tags: [] },
      { title: 'Google PostgreSQL WAL', url: 'https://qiita.com/p0/items/google', body: 'Google PostgreSQL WAL concurrency locking.', user: { id: 'p0' }, tags: [] },
    ]);
    const out = await discover({ purpose: 'SQLite PostgreSQL WAL', queries: ['SQLite PostgreSQL WAL'], sources: ['qiita'] }, { fetchText: async () => qiita, env: {} });
    expect(out.results[0].url).toContain('/both');
    expect(out.results.find(item => item.url.endsWith('/partial'))?.breakdown.missingKeyTerms).toEqual(['postgresql']);
    const go = await discover({ purpose: 'Go PostgreSQL WAL', queries: ['Google PostgreSQL WAL'], sources: ['qiita'] }, { fetchText: async () => qiita, env: {} });
    expect(go.results.find(item => item.url.endsWith('/google'))?.breakdown.missingKeyTerms).toContain('go');
  });
});

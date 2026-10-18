import crypto from 'node:crypto';
import { db } from '../db/database.js';
import type { AdapterConfig } from '../services/site_adapters.js';
import type { SiteScope } from '../services/site_parsing.js';
import { articleIdentityKey } from '../services/article_identity.js';

// Sites the user registered by URL, and which of their articles are already known.
// Articles themselves live in the articles table (source = "site:<id>"), so search,
// candidate review, the reader and saving work for them as for any collected article.

export type SiteStatus = 'ok' | 'checking' | 'partial' | 'error' | 'unsupported';
/** pending = terms not checked yet (title/summary only); metadata = title/summary only by choice; body = the user confirmed full text may be fetched */
export type BodyPolicy = 'pending' | 'metadata' | 'body';

export type SiteSource = {
  id: string;
  siteUrl: string;
  name: string;
  scope: SiteScope;
  adapter: AdapterConfig;
  status: SiteStatus;
  bodyPolicy: BodyPolicy;
  maxInitial: number;
  enabled: boolean;
  lastCheckedAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
  lastResult: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
};

type Row = {
  id: string; site_url: string; name: string; hosts_json: string; scope_path: string; adapter_json: string; status: SiteStatus; body_policy: BodyPolicy;
  max_initial: number; enabled: number; last_checked_at: string | null; last_success_at: string | null; last_error: string | null; last_result_json: string | null;
  created_at: string; updated_at: string; scope_extra_json?: string;
};

function toSite(row: Row): SiteSource {
  return {
    id: row.id,
    siteUrl: row.site_url,
    name: row.name,
    scope: {
      hosts: JSON.parse(row.hosts_json),
      pathPrefix: row.scope_path,
      ...(JSON.parse(row.scope_extra_json ?? '[]').length ? { extraPrefixes: JSON.parse(row.scope_extra_json ?? '[]') } : {}),
      ...(JSON.parse(row.adapter_json).linked ? { linked: true } : {}),
    },
    adapter: JSON.parse(row.adapter_json),
    status: row.status,
    bodyPolicy: row.body_policy,
    maxInitial: row.max_initial,
    enabled: !!row.enabled,
    lastCheckedAt: row.last_checked_at,
    lastSuccessAt: row.last_success_at,
    lastError: row.last_error,
    lastResult: row.last_result_json ? JSON.parse(row.last_result_json) : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function siteSourceTag(id: string): string {
  return `site:${id}`;
}

export function listSites(): SiteSource[] {
  return (db.prepare('SELECT * FROM site_sources ORDER BY created_at').all() as Row[]).map(toSite);
}

export function getSite(id: string): SiteSource | null {
  const row = db.prepare('SELECT * FROM site_sources WHERE id = ?').get(id) as Row | undefined;
  return row ? toSite(row) : null;
}

export function findSiteByUrl(siteUrl: string): SiteSource | null {
  const row = db.prepare('SELECT * FROM site_sources WHERE site_url = ?').get(siteUrl) as Row | undefined;
  return row ? toSite(row) : null;
}

export function createSite(input: { siteUrl: string; name: string; scope: SiteScope; adapter: AdapterConfig; bodyPolicy: BodyPolicy; maxInitial: number }): SiteSource {
  const now = new Date().toISOString();
  const id = crypto.randomBytes(6).toString('hex');
  db.prepare(`INSERT INTO site_sources (id, site_url, name, hosts_json, scope_path, scope_extra_json, adapter_json, status, body_policy, max_initial, enabled, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'checking', ?, ?, 1, ?, ?)`)
    .run(id, input.siteUrl, input.name, JSON.stringify(input.scope.hosts), input.scope.pathPrefix, JSON.stringify(input.scope.extraPrefixes ?? []), JSON.stringify(input.adapter), input.bodyPolicy, input.maxInitial, now, now);
  return getSite(id)!;
}

export function updateSite(id: string, fields: Partial<Pick<SiteSource, 'name' | 'bodyPolicy' | 'maxInitial' | 'enabled' | 'status' | 'adapter'>>): SiteSource | null {
  const site = getSite(id);
  if (!site) return null;
  const next = { ...site, ...fields };
  db.prepare('UPDATE site_sources SET name = ?, body_policy = ?, max_initial = ?, enabled = ?, status = ?, adapter_json = ?, updated_at = ? WHERE id = ?')
    .run(next.name, next.bodyPolicy, next.maxInitial, next.enabled ? 1 : 0, next.status, JSON.stringify(next.adapter), new Date().toISOString(), id);
  return getSite(id);
}

export function recordSiteCheck(id: string, result: { status: SiteStatus; error: string | null; summary: Record<string, unknown>; success: boolean }): void {
  const now = new Date().toISOString();
  db.prepare(`UPDATE site_sources SET status = ?, last_checked_at = ?, last_success_at = CASE WHEN ? THEN ? ELSE last_success_at END, last_error = ?, last_result_json = ?, updated_at = ? WHERE id = ?`)
    .run(result.status, now, result.success ? 1 : 0, now, result.error, JSON.stringify(result.summary), now, id);
}

/**
 * At startup no check can be running. A site still marked "checking" was interrupted (the app was closed
 * or crashed during a check): show that, so the user can check again right away.
 */
export function resetInterruptedSiteChecks(): number {
  return db.prepare("UPDATE site_sources SET status = 'error', last_error = ?, updated_at = ? WHERE status = 'checking'")
    .run('前回の確認が途中で中断されました（アプリの終了など）。もう一度確認してください', new Date().toISOString()).changes;
}

export function markSiteChecking(id: string): void {
  db.prepare("UPDATE site_sources SET status = 'checking', updated_at = ? WHERE id = ?").run(new Date().toISOString(), id);
}

/** Collected articles of a site that the user has not saved as a card (the only ones that may be removed). */
export function unsavedSiteArticleIds(siteId: string): string[] {
  const savedUrls = new Set((db.prepare('SELECT url FROM cards WHERE url IS NOT NULL').all() as Array<{url: string}>).map(row => articleIdentityKey(row.url)));
  return (db.prepare(`SELECT DISTINCT a.id, a.url FROM articles a JOIN site_articles sa ON sa.article_id=a.id WHERE sa.site_id = ? AND a.saved_card_id IS NULL
    AND COALESCE(a.candidate_status, 'unreviewed') != 'saved_as_card'
    AND NOT EXISTS (SELECT 1 FROM article_sources s WHERE s.article_id=a.id AND s.source != ?)
    AND NOT EXISTS (SELECT 1 FROM cards c WHERE c.url = a.url)`).all(siteId, siteSourceTag(siteId)) as Array<{ id: string; url: string }>).filter(row => !savedUrls.has(articleIdentityKey(row.url))).map(row => row.id);
}

/**
 * Unregister a site. Cards, memos, quotes and tags are never touched. The site's collected
 * articles stay unless the user chose to remove the ones not saved as cards.
 */
export function deleteSite(id: string, options: { removeUnsavedArticles?: boolean } = {}): { deleted: boolean; removedArticles: number } {
  return db.transaction(() => {
    let removedArticles = 0;
    if (options.removeUnsavedArticles) {
      const remove = db.prepare('DELETE FROM articles WHERE id = ?');
      for (const articleId of unsavedSiteArticleIds(id)) removedArticles += remove.run(articleId).changes;
    }
    const deleted = db.prepare('DELETE FROM site_sources WHERE id = ?').run(id).changes > 0;
    db.prepare('DELETE FROM collector_settings WHERE key = ?').run(`sitemap_older_offset:${id}`);
    db.prepare('DELETE FROM article_sources WHERE source = ?').run(siteSourceTag(id));
    db.prepare(`UPDATE articles SET source=COALESCE((SELECT source FROM article_sources WHERE article_id=articles.id ORDER BY source LIMIT 1), 'unknown') WHERE source=?`).run(siteSourceTag(id));
    db.prepare(`INSERT INTO article_sources(article_id,source,first_seen_at,last_seen_at)
      SELECT id,'unknown',COALESCE(first_seen_at,created_at),COALESCE(last_fetched_at,updated_at) FROM articles a
      WHERE NOT EXISTS (SELECT 1 FROM article_sources s WHERE s.article_id=a.id)`).run();
    return { deleted, removedArticles };
  })();
}

/** active | missing (not in the site's list any more) | gone (404/410 twice) | restricted (401/403) | error (temporary failure) */
export type ArticleState = 'active' | 'missing' | 'gone' | 'restricted' | 'error';

export type KnownArticle = {
  key: string; articleId: string; url: string; lastmod: string | null; externalId: string | null; state: ArticleState;
  etag: string | null; lastModified: string | null; failCount: number; missingSince: string | null; hasBody: boolean;
};

type KnownRow = { article_key: string; article_id: string; url: string; lastmod: string | null; external_id: string | null; state: ArticleState; etag: string | null; last_modified: string | null; fail_count: number; missing_since: string | null; has_body: number };

export function knownSiteArticles(siteId: string): Map<string, KnownArticle> {
  const rows = db.prepare('SELECT article_key, article_id, url, lastmod, external_id, state, etag, last_modified, fail_count, missing_since, has_body FROM site_articles WHERE site_id = ?').all(siteId) as KnownRow[];
  return new Map(rows.map(row => [row.article_key, {
    key: row.article_key, articleId: row.article_id, url: row.url, lastmod: row.lastmod, externalId: row.external_id, state: row.state ?? 'active',
    etag: row.etag, lastModified: row.last_modified, failCount: row.fail_count ?? 0, missingSince: row.missing_since, hasBody: !!row.has_body,
  }]));
}

/** After a check of the site's list: what was listed is active again; what was not is "missing" (never deleted). */
export function markListed(siteId: string, listedKeys: Set<string>, listComplete: boolean): void {
  const now = new Date().toISOString();
  const rows = db.prepare('SELECT article_key, state FROM site_articles WHERE site_id = ?').all(siteId) as Array<{ article_key: string; state: ArticleState }>;
  const seen = db.prepare("UPDATE site_articles SET last_seen_at = ?, missing_since = NULL, state = CASE WHEN state = 'missing' THEN 'active' ELSE state END WHERE site_id = ? AND article_key = ?");
  const missing = db.prepare("UPDATE site_articles SET missing_since = COALESCE(missing_since, ?), state = CASE WHEN state = 'active' THEN 'missing' ELSE state END WHERE site_id = ? AND article_key = ?");
  db.transaction(() => {
    for (const row of rows) {
      if (listedKeys.has(row.article_key)) seen.run(now, siteId, row.article_key);
      else if (listComplete) missing.run(now, siteId, row.article_key);
    }
  })();
}

export function recordArticleCheck(siteId: string, key: string, check: { state: ArticleState; httpStatus: number | null; etag?: string | null; lastModified?: string | null; failCount: number }): void {
  db.prepare(`UPDATE site_articles SET state = ?, http_status = ?, etag = COALESCE(?, etag), last_modified = COALESCE(?, last_modified), fail_count = ?, last_fetched_at = ? WHERE site_id = ? AND article_key = ?`)
    .run(check.state, check.httpStatus, check.etag ?? null, check.lastModified ?? null, check.failCount, new Date().toISOString(), siteId, key);
}

/** The article's URL changed (same id at the source): move the record to the new key. */
export function moveSiteArticle(siteId: string, oldKey: string, newKey: string, newUrl: string): void {
  db.prepare('UPDATE OR IGNORE site_articles SET article_key = ?, url = ? WHERE site_id = ? AND article_key = ?').run(newKey, newUrl, siteId, oldKey);
}

/** Availability of collected articles, for search results (only those not "active"). */
export function articleAvailability(articleIds: string[]): Map<string, { state: ArticleState; httpStatus: number | null; since: string | null }> {
  const out = new Map<string, { state: ArticleState; httpStatus: number | null; since: string | null }>();
  if (!articleIds.length) return out;
  const query = db.prepare("SELECT article_id, state, http_status, COALESCE(missing_since, last_fetched_at) AS since FROM site_articles WHERE article_id = ? AND state != 'active' AND NOT EXISTS (SELECT 1 FROM site_articles active WHERE active.article_id=site_articles.article_id AND active.state='active')");
  for (const id of articleIds) {
    const row = query.get(id) as { article_id: string; state: ArticleState; http_status: number | null; since: string | null } | undefined;
    if (row) out.set(id, { state: row.state, httpStatus: row.http_status, since: row.since });
  }
  return out;
}

export function recordSiteArticles(siteId: string, items: Array<{ key: string; articleId: string; url: string; lastmod: string | null; hasBody: boolean; externalId?: string | null; etag?: string | null; lastModified?: string | null; contentHash?: string | null }>): void {
  const now = new Date().toISOString();
  const upsert = db.prepare(`INSERT INTO site_articles (site_id, article_key, article_id, url, lastmod, has_body, external_id, etag, last_modified, content_hash, state, last_seen_at, last_fetched_at, first_seen_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)
    ON CONFLICT(site_id, article_key) DO UPDATE SET article_id=excluded.article_id, lastmod = excluded.lastmod, url = excluded.url, has_body = MAX(has_body, excluded.has_body),
      external_id = COALESCE(excluded.external_id, external_id), etag = COALESCE(excluded.etag, etag), last_modified = COALESCE(excluded.last_modified, last_modified),
      content_hash = COALESCE(excluded.content_hash, content_hash), state = 'active', fail_count = 0, missing_since = NULL, last_seen_at = excluded.last_seen_at, last_fetched_at = excluded.last_fetched_at`);
  db.transaction(() => { for (const item of items) upsert.run(siteId, item.key, item.articleId, item.url, item.lastmod, item.hasBody ? 1 : 0, item.externalId ?? null, item.etag ?? null, item.lastModified ?? null, item.contentHash ?? null, now, now, now); })();
}

export type SiteCounts = { articles: number; withBody: number; missing: number; gone: number; restricted: number; error: number };

export function siteArticleCounts(): Map<string, SiteCounts> {
  const rows = db.prepare(`SELECT site_id, COUNT(DISTINCT article_id) AS articles, COUNT(DISTINCT CASE WHEN has_body=1 THEN article_id END) AS with_body,
      SUM(CASE WHEN state = 'missing' THEN 1 ELSE 0 END) AS missing, SUM(CASE WHEN state = 'gone' THEN 1 ELSE 0 END) AS gone,
      SUM(CASE WHEN state = 'restricted' THEN 1 ELSE 0 END) AS restricted, SUM(CASE WHEN state = 'error' THEN 1 ELSE 0 END) AS error
    FROM site_articles GROUP BY site_id`).all() as Array<{ site_id: string; articles: number; with_body: number; missing: number; gone: number; restricted: number; error: number }>;
  return new Map(rows.map(row => [row.site_id, { articles: row.articles, withBody: row.with_body ?? 0, missing: row.missing ?? 0, gone: row.gone ?? 0, restricted: row.restricted ?? 0, error: row.error ?? 0 }]));
}

/** The registered site whose scope contains this URL, if any. */
export function findSiteForUrl(url: string, accepts: (url: string, site: SiteSource) => boolean): SiteSource | null {
  return listSites().find(site => accepts(url, site)) ?? null;
}

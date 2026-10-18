import type Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { articleIdentityKey } from '../services/article_identity.js';

export function migrateSiteIntegration(db: Database.Database): void {
  if (!(db.prepare('PRAGMA table_info(articles)').all()).length) return;
  db.exec(`
    ALTER TABLE articles ADD COLUMN body_kind TEXT NOT NULL DEFAULT 'excerpt' CHECK(body_kind IN ('excerpt','fulltext'));
    ALTER TABLE articles ADD COLUMN source_updated_at TEXT;
    CREATE TABLE article_sources (
      article_id TEXT NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
      source TEXT NOT NULL, first_seen_at TEXT NOT NULL, last_seen_at TEXT NOT NULL,
      PRIMARY KEY(article_id,source)
    );
    CREATE INDEX idx_article_sources_source ON article_sources(source, article_id);
    CREATE TABLE site_article_repairs (
      id INTEGER PRIMARY KEY, site_id TEXT NOT NULL, article_key TEXT NOT NULL,
      old_article_id TEXT NOT NULL, resolved_article_id TEXT, reason TEXT NOT NULL,
      row_json TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE site_articles_integrated (
      site_id TEXT NOT NULL REFERENCES site_sources(id) ON DELETE CASCADE,
      article_key TEXT NOT NULL,
      article_id TEXT NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
      url TEXT NOT NULL, lastmod TEXT, has_body INTEGER NOT NULL DEFAULT 0,
      first_seen_at TEXT NOT NULL, external_id TEXT, state TEXT NOT NULL DEFAULT 'active',
      etag TEXT, last_modified TEXT, http_status INTEGER, fail_count INTEGER NOT NULL DEFAULT 0,
      missing_since TEXT, last_seen_at TEXT, last_fetched_at TEXT, content_hash TEXT,
      PRIMARY KEY(site_id,article_key)
    );
  `);
  const now = new Date().toISOString();
  const articles = db.prepare('SELECT id,url,title,body,source,created_at,last_fetched_at FROM articles').all() as Array<{id: string; url: string; title: string; body: string; source: string | null; created_at: string; last_fetched_at: string | null}>;
  const byId = new Map(articles.map(row => [row.id, row]));
  const byKey = new Map<string, string[]>();
  const normalize = db.prepare('UPDATE articles SET normalized_url=? WHERE id=?');
  for (const row of articles) {
    if (!row.url) continue;
    let key: string;
    try { key = articleIdentityKey(row.url); } catch { continue; }
    normalize.run(key, row.id);
    byKey.set(key, [...(byKey.get(key) ?? []), row.id]);
  }
  const record = db.prepare('INSERT INTO site_article_repairs(site_id,article_key,old_article_id,resolved_article_id,reason,row_json,created_at) VALUES (?,?,?,?,?,?,?)');
  const rows = db.prepare('SELECT * FROM site_articles').all() as Array<Record<string, any>>;
  const insert = db.prepare(`INSERT INTO site_articles_integrated(site_id,article_key,article_id,url,lastmod,has_body,first_seen_at,external_id,state,etag,last_modified,http_status,fail_count,missing_since,last_seen_at,last_fetched_at,content_hash)
    VALUES (@site_id,@article_key,@article_id,@url,@lastmod,@has_body,@first_seen_at,@external_id,@state,@etag,@last_modified,@http_status,@fail_count,@missing_since,@last_seen_at,@last_fetched_at,@content_hash)`);
  for (const row of rows) {
    let id: string | undefined = byId.has(row.article_id) ? row.article_id : undefined;
    let reason = '';
    if (!id) {
      const alias = db.prepare('SELECT article_id FROM article_aliases WHERE alias_id=?').get(row.article_id) as {article_id: string} | undefined;
      if (alias && byId.has(alias.article_id)) { id = alias.article_id; reason = 'resolved_alias'; }
      else {
        let candidates: string[] = [];
        try { candidates = byKey.get(articleIdentityKey(row.url)) ?? []; } catch { /* Quarantine invalid URLs. */ }
        if (candidates.length === 1) { id = candidates[0]; reason = 'resolved_url'; }
        else reason = candidates.length > 1 ? 'ambiguous_url' : 'unresolved_article';
      }
    }
    if (!db.prepare('SELECT 1 FROM site_sources WHERE id=?').get(row.site_id)) { id = undefined; reason = 'missing_site'; }
    if (reason) record.run(row.site_id, row.article_key, row.article_id, id ?? null, reason, JSON.stringify(row), now);
    if (!id) continue;
    insert.run({ ...row, article_id: id });
    const article = byId.get(id)!;
    const expectedHash = createHash('sha1').update(`${article.title}\n${article.body}`).digest('hex').slice(0, 16);
    if (row.has_body && (row.content_hash === expectedHash || (!row.content_hash && article.source === `site:${row.site_id}`))) {
      db.prepare("UPDATE articles SET body_kind='fulltext',source_updated_at=? WHERE id=?").run(row.lastmod ?? null, id);
    }
  }
  db.exec(`
    DROP TABLE site_articles;
    ALTER TABLE site_articles_integrated RENAME TO site_articles;
    CREATE INDEX idx_site_articles_article ON site_articles(article_id);
    CREATE INDEX idx_site_articles_external ON site_articles(site_id,external_id);
    INSERT OR IGNORE INTO article_sources(article_id,source,first_seen_at,last_seen_at)
      SELECT id,COALESCE(NULLIF(source,''),'unknown'),COALESCE(first_seen_at,created_at),COALESCE(last_fetched_at,updated_at) FROM articles;
    INSERT OR IGNORE INTO article_sources(article_id,source,first_seen_at,last_seen_at)
      SELECT article_id,'site:'||site_id,first_seen_at,COALESCE(last_fetched_at,first_seen_at) FROM site_articles;
  `);
}

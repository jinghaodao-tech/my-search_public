import crypto from "node:crypto";
import type { Article } from "../bm25_engine.js";
import { db } from "../db/database.js";
import { buildStoredTokenSet } from '../bm25_engine.js';
import { articleIdentityKey, stableArticleId } from '../services/article_identity.js';

export interface ArticleRow {
  id: string;
  title: string;
  body: string;
  url: string;
  source: string | null;
  source_authority: number;
  published_at: string | null;
  summary: string | null;
  tags_json: string;
  tokens_json: string | null;
  doc_length: number;
  morphological_tokens_json: string | null;
  ngram_tokens_json: string | null;
  morphological_doc_length: number;
  ngram_doc_length: number;
  content_hash: string | null;
  created_at: string;
  first_seen_at: string | null;
  updated_at: string;
  last_fetched_at: string | null;
}

export interface ArticleStats {
  rss: number;
  arxiv: number;
  github: number;
  total: number;
  fetchedAt: string;
}

export interface ArticleSaveResult {
  inserted: number;
  updated: number;
  skippedDuplicateUrls: number;
  canonicalIds: Record<string, string>;
}

function jsonArray(value: unknown): string {
  return JSON.stringify(Array.isArray(value) ? value : []);
}

export function articleContentHash(article: Pick<Article, "title" | "body">): string {
  return crypto
    .createHash("sha256")
    .update(article.title ?? "")
    .update("\0")
    .update(article.body ?? "")
    .digest("hex");
}

function parseJsonArray(value: string | null | undefined): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function inferSource(article: Partial<Article> & { source?: string | null }): string | null {
  if (article.source) return article.source;
  if (article.id?.startsWith("rss_")) return "rss";
  if (article.id?.startsWith("arxiv_")) return "arxiv";
  if (article.id?.startsWith("github_")) return "github";
  return null;
}

function rowToArticle(row: ArticleRow, sources?: string[]): Article & { source?: string | null; lastFetchedAt?: string | null } {
  const reader = row as ArticleRow & { reader_body?: string; reader_tokens?: string; reader_morphological?: string; reader_hash?: string };
  const hasReader = reader.reader_body !== undefined && reader.reader_body !== null;
  const validReaderCache = hasReader && reader.reader_hash === articleContentHash({ title: row.title, body: reader.reader_body! });
  const ngrams = parseJsonArray(hasReader ? validReaderCache ? reader.reader_tokens : null : row.ngram_tokens_json ?? row.tokens_json);
  const morphological = parseJsonArray(hasReader ? validReaderCache ? reader.reader_morphological : null : row.morphological_tokens_json);
  return {
    id: row.id,
    title: row.title,
    body: reader.reader_body ?? row.body,
    publishedAt: row.published_at ? new Date(row.published_at) : new Date(row.created_at),
    publicationDateKnown: !!row.published_at,
    sourceAuthority: row.source_authority,
    url: row.url,
    tokens: ngrams,
    docLength: ngrams.length,
    morphologicalTokens: morphological,
    ngramTokens: ngrams,
    morphologicalDocLength: morphological.length,
    ngramDocLength: ngrams.length,
    summary: row.summary ?? undefined,
    tags: parseJsonArray(row.tags_json),
    source: row.source,
    sources: sources ?? (db.prepare('SELECT source FROM article_sources WHERE article_id = ? ORDER BY source').all(row.id) as Array<{source: string}>).map(item => item.source),
    createdAt: row.created_at,
    firstSeenAt: row.first_seen_at ?? row.created_at,
    updatedAt: row.updated_at,
    lastFetchedAt: row.last_fetched_at,
  };
}

export function loadArticlesFromDb(): Article[] {
  const rows = db.prepare(`
    SELECT articles.*, article_reader_content.body AS reader_body,
      article_reader_content.tokens_json AS reader_tokens, article_reader_content.morphological_tokens_json AS reader_morphological,
      article_reader_content.content_hash AS reader_hash
    FROM articles LEFT JOIN article_reader_content ON articles.id = article_reader_content.article_id
    ORDER BY published_at DESC, updated_at DESC
  `).all() as ArticleRow[];
  const sources = new Map<string, string[]>();
  for (const row of db.prepare('SELECT article_id,source FROM article_sources ORDER BY source').all() as Array<{article_id: string; source: string}>) {
    const list = sources.get(row.article_id) ?? [];
    list.push(row.source);
    sources.set(row.article_id, list);
  }
  return rows.map(row => rowToArticle(row, sources.get(row.id) ?? []));
}

export function getArticleById(id: string): Article | null {
  const row = db.prepare(`SELECT articles.*, r.body AS reader_body,
    r.tokens_json AS reader_tokens, r.morphological_tokens_json AS reader_morphological, r.content_hash AS reader_hash
    FROM articles LEFT JOIN article_reader_content r ON r.article_id = articles.id
    WHERE articles.id = COALESCE((SELECT article_id FROM article_aliases WHERE alias_id = ?), ?)`)
    .get(id, id) as ArticleRow | undefined;
  return row ? rowToArticle(row) : null;
}

export function getArticleByUrl(url: string): Article | null {
  if (!url) return null;
  const key = articleIdentityKey(url);
  const row = db.prepare('SELECT id FROM articles WHERE url = ? OR normalized_url = ? ORDER BY CASE WHEN url=? THEN 0 ELSE 1 END, created_at LIMIT 1').get(url, key, url) as { id: string } | undefined;
  if (row) return getArticleById(row.id);
  const legacy = (db.prepare('SELECT id, url FROM articles WHERE normalized_url IS NULL').all() as Array<{id: string; url: string}>).find(item => articleIdentityKey(item.url) === key);
  return legacy ? getArticleById(legacy.id) : null;
}

export async function prepareReaderContent(url: string | null, body: string) {
  if (!url || !body) return null;
  const article = getArticleByUrl(url);
  if (!article) return null;
  const content = { title: article.title, body };
  const hash = articleContentHash(content);
  const cached = db.prepare('SELECT content_hash FROM article_reader_content WHERE article_id = ?').get(article.id) as {content_hash: string | null} | undefined;
  if (cached?.content_hash === hash) return { articleId: article.id, body, hash, tokens: null };
  return { articleId: article.id, body, hash, tokens: await buildStoredTokenSet(`${article.title} ${body}`) };
}

export function storeReaderContent(content: Awaited<ReturnType<typeof prepareReaderContent>>, fetchedAt: string): void {
  if (!content) return;
  if (!content.tokens) return;
  db.prepare(`INSERT INTO article_reader_content(article_id, body, fetched_at, tokens_json, morphological_tokens_json, content_hash)
    VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(article_id) DO UPDATE SET
    body=excluded.body, fetched_at=excluded.fetched_at, tokens_json=excluded.tokens_json,
    morphological_tokens_json=excluded.morphological_tokens_json, content_hash=excluded.content_hash`)
    .run(content.articleId, content.body, fetchedAt, JSON.stringify(content.tokens.ngramTokens), JSON.stringify(content.tokens.morphologicalTokens), content.hash);
}

export function findArticleTokenCache(article: Article): Pick<Article, "tokens" | "docLength" | "morphologicalTokens" | "ngramTokens" | "morphologicalDocLength" | "ngramDocLength"> | null {
  const hash = articleContentHash(article);
  const row = db.prepare(`
    SELECT tokens_json, doc_length, morphological_tokens_json, ngram_tokens_json, morphological_doc_length, ngram_doc_length, content_hash
    FROM articles
    WHERE id = ? OR url = ?
    ORDER BY CASE WHEN id = ? THEN 0 ELSE 1 END
    LIMIT 1
  `).get(article.id, article.url, article.id) as Pick<ArticleRow, "tokens_json" | "doc_length" | "morphological_tokens_json" | "ngram_tokens_json" | "morphological_doc_length" | "ngram_doc_length" | "content_hash"> | undefined;

  if (!row || row.content_hash !== hash) return null;
  const tokens = parseJsonArray(row.tokens_json);
  if (!tokens.length) return null;
  const storedNgramTokens = parseJsonArray(row.ngram_tokens_json);
  const ngramTokens = storedNgramTokens.length ? storedNgramTokens : tokens;
  const morphologicalTokens = parseJsonArray(row.morphological_tokens_json);
  return { tokens: ngramTokens, docLength: row.ngram_doc_length || row.doc_length || ngramTokens.length, ngramTokens, morphologicalTokens: morphologicalTokens.length ? morphologicalTokens : tokens, ngramDocLength: row.ngram_doc_length || ngramTokens.length, morphologicalDocLength: row.morphological_doc_length || morphologicalTokens.length || tokens.length };
}

export function reuseArticleTokenCache(articles: Article[]): Article[] {
  return articles.map((article) => {
    if (Array.isArray(article.morphologicalTokens) && article.morphologicalTokens.length > 0 && Array.isArray(article.ngramTokens) && article.ngramTokens.length > 0) return article;
    const cache = findArticleTokenCache(article);
    return cache ? { ...article, ...cache } : article;
  });
}

export function saveArticlesToDb(articles: Article[], fetchedAt = new Date().toISOString()): ArticleSaveResult {
  const existingById = db.prepare("SELECT id, url FROM articles WHERE id = ?");
  const upsert = db.prepare(`
    INSERT INTO articles (
      id,
      title,
      body,
      url,
      source,
      source_authority,
      published_at,
      summary,
      tags_json,
      tokens_json,
      doc_length,
      morphological_tokens_json,
      ngram_tokens_json,
      morphological_doc_length,
      ngram_doc_length,
      content_hash,
      created_at,
      first_seen_at,
      updated_at,
      last_fetched_at, body_kind, source_updated_at
    )
    VALUES (
      @id,
      @title,
      @body,
      @url,
      @source,
      @source_authority,
      @published_at,
      @summary,
      @tags_json,
      @tokens_json,
      @doc_length,
      @morphological_tokens_json,
      @ngram_tokens_json,
      @morphological_doc_length,
      @ngram_doc_length,
      @content_hash,
      @created_at,
      @first_seen_at,
      @updated_at,
      @last_fetched_at, @body_kind, @source_updated_at
    )
    ON CONFLICT(id) DO UPDATE SET
      title = excluded.title,
      body = excluded.body,
      url = excluded.url,
      source = COALESCE(articles.source, excluded.source),
      source_authority = excluded.source_authority,
      published_at = COALESCE(excluded.published_at, articles.published_at),
      summary = excluded.summary,
      tags_json = excluded.tags_json,
      tokens_json = excluded.tokens_json,
      doc_length = excluded.doc_length,
      morphological_tokens_json = excluded.morphological_tokens_json,
      ngram_tokens_json = excluded.ngram_tokens_json,
      morphological_doc_length = excluded.morphological_doc_length,
      ngram_doc_length = excluded.ngram_doc_length,
      content_hash = excluded.content_hash,
      updated_at = excluded.updated_at,
      last_fetched_at = excluded.last_fetched_at,
      body_kind = excluded.body_kind, source_updated_at = excluded.source_updated_at
  `);

  let inserted = 0;
  let updated = 0;
  let skippedDuplicateUrls = 0;
  const canonicalIds: Record<string, string> = Object.create(null);

  const tx = db.transaction((items: Article[]) => {
    const seenUrls = new Set<string>();
    for (const article of items) {
      const originalId = article.id;
      const normalizedUrl = articleIdentityKey(article.url ?? '');
      const repeated = normalizedUrl && seenUrls.has(normalizedUrl);
      if (normalizedUrl) seenUrls.add(normalizedUrl);
      const duplicateUrl = article.url ? getArticleByUrl(article.url) : null;
      const byId = existingById.get(article.id) as {id: string; url: string} | undefined;
      const alias = db.prepare('SELECT article_id FROM article_aliases WHERE alias_id = ?').get(article.id) as {article_id: string} | undefined;
      let id = duplicateUrl?.id ?? alias?.article_id ?? article.id;
      if (!duplicateUrl && byId && /^(rss|arxiv)_/.test(article.id) && !/_[a-f0-9]{32}$/.test(article.id) && articleIdentityKey(byId.url) !== normalizedUrl) {
        id = stableArticleId('article', `${article.id}\0${normalizedUrl}`);
      }
      const existingId = existingById.get(id);
      canonicalIds[originalId] = id;
      const stored = db.prepare(`SELECT title,body,summary,source_authority,tags_json,tokens_json,doc_length,morphological_tokens_json,ngram_tokens_json,
        morphological_doc_length,ngram_doc_length,content_hash,body_kind,source_updated_at FROM articles WHERE id = ?`).get(id) as (ArticleRow & {body_kind: string; source_updated_at: string | null}) | undefined;
      const incomingKind = article.bodyKind ?? 'excerpt';
      const keepText = stored && ((stored.body_kind === 'fulltext' && incomingKind !== 'fulltext') ||
        (stored.body_kind === 'fulltext' && incomingKind === 'fulltext' && stored.source_updated_at && article.sourceUpdatedAt && Date.parse(article.sourceUpdatedAt) < Date.parse(stored.source_updated_at)) ||
        (repeated && !(stored.body_kind !== 'fulltext' && incomingKind === 'fulltext')));
      if (repeated) skippedDuplicateUrls += 1;

      const now = new Date().toISOString();
      upsert.run({
        id,
        title: keepText ? stored.title : article.title,
        body: keepText ? stored.body : article.body ?? "",
        url: article.url ?? "",
        source: inferSource(article),
        source_authority: keepText ? stored.source_authority : article.sourceAuthority ?? 0,
        published_at: article.publicationDateKnown !== false && article.publishedAt && Number.isFinite(new Date(article.publishedAt).getTime()) ? new Date(article.publishedAt).toISOString() : null,
        summary: keepText ? stored.summary : article.summary ?? null,
        tags_json: keepText ? stored.tags_json : jsonArray(article.tags),
        tokens_json: keepText ? stored.tokens_json : jsonArray(article.tokens),
        doc_length: keepText ? stored.doc_length : article.docLength ?? article.tokens?.length ?? 0,
        morphological_tokens_json: keepText ? stored.morphological_tokens_json : jsonArray(article.morphologicalTokens ?? article.tokens),
        ngram_tokens_json: keepText ? stored.ngram_tokens_json : jsonArray(article.ngramTokens ?? article.tokens),
        morphological_doc_length: keepText ? stored.morphological_doc_length : article.morphologicalDocLength ?? article.tokens?.length ?? 0,
        ngram_doc_length: keepText ? stored.ngram_doc_length : article.ngramDocLength ?? article.docLength ?? article.tokens?.length ?? 0,
        content_hash: keepText ? stored.content_hash : articleContentHash(article),
        body_kind: keepText ? stored.body_kind : incomingKind,
        source_updated_at: keepText ? stored.source_updated_at : article.sourceUpdatedAt ?? null,
        created_at: existingId ? now : article.createdAt ?? now,
        first_seen_at: existingId ? null : article.firstSeenAt ?? article.createdAt ?? now,
        updated_at: now,
        last_fetched_at: fetchedAt,
      });

      db.prepare('UPDATE articles SET normalized_url = ? WHERE id = ?').run(normalizedUrl, id);
      const source = inferSource(article) ?? 'unknown';
      db.prepare(`INSERT INTO article_sources(article_id, source, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?)
        ON CONFLICT(article_id, source) DO UPDATE SET last_seen_at=excluded.last_seen_at`).run(id, source, fetchedAt, fetchedAt);
      // Never redirect a legacy ID already belonging to another article.
      if (originalId !== id && !byId) db.prepare('INSERT OR IGNORE INTO article_aliases(alias_id, article_id) VALUES (?, ?)').run(originalId, id);
      const reader = db.prepare('SELECT body FROM article_reader_content WHERE article_id = ?').get(id) as {body: string} | undefined;
      if (reader) db.prepare('UPDATE article_reader_content SET tokens_json = NULL, morphological_tokens_json = NULL, content_hash = NULL WHERE article_id = ? AND content_hash <> ?').run(id, articleContentHash({ title: keepText ? stored.title : article.title, body: reader.body }));

      if (repeated) continue;
      if (existingId) updated += 1;
      else inserted += 1;
    }
  });

  tx(articles);
  return { inserted, updated, skippedDuplicateUrls, canonicalIds };
}

export function loadArticleStats(): ArticleStats | null {
  const rows = db.prepare(`
    SELECT source, COUNT(*) AS count
    FROM article_sources
    GROUP BY source
  `).all() as Array<{ source: string | null; count: number }>;
  const total = (db.prepare('SELECT COUNT(*) AS count FROM articles').get() as {count: number}).count;
  if (!total) return null;

  const last = db.prepare(`
    SELECT MAX(last_fetched_at) AS fetchedAt
    FROM articles
  `).get() as { fetchedAt: string | null };

  const countFor = (source: string) => (db.prepare('SELECT COUNT(DISTINCT article_id) AS count FROM article_sources WHERE source = ? OR source LIKE ?').get(source, `${source}:%`) as {count: number}).count;

  return {
    rss: countFor("rss"),
    arxiv: countFor("arxiv"),
    github: countFor("github"),
    total,
    fetchedAt: last.fetchedAt ?? new Date(0).toISOString(),
  };
}

export function deleteArticle(id: string): boolean {
  const result = db.prepare("DELETE FROM articles WHERE id = ?").run(id);
  return result.changes > 0;
}

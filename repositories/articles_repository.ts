import crypto from "node:crypto";
import type { Article } from "../bm25_engine.js";
import { db } from "../db/database.js";

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

function rowToArticle(row: ArticleRow): Article & { source?: string | null; lastFetchedAt?: string | null } {
  return {
    id: row.id,
    title: row.title,
    body: row.body,
    publishedAt: row.published_at ? new Date(row.published_at) : new Date(row.created_at),
    sourceAuthority: row.source_authority,
    url: row.url,
    tokens: parseJsonArray(row.tokens_json),
    docLength: row.doc_length,
    morphologicalTokens: parseJsonArray(row.morphological_tokens_json),
    ngramTokens: parseJsonArray(row.ngram_tokens_json),
    morphologicalDocLength: row.morphological_doc_length,
    ngramDocLength: row.ngram_doc_length,
    summary: row.summary ?? undefined,
    tags: parseJsonArray(row.tags_json),
    source: row.source,
    createdAt: row.created_at,
    firstSeenAt: row.first_seen_at ?? row.created_at,
    updatedAt: row.updated_at,
    lastFetchedAt: row.last_fetched_at,
  };
}

export function loadArticlesFromDb(): Article[] {
  const rows = db.prepare(`
    SELECT *
    FROM articles
    ORDER BY published_at DESC, updated_at DESC
  `).all() as ArticleRow[];
  return rows.map(rowToArticle);
}

export function getArticleById(id: string): Article | null {
  const row = db.prepare("SELECT * FROM articles WHERE id = ?").get(id) as ArticleRow | undefined;
  return row ? rowToArticle(row) : null;
}

export function getArticleByUrl(url: string): Article | null {
  const row = db.prepare("SELECT * FROM articles WHERE url = ?").get(url) as ArticleRow | undefined;
  return row ? rowToArticle(row) : null;
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
  const existingById = db.prepare("SELECT id FROM articles WHERE id = ?");
  const existingByUrl = db.prepare("SELECT id FROM articles WHERE url = ?");
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
      last_fetched_at
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
      @last_fetched_at
    )
    ON CONFLICT(id) DO UPDATE SET
      title = excluded.title,
      body = excluded.body,
      url = excluded.url,
      source = excluded.source,
      source_authority = excluded.source_authority,
      published_at = excluded.published_at,
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
      last_fetched_at = excluded.last_fetched_at
  `);

  let inserted = 0;
  let updated = 0;
  let skippedDuplicateUrls = 0;

  const tx = db.transaction((items: Article[]) => {
    for (const article of items) {
      const existingId = existingById.get(article.id) as { id: string } | undefined;
      const duplicateUrl = article.url
        ? existingByUrl.get(article.url) as { id: string } | undefined
        : undefined;
      if (duplicateUrl && duplicateUrl.id !== article.id) {
        skippedDuplicateUrls += 1;
        continue;
      }

      const now = new Date().toISOString();
      upsert.run({
        id: article.id,
        title: article.title,
        body: article.body ?? "",
        url: article.url ?? "",
        source: inferSource(article),
        source_authority: article.sourceAuthority ?? 0,
        published_at: article.publishedAt ? new Date(article.publishedAt).toISOString() : null,
        summary: article.summary ?? null,
        tags_json: jsonArray(article.tags),
        tokens_json: jsonArray(article.tokens),
        doc_length: article.docLength ?? article.tokens?.length ?? 0,
        morphological_tokens_json: jsonArray(article.morphologicalTokens ?? article.tokens),
        ngram_tokens_json: jsonArray(article.ngramTokens ?? article.tokens),
        morphological_doc_length: article.morphologicalDocLength ?? article.tokens?.length ?? 0,
        ngram_doc_length: article.ngramDocLength ?? article.docLength ?? article.tokens?.length ?? 0,
        content_hash: articleContentHash(article),
        created_at: existingId ? now : article.createdAt ?? now,
        first_seen_at: existingId ? null : article.firstSeenAt ?? article.createdAt ?? now,
        updated_at: now,
        last_fetched_at: fetchedAt,
      });

      if (existingId) updated += 1;
      else inserted += 1;
    }
  });

  tx(articles);
  return { inserted, updated, skippedDuplicateUrls };
}

export function loadArticleStats(): ArticleStats | null {
  const rows = db.prepare(`
    SELECT source, COUNT(*) AS count
    FROM articles
    GROUP BY source
  `).all() as Array<{ source: string | null; count: number }>;
  const total = rows.reduce((sum, row) => sum + row.count, 0);
  if (!total) return null;

  const last = db.prepare(`
    SELECT MAX(last_fetched_at) AS fetchedAt
    FROM articles
  `).get() as { fetchedAt: string | null };

  const countFor = (source: string) => rows
    .filter((row) => row.source === source || row.source?.startsWith(`${source}:`))
    .reduce((sum, row) => sum + row.count, 0);

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

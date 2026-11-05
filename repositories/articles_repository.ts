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

export type ArticleFtsRank = { id: string; morphRank: number | null; ngramRank: number | null; score?: number };
export type ArticleFtsSearchResult = { ranks: ArticleFtsRank[]; matchedCount: number; matchedCountIsLowerBound?: boolean };
export type ArticleFtsRrfRank = ArticleFtsRank & { rrfScore: number };
export type ArticleFtsRrfSearchResult = { ranks: ArticleFtsRrfRank[]; matchedCount: number; matchedCountIsLowerBound?: boolean };

function ftsMatchExpression(tokens: string[]): string | null {
  const unique = [...new Set(tokens.map(token => token.trim()).filter(Boolean))];
  return unique.length ? unique.map(token => `"${token.replace(/"/g, '""')}"`).join(' OR ') : null;
}

/** FTS lookup returns full modality ranks because omitted tail ranks still contribute to RRF scores. */
export function searchArticleIdsFts5(morphologicalTokens: string[], ngramTokens: string[], filters: ArticleSearchScopeFilters = {}): ArticleFtsSearchResult {
  const morphExpression = ftsMatchExpression(morphologicalTokens);
  const ngramExpression = ftsMatchExpression(ngramTokens);
  const ranks = new Map<string, ArticleFtsRank>();
  const conditions = ["COALESCE(a.candidate_status, 'unreviewed') != 'expired'"];
  const filterParams: string[] = [];
  if (filters.since) { conditions.push('a.first_seen_at > ?'); filterParams.push(filters.since); }
  if (filters.status && filters.status !== 'all') { conditions.push('a.candidate_status = ?'); filterParams.push(filters.status); }
  if (filters.sources?.length) {
    conditions.push(`EXISTS (SELECT 1 FROM article_sources selected WHERE selected.article_id=a.id AND selected.source IN (${filters.sources.map(() => '?').join(',')}))`);
    filterParams.push(...filters.sources);
  }
  const where = conditions.join(' AND ');
  if (morphExpression) {
    const rows = db.prepare(`SELECT articles_morph_fts.id, bm25(articles_morph_fts) AS score FROM articles_morph_fts JOIN articles a ON a.id=articles_morph_fts.id WHERE articles_morph_fts MATCH ? AND ${where} ORDER BY score, articles_morph_fts.id`).all(morphExpression, ...filterParams) as Array<{id: string; score: number}>;
    rows.forEach((row, index) => ranks.set(row.id, { id: row.id, morphRank: index + 1, ngramRank: null }));
  }
  if (ngramExpression) {
    const rows = db.prepare(`SELECT articles_ngram_fts.id, bm25(articles_ngram_fts) AS score FROM articles_ngram_fts JOIN articles a ON a.id=articles_ngram_fts.id WHERE articles_ngram_fts MATCH ? AND ${where} ORDER BY score, articles_ngram_fts.id`).all(ngramExpression, ...filterParams) as Array<{id: string; score: number}>;
    rows.forEach((row, index) => {
      const current = ranks.get(row.id) ?? { id: row.id, morphRank: null, ngramRank: null };
      current.ngramRank = index + 1;
      ranks.set(row.id, current);
    });
  }
  return {
    ranks: [...ranks.values()].sort((a, b) => Math.min(a.morphRank ?? Infinity, a.ngramRank ?? Infinity) - Math.min(b.morphRank ?? Infinity, b.ngramRank ?? Infinity)),
    matchedCount: ranks.size,
  };
}

/** Returns morphology top-K rows without scanning/counting the full FTS match set. */
export function searchArticleIdsFts5MorphologicalTopK(
  morphologicalTokens: string[],
  resultLimit: number,
  filters: ArticleSearchScopeFilters = {},
): ArticleFtsSearchResult {
  const expression = ftsMatchExpression(morphologicalTokens);
  if (!expression) return { ranks: [], matchedCount: 0 };

  const conditions = ["COALESCE(a.candidate_status, 'unreviewed') != 'expired'"];
  const filterParams: string[] = [];
  if (filters.since) { conditions.push('a.first_seen_at > ?'); filterParams.push(filters.since); }
  if (filters.status && filters.status !== 'all') { conditions.push('a.candidate_status = ?'); filterParams.push(filters.status); }
  if (filters.sources?.length) {
    conditions.push(`EXISTS (SELECT 1 FROM article_sources selected WHERE selected.article_id=a.id AND selected.source IN (${filters.sources.map(() => '?').join(',')}))`);
    filterParams.push(...filters.sources);
  }
  const limit = Math.max(1, Math.min(1000, Math.floor(resultLimit)));
  const canFilterStatusAfterTopK = !filters.since
    && (!filters.status || filters.status === 'all')
    && !filters.sources?.length;
  let fetchLimit = limit;
  let rows: Array<{id: string; score?: number}> = [];
  let hasMoreCandidates = false;
  while (true) {
    if (canFilterStatusAfterTopK) {
      const ftsRows = db.prepare(`
        SELECT id, -bm25(articles_morph_fts) AS score FROM articles_morph_fts
        WHERE articles_morph_fts MATCH ?
        ORDER BY bm25(articles_morph_fts), id
        LIMIT ?
      `).all(expression, fetchLimit) as Array<{id: string; score: number}>;
      hasMoreCandidates = ftsRows.length === fetchLimit;
      const statuses = ftsRows.length
        ? db.prepare(`SELECT id,candidate_status FROM articles WHERE id IN (${ftsRows.map(() => '?').join(',')})`)
          .all(...ftsRows.map(row => row.id)) as Array<{id: string; candidate_status: string | null}>
        : [];
      const statusById = new Map(statuses.map(row => [row.id, row.candidate_status ?? 'unreviewed']));
      rows = ftsRows.filter(row => statusById.get(row.id) !== 'expired');
      if (rows.length < limit && hasMoreCandidates) fetchLimit *= 2;
      else break;
    } else {
      const from = 'FROM articles_morph_fts JOIN articles a ON a.id=articles_morph_fts.id';
      const where = `WHERE articles_morph_fts MATCH ? AND ${conditions.join(' AND ')}`;
      rows = db.prepare(`
        SELECT articles_morph_fts.id, -bm25(articles_morph_fts) AS score
        ${from}
        ${where}
        ORDER BY score, articles_morph_fts.id
        LIMIT ?
      `).all(expression, ...filterParams, limit) as Array<{id: string}>;
      hasMoreCandidates = rows.length === limit;
      break;
    }
  }
  rows = rows.slice(0, limit);
  return {
    ranks: rows.map((row, index) => ({ id: row.id, morphRank: index + 1, ngramRank: null, ...(row.score === undefined ? {} : { score: row.score }) })),
    matchedCount: rows.length,
    matchedCountIsLowerBound: hasMoreCandidates || rows.length === limit,
  };
}

/** Computes complete modality ranks and exact RRF top-K inside SQLite. */
export function searchArticleIdsFts5Rrf(morphologicalTokens: string[], ngramTokens: string[], resultLimit: number, filters: ArticleSearchScopeFilters = {}): ArticleFtsRrfSearchResult {
  const morphExpression = ftsMatchExpression(morphologicalTokens);
  const ngramExpression = ftsMatchExpression(ngramTokens);
  const conditions = ["COALESCE(a.candidate_status, 'unreviewed') != 'expired'"];
  const filterParams: string[] = [];
  if (filters.since) { conditions.push('a.first_seen_at > ?'); filterParams.push(filters.since); }
  if (filters.status && filters.status !== 'all') { conditions.push('a.candidate_status = ?'); filterParams.push(filters.status); }
  if (filters.sources?.length) {
    conditions.push(`EXISTS (SELECT 1 FROM article_sources selected WHERE selected.article_id=a.id AND selected.source IN (${filters.sources.map(() => '?').join(',')}))`);
    filterParams.push(...filters.sources);
  }
  const where = conditions.join(' AND ');
  const morphSql = morphExpression
    ? `SELECT articles_morph_fts.id AS id, ROW_NUMBER() OVER (ORDER BY bm25(articles_morph_fts), articles_morph_fts.id) AS fts_rank
       FROM articles_morph_fts JOIN articles a ON a.id=articles_morph_fts.id
       WHERE articles_morph_fts MATCH ? AND ${where}`
    : 'SELECT NULL AS id, NULL AS fts_rank WHERE 0';
  const ngramSql = ngramExpression
    ? `SELECT articles_ngram_fts.id AS id, ROW_NUMBER() OVER (ORDER BY bm25(articles_ngram_fts), articles_ngram_fts.id) AS fts_rank
       FROM articles_ngram_fts JOIN articles a ON a.id=articles_ngram_fts.id
       WHERE articles_ngram_fts MATCH ? AND ${where}`
    : 'SELECT NULL AS id, NULL AS fts_rank WHERE 0';
  const params = [
    ...(morphExpression ? [morphExpression, ...filterParams] : []),
    ...(ngramExpression ? [ngramExpression, ...filterParams] : []),
    Math.max(1, Math.min(500, Math.floor(resultLimit))),
  ];
  const rows = db.prepare(`
    WITH morph AS MATERIALIZED (${morphSql}),
    ngram AS MATERIALIZED (${ngramSql}),
    ids AS MATERIALIZED (SELECT id FROM morph UNION SELECT id FROM ngram),
    fused AS (
      SELECT ids.id, morph.fts_rank AS morph_rank, ngram.fts_rank AS ngram_rank,
        COALESCE(1.0 / (60 + morph.fts_rank), 0) + COALESCE(1.0 / (60 + ngram.fts_rank), 0) AS rrf_score
      FROM ids LEFT JOIN morph ON morph.id=ids.id LEFT JOIN ngram ON ngram.id=ids.id
    )
    SELECT *, COUNT(*) OVER() AS matched_count FROM fused
    ORDER BY rrf_score DESC,
      MIN(COALESCE(morph_rank, 2147483647), COALESCE(ngram_rank, 2147483647)),
      CASE WHEN morph_rank IS NULL THEN 1 ELSE 0 END, morph_rank, ngram_rank, id
    LIMIT ?
  `).all(...params) as Array<{id:string; morph_rank:number | null; ngram_rank:number | null; rrf_score:number; matched_count:number}>;
  return {
    ranks: rows.map(row => ({ id: row.id, morphRank: row.morph_rank, ngramRank: row.ngram_rank, rrfScore: row.rrf_score })),
    matchedCount: rows[0]?.matched_count ?? 0,
  };
}

/** Loads bodies and token arrays only for FTS-matched documents. */
export function loadArticlesFromDbByIds(ids: string[]): Article[] {
  const unique = [...new Set(ids)];
  if (!unique.length) return [];
  const rows: ArticleRow[] = [];
  for (let offset = 0; offset < unique.length; offset += 400) {
    const batch = unique.slice(offset, offset + 400);
    rows.push(...db.prepare(`
      SELECT articles.*, article_reader_content.body AS reader_body,
        article_reader_content.tokens_json AS reader_tokens, article_reader_content.morphological_tokens_json AS reader_morphological,
        article_reader_content.content_hash AS reader_hash
      FROM articles LEFT JOIN article_reader_content ON articles.id = article_reader_content.article_id
      WHERE articles.id IN (${batch.map(() => '?').join(',')})
    `).all(...batch) as ArticleRow[]);
  }
  const sources = new Map<string, string[]>();
  const sourceRows = db.prepare(`SELECT article_id, source FROM article_sources WHERE article_id IN (${unique.map(() => '?').join(',')}) ORDER BY source`).all(...unique) as Array<{article_id: string; source: string}>;
  for (const row of sourceRows) (sources.get(row.article_id) ?? (sources.set(row.article_id, []), sources.get(row.article_id)!)).push(row.source);
  const byId = new Map(rows.map(row => [row.id, rowToArticle(row, sources.get(row.id) ?? [])]));
  return unique.map(id => byId.get(id)).filter((article): article is Article => !!article);
}

type ArticleSearchIndexStatus = { articles: number; morphologyRows: number; ngramRows: number; missingTokenRows: number };
let articleSearchIndexStatusCache: ArticleSearchIndexStatus | null = null;

export function invalidateArticleSearchIndexStatus(): void {
  articleSearchIndexStatusCache = null;
}

export function articleSearchIndexStatus(): ArticleSearchIndexStatus {
  if (articleSearchIndexStatusCache) return articleSearchIndexStatusCache;
  const articles = Number((db.prepare('SELECT COUNT(*) AS count FROM articles').get() as {count: number}).count);
  const morphologyRows = Number((db.prepare('SELECT COUNT(*) AS count FROM articles_morph_fts').get() as {count: number}).count);
  const ngramRows = Number((db.prepare('SELECT COUNT(*) AS count FROM articles_ngram_fts').get() as {count: number}).count);
  // An empty result from one tokenizer is valid when the other representation remains searchable.
  const missingTokenRows = Number((db.prepare("SELECT COUNT(*) AS count FROM articles WHERE COALESCE(morphological_tokens_json,'[]')='[]' AND COALESCE(ngram_tokens_json,tokens_json,'[]')='[]'").get() as {count: number}).count);
  articleSearchIndexStatusCache = { articles, morphologyRows, ngramRows, missingTokenRows };
  return articleSearchIndexStatusCache;
}

/** FTS is maintained by migrations and SQLite triggers; do not count millions of rows per request. */
export function articleSearchFtsAvailable(): boolean {
  const count = Number((db.prepare(`SELECT COUNT(*) AS count FROM sqlite_master
    WHERE type='table' AND name IN ('articles_morph_fts','articles_ngram_fts')`).get() as {count: number}).count);
  return count === 2;
}

export type ArticleSearchScopeFilters = { excludedTerms?: string[]; status?: string; since?: string | null; sources?: string[] };

/** Aggregate scope metadata in SQLite without materializing article bodies in Node. */
export function getArticleSearchScope(filters: ArticleSearchScopeFilters = {}) {
  const where = ["COALESCE(a.candidate_status, 'unreviewed') != 'expired'"];
  const params: string[] = [];
  if (filters.since) { where.push('a.first_seen_at > ?'); params.push(filters.since); }
  if (filters.status && filters.status !== 'all') { where.push('a.candidate_status = ?'); params.push(filters.status); }
  if (filters.sources?.length) {
    where.push(`EXISTS (SELECT 1 FROM article_sources selected WHERE selected.article_id=a.id AND selected.source IN (${filters.sources.map(() => '?').join(',')}))`);
    params.push(...filters.sources);
  }
  for (const term of filters.excludedTerms ?? []) {
    const normalized = term.normalize('NFKC').toLowerCase();
    if (normalized) { where.push("instr(lower(COALESCE(a.title,'') || ' ' || COALESCE(a.body,'') || ' ' || COALESCE(a.summary,'')), lower(?)) = 0"); params.push(normalized); }
  }
  const condition = where.join(' AND ');
  const totalCount = Number((db.prepare('SELECT COUNT(*) AS count FROM articles').get() as {count: number}).count);
  const searchedCount = Number((db.prepare(`SELECT COUNT(*) AS count FROM articles a WHERE ${condition}`).get(...params) as {count: number}).count);
  const all = db.prepare(`SELECT COALESCE(s.source, 'unknown') AS source, COUNT(DISTINCT a.id) AS count FROM articles a LEFT JOIN article_sources s ON s.article_id=a.id GROUP BY COALESCE(s.source, 'unknown')`).all() as Array<{source: string; count: number}>;
  const searched = db.prepare(`SELECT COALESCE(s.source, 'unknown') AS source, COUNT(DISTINCT a.id) AS count FROM articles a LEFT JOIN article_sources s ON s.article_id=a.id WHERE ${condition} GROUP BY COALESCE(s.source, 'unknown')`).all(...params) as Array<{source: string; count: number}>;
  const allCounts = new Map(all.map(row => [row.source, Number(row.count)]));
  const searchedCounts = new Map(searched.map(row => [row.source, Number(row.count)]));
  const sources = [...searchedCounts].filter(([, count]) => count > 0).map(([source]) => source);
  const availableSources = [...allCounts.keys()];
  const bySource: Record<string, {total: number; searched: number}> = {};
  for (const source of new Set([...allCounts.keys(), ...searchedCounts.keys()])) bySource[source] = {total: allCounts.get(source) ?? 0, searched: searchedCounts.get(source) ?? 0};
  return { totalCount, searchedCount, sources, availableSources, bySource };
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
  // the exact URL first, then the normalised one (two indexed lookups; an OR of the two scanned the table)
  const row = (db.prepare("SELECT id FROM articles WHERE url = ? AND url <> '' ORDER BY created_at LIMIT 1").get(url)
    ?? db.prepare('SELECT id FROM articles WHERE normalized_url = ? ORDER BY created_at LIMIT 1').get(key)) as { id: string } | undefined;
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
  // id first, then url: "id = ? OR url = ?" cannot use the indexes and scanned the whole table for every article
  const columns = 'tokens_json, doc_length, morphological_tokens_json, ngram_tokens_json, morphological_doc_length, ngram_doc_length, content_hash';
  const row = (db.prepare(`SELECT ${columns} FROM articles WHERE id = ?`).get(article.id)
    ?? (article.url ? db.prepare(`SELECT ${columns} FROM articles WHERE url = ? AND url <> ''`).get(article.url) : undefined)) as Pick<ArticleRow, "tokens_json" | "doc_length" | "morphological_tokens_json" | "ngram_tokens_json" | "morphological_doc_length" | "ngram_doc_length" | "content_hash"> | undefined;

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
  if (articles.length) invalidateArticleSearchIndexStatus();
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
  if (result.changes > 0) invalidateArticleSearchIndexStatus();
  return result.changes > 0;
}

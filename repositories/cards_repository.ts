/**
 * cards_engine.ts — カード管理エンジン
 * Zettelkasten / KJ法 / タグ / CSV取り込み / メモ機能
 */

import fs   from 'fs';
import { PROJECT_ROOT } from '../utils/project_root.js';
import path from 'path';
import { performance } from 'node:perf_hooks';
import { logger } from '../utils/logger.js';

const DATA_DIR   = path.join(PROJECT_ROOT, 'data');
const CARDS_FILE = path.join(DATA_DIR, 'cards.json');
const KJ_FILE    = process.env.KJ_FILE ?? path.join(DATA_DIR, 'kj_groups.json');

// ════════════════════════════════════════════════════
//  § 1. 型定義
// ════════════════════════════════════════════════════

import type { Card } from '../domain/card.js';

// ════════════════════════════════════════════════════
//  § 2. ストレージユーティリティ
// ════════════════════════════════════════════════════

function ensureDataDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

import { db } from '../db/database.js';
import { buildStoredTokenSet } from '../bm25_engine.js';

type CardRow = {
  id: string;
  title: string;
  body: string | null;
  summary: string | null;
  url: string | null;
  type: Card["type"] | null;
  color: string | null;
  tags_json: string | null;
  links_json: string | null;
  kj_group_id: string | null;
  archived: number | null;
  archived_at: string | null;
  tokens_json: string | null;
  doc_length: number | null;
  morphological_tokens_json: string | null;
  ngram_tokens_json: string | null;
  morphological_doc_length: number | null;
  ngram_doc_length: number | null;
  created_at: string;
  updated_at: string;
};

const CARD_COLUMNS = `
  id, title, body, summary, url, type, color, tags_json, links_json,
  kj_group_id, archived, archived_at, tokens_json, doc_length,
  morphological_tokens_json, ngram_tokens_json,
  morphological_doc_length, ngram_doc_length, created_at, updated_at
`;
const CARD_COLUMNS_WITH_TABLE = `
  cards.id, cards.title, cards.body, cards.summary, cards.url, cards.type, cards.color,
  cards.tags_json, cards.links_json, cards.kj_group_id, cards.archived, cards.archived_at,
  cards.tokens_json, cards.doc_length, cards.morphological_tokens_json, cards.ngram_tokens_json,
  cards.morphological_doc_length, cards.ngram_doc_length, cards.created_at, cards.updated_at
`;

function rowToCard(row: CardRow): Card {
  return {
    id: row.id,
    title: row.title,
    body: row.body ?? "",
    summary: row.summary ?? undefined,
    url: row.url ?? undefined,
    type: row.type ?? "memo",
    color: row.color ?? undefined,
    tags: JSON.parse(row.tags_json ?? "[]"),
    links: JSON.parse(row.links_json ?? "[]"),
    kjGroupId: row.kj_group_id ?? undefined,
    archived: Boolean(row.archived),
    archivedAt: row.archived_at ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    tokens: JSON.parse(row.tokens_json ?? "[]"),
    docLength: row.doc_length ?? 0,
    morphologicalTokens: JSON.parse(row.morphological_tokens_json ?? "[]"),
    ngramTokens: JSON.parse(row.ngram_tokens_json ?? row.tokens_json ?? "[]"),
    morphologicalDocLength: row.morphological_doc_length ?? 0,
    ngramDocLength: row.ngram_doc_length ?? row.doc_length ?? 0,
  };
}

function parseJsonArray(value: string | null): string[] {
  try {
    const parsed = JSON.parse(value ?? "[]");
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function placeholders(values: readonly unknown[]): string {
  return values.map(() => '?').join(', ');
}

function loadCardTagsMap(cardIds?: readonly string[]): Map<string, string[]> {
  if (cardIds && cardIds.length === 0) return new Map();
  const where = cardIds ? `WHERE card_id IN (${placeholders(cardIds)})` : '';
  const rows = db.prepare(`
    SELECT card_id, tag
    FROM card_tags
    ${where}
    ORDER BY rowid ASC
  `).all(...(cardIds ?? [])) as Array<{ card_id: string; tag: string }>;
  const map = new Map<string, string[]>();
  for (const row of rows) {
    const tags = map.get(row.card_id) ?? [];
    tags.push(row.tag);
    map.set(row.card_id, tags);
  }
  return map;
}

function loadCardLinksMap(cardIds?: readonly string[]): Map<string, string[]> {
  if (cardIds && cardIds.length === 0) return new Map();
  const where = cardIds ? `WHERE source_card_id IN (${placeholders(cardIds)})` : '';
  const rows = db.prepare(`
    SELECT source_card_id, target_card_id
    FROM card_links
    ${where}
    ORDER BY rowid ASC
  `).all(...(cardIds ?? [])) as Array<{ source_card_id: string; target_card_id: string }>;
  const map = new Map<string, string[]>();
  for (const row of rows) {
    const links = map.get(row.source_card_id) ?? [];
    links.push(row.target_card_id);
    map.set(row.source_card_id, links);
  }
  return map;
}

function hydrateCardRelations(card: Card, row: CardRow, tagsMap: Map<string, string[]>, linksMap: Map<string, string[]>): Card {
  const tags = tagsMap.get(card.id);
  const links = linksMap.get(card.id);
  return {
    ...card,
    tags: tags && tags.length ? tags : parseJsonArray(row.tags_json),
    links: links && links.length ? links : parseJsonArray(row.links_json),
  };
}

function cardToRow(card: Card) {
  return {
    id: card.id,
    title: card.title,
    body: card.body ?? "",
    summary: card.summary ?? null,
    url: card.url ?? null,
    type: card.type ?? "memo",
    color: card.color ?? null,
    // Normalized relation tables are canonical; JSON columns remain read-only compatibility fields.
    tags_json: "[]",
    links_json: "[]",
    kj_group_id: card.kjGroupId ?? null,
    archived: card.archived ? 1 : 0,
    archived_at: card.archivedAt ?? null,
    tokens_json: JSON.stringify(card.tokens ?? []),
    doc_length: card.docLength ?? card.tokens?.length ?? 0,
    morphological_tokens_json: JSON.stringify(card.morphologicalTokens ?? card.tokens ?? []),
    ngram_tokens_json: JSON.stringify(card.ngramTokens ?? card.tokens ?? []),
    morphological_doc_length: card.morphologicalDocLength ?? card.morphologicalTokens?.length ?? card.tokens?.length ?? 0,
    ngram_doc_length: card.ngramDocLength ?? card.ngramTokens?.length ?? card.docLength ?? card.tokens?.length ?? 0,
    created_at: card.createdAt,
    updated_at: card.updatedAt,
  };
}

const insertCardSql = `
  INSERT INTO cards (
    id,
    title,
    body,
    summary,
    url,
    type,
    color,
    tags_json,
    links_json,
    kj_group_id,
    archived,
    archived_at,
    tokens_json,
    doc_length,
    morphological_tokens_json,
    ngram_tokens_json,
    morphological_doc_length,
    ngram_doc_length,
    created_at,
    updated_at
  )
  VALUES (
    @id,
    @title,
    @body,
    @summary,
    @url,
    @type,
    @color,
    @tags_json,
    @links_json,
    @kj_group_id,
    @archived,
    @archived_at,
    @tokens_json,
    @doc_length,
    @morphological_tokens_json,
    @ngram_tokens_json,
    @morphological_doc_length,
    @ngram_doc_length,
    @created_at,
    @updated_at
  )
`;

function insertStoredCard(card: Card): void {
  db.prepare(insertCardSql).run(cardToRow(card));
  syncStoredRelations(card.id, card.tags ?? [], card.links ?? [], card.createdAt);
}

function updateStoredCard(card: Card): void {
  db.prepare(`
    UPDATE cards
    SET
      title = @title,
      body = @body,
      summary = @summary,
      url = @url,
      type = @type,
      color = @color,
      tags_json = @tags_json,
      links_json = @links_json,
      kj_group_id = @kj_group_id,
      archived = @archived,
      archived_at = @archived_at,
      tokens_json = @tokens_json,
      doc_length = @doc_length,
      morphological_tokens_json = @morphological_tokens_json,
      ngram_tokens_json = @ngram_tokens_json,
      morphological_doc_length = @morphological_doc_length,
      ngram_doc_length = @ngram_doc_length,
      created_at = @created_at,
      updated_at = @updated_at
    WHERE id = @id
  `).run(cardToRow(card));
  syncStoredRelations(card.id, card.tags ?? [], card.links ?? [], card.updatedAt);
}

function updateStoredLinks(id: string, links: string[], updatedAt: string): void {
  db.prepare(`
    UPDATE cards
    SET links_json = ?, updated_at = ?
    WHERE id = ?
  `).run(JSON.stringify(links), updatedAt, id);
  syncStoredLinks(id, links, updatedAt);
}

function syncStoredTags(id: string, tags: string[], createdAt: string): void {
  const deleteTags = db.prepare(`DELETE FROM card_tags WHERE card_id = ?`);
  const insertTag = db.prepare(`
    INSERT OR IGNORE INTO card_tags (card_id, tag, created_at)
    VALUES (?, ?, ?)
  `);
  deleteTags.run(id);
  for (const tag of [...new Set(tags.map(tag => tag.trim()).filter(Boolean))]) {
    insertTag.run(id, tag, createdAt);
  }
}

function syncStoredLinks(id: string, links: string[], createdAt: string): void {
  const deleteLinks = db.prepare(`DELETE FROM card_links WHERE source_card_id = ?`);
  const insertLink = db.prepare(`
    INSERT OR IGNORE INTO card_links (source_card_id, target_card_id, created_at)
    VALUES (?, ?, ?)
  `);
  deleteLinks.run(id);
  for (const linkId of [...new Set(links.map(link => link.trim()).filter(Boolean))]) {
    insertLink.run(id, linkId, createdAt);
  }
}

function syncStoredRelations(id: string, tags: string[], links: string[], createdAt: string): void {
  syncStoredTags(id, tags, createdAt);
  syncStoredLinks(id, links, createdAt);
}

export function loadCards(): Card[] {
  const startTime = performance.now();
  try {
    const rows = db.prepare(`SELECT ${CARD_COLUMNS} FROM cards`).all() as CardRow[];
    const tagsMap = loadCardTagsMap();
    const linksMap = loadCardLinksMap();

    return rows.map(row => hydrateCardRelations(rowToCard(row), row, tagsMap, linksMap));
  } finally {
    const durationMs = performance.now() - startTime;
    logger.debug({ event: 'db_load_cards_duration', durationMs }, 'Loaded cards from SQLite database');
  }
}

export function loadCardsByIds(ids: readonly string[]): Card[] {
  if (!ids.length) return [];
  const uniqueIds = [...new Set(ids)];
  const rows = db.prepare(`SELECT ${CARD_COLUMNS} FROM cards WHERE id IN (${placeholders(uniqueIds)})`).all(...uniqueIds) as CardRow[];
  const byId = new Map(hydrateRows(rows).map(card => [card.id, card]));
  return uniqueIds.flatMap(id => {
    const card = byId.get(id);
    return card ? [card] : [];
  });
}

export type SavedCardFtsRank = {
  id: string;
  morphologicalRank: number | null;
  ngramRank: number | null;
  rawTextRank: number | null;
  rrfScore: number;
  normalizedScore: number;
  matchedCount: number;
};

function numericPhraseVariants(term: string): string[] {
  const normalized = term.normalize('NFKC').toLowerCase();
  const fullWidth = normalized.replace(/[0-9]/gu, digit => String.fromCharCode(digit.charCodeAt(0) + 0xfee0));
  return [...new Set([normalized, fullWidth])];
}

/** Request-time exact text fallback for numeric-unit terms absent from persisted token caches. */
export function searchSavedCardIdsByNumericPhrase(terms: readonly string[], limit: number, offset = 0): SavedCardFtsRank[] {
  const uniqueTerms = [...new Set(terms.map(term => term.normalize('NFKC').toLowerCase().trim()).filter(Boolean))].slice(0, 8);
  if (!uniqueTerms.length) return [];
  const variants = [...new Set(uniqueTerms.flatMap(numericPhraseVariants))];
  const predicate = (column: string) => `(${variants.map(() => `instr(lower(COALESCE(${column},'')), ?) > 0`).join(' OR ')})`;
  const titlePredicate = predicate('title');
  const bodyPredicate = predicate('body');
  const summaryPredicate = predicate('summary');
  const scoreExpression = `(CASE WHEN ${titlePredicate} THEN 3 ELSE 0 END + CASE WHEN ${bodyPredicate} THEN 1 ELSE 0 END + CASE WHEN ${summaryPredicate} THEN 0.5 ELSE 0 END)`;
  const rows = db.prepare(`
    WITH matched AS (
      SELECT id, ${scoreExpression} AS match_score, COUNT(*) OVER() AS matched_count
      FROM cards
      WHERE ${titlePredicate} OR ${bodyPredicate} OR ${summaryPredicate}
    )
    SELECT id, match_score, matched_count FROM matched
    ORDER BY match_score DESC, id LIMIT ? OFFSET ?
  `).all(
    ...variants, ...variants, ...variants,
    ...variants, ...variants, ...variants,
    Math.max(1, Math.min(1000, Math.floor(limit))),
    Math.max(0, Math.floor(offset)),
  ) as Array<{ id: string; match_score: number; matched_count: number }>;
  return rows.map((row, index) => ({
    id: row.id,
    morphologicalRank: null,
    ngramRank: null,
    rawTextRank: index + 1,
    rrfScore: 1 / (60 + index + 1),
    normalizedScore: 61 / (60 + index + 1),
    matchedCount: row.matched_count,
  }));
}

function ftsExpression(tokens: readonly string[]): string | null {
  const unique = [...new Set(tokens.map(token => token.trim()).filter(Boolean))];
  return unique.length ? unique.map(token => `"${token.replace(/"/g, '""')}"`).join(' OR ') : null;
}

export function savedCardTokenFtsAvailable(): boolean {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('cards_fts','cards_morph_fts','cards_ngram_fts')").all() as Array<{name:string}>;
  return tables.length === 3;
}

export function savedCardCount(): number {
  return (db.prepare('SELECT COUNT(*) AS count FROM cards').get() as {count:number}).count;
}

export function savedCardTokenFtsStatus(): {ready:boolean;cards:number;morphological:number;ngram:number;raw:number} {
  const tables = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('cards_fts','cards_morph_fts','cards_ngram_fts')").all() as Array<{name:string}>).map(row=>row.name));
  const cards=savedCardCount();
  if(tables.size!==3) return {ready:false,cards,morphological:0,ngram:0,raw:0};
  const morphological=Number((db.prepare('SELECT COUNT(*) AS count FROM cards_morph_fts').get() as {count:number}).count);
  const ngram=Number((db.prepare('SELECT COUNT(*) AS count FROM cards_ngram_fts').get() as {count:number}).count);
  const raw=Number((db.prepare('SELECT COUNT(*) AS count FROM cards_fts').get() as {count:number}).count);
  return {ready:cards===morphological&&cards===ngram&&cards===raw,cards,morphological,ngram,raw};
}

export function rebuildSavedCardTokenFts(): number {
  if (!savedCardTokenFtsAvailable()) throw new Error('Saved-card token FTS5 indexes are not available.');
  db.transaction(() => {
    db.exec('DELETE FROM cards_fts; DELETE FROM cards_morph_fts; DELETE FROM cards_ngram_fts;');
    db.exec(`
      INSERT INTO cards_fts(id,title,body,summary,tags)
        SELECT cards.id,cards.title,cards.body,COALESCE(cards.summary,''),COALESCE((SELECT group_concat(tag,' ') FROM card_tags WHERE card_tags.card_id=cards.id),'') FROM cards;
      INSERT INTO cards_morph_fts(id,tokens)
        SELECT id, COALESCE((SELECT group_concat(value,' ') FROM json_each(CASE WHEN json_valid(COALESCE(morphological_tokens_json,'[]')) THEN COALESCE(morphological_tokens_json,'[]') ELSE '[]' END)),'') FROM cards;
      INSERT INTO cards_ngram_fts(id,tokens)
        SELECT id, COALESCE((SELECT group_concat(value,' ') FROM json_each(CASE WHEN json_valid(COALESCE(ngram_tokens_json,tokens_json,'[]')) THEN COALESCE(ngram_tokens_json,tokens_json,'[]') ELSE '[]' END)),'') FROM cards;
    `);
  })();
  return (db.prepare('SELECT COUNT(*) AS count FROM cards').get() as {count:number}).count;
}

export function searchSavedCardIdsFts5Rrf(
  morphologicalTokens: readonly string[],
  ngramTokens: readonly string[],
  rawTerms: readonly string[],
  limit: number,
  offset = 0,
): SavedCardFtsRank[] {
  const morphExpression = ftsExpression(morphologicalTokens);
  const ngramExpression = ftsExpression(ngramTokens);
  const rawExpression = ftsExpression(rawTerms);
  if (!morphExpression && !ngramExpression && !rawExpression) return [];
  const morph = morphExpression
    ? 'SELECT id, ROW_NUMBER() OVER (ORDER BY bm25(cards_morph_fts), id) AS fts_rank FROM cards_morph_fts WHERE cards_morph_fts MATCH ?'
    : 'SELECT NULL AS id, NULL AS fts_rank WHERE 0';
  const ngram = ngramExpression
    ? 'SELECT id, ROW_NUMBER() OVER (ORDER BY bm25(cards_ngram_fts), id) AS fts_rank FROM cards_ngram_fts WHERE cards_ngram_fts MATCH ?'
    : 'SELECT NULL AS id, NULL AS fts_rank WHERE 0';
  const raw = rawExpression
    ? 'SELECT id, ROW_NUMBER() OVER (ORDER BY bm25(cards_fts), id) AS fts_rank FROM cards_fts WHERE cards_fts MATCH ?'
    : 'SELECT NULL AS id, NULL AS fts_rank WHERE 0';
  const params: Array<string|number> = [];
  if (morphExpression) params.push(morphExpression);
  if (ngramExpression) params.push(ngramExpression);
  if (rawExpression) params.push(rawExpression);
  params.push(Math.max(1, Math.min(1000, Math.floor(limit))), Math.max(0, Math.floor(offset)));
  const rows = db.prepare(`
    WITH morph AS MATERIALIZED (${morph}),
    ngram AS MATERIALIZED (${ngram}),
    raw AS MATERIALIZED (${raw}),
    ids AS MATERIALIZED (SELECT id FROM morph UNION SELECT id FROM ngram UNION SELECT id FROM raw),
    fused AS (
      SELECT ids.id, morph.fts_rank AS morphological_rank, ngram.fts_rank AS ngram_rank, raw.fts_rank AS raw_text_rank,
        COALESCE(1.0/(60+morph.fts_rank),0)+COALESCE(1.0/(60+ngram.fts_rank),0)+COALESCE(1.0/(60+raw.fts_rank),0) AS rrf_score
      FROM ids LEFT JOIN morph ON morph.id=ids.id LEFT JOIN ngram ON ngram.id=ids.id LEFT JOIN raw ON raw.id=ids.id
    ),
    scored AS (
      SELECT *, COUNT(*) OVER() AS matched_count, MAX(rrf_score) OVER() AS max_score FROM fused
    )
    SELECT id, morphological_rank, ngram_rank, rrf_score, matched_count, max_score
    FROM scored ORDER BY rrf_score DESC, id LIMIT ? OFFSET ?
  `).all(...params) as Array<{id:string;morphological_rank:number|null;ngram_rank:number|null;raw_text_rank:number|null;rrf_score:number;matched_count:number;max_score:number}>;
  return rows.map(row => ({
    id: row.id,
    morphologicalRank: row.morphological_rank,
    ngramRank: row.ngram_rank,
    rawTextRank: row.raw_text_rank,
    rrfScore: row.rrf_score,
    normalizedScore: row.max_score > 0 ? row.rrf_score / row.max_score : 0,
    matchedCount: row.matched_count,
  }));
}

export function searchSavedCardIdsFts5Raw(
  rawTerms: readonly string[],
  limit: number,
  offset = 0,
): SavedCardFtsRank[] {
  const expression = ftsExpression(rawTerms);
  if (!expression) return [];
  const rows = db.prepare(`
    WITH ranked AS MATERIALIZED (
      SELECT id, ROW_NUMBER() OVER (ORDER BY bm25(cards_fts), id) AS fts_rank
      FROM cards_fts WHERE cards_fts MATCH ?
    ), scored AS (
      SELECT id, fts_rank, COUNT(*) OVER() AS matched_count
      FROM ranked
    )
    SELECT id, fts_rank, matched_count FROM scored
    ORDER BY fts_rank LIMIT ? OFFSET ?
  `).all(
    expression,
    Math.max(1, Math.min(1000, Math.floor(limit))),
    Math.max(0, Math.floor(offset)),
  ) as Array<{ id: string; fts_rank: number; matched_count: number }>;
  return rows.map(row => ({
    id: row.id,
    morphologicalRank: null,
    ngramRank: null,
    rawTextRank: row.fts_rank,
    rrfScore: 1 / (60 + row.fts_rank),
    normalizedScore: 61 / (60 + row.fts_rank),
    matchedCount: row.matched_count,
  }));
}

export function searchSavedCardIdsFts5Morphological(
  morphologicalTokens: readonly string[],
  limit: number,
  offset = 0,
): SavedCardFtsRank[] {
  const expression = ftsExpression(morphologicalTokens);
  if (!expression) return [];
  const rows = db.prepare(`
    WITH ranked AS MATERIALIZED (
      SELECT id, ROW_NUMBER() OVER (ORDER BY bm25(cards_morph_fts), id) AS fts_rank
      FROM cards_morph_fts WHERE cards_morph_fts MATCH ?
    ), scored AS MATERIALIZED (
      SELECT id, fts_rank, COUNT(*) OVER() AS matched_count
      FROM ranked
    )
    SELECT id, fts_rank, matched_count FROM scored
    ORDER BY fts_rank LIMIT ? OFFSET ?
  `).all(
    expression,
    Math.max(1, Math.min(1000, Math.floor(limit))),
    Math.max(0, Math.floor(offset)),
  ) as Array<{ id: string; fts_rank: number; matched_count: number }>;
  return rows.map(row => ({
    id: row.id,
    morphologicalRank: row.fts_rank,
    ngramRank: null,
    rawTextRank: null,
    rrfScore: 1 / (60 + row.fts_rank),
    normalizedScore: 61 / (60 + row.fts_rank),
    matchedCount: row.matched_count,
  }));
}

export type CardListSort = 'created_at_desc' | 'created_at_asc';

export type CardListFilters = {
  archived?: boolean;
  tag?: string;
  type?: string;
  q?: string;
  kjGroupId?: string;
  limit?: number;
  offset?: number;
  sort?: CardListSort;
};

export type CardListPage = {
  items: Card[];
  total: number;
  limit: number;
  offset: number;
};

type SqlParam = string | number;

function normalizeCardLimit(value?: number, defaultLimit?: number, maxLimit = 100): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return defaultLimit;
  const limit = Math.floor(value);
  if (limit <= 0) return defaultLimit;
  return Math.min(limit, maxLimit);
}

function normalizeCardOffset(value?: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  const offset = Math.floor(value);
  return offset >= 0 ? offset : 0;
}

function escapeLike(value: string): string {
  return value.replace(/[~%_]/g, (match) => `~${match}`);
}

function buildCardListWhere(filters: CardListFilters): { whereSql: string; params: SqlParam[] } {
  const where: string[] = [];
  const params: SqlParam[] = [];

  if (typeof filters.archived === 'boolean') {
    where.push('cards.archived = ?');
    params.push(filters.archived ? 1 : 0);
  }
  if (filters.type) {
    where.push('cards.type = ?');
    params.push(filters.type);
  }
  if (filters.kjGroupId) {
    where.push('cards.kj_group_id = ?');
    params.push(filters.kjGroupId);
  }
  if (filters.tag) {
    where.push('EXISTS (SELECT 1 FROM card_tags WHERE card_tags.card_id = cards.id AND card_tags.tag = ?)');
    params.push(filters.tag);
  }
  const keyword = filters.q?.trim();
  if (keyword) {
    const like = `%${escapeLike(keyword.toLowerCase())}%`;
    const readerTextClause = [...keyword].length >= 3
      ? 'cards.id IN (SELECT card_id FROM reader_text_fts WHERE reader_text_fts MATCH ?)'
      : `EXISTS (
        SELECT 1 FROM reader_texts
        WHERE reader_texts.card_id = cards.id
          AND LOWER(reader_texts.paragraphs_json) LIKE ? ESCAPE '~'
      )`;
    if (process.env.CARD_SEARCH_ENGINE === 'fts5' || process.env.CARD_SEARCH_ENGINE === 'fts5-raw') {
      const ftsQuery = keyword.split(/\s+/).filter(Boolean).map(term => `"${term.replace(/"/g, '""')}"`).join(' OR ');
      where.push(`(cards.id IN (SELECT id FROM cards_fts WHERE cards_fts MATCH ?) OR ${readerTextClause})`);
      params.push(ftsQuery);
    } else {
      where.push(`(
      LOWER(cards.title) LIKE ? ESCAPE '~'
      OR LOWER(COALESCE(cards.body, '')) LIKE ? ESCAPE '~'
      OR LOWER(COALESCE(cards.summary, '')) LIKE ? ESCAPE '~'
      OR EXISTS (
        SELECT 1 FROM card_tags q_tags
        WHERE q_tags.card_id = cards.id
          AND LOWER(q_tags.tag) LIKE ? ESCAPE '~'
      )
      OR ${readerTextClause}
    )`);
      params.push(like, like, like, like);
    }
    if ([...keyword].length >= 3) params.push(`"${keyword.replace(/"/g, '""')}"`);
    else params.push(like);
  }

  return {
    whereSql: where.length > 0 ? `WHERE ${where.join(' AND ')}` : '',
    params,
  };
}

function cardListOrderBy(sort: CardListSort | undefined): string {
  return sort === 'created_at_asc' ? 'cards.created_at ASC' : 'cards.created_at DESC';
}

function hydrateRows(rows: CardRow[]): Card[] {
  const ids = rows.map(row => row.id);
  const tagsMap = loadCardTagsMap(ids);
  const linksMap = loadCardLinksMap(ids);
  return rows.map(row => hydrateCardRelations(rowToCard(row), row, tagsMap, linksMap));
}

export function getCards(filters: CardListFilters = {}): Card[] {
  const { whereSql, params } = buildCardListWhere(filters);
  const orderBy = cardListOrderBy(filters.sort);
  const limit = normalizeCardLimit(filters.limit, undefined, 500);
  const offset = normalizeCardOffset(filters.offset);
  let sql = `SELECT ${CARD_COLUMNS_WITH_TABLE} FROM cards ${whereSql} ORDER BY ${orderBy}`;
  const queryParams = [...params];

  if (typeof limit === 'number') {
    sql += ' LIMIT ? OFFSET ?';
    queryParams.push(limit, offset);
  } else if (offset > 0) {
    sql += ' LIMIT -1 OFFSET ?';
    queryParams.push(offset);
  }

  const rows = db.prepare(sql).all(...queryParams) as CardRow[];
  return hydrateRows(rows);
}

export function getCardsPage(filters: CardListFilters = {}): CardListPage {
  const { whereSql, params } = buildCardListWhere(filters);
  const orderBy = cardListOrderBy(filters.sort);
  const limit = normalizeCardLimit(filters.limit, 20, 100) ?? 20;
  const offset = normalizeCardOffset(filters.offset);

  const totalRow = db.prepare(`
    SELECT COUNT(*) as total
    FROM cards
    ${whereSql}
  `).get(...params) as { total: number };

  const rows = db.prepare(`
    SELECT ${CARD_COLUMNS_WITH_TABLE}
    FROM cards
    ${whereSql}
    ORDER BY ${orderBy}
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset) as CardRow[];

  return {
    items: hydrateRows(rows),
    total: totalRow.total,
    limit,
    offset,
  };
}

export function saveCards(cards: Card[]): void {
  const tx = db.transaction(() => {
    const currentIds = new Set((db.prepare('SELECT id FROM cards').all() as Array<{id: string}>).map(row => row.id));
    const retainedIds = new Set(cards.map(card => card.id));
    for (const id of currentIds) if (!retainedIds.has(id)) db.prepare('DELETE FROM cards WHERE id = ?').run(id);
    for (const card of cards) {
      if (currentIds.has(card.id)) updateStoredCard(card);
      else insertStoredCard(card);
    }
  });

  tx();
}

export function saveCardTokenCaches(cards: Card[]): void {
  if (!cards.length) return;
  const update = db.prepare(`
    UPDATE cards
    SET tokens_json = ?, doc_length = ?, morphological_tokens_json = ?, ngram_tokens_json = ?,
        morphological_doc_length = ?, ngram_doc_length = ?
    WHERE id = ?
  `);
  const tx = db.transaction((rows: Card[]) => {
    for (const card of rows) {
      const ngramTokens = card.ngramTokens ?? card.tokens ?? [];
      const morphologicalTokens = card.morphologicalTokens ?? card.tokens ?? [];
      update.run(
        JSON.stringify(card.tokens ?? ngramTokens),
        card.docLength ?? ngramTokens.length,
        JSON.stringify(morphologicalTokens),
        JSON.stringify(ngramTokens),
        card.morphologicalDocLength ?? morphologicalTokens.length,
        card.ngramDocLength ?? ngramTokens.length,
        card.id,
      );
    }
  });
  tx(cards);
}

function newId(): string {
  return `card_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

/**
 * システム内部用途（移行や外部記事収集など）限定のカード作成フィールド型。
 * 通常のクライアントAPIからは `id` を直接指定することはできません。
 */
export type SystemCreateCardFields = Pick<Card, 'title' | 'body'> &
  Partial<Omit<Card, 'createdAt' | 'updatedAt'>> & {
    /** 内部用途限定の固定ID */
    id?: string;
  };

/**
 * カードを新規作成し、データベースに保存します。
 * @param fields 作成するカードのフィールド情報
 */
export async function createCard(
  fields: SystemCreateCardFields
): Promise<Card> {
  const now   = new Date().toISOString();
  const card: Card = {
    id:        fields.id ?? newId(),
    title:     fields.title,
    body:      fields.body,
    summary:   fields.summary,
    url:       fields.url,
    tags:      fields.tags      ?? [],
    links:     fields.links     ?? [],
    kjGroupId: fields.kjGroupId,
    type:      fields.type      ?? 'memo',
    color:     fields.color,
    archived:  fields.archived ?? false,
    archivedAt: fields.archivedAt,
    createdAt: now,
    updatedAt: now,
  };
  const stored = await buildStoredTokenSet(`${card.title} ${card.body} ${(card.tags ?? []).join(" ")}`);
  Object.assign(card, { tokens: stored.ngramTokens, docLength: stored.ngramDocLength, ...stored });
  db.transaction(() => insertStoredCard(card))();
  return card;
}

export async function createCardWithTransaction(
  fields: SystemCreateCardFields,
  finalize: (card: Card) => void,
): Promise<Card> {
  const now = new Date().toISOString();
  const card: Card = {
    id: fields.id ?? newId(),
    title: fields.title,
    body: fields.body,
    summary: fields.summary,
    url: fields.url,
    tags: fields.tags ?? [],
    links: fields.links ?? [],
    kjGroupId: fields.kjGroupId,
    type: fields.type ?? 'memo',
    color: fields.color,
    archived: fields.archived ?? false,
    archivedAt: fields.archivedAt,
    createdAt: now,
    updatedAt: now,
  };
  const stored = await buildStoredTokenSet(card.title + ' ' + card.body + ' ' + (card.tags ?? []).join(" "));
  Object.assign(card, { tokens: stored.ngramTokens, docLength: stored.ngramDocLength, ...stored });
  return db.transaction(() => {
    insertStoredCard(card);
    finalize(card);
    return card;
  })();
}
export async function updateCard(
  id: string,
  updates: Partial<Card>,
  finalize?: (card: Card) => void,
  expectedBody?: string,
  expectedRelatedBodies: Array<{ id: string; body: string }> = [],
): Promise<Card | null> {
  const existing = getCard(id);
  if (!existing) return null;
  const updated: Card = { ...existing, ...updates, id, updatedAt: new Date().toISOString() };
  const stored = await buildStoredTokenSet(`${updated.title} ${updated.body} ${(updated.tags ?? []).join(" ")}`);
  Object.assign(updated, { tokens: stored.ngramTokens, docLength: stored.ngramDocLength, ...stored });
  return db.transaction(() => {
    const current = getCard(id);
    if (!current || (expectedBody !== undefined && current.body !== expectedBody)) return null;
    for (const expected of expectedRelatedBodies) {
      const related = getCard(expected.id);
      if (!related || related.body !== expected.body) return null;
    }
    updateStoredCard(updated); finalize?.(updated); return updated;
  })();
}

export function deleteCard(id: string): boolean {
  const cards = loadCards();
  if (!cards.some(card => card.id === id)) return false;
  const now = new Date().toISOString();
  const tx = db.transaction(() => {
    db.prepare(`DELETE FROM cards WHERE id = ?`).run(id);
    db.prepare(`DELETE FROM card_tags WHERE card_id = ?`).run(id);
    db.prepare(`DELETE FROM card_links WHERE source_card_id = ? OR target_card_id = ?`).run(id, id);
    for (const card of cards) {
      if (card.id === id || !card.links.includes(id)) continue;
      updateStoredLinks(card.id, card.links.filter(linkId => linkId !== id), now);
    }
  });
  tx();
  return true;
}

export function bulkArchiveCards(ids: string[]): string[] {
  const now = new Date().toISOString();
  const updated: string[] = [];
  const archive = db.prepare(`
    UPDATE cards
    SET archived = 1, archived_at = ?, updated_at = ?
    WHERE id = ?
  `);
  const tx = db.transaction(() => {
    for (const id of ids) {
      const result = archive.run(now, now, id);
      if (result.changes > 0) updated.push(id);
    }
  });
  tx();
  return updated;
}

export async function restoreCard(id: string): Promise<Card | null> {
  return updateCard(id, { archived: false, archivedAt: undefined });
}

export function bulkRestoreCards(ids: string[]): string[] {
  const now = new Date().toISOString();
  const updated: string[] = [];
  const restore = db.prepare(`
    UPDATE cards
    SET archived = 0, archived_at = NULL, updated_at = ?
    WHERE id = ?
  `);
  const tx = db.transaction(() => {
    for (const id of ids) {
      const result = restore.run(now, id);
      if (result.changes > 0) updated.push(id);
    }
  });
  tx();
  return updated;
}

export function bulkDeleteCards(ids: string[]): string[] {
  const idSet = new Set(ids);
  const cards = loadCards();
  const deleted = cards.filter(card => idSet.has(card.id)).map(card => card.id);
  if (!deleted.length) return [];

  const now = new Date().toISOString();
  const deleteById = db.prepare(`DELETE FROM cards WHERE id = ?`);
  const deleteTagsById = db.prepare(`DELETE FROM card_tags WHERE card_id = ?`);
  const deleteLinksById = db.prepare(`DELETE FROM card_links WHERE source_card_id = ? OR target_card_id = ?`);
  const tx = db.transaction(() => {
    for (const id of deleted) {
      deleteById.run(id);
      deleteTagsById.run(id);
      deleteLinksById.run(id, id);
    }
    for (const card of cards) {
      if (idSet.has(card.id)) continue;
      const links = card.links.filter(linkId => !idSet.has(linkId));
      if (links.length !== card.links.length) {
        updateStoredLinks(card.id, links, now);
      }
    }
  });
  tx();
  return deleted;
}

export function getCard(id: string): Card | null {
  const row = db.prepare(`SELECT ${CARD_COLUMNS} FROM cards WHERE id = ?`).get(id) as CardRow | undefined;
  if (!row) return null;
  return hydrateCardRelations(rowToCard(row), row, loadCardTagsMap(), loadCardLinksMap());
}

// ════════════════════════════════════════════════════
//  § 4. Zettelkasten リンク管理
// ════════════════════════════════════════════════════

/** 双方向リンクを貼る */
export function linkCards(sourceId: string, targetId: string): void {
  const source = getCard(sourceId);
  const target = getCard(targetId);
  if (!source || !target || sourceId === targetId) return;
  const links = source.links.includes(targetId) ? source.links : [...source.links, targetId];
  updateStoredLinks(sourceId, links, new Date().toISOString());
}

export function unlinkCards(sourceId: string, targetId: string): boolean {
  const source = getCard(sourceId);
  if (!source || !source.links.includes(targetId)) return false;
  updateStoredLinks(sourceId, source.links.filter(linkId => linkId !== targetId), new Date().toISOString());
  return true;
}
export function getBacklinks(id: string): Card[] {
  return loadCards().filter(c => c.links.includes(id) && c.id !== id);
}

// ════════════════════════════════════════════════════
//  § 5. タグ管理
// ════════════════════════════════════════════════════

export function getAllTags(): { tag: string; count: number }[] {
  return db.prepare(`
    SELECT tag, COUNT(*) AS count
    FROM card_tags
    GROUP BY tag
    ORDER BY count DESC, tag ASC
  `).all() as { tag: string; count: number }[];
}

// ════════════════════════════════════════════════════
//  § 6. KJ法グループ管理
// ════════════════════════════════════════════════════

export async function backfillCardTokens(forceRebuild = false): Promise<number> {
  const cards = loadCards();
  const updatedCards: Card[] = [];
  let updated = 0;

  for (const card of cards) {
    if (!forceRebuild && (card.morphologicalTokens?.length ?? 0) > 0 && (card.ngramTokens?.length ?? 0) > 0) continue;
    const stored = await buildStoredTokenSet(`${card.title} ${card.body} ${(card.tags ?? []).join(" ")}`);
    Object.assign(card, { tokens: stored.ngramTokens, docLength: stored.ngramDocLength, ...stored });
    updatedCards.push(card);
    updated += 1;
  }

  if (updatedCards.length > 0) saveCardTokenCaches(updatedCards);
  return updated;
}

// ════════════════════════════════════════════════════
//  § 7. CSV インポート
// ════════════════════════════════════════════════════

/**
 * CSV文字列をパースしてカードを生成する
 * 期待カラム（1行目ヘッダー）:
 *   title, body（またはcontent/description）, url, tags（カンマ区切り）
 * ヘッダー名の大文字小文字は無視。不明列はbodyに結合。
 */

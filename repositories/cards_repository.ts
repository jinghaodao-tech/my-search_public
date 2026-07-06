/**
 * cards_engine.ts — カード管理エンジン
 * Zettelkasten / KJ法 / タグ / CSV取り込み / メモ機能
 */

import fs   from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { performance } from 'node:perf_hooks';
import { logger } from '../utils/logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.dirname(__dirname);
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
import { tokenize } from '../search/tokenizer.js';

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
  created_at: string;
  updated_at: string;
};

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
    tags_json: JSON.stringify(card.tags ?? []),
    links_json: JSON.stringify(card.links ?? []),
    kj_group_id: card.kjGroupId ?? null,
    archived: card.archived ? 1 : 0,
    archived_at: card.archivedAt ?? null,
    tokens_json: JSON.stringify(card.tokens ?? []),
    doc_length: card.docLength ?? card.tokens?.length ?? 0,
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
    const rows = db.prepare(`
      SELECT * FROM cards
    `).all() as CardRow[];
    const tagsMap = loadCardTagsMap();
    const linksMap = loadCardLinksMap();

    return rows.map(row => hydrateCardRelations(rowToCard(row), row, tagsMap, linksMap));
  } finally {
    const durationMs = performance.now() - startTime;
    logger.debug({ event: 'db_load_cards_duration', durationMs }, 'Loaded cards from SQLite database');
  }
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
  return value.replace(/[\%_]/g, (match) => `\${match}`);
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
    where.push(`(
      LOWER(cards.title) LIKE ? ESCAPE '~'
      OR LOWER(COALESCE(cards.body, '')) LIKE ? ESCAPE '~'
      OR LOWER(COALESCE(cards.summary, '')) LIKE ? ESCAPE '~'
      OR EXISTS (
        SELECT 1 FROM card_tags q_tags
        WHERE q_tags.card_id = cards.id
          AND LOWER(q_tags.tag) LIKE ? ESCAPE '~'
      )
    )`);
    params.push(like, like, like, like);
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
  let sql = `SELECT cards.* FROM cards ${whereSql} ORDER BY ${orderBy}`;
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
    SELECT cards.*
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
  const clear = db.prepare(`
    DELETE FROM cards
  `);
  const clearTags = db.prepare(`DELETE FROM card_tags`);
  const clearLinks = db.prepare(`DELETE FROM card_links`);

  const insert = db.prepare(insertCardSql);

  const tx = db.transaction(() => {
    clearTags.run();
    clearLinks.run();
    clear.run();

    for (const card of cards) {
      insert.run(cardToRow(card));
      syncStoredRelations(card.id, card.tags ?? [], card.links ?? [], card.createdAt);
    }
  });

  tx();
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
  card.tokens = await tokenize(`${card.title} ${card.body} ${(card.tags ?? []).join(" ")}`);
  card.docLength = card.tokens.length;
  insertStoredCard(card);
  return card;
}

export async function updateCard(id: string, updates: Partial<Card>): Promise<Card | null> {
  const existing = getCard(id);
  if (!existing) return null;
  const updated: Card = { ...existing, ...updates, id, updatedAt: new Date().toISOString() };
  updated.tokens = await tokenize(
    `${updated.title} ${updated.body} ${(updated.tags ?? []).join(" ")}`
  );
  updated.docLength = updated.tokens.length;
  updateStoredCard(updated);
  return updated;
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
  const row = db.prepare(`SELECT * FROM cards WHERE id = ?`).get(id) as CardRow | undefined;
  if (!row) return null;
  return hydrateCardRelations(rowToCard(row), row, loadCardTagsMap(), loadCardLinksMap());
}

// ════════════════════════════════════════════════════
//  § 4. Zettelkasten リンク管理
// ════════════════════════════════════════════════════

/** 双方向リンクを貼る */
export function linkCards(id1: string, id2: string): void {
  const card1 = getCard(id1);
  const card2 = getCard(id2);
  if (!card1 || !card2) return;
  const links1 = card1.links.includes(id2) ? card1.links : [...card1.links, id2];
  const links2 = card2.links.includes(id1) ? card2.links : [...card2.links, id1];
  const now = new Date().toISOString();
  const tx = db.transaction(() => {
    updateStoredLinks(id1, links1, now);
    updateStoredLinks(id2, links2, now);
  });
  tx();
}

/** 双方向リンクを外す */
export function unlinkCards(id1: string, id2: string): void {
  const card1 = getCard(id1);
  const card2 = getCard(id2);
  const now = new Date().toISOString();
  const tx = db.transaction(() => {
    if (card1) updateStoredLinks(id1, card1.links.filter(linkId => linkId !== id2), now);
    if (card2) updateStoredLinks(id2, card2.links.filter(linkId => linkId !== id1), now);
  });
  tx();
}

/** 指定カードのバックリンク（被リンク）を返す */
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

export async function backfillCardTokens(): Promise<number> {
  const cards = loadCards();
  let updated = 0;

  for (const card of cards) {
    if ((card.tokens?.length ?? 0) > 0 && (card.docLength ?? 0) > 0) continue;
    card.tokens = await tokenize(`${card.title} ${card.body} ${(card.tags ?? []).join(" ")}`);
    card.docLength = card.tokens.length;
    updated += 1;
  }

  if (updated > 0) saveCards(cards);
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

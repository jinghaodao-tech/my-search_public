/**
 * cards_engine.ts — カード管理エンジン
 * Zettelkasten / KJ法 / タグ / CSV取り込み / メモ機能
 */

import fs   from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR   = path.join(__dirname, 'data');
const CARDS_FILE = path.join(DATA_DIR, 'cards.json');
const KJ_FILE    = path.join(DATA_DIR, 'kj_groups.json');

// ════════════════════════════════════════════════════
//  § 1. 型定義
// ════════════════════════════════════════════════════

export interface Card {
  id:          string;
  title:       string;
  body:        string;
  summary?:    string;       // AI要約
  url?:        string;
  tags:        string[];     // タグ一覧
  links:       string[];     // Zettelkasten リンク先カードID
  kjGroupId?:  string;       // KJ法グループID
  type:        'article' | 'memo' | 'csv';
  color?:      string;       // カード色 (例: '#FFD700')
  archived?:   boolean;
  archivedAt?: string;
  createdAt:   string;       // ISO文字列
  updatedAt:   string;
  tokens?:     string[];
  docLength?:  number;
}

export interface KJGroup {
  id:           string;
  name:         string;
  description?: string;
  color:        string;
  createdAt:    string;
}

// ════════════════════════════════════════════════════
//  § 2. ストレージユーティリティ
// ════════════════════════════════════════════════════

function ensureDataDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

import { db } from "./db/database.js";
import { tokenize } from "./bm25_engine.js";

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
}

function updateStoredLinks(id: string, links: string[], updatedAt: string): void {
  db.prepare(`
    UPDATE cards
    SET links_json = ?, updated_at = ?
    WHERE id = ?
  `).run(JSON.stringify(links), updatedAt, id);
}

export function loadCards(): Card[] {
  console.time("load cards");
  try {
    const rows = db.prepare(`
      SELECT * FROM cards
    `).all();

    return rows.map(row => rowToCard(row as CardRow));
  } finally {
    console.timeEnd("load cards");
  }
}

export function getCards(filters: {
  archived?: boolean;
  tag?: string;
  type?: string;
  q?: string;
  kjGroupId?: string;
} = {}): Card[] {
  let cards = loadCards();
  if (typeof filters.archived === 'boolean') {
    cards = cards.filter(card => Boolean(card.archived) === filters.archived);
  }
  if (filters.tag) cards = cards.filter(card => card.tags.includes(filters.tag!));
  if (filters.type) cards = cards.filter(card => card.type === filters.type);
  if (filters.kjGroupId) cards = cards.filter(card => card.kjGroupId === filters.kjGroupId);
  if (filters.q) {
    const keyword = filters.q.toLowerCase();
    cards = cards.filter(card =>
      card.title.toLowerCase().includes(keyword) ||
      card.body.toLowerCase().includes(keyword) ||
      (card.summary ?? '').toLowerCase().includes(keyword) ||
      card.tags.some(tag => tag.toLowerCase().includes(keyword))
    );
  }
  return cards.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function saveCards(cards: Card[]): void {
  const clear = db.prepare(`
    DELETE FROM cards
  `);

  const insert = db.prepare(insertCardSql);

  const tx = db.transaction(() => {
    clear.run();

    for (const card of cards) {
      insert.run(cardToRow(card));
    }
  });

  tx();
}

export function loadKJGroups(): KJGroup[] {
  ensureDataDir();
  if (!fs.existsSync(KJ_FILE)) return [];
  try {
    return JSON.parse(fs.readFileSync(KJ_FILE, 'utf-8')) as KJGroup[];
  } catch {
    return [];
  }
}

export function saveKJGroups(groups: KJGroup[]): void {
  ensureDataDir();
  fs.writeFileSync(KJ_FILE, JSON.stringify(groups, null, 2), 'utf-8');
}

// ════════════════════════════════════════════════════
//  § 3. カードCRUD
// ════════════════════════════════════════════════════

function newId(): string {
  return `card_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

export async function createCard(
  fields: Pick<Card, 'title' | 'body'> & Partial<Omit<Card, 'id' | 'createdAt' | 'updatedAt'>>
): Promise<Card> {
  const now   = new Date().toISOString();
  const card: Card = {
    id:        newId(),
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
  const tx = db.transaction(() => {
    for (const id of deleted) {
      deleteById.run(id);
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
  return row ? rowToCard(row) : null;
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
  const cards = loadCards();
  const map   = new Map<string, number>();
  for (const card of cards) {
    for (const tag of card.tags) {
      map.set(tag, (map.get(tag) ?? 0) + 1);
    }
  }
  return [...map.entries()]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count);
}

// ════════════════════════════════════════════════════
//  § 6. KJ法グループ管理
// ════════════════════════════════════════════════════

const KJ_COLORS = [
  '#FF6B6B', '#FFD93D', '#6BCB77', '#4D96FF',
  '#C77DFF', '#FF9A3C', '#00C9A7', '#F72585',
];

export function createKJGroup(name: string, description?: string, color?: string): KJGroup {
  const groups = loadKJGroups();
  const group: KJGroup = {
    id:          `kj_${Date.now()}`,
    name,
    description,
    color:       color ?? KJ_COLORS[groups.length % KJ_COLORS.length],
    createdAt:   new Date().toISOString(),
  };
  groups.push(group);
  saveKJGroups(groups);
  return group;
}

export function updateKJGroup(id: string, updates: Partial<KJGroup>): KJGroup | null {
  const groups = loadKJGroups();
  const idx    = groups.findIndex(g => g.id === id);
  if (idx === -1) return null;
  groups[idx] = { ...groups[idx], ...updates, id };
  saveKJGroups(groups);
  return groups[idx];
}

export function deleteKJGroup(id: string): void {
  db.prepare(`
    UPDATE cards
    SET kj_group_id = NULL, updated_at = ?
    WHERE kj_group_id = ?
  `).run(new Date().toISOString(), id);
  saveKJGroups(loadKJGroups().filter(g => g.id !== id));
}

/** カードをKJグループへ割り当て（nullで解除） */
export async function assignKJGroup(cardId: string, groupId: string | null): Promise<void> {
  await updateCard(cardId, { kjGroupId: groupId ?? undefined });
}

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
export function parseAndImportCSV(csvText: string): Card[] {
  const lines  = csvText.split(/\r?\n/).filter(l => l.trim());
  if (lines.length < 2) return [];

  // ヘッダー解析（引用符付きCSV簡易対応）
  const headers = splitCSVLine(lines[0]).map(h => h.toLowerCase().trim());

  const col = (candidates: string[]) =>
    candidates.map(c => headers.indexOf(c)).find(i => i >= 0) ?? -1;

  const titleCol   = col(['title', 'タイトル', 'name']);
  const bodyCol    = col(['body', 'content', 'description', '本文', 'テキスト', 'text']);
  const urlCol     = col(['url', 'link', 'リンク']);
  const tagsCol    = col(['tags', 'tag', 'タグ', 'categories', 'keywords']);

  const imported: Card[] = [];
  const now = new Date().toISOString();

  for (let i = 1; i < lines.length; i++) {
    const cols  = splitCSVLine(lines[i]);
    if (!cols.length) continue;

    const get = (idx: number) => (idx >= 0 ? (cols[idx] ?? '').trim() : '');

    const title = get(titleCol) || `行 ${i}`;
    let   body  = get(bodyCol);

    // 不明列をbodyに補完
    if (!body) {
      body = cols
        .filter((_, idx) => idx !== titleCol && idx !== urlCol && idx !== tagsCol)
        .join(' ')
        .trim();
    }

    const rawTags = get(tagsCol);
    const tags    = rawTags
      ? rawTags.split(/[,、；;]/).map(t => t.trim()).filter(Boolean)
      : [];

    const card: Card = {
      id:        newId(),
      title,
      body,
      url:       get(urlCol) || undefined,
      tags,
      links:     [],
      type:      'csv',
      createdAt: now,
      updatedAt: now,
    };
    imported.push(card);
  }

  // 既存カードに追記保存
  const existing = loadCards();
  saveCards([...existing, ...imported]);
  return imported;
}

// ════════════════════════════════════════════════════
//  § 8. JSON インポート
// ════════════════════════════════════════════════════

/**
 * JSON文字列をパースしてカードを生成する。
 *
 * 対応フォーマット:
 *   A) Card[] 形式       — このシステムのエクスポートをそのまま再インポート
 *   B) Article[] 形式    — collector.ts が出力する articles.json
 *   C) オブジェクト配列  — {title, body/content/description, url, tags} の配列
 *   D) ラッパー形式      — { cards/articles/items/data/results: [...] }
 *   E) 単一オブジェクト  — 上記フィールドを持つ1件のオブジェクト
 *
 * フィールドマッピング（大文字小文字・日英を自動判定）:
 *   title   → title / タイトル / name / headline / subject
 *   body    → body / content / description / text / abstract / summary / 本文 / テキスト
 *   url     → url / link / href / リンク
 *   tags    → tags / tag / categories / category / keywords / labels / タグ / ラベル
 *             ※ 文字列（カンマ区切り）または配列どちらも受け付ける
 */
export function parseAndImportJSON(jsonText: string): { cards: Card[]; warnings: string[] } {
  const warnings: string[] = [];

  // ── パース ──────────────────────────────────────
  let raw: unknown;
  try {
    raw = JSON.parse(jsonText);
  } catch (e) {
    throw new Error(`JSONパースエラー: ${(e as Error).message}`);
  }

  // ── 配列を取り出す ──────────────────────────────
  let items: unknown[];
  if (Array.isArray(raw)) {
    items = raw;
  } else if (raw && typeof raw === 'object') {
    // ラッパーキーを探す
    const WRAPPER_KEYS = ['cards', 'articles', 'items', 'data', 'results', 'records', 'entries'];
    const found = WRAPPER_KEYS.find(k => Array.isArray((raw as Record<string, unknown>)[k]));
    if (found) {
      items = (raw as Record<string, unknown>)[found] as unknown[];
    } else {
      // 単一オブジェクトとして扱う
      items = [raw];
    }
  } else {
    throw new Error('JSONの形式が不正です（配列またはオブジェクトが必要です）');
  }

  if (!items.length) {
    warnings.push('データが0件でした');
    return { cards: [], warnings };
  }

  // ── フィールドマッパー ───────────────────────────
  const TITLE_KEYS  = ['title', 'タイトル', 'name', 'headline', 'subject'];
  const BODY_KEYS   = ['body', 'content', 'description', 'text', 'abstract', 'summary', '本文', 'テキスト'];
  const URL_KEYS    = ['url', 'link', 'href', 'リンク'];
  const TAGS_KEYS   = ['tags', 'tag', 'categories', 'category', 'keywords', 'labels', 'タグ', 'ラベル'];
  const SUMMARY_KEYS = ['summary', 'abstract', '要約'];

  function pickStr(obj: Record<string, unknown>, keys: string[]): string {
    for (const k of keys) {
      const v = obj[k] ?? obj[k.toLowerCase()] ?? obj[k.toUpperCase()];
      if (v !== undefined && v !== null) return String(v).trim();
    }
    // 大文字小文字無視で再検索
    const objKeys = Object.keys(obj);
    for (const k of keys) {
      const found = objKeys.find(ok => ok.toLowerCase() === k.toLowerCase());
      if (found && obj[found] !== null && obj[found] !== undefined) return String(obj[found]).trim();
    }
    return '';
  }

  function pickTags(obj: Record<string, unknown>): string[] {
    const objKeys = Object.keys(obj);
    for (const k of TAGS_KEYS) {
      const found = objKeys.find(ok => ok.toLowerCase() === k.toLowerCase());
      if (!found) continue;
      const v = obj[found];
      if (Array.isArray(v))       return v.map(t => String(t).trim()).filter(Boolean);
      if (typeof v === 'string')  return v.split(/[,、；;\s]+/).map(t => t.trim()).filter(Boolean);
    }
    return [];
  }

  // ── システム固有フォーマット検出 ────────────────
  // Card[] 形式: id が "card_" で始まり type フィールドがある
  const isCardExport = items.length > 0 &&
    typeof (items[0] as Record<string, unknown>).id === 'string' &&
    typeof (items[0] as Record<string, unknown>).type === 'string' &&
    ['memo','csv','article'].includes(String((items[0] as Record<string, unknown>).type));

  // Article[] 形式: sourceAuthority フィールドがある
  const isArticleExport = items.length > 0 &&
    typeof (items[0] as Record<string, unknown>).sourceAuthority === 'number';

  // ── カード生成 ───────────────────────────────────
  const now = new Date().toISOString();
  const imported: Card[] = [];
  let skipped = 0;

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (!item || typeof item !== 'object') { skipped++; continue; }
    const obj = item as Record<string, unknown>;

    if (isCardExport) {
      // このシステムのカードをそのまま復元（idは新規発行して重複を防ぐ）
      const card: Card = {
        id:          newId(),
        title:       String(obj.title ?? `カード ${i + 1}`),
        body:        String(obj.body ?? ''),
        summary:     obj.summary ? String(obj.summary) : undefined,
        url:         obj.url ? String(obj.url) : undefined,
        tags:        Array.isArray(obj.tags) ? obj.tags.map(String) : [],
        links:       [],            // リンクは再インポート時に初期化
        kjGroupId:   undefined,
        type:        (['memo','csv','article'].includes(String(obj.type)) ? obj.type : 'csv') as Card['type'],
        color:       obj.color ? String(obj.color) : undefined,
        createdAt:   String(obj.createdAt ?? now),
        updatedAt:   now,
      };
      imported.push(card);

    } else if (isArticleExport) {
      // collector の Article 形式
      const title = pickStr(obj, ['title']) || `記事 ${i + 1}`;
      const card: Card = {
        id:          newId(),
        title,
        body:        pickStr(obj, ['body', 'content', 'summary']),
        url:         pickStr(obj, ['url']),
        tags:        [],
        links:       [],
        type:        'article',
        createdAt:   obj.publishedAt ? String(obj.publishedAt) : now,
        updatedAt:   now,
      };
      imported.push(card);

    } else {
      // 汎用オブジェクト
      const title = pickStr(obj, TITLE_KEYS);
      if (!title) {
        // タイトルがなければ残フィールドをすべて本文として1枚作成
        const body = Object.entries(obj)
          .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
          .join('\n');
        if (!body.trim()) { skipped++; continue; }
        imported.push({
          id: newId(), title: `データ ${i + 1}`, body,
          tags: [], links: [], type: 'csv', createdAt: now, updatedAt: now,
        });
        warnings.push(`行 ${i + 1}: titleフィールドが見つからないため自動生成しました`);
        continue;
      }

      // summaryキーがbody_keysより先に来るケースを除外（body優先）
      const body    = pickStr(obj, BODY_KEYS);
      const summaryRaw = pickStr(obj, SUMMARY_KEYS);
      // bodyとsummaryが同じキーにマップされた場合は重複しない
      const summary = (summaryRaw && summaryRaw !== body) ? summaryRaw : undefined;

      imported.push({
        id:        newId(),
        title,
        body:      body || title,
        summary,
        url:       pickStr(obj, URL_KEYS) || undefined,
        tags:      pickTags(obj),
        links:     [],
        type:      'csv',
        createdAt: now,
        updatedAt: now,
      });
    }
  }

  if (skipped) warnings.push(`${skipped}件をスキップしました（不正な形式）`);

  // 既存カードに追記保存
  const existing = loadCards();
  saveCards([...existing, ...imported]);
  return { cards: imported, warnings };
}

function splitCSVLine(line: string): string[] {
  const result: string[] = [];
  let current = '';
  let inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuote && line[i + 1] === '"') { current += '"'; i++; }
      else inQuote = !inQuote;
    } else if (ch === ',' && !inQuote) {
      result.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  result.push(current);
  return result;
}

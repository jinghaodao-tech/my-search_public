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

import { db } from "./db/database.ts";

export function loadCards(): Card[] {
  const rows = db.prepare(`
    SELECT * FROM cards
  `).all();

  return rows.map((row: any) => ({
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
  }));
}

export function saveCards(cards: Card[]): void {
  const clear = db.prepare(`
    DELETE FROM cards
  `);

  const insert = db.prepare(`
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
      @created_at,
      @updated_at
    )
  `);

  const tx = db.transaction(() => {
    clear.run();

    for (const card of cards) {
      insert.run({
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
        created_at: card.createdAt,
        updated_at: card.updatedAt,
      });
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

export function createCard(
  fields: Pick<Card, 'title' | 'body'> & Partial<Omit<Card, 'id' | 'createdAt' | 'updatedAt'>>
): Card {
  const cards = loadCards();
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
  cards.push(card);
  saveCards(cards);
  return card;
}

export function updateCard(id: string, updates: Partial<Card>): Card | null {
  const cards = loadCards();
  const idx   = cards.findIndex(c => c.id === id);
  if (idx === -1) return null;
  cards[idx] = { ...cards[idx], ...updates, id, updatedAt: new Date().toISOString() };
  saveCards(cards);
  return cards[idx];
}

export function deleteCard(id: string): boolean {
  let cards = loadCards();
  const before = cards.length;
  // 他カードのlinksからも削除
  cards = cards
    .filter(c => c.id !== id)
    .map(c => ({ ...c, links: c.links.filter(l => l !== id) }));
  if (cards.length === before) return false;
  saveCards(cards);
  return true;
}

export function getCard(id: string): Card | null {
  return loadCards().find(c => c.id === id) ?? null;
}

export function getCards(filters?: {
  archived?: boolean;
  tag?: string;
  type?: string;
  q?: string;
  kjGroupId?: string;
}): Card[] {
  let cards = loadCards();

  if (filters?.archived !== undefined) {
    cards = cards.filter(card => Boolean(card.archived) === filters.archived);
  }
  if (filters?.tag) {
    cards = cards.filter(card => card.tags.includes(filters.tag!));
  }
  if (filters?.type) {
    cards = cards.filter(card => card.type === filters.type);
  }
  if (filters?.kjGroupId) {
    cards = cards.filter(card => (card.kjGroupId ?? '') === filters.kjGroupId);
  }
  if (filters?.q) {
    const q = filters.q.toLowerCase();
    cards = cards.filter(card =>
      card.title.toLowerCase().includes(q) ||
      card.body.toLowerCase().includes(q) ||
      (card.summary ?? '').toLowerCase().includes(q) ||
      (card.url ?? '').toLowerCase().includes(q) ||
      card.tags.some(tag => tag.toLowerCase().includes(q))
    );
  }

  return cards;
}

export function restoreCard(id: string): boolean {
  const restored = updateCard(id, {
    archived: false,
    archivedAt: undefined,
  });
  return Boolean(restored);
}

export function bulkArchiveCards(ids: string[]): string[] {
  const idSet = new Set(ids);
  const cards = loadCards();
  const now = new Date().toISOString();
  const updated: string[] = [];

  for (const card of cards) {
    if (!idSet.has(card.id)) continue;
    card.archived = true;
    card.archivedAt = now;
    card.updatedAt = now;
    updated.push(card.id);
  }

  if (updated.length) saveCards(cards);
  return updated;
}

export function bulkRestoreCards(ids: string[]): string[] {
  const idSet = new Set(ids);
  const cards = loadCards();
  const now = new Date().toISOString();
  const updated: string[] = [];

  for (const card of cards) {
    if (!idSet.has(card.id)) continue;
    card.archived = false;
    card.archivedAt = undefined;
    card.updatedAt = now;
    updated.push(card.id);
  }

  if (updated.length) saveCards(cards);
  return updated;
}

export function bulkDeleteCards(ids: string[]): string[] {
  const idSet = new Set(ids);
  const cards = loadCards();
  const now = new Date().toISOString();
  const remaining = cards
    .filter(card => !idSet.has(card.id))
    .map(card => {
      const nextLinks = card.links.filter(linkId => !idSet.has(linkId));
      if (nextLinks.length === card.links.length) return card;
      return { ...card, links: nextLinks, updatedAt: now };
    });

  const deleted = cards.filter(card => idSet.has(card.id)).map(card => card.id);
  if (deleted.length) saveCards(remaining);
  return deleted;
}

// ════════════════════════════════════════════════════
//  § 4. Zettelkasten リンク管理
// ════════════════════════════════════════════════════

/** 双方向リンクを貼る */
export function linkCards(id1: string, id2: string): void {
  const cards = loadCards();
  for (const card of cards) {
    if (card.id === id1 && !card.links.includes(id2)) card.links.push(id2);
    if (card.id === id2 && !card.links.includes(id1)) card.links.push(id1);
  }
  saveCards(cards);
}

/** 双方向リンクを外す */
export function unlinkCards(id1: string, id2: string): void {
  const cards = loadCards();
  for (const card of cards) {
    if (card.id === id1) card.links = card.links.filter(l => l !== id2);
    if (card.id === id2) card.links = card.links.filter(l => l !== id1);
  }
  saveCards(cards);
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
  // グループに属していたカードのkjGroupIdをクリア
  const cards = loadCards().map(c =>
    c.kjGroupId === id ? { ...c, kjGroupId: undefined } : c
  );
  saveCards(cards);
  saveKJGroups(loadKJGroups().filter(g => g.id !== id));
}

/** カードをKJグループへ割り当て（nullで解除） */
export function assignKJGroup(cardId: string, groupId: string | null): void {
  updateCard(cardId, { kjGroupId: groupId ?? undefined });
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

import type { Card } from '../domain/card.js';
import { loadCards, saveCards } from '../repositories/cards_repository.js';

function newImportCardId(): string {
  return `card_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

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
      id:        newImportCardId(),
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

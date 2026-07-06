import type { Card } from '../domain/card.js';
import { loadCards, saveCards } from '../repositories/cards_repository.js';

function newImportCardId(): string {
  return `card_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

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
        id:          newImportCardId(),
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
        id:          newImportCardId(),
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
          id: newImportCardId(), title: `データ ${i + 1}`, body,
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
        id:        newImportCardId(),
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

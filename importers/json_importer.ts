import type { Card } from '../domain/card.js';
import { loadCards, saveCards } from '../repositories/cards_repository.js';
import { attachCardTokensMany } from '../services/card_token_service.js';

function newImportCardId(): string {
  return `card_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

export async function parseAndImportJSON(jsonText: string): Promise<{ cards: Card[]; warnings: string[] }> {
  const warnings: string[] = [];
  let raw: unknown;

  try {
    raw = JSON.parse(jsonText);
  } catch (error) {
    throw new Error(`JSON parse error: ${(error as Error).message}`);
  }

  const items = extractItems(raw);
  if (!items.length) {
    warnings.push('No importable data was found');
    return { cards: [], warnings };
  }

  const now = new Date().toISOString();
  const imported: Card[] = [];
  let skipped = 0;

  const isCardExport = isRecord(items[0]) &&
    typeof items[0].id === 'string' &&
    typeof items[0].type === 'string' &&
    ['memo', 'csv', 'article'].includes(String(items[0].type));
  const isArticleExport = isRecord(items[0]) && typeof items[0].sourceAuthority === 'number';

  for (let i = 0; i < items.length; i += 1) {
    const item = items[i];
    if (!isRecord(item)) {
      skipped += 1;
      continue;
    }

    if (isCardExport) {
      imported.push({
        id: newImportCardId(),
        title: String(item.title ?? `Card ${i + 1}`),
        body: String(item.body ?? ''),
        summary: item.summary ? String(item.summary) : undefined,
        url: item.url ? String(item.url) : undefined,
        tags: Array.isArray(item.tags) ? item.tags.map(String) : [],
        links: [],
        kjGroupId: undefined,
        type: (['memo', 'csv', 'article'].includes(String(item.type)) ? item.type : 'csv') as Card['type'],
        color: item.color ? String(item.color) : undefined,
        createdAt: String(item.createdAt ?? now),
        updatedAt: now,
      });
      continue;
    }

    if (isArticleExport) {
      const title = pickStr(item, ['title']) || `Article ${i + 1}`;
      imported.push({
        id: newImportCardId(),
        title,
        body: pickStr(item, ['body', 'content', 'summary']),
        url: pickStr(item, ['url']) || undefined,
        tags: [],
        links: [],
        type: 'article',
        createdAt: item.publishedAt ? String(item.publishedAt) : now,
        updatedAt: now,
      });
      continue;
    }

    const title = pickStr(item, ['title', 'タイトル', 'name', 'headline', 'subject']);
    if (!title) {
      const body = Object.entries(item).map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join('\n');
      if (!body.trim()) {
        skipped += 1;
        continue;
      }
      imported.push({
        id: newImportCardId(),
        title: `Data ${i + 1}`,
        body,
        tags: [],
        links: [],
        type: 'csv',
        createdAt: now,
        updatedAt: now,
      });
      warnings.push(`Row ${i + 1}: generated a title because no title field was found`);
      continue;
    }

    const body = pickStr(item, ['body', 'content', 'description', 'text', 'abstract', 'summary', '本文', 'テキスト']);
    const summaryRaw = pickStr(item, ['summary', 'abstract', '要約']);
    imported.push({
      id: newImportCardId(),
      title,
      body: body || title,
      summary: summaryRaw && summaryRaw !== body ? summaryRaw : undefined,
      url: pickStr(item, ['url', 'link', 'href', 'リンク']) || undefined,
      tags: pickTags(item),
      links: [],
      type: 'csv',
      createdAt: now,
      updatedAt: now,
    });
  }

  if (skipped) warnings.push(`${skipped} item(s) were skipped`);

  const tokenized = await attachCardTokensMany(imported);
  saveCards([...loadCards(), ...tokenized]);
  return { cards: tokenized, warnings };
}

function extractItems(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw;
  if (!isRecord(raw)) throw new Error('JSON must be an array or object');

  for (const key of ['cards', 'articles', 'items', 'data', 'results', 'records', 'entries']) {
    const value = raw[key];
    if (Array.isArray(value)) return value;
  }
  return [raw];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function pickStr(obj: Record<string, unknown>, keys: string[]): string {
  const objKeys = Object.keys(obj);
  for (const key of keys) {
    const found = objKeys.find(objKey => objKey.toLowerCase() === key.toLowerCase());
    if (found && obj[found] !== undefined && obj[found] !== null) return String(obj[found]).trim();
  }
  return '';
}

function pickTags(obj: Record<string, unknown>): string[] {
  const objKeys = Object.keys(obj);
  for (const key of ['tags', 'tag', 'categories', 'category', 'keywords', 'labels', 'タグ', 'ラベル']) {
    const found = objKeys.find(objKey => objKey.toLowerCase() === key.toLowerCase());
    if (!found) continue;
    const value = obj[found];
    if (Array.isArray(value)) return value.map(tag => String(tag).trim()).filter(Boolean);
    if (typeof value === 'string') return value.split(/[,、，\s]+/).map(tag => tag.trim()).filter(Boolean);
  }
  return [];
}

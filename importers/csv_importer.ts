import type { Card } from '../domain/card.js';
import { loadCards, saveCards } from '../repositories/cards_repository.js';
import { attachCardTokensMany } from '../services/card_token_service.js';

function newImportCardId(): string {
  return `card_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

export async function parseAndImportCSV(csvText: string): Promise<Card[]> {
  const lines = csvText.split(/\r?\n/).filter(line => line.trim());
  if (lines.length < 2) return [];

  const headers = splitCSVLine(lines[0]).map(header => header.toLowerCase().trim());
  const col = (candidates: string[]) =>
    candidates.map(candidate => headers.indexOf(candidate)).find(index => index >= 0) ?? -1;

  const titleCol = col(['title', 'タイトル', 'name']);
  const bodyCol = col(['body', 'content', 'description', '本文', 'テキスト', 'text']);
  const urlCol = col(['url', 'link', 'リンク']);
  const tagsCol = col(['tags', 'tag', 'タグ', 'categories', 'keywords']);

  const imported: Card[] = [];
  const now = new Date().toISOString();

  for (let i = 1; i < lines.length; i += 1) {
    const cols = splitCSVLine(lines[i]);
    if (!cols.length) continue;

    const get = (index: number) => (index >= 0 ? (cols[index] ?? '').trim() : '');
    const title = get(titleCol) || `Row ${i}`;
    let body = get(bodyCol);

    if (!body) {
      body = cols
        .filter((_, index) => index !== titleCol && index !== urlCol && index !== tagsCol)
        .join(' ')
        .trim();
    }

    const rawTags = get(tagsCol);
    const tags = rawTags
      ? rawTags.split(/[,、，\s]+/).map(tag => tag.trim()).filter(Boolean)
      : [];

    imported.push({
      id: newImportCardId(),
      title,
      body,
      url: get(urlCol) || undefined,
      tags,
      links: [],
      type: 'csv',
      createdAt: now,
      updatedAt: now,
    });
  }

  const tokenized = await attachCardTokensMany(imported);
  saveCards([...loadCards(), ...tokenized]);
  return tokenized;
}

function splitCSVLine(line: string): string[] {
  const result: string[] = [];
  let current = '';
  let inQuote = false;

  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuote && line[i + 1] === '"') {
        current += '"';
        i += 1;
      } else {
        inQuote = !inQuote;
      }
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

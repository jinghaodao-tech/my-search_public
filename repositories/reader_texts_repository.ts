import { db } from '../db/database.js';

// Full text read in the reader (articles, PDFs). The card body keeps only the
// first 20,000 characters (card schema limit); this table keeps all of it so
// quotes and pages can be checked against the whole document.

export function saveReaderText(cardId: string, paragraphs: string[]): void {
  db.prepare(
    'INSERT INTO reader_texts (card_id, paragraphs_json, updated_at) VALUES (?, ?, ?) ON CONFLICT(card_id) DO UPDATE SET paragraphs_json = excluded.paragraphs_json, updated_at = excluded.updated_at',
  ).run(cardId, JSON.stringify(paragraphs), new Date().toISOString());
}

export function getReaderText(cardId: string): string[] | null {
  const row = db.prepare('SELECT paragraphs_json FROM reader_texts WHERE card_id = ?').get(cardId) as { paragraphs_json: string } | undefined;
  if (!row) return null;
  try {
    const parsed = JSON.parse(row.paragraphs_json);
    return Array.isArray(parsed) ? parsed.map(String) : null;
  } catch {
    return null;
  }
}

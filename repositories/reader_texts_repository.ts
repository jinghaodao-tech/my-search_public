import { db } from '../db/database.js';

// Full text read in the reader (articles, PDFs). The card body keeps only the
// first 20,000 characters (card schema limit); this table keeps all of it so
// quotes and pages can be checked against the whole document.

export type ReaderTranslation = {
  from: string;
  to: 'ja';
  engine: string;
  translatedAt: string;
  /** aligned to the paragraphs: paragraphs[i] in Japanese, or null */
  paragraphs: Array<string | null>;
};

/**
 * `translation`: undefined keeps the stored one (when the text is unchanged), null removes it.
 * A stored translation is dropped when the text it was made for changes length.
 */
export function saveReaderText(cardId: string, paragraphs: string[], translation?: ReaderTranslation | null): void {
  let translationJson: string | null;
  if (translation === undefined) {
    const kept = getReaderTranslation(cardId);
    translationJson = kept && JSON.stringify(getReaderText(cardId)) === JSON.stringify(paragraphs) ? JSON.stringify(kept) : null;
  } else {
    translationJson = translation ? JSON.stringify(translation) : null;
  }
  db.prepare(
    'INSERT INTO reader_texts (card_id, paragraphs_json, translation_json, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(card_id) DO UPDATE SET paragraphs_json = excluded.paragraphs_json, translation_json = excluded.translation_json, updated_at = excluded.updated_at',
  ).run(cardId, JSON.stringify(paragraphs), translationJson, new Date().toISOString());
}

export function getReaderTranslation(cardId: string): ReaderTranslation | null {
  const row = db.prepare('SELECT translation_json FROM reader_texts WHERE card_id = ?').get(cardId) as { translation_json: string | null } | undefined;
  if (!row?.translation_json) return null;
  try {
    const parsed = JSON.parse(row.translation_json);
    return parsed && Array.isArray(parsed.paragraphs) ? parsed as ReaderTranslation : null;
  } catch {
    return null;
  }
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

import { db } from '../db/database.js';
import { readerToolsSourceHash, READER_SOURCE_HASH_VERSION } from '../services/reader_tools_service.js';

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
  const previousParagraphs = getReaderText(cardId);
  if (previousParagraphs) ensureReaderTextRevision(cardId, previousParagraphs);
  ensureReaderTextRevision(cardId, paragraphs);
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

/** Append a content revision if this exact paragraph array is not the latest. */
export function ensureReaderTextRevision(cardId: string, paragraphs: string[], fetchedAt = new Date().toISOString()): number {
  const serialized = JSON.stringify(paragraphs);
  const latest = db.prepare('SELECT revision,paragraphs_json FROM reader_text_revisions WHERE card_id=? ORDER BY revision DESC LIMIT 1').get(cardId) as { revision: number; paragraphs_json: string } | undefined;
  if (latest && latest.paragraphs_json === serialized) return latest.revision;
  const revision = (latest?.revision ?? 0) + 1;
  db.prepare('INSERT INTO reader_text_revisions(card_id,revision,paragraphs_json,body_hash,hash_version,fetched_at) VALUES(?,?,?,?,?,?)')
    .run(cardId, revision, serialized, readerToolsSourceHash(paragraphs), READER_SOURCE_HASH_VERSION, fetchedAt);
  return revision;
}

export function getReaderTextRevision(cardId: string, revision: number): string[] | null {
  const row = db.prepare('SELECT paragraphs_json FROM reader_text_revisions WHERE card_id=? AND revision=?').get(cardId, revision) as { paragraphs_json: string } | undefined;
  if (!row) return null;
  try {
    const parsed = JSON.parse(row.paragraphs_json);
    return Array.isArray(parsed) ? parsed.map(String) : null;
  } catch {
    return null;
  }
}

export function readerTextRevisionStorageBytes(): number {
  return (db.prepare('SELECT COALESCE(SUM(length(CAST(paragraphs_json AS BLOB))+length(CAST(body_hash AS BLOB))),0) AS bytes FROM reader_text_revisions').get() as { bytes: number }).bytes;
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

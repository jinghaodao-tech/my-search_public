import { db } from '../db/database.js';
import { parseStoredReaderTools, type ReaderToolsPayload } from '../services/reader_tools_service.js';

export function saveReaderTools(cardId: string, payload: ReaderToolsPayload): void {
  db.prepare(`INSERT INTO reader_tool_state (card_id, payload_json, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(card_id) DO UPDATE SET payload_json = excluded.payload_json, updated_at = excluded.updated_at`)
    .run(cardId, JSON.stringify(payload), new Date().toISOString());
}

export function getReaderTools(cardId: string): ReaderToolsPayload | null {
  const row = db.prepare('SELECT payload_json FROM reader_tool_state WHERE card_id = ?').get(cardId) as { payload_json: string } | undefined;
  return parseStoredReaderTools(row?.payload_json);
}

import { db } from '../db/database.js';

export function getOutgoingLinks(cardId: string): string[] {
  const rows = db.prepare(`
    SELECT target_card_id
    FROM card_links
    WHERE source_card_id = ?
    ORDER BY target_card_id
  `).all(cardId) as Array<{ target_card_id: string }>;
  return rows.map(row => row.target_card_id);
}

export function getIncomingLinks(cardId: string): string[] {
  const rows = db.prepare(`
    SELECT source_card_id
    FROM card_links
    WHERE target_card_id = ?
    ORDER BY source_card_id
  `).all(cardId) as Array<{ source_card_id: string }>;
  return rows.map(row => row.source_card_id);
}

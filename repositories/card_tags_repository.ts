import { db } from '../db/database.js';

export function getTagsForCard(cardId: string): string[] {
  const rows = db.prepare(`
    SELECT tag
    FROM card_tags
    WHERE card_id = ?
    ORDER BY tag
  `).all(cardId) as Array<{ tag: string }>;
  return rows.map(row => row.tag);
}

export function replaceTagsForCard(cardId: string, tags: string[], createdAt = new Date().toISOString()): void {
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM card_tags WHERE card_id = ?').run(cardId);
    const insert = db.prepare('INSERT OR IGNORE INTO card_tags (card_id, tag, created_at) VALUES (?, ?, ?)');
    for (const tag of tags) {
      const value = String(tag).trim();
      if (value) insert.run(cardId, value, createdAt);
    }
  });
  tx();
}

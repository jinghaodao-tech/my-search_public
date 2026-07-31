import { db } from '../db/database.js';

type Column = { name: string };
const requiredTables = ['cards', 'articles', 'card_tags', 'card_links', 'kj_groups', 'schema_migrations', 'jobs', 'cards_fts'];
const requiredColumns: Record<string, string[]> = {
  articles: ['candidate_status', 'first_seen_at', 'reviewed_at', 'saved_at', 'expired_at', 'candidate_score', 'candidate_match_reason', 'saved_card_id'],
  cards: ['tokens_json', 'doc_length', 'kj_group_id'],
  card_tags: ['card_id', 'tag'],
  card_links: ['source_card_id', 'target_card_id'],
};

const missing: string[] = [];
for (const table of requiredTables) {
  const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
  if (!exists) missing.push('table:' + table);
}
for (const [table, columns] of Object.entries(requiredColumns)) {
  const actual = new Set((db.prepare('PRAGMA table_info(' + table + ')').all() as Column[]).map(column => column.name));
  for (const column of columns) if (!actual.has(column)) missing.push('column:' + table + '.' + column);
}
const foreignKeys = db.prepare('PRAGMA foreign_key_check').all();
const integrity = db.prepare('PRAGMA integrity_check').get() as { integrity_check: string };
const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as Array<{ name: string }>;
const hasSavedCardUniqueIndex = indexes.some(index => index.name === 'idx_articles_saved_card_unique');

if (missing.length || foreignKeys.length || integrity.integrity_check !== 'ok' || !hasSavedCardUniqueIndex) {
  console.error(JSON.stringify({ ok: false, missing, foreignKeys, integrity: integrity.integrity_check, hasSavedCardUniqueIndex }, null, 2));
  process.exitCode = 1;
} else {
  console.log(JSON.stringify({ ok: true, tables: requiredTables.length, foreignKeys: 0, integrity: integrity.integrity_check, hasSavedCardUniqueIndex }, null, 2));
}
db.close();

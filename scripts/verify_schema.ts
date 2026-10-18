import { db } from '../db/database.js';

type Column = { name: string };
const requiredTables = ['cards', 'articles', 'card_tags', 'card_links', 'kj_groups', 'schema_migrations', 'jobs', 'cards_fts', 'site_sources', 'site_articles', 'article_sources', 'site_article_repairs'];
const requiredColumns: Record<string, string[]> = {
  articles: ['candidate_status', 'first_seen_at', 'reviewed_at', 'saved_at', 'expired_at', 'candidate_score', 'candidate_match_reason', 'saved_card_id', 'normalized_url', 'body_kind', 'source_updated_at'],
  site_articles: ['site_id', 'article_id', 'article_key'],
  article_sources: ['article_id', 'source', 'first_seen_at', 'last_seen_at'],
  cards: ['tokens_json', 'doc_length', 'morphological_tokens_json', 'ngram_tokens_json', 'morphological_doc_length', 'ngram_doc_length', 'kj_group_id'],
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
const articleReferences = (db.prepare('PRAGMA foreign_key_list(site_articles)').all() as Array<{table: string; from: string; on_delete: string}>).some(row => row.table === 'articles' && row.from === 'article_id' && row.on_delete === 'CASCADE');
const siteArticleRepairs = db.prepare('SELECT reason, COUNT(*) AS count FROM site_article_repairs GROUP BY reason ORDER BY reason').all();

if (missing.length || foreignKeys.length || integrity.integrity_check !== 'ok' || !hasSavedCardUniqueIndex || !articleReferences) {
  console.error(JSON.stringify({ ok: false, missing, foreignKeys, integrity: integrity.integrity_check, hasSavedCardUniqueIndex, articleReferences, siteArticleRepairs }, null, 2));
  process.exitCode = 1;
} else {
  console.log(JSON.stringify({ ok: true, tables: requiredTables.length, foreignKeys: 0, integrity: integrity.integrity_check, hasSavedCardUniqueIndex, articleReferences, siteArticleRepairs }, null, 2));
}
db.close();

import type Database from "better-sqlite3";

type Migration = { id: string; sql: string };

const migrations: Migration[] = [
  { id: "001_create_migrations_table", sql: "" },
  { id: "002_add_search_token_columns", sql: "" },
  { id: "003_create_kj_groups", sql: `
    CREATE TABLE IF NOT EXISTS kj_groups (id TEXT PRIMARY KEY, name TEXT NOT NULL, color TEXT, description TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS idx_cards_kj_group_id ON cards(kj_group_id);
    CREATE INDEX IF NOT EXISTS idx_kj_groups_created_at ON kj_groups(created_at);
  ` },
  { id: "004_create_card_relation_tables", sql: `
    CREATE TABLE IF NOT EXISTS card_tags (card_id TEXT NOT NULL, tag TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (card_id, tag), FOREIGN KEY (card_id) REFERENCES cards(id) ON DELETE CASCADE);
    CREATE INDEX IF NOT EXISTS idx_card_tags_tag ON card_tags(tag);
    CREATE INDEX IF NOT EXISTS idx_card_tags_card_id ON card_tags(card_id);
    CREATE TABLE IF NOT EXISTS card_links (source_card_id TEXT NOT NULL, target_card_id TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (source_card_id, target_card_id), FOREIGN KEY (source_card_id) REFERENCES cards(id) ON DELETE CASCADE, FOREIGN KEY (target_card_id) REFERENCES cards(id) ON DELETE CASCADE);
    CREATE INDEX IF NOT EXISTS idx_card_links_source ON card_links(source_card_id);
    CREATE INDEX IF NOT EXISTS idx_card_links_target ON card_links(target_card_id);
    INSERT OR IGNORE INTO card_tags (card_id, tag, created_at) SELECT cards.id, json_each.value, cards.created_at FROM cards, json_each(COALESCE(cards.tags_json, '[]')) WHERE json_each.value IS NOT NULL AND TRIM(json_each.value) <> '';
    INSERT OR IGNORE INTO card_links (source_card_id, target_card_id, created_at) SELECT cards.id, json_each.value, cards.created_at FROM cards, json_each(COALESCE(cards.links_json, '[]')) WHERE json_each.value IS NOT NULL AND TRIM(json_each.value) <> '' AND EXISTS (SELECT 1 FROM cards target WHERE target.id = json_each.value);
  ` },
  { id: "005_create_articles_table", sql: "" },
  { id: "006_add_candidate_lifecycle", sql: "" },
  { id: "008_add_candidate_ranking_metadata", sql: "" },
  { id: "007_enforce_relation_foreign_keys", sql: `
    CREATE TABLE cards_new (id TEXT PRIMARY KEY, title TEXT NOT NULL, body TEXT NOT NULL, summary TEXT, url TEXT, type TEXT NOT NULL DEFAULT 'memo', color TEXT, tags_json TEXT NOT NULL DEFAULT '[]', links_json TEXT NOT NULL DEFAULT '[]', kj_group_id TEXT REFERENCES kj_groups(id) ON DELETE SET NULL, archived INTEGER NOT NULL DEFAULT 0, archived_at TEXT, tokens_json TEXT NOT NULL DEFAULT '[]', doc_length INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    INSERT INTO cards_new SELECT * FROM cards;
    CREATE TABLE card_tags_new (card_id TEXT NOT NULL, tag TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (card_id, tag), FOREIGN KEY (card_id) REFERENCES cards_new(id) ON DELETE CASCADE);
    INSERT INTO card_tags_new SELECT card_id, tag, created_at FROM card_tags;
    CREATE TABLE card_links_new (source_card_id TEXT NOT NULL, target_card_id TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (source_card_id, target_card_id), FOREIGN KEY (source_card_id) REFERENCES cards_new(id) ON DELETE CASCADE, FOREIGN KEY (target_card_id) REFERENCES cards_new(id) ON DELETE CASCADE);
    INSERT INTO card_links_new SELECT source_card_id, target_card_id, created_at FROM card_links WHERE EXISTS (SELECT 1 FROM cards_new WHERE id = source_card_id) AND EXISTS (SELECT 1 FROM cards_new WHERE id = target_card_id);
    DROP TABLE card_tags;
    DROP TABLE card_links;
    DROP TABLE cards;
    ALTER TABLE cards_new RENAME TO cards;
    ALTER TABLE card_tags_new RENAME TO card_tags;
    ALTER TABLE card_links_new RENAME TO card_links;
    CREATE INDEX IF NOT EXISTS idx_cards_title ON cards(title);
    CREATE INDEX IF NOT EXISTS idx_cards_type ON cards(type);
    CREATE INDEX IF NOT EXISTS idx_cards_created_at ON cards(created_at);
    CREATE INDEX IF NOT EXISTS idx_cards_kj_group_id ON cards(kj_group_id);
    CREATE INDEX IF NOT EXISTS idx_card_tags_tag ON card_tags(tag);
    CREATE INDEX IF NOT EXISTS idx_card_tags_card_id ON card_tags(card_id);
    CREATE INDEX IF NOT EXISTS idx_card_links_source ON card_links(source_card_id);
    CREATE INDEX IF NOT EXISTS idx_card_links_target ON card_links(target_card_id);
  ` },
];

function columns(db: Database.Database, table: string): Set<string> {
  return new Set((db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(row => row.name));
}

function applyMigration(db: Database.Database, migration: Migration): void {
  if (migration.id === "002_add_search_token_columns") {
    const names = columns(db, "cards");
    if (!names.has("tokens_json")) db.exec("ALTER TABLE cards ADD COLUMN tokens_json TEXT NOT NULL DEFAULT '[]'");
    if (!names.has("doc_length")) db.exec("ALTER TABLE cards ADD COLUMN doc_length INTEGER NOT NULL DEFAULT 0");
    return;
  }
  if (migration.id === "008_add_candidate_ranking_metadata") {
    const names = columns(db, "articles");
    if (names.size === 0) return;
    if (!names.has("candidate_score")) db.exec("ALTER TABLE articles ADD COLUMN candidate_score REAL");
    if (!names.has("candidate_match_reason")) db.exec("ALTER TABLE articles ADD COLUMN candidate_match_reason TEXT");
    return;
  }
  if (migration.id === "006_add_candidate_lifecycle") {
    const names = columns(db, "articles");
    if (!names.has("candidate_status")) db.exec("ALTER TABLE articles ADD COLUMN candidate_status TEXT NOT NULL DEFAULT 'unreviewed'");
    if (!names.has("first_seen_at")) db.exec("ALTER TABLE articles ADD COLUMN first_seen_at TEXT");
    if (!names.has("reviewed_at")) db.exec("ALTER TABLE articles ADD COLUMN reviewed_at TEXT");
    if (!names.has("saved_at")) db.exec("ALTER TABLE articles ADD COLUMN saved_at TEXT");
    if (!names.has("expired_at")) db.exec("ALTER TABLE articles ADD COLUMN expired_at TEXT");
    db.exec("UPDATE articles SET first_seen_at = COALESCE(first_seen_at, created_at) WHERE first_seen_at IS NULL; CREATE INDEX IF NOT EXISTS idx_articles_candidate_status ON articles(candidate_status); CREATE INDEX IF NOT EXISTS idx_articles_first_seen_at ON articles(first_seen_at);");
    return;
  }
  if (migration.sql.trim()) db.exec(migration.sql);
}

export function runMigrations(db: Database.Database): string[] {
  db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL)");
  const applied = new Set((db.prepare("SELECT id FROM schema_migrations").all() as Array<{ id: string }>).map(row => row.id));
  const appliedNow: string[] = [];
  const record = db.prepare("INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)");
  for (const migration of migrations) {
    if (applied.has(migration.id)) continue;
    db.transaction(() => {
      applyMigration(db, migration);
      record.run(migration.id, new Date().toISOString());
    })();
    appliedNow.push(migration.id);
  }
  return appliedNow;
}
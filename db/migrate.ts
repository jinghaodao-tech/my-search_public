import type Database from "better-sqlite3";

type Migration = { id: string; sql: string };

const migrations: Migration[] = [
    { id: "001_create_migrations_table", sql: "CREATE TABLE IF NOT EXISTS cards (id TEXT PRIMARY KEY, title TEXT NOT NULL, body TEXT NOT NULL, summary TEXT, url TEXT, type TEXT NOT NULL DEFAULT 'memo', color TEXT, tags_json TEXT NOT NULL DEFAULT '[]', links_json TEXT NOT NULL DEFAULT '[]', kj_group_id TEXT REFERENCES kj_groups(id) ON DELETE SET NULL, archived INTEGER NOT NULL DEFAULT 0, archived_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL); CREATE INDEX IF NOT EXISTS idx_cards_title ON cards(title); CREATE INDEX IF NOT EXISTS idx_cards_type ON cards(type); CREATE INDEX IF NOT EXISTS idx_cards_created_at ON cards(created_at); CREATE INDEX IF NOT EXISTS idx_cards_kj_group_id ON cards(kj_group_id);" },
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
    { id: "005_create_articles_table", sql: "CREATE TABLE IF NOT EXISTS articles (id TEXT PRIMARY KEY, title TEXT NOT NULL, body TEXT NOT NULL, url TEXT NOT NULL, source TEXT, source_authority REAL NOT NULL DEFAULT 0, published_at TEXT, summary TEXT, tags_json TEXT NOT NULL DEFAULT '[]', tokens_json TEXT, doc_length INTEGER NOT NULL DEFAULT 0, content_hash TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, last_fetched_at TEXT); CREATE UNIQUE INDEX IF NOT EXISTS idx_articles_url_unique ON articles(url); CREATE INDEX IF NOT EXISTS idx_articles_published_at ON articles(published_at); CREATE INDEX IF NOT EXISTS idx_articles_source ON articles(source); CREATE INDEX IF NOT EXISTS idx_articles_doc_length ON articles(doc_length); CREATE INDEX IF NOT EXISTS idx_articles_content_hash ON articles(content_hash);" },
  { id: "006_add_candidate_lifecycle", sql: "" },
  { id: "008_add_candidate_ranking_metadata", sql: "" },
  { id: "009_add_candidate_saved_card", sql: "" },
  { id: "010_repair_candidate_saved_card", sql: "" },
  { id: "007_enforce_relation_foreign_keys", sql: `
    UPDATE cards SET kj_group_id = NULL WHERE kj_group_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM kj_groups WHERE kj_groups.id = cards.kj_group_id);
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
  { id: "011_create_jobs", sql: `
    CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, type TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, result_json TEXT, error TEXT);
    CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
    CREATE INDEX IF NOT EXISTS idx_jobs_created_at ON jobs(created_at);
  ` },
  { id: "012_create_cards_fts", sql: `
    CREATE VIRTUAL TABLE IF NOT EXISTS cards_fts USING fts5(id UNINDEXED, title, body, summary, tags);
    INSERT INTO cards_fts (id, title, body, summary, tags)
      SELECT cards.id, cards.title, cards.body, COALESCE(cards.summary, ''), COALESCE((SELECT group_concat(tag, ' ') FROM card_tags WHERE card_tags.card_id = cards.id), '') FROM cards
      WHERE NOT EXISTS (SELECT 1 FROM cards_fts WHERE cards_fts.id = cards.id);
    CREATE TRIGGER IF NOT EXISTS cards_fts_after_insert AFTER INSERT ON cards BEGIN
      INSERT INTO cards_fts (id, title, body, summary, tags) VALUES (NEW.id, NEW.title, NEW.body, COALESCE(NEW.summary, ''), COALESCE((SELECT group_concat(tag, ' ') FROM card_tags WHERE card_tags.card_id = NEW.id), ''));
    END;
    CREATE TRIGGER IF NOT EXISTS cards_fts_after_update AFTER UPDATE OF title, body, summary, tags_json ON cards BEGIN
      DELETE FROM cards_fts WHERE id = OLD.id;
      INSERT INTO cards_fts (id, title, body, summary, tags) VALUES (NEW.id, NEW.title, NEW.body, COALESCE(NEW.summary, ''), COALESCE((SELECT group_concat(tag, ' ') FROM card_tags WHERE card_tags.card_id = NEW.id), ''));
    END;
    CREATE TRIGGER IF NOT EXISTS cards_fts_after_delete AFTER DELETE ON cards BEGIN DELETE FROM cards_fts WHERE id = OLD.id; END;
  ` },
  { id: "013_sync_cards_fts_tags", sql: `
    CREATE TRIGGER IF NOT EXISTS card_tags_fts_after_insert AFTER INSERT ON card_tags BEGIN
      DELETE FROM cards_fts WHERE id = NEW.card_id;
      INSERT INTO cards_fts (id, title, body, summary, tags) SELECT cards.id, cards.title, cards.body, COALESCE(cards.summary, ''), COALESCE((SELECT group_concat(tag, ' ') FROM card_tags WHERE card_tags.card_id = cards.id), '') FROM cards WHERE cards.id = NEW.card_id;
    END;
    CREATE TRIGGER IF NOT EXISTS card_tags_fts_after_delete AFTER DELETE ON card_tags BEGIN
      DELETE FROM cards_fts WHERE id = OLD.card_id;
      INSERT INTO cards_fts (id, title, body, summary, tags) SELECT cards.id, cards.title, cards.body, COALESCE(cards.summary, ''), COALESCE((SELECT group_concat(tag, ' ') FROM card_tags WHERE card_tags.card_id = cards.id), '') FROM cards WHERE cards.id = OLD.card_id;
    END;
  ` },
  { id: "014_add_dual_token_columns", sql: "" },
  { id: "015_repair_invalid_card_timestamps", sql: "" },
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
  if (migration.id === "009_add_candidate_saved_card") {
    const names = columns(db, "articles");
    if (names.size === 0) return;
    if (!names.has("saved_card_id")) db.exec("ALTER TABLE articles ADD COLUMN saved_card_id TEXT REFERENCES cards(id) ON DELETE SET NULL");
    db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_articles_saved_card_unique ON articles(saved_card_id) WHERE saved_card_id IS NOT NULL");
    return;
  }
  if (migration.id === "010_repair_candidate_saved_card") {
    const names = columns(db, "articles");
    if (names.size === 0) return;
    if (!names.has("saved_card_id")) db.exec("ALTER TABLE articles ADD COLUMN saved_card_id TEXT REFERENCES cards(id) ON DELETE SET NULL");
    db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_articles_saved_card_unique ON articles(saved_card_id) WHERE saved_card_id IS NOT NULL");
    return;
  }
  if (migration.id === "014_add_dual_token_columns") {
    for (const table of ["cards", "articles"]) {
      const names = columns(db, table);
      if (names.size === 0) continue;
      if (!names.has("morphological_tokens_json")) db.exec(`ALTER TABLE ${table} ADD COLUMN morphological_tokens_json TEXT NOT NULL DEFAULT '[]'`);
      if (!names.has("ngram_tokens_json")) db.exec(`ALTER TABLE ${table} ADD COLUMN ngram_tokens_json TEXT NOT NULL DEFAULT '[]'`);
      if (!names.has("morphological_doc_length")) db.exec(`ALTER TABLE ${table} ADD COLUMN morphological_doc_length INTEGER NOT NULL DEFAULT 0`);
      if (!names.has("ngram_doc_length")) db.exec(`ALTER TABLE ${table} ADD COLUMN ngram_doc_length INTEGER NOT NULL DEFAULT 0`);
      db.exec(`UPDATE ${table} SET ngram_tokens_json = CASE WHEN ngram_tokens_json = '[]' THEN COALESCE(tokens_json, '[]') ELSE ngram_tokens_json END, ngram_doc_length = CASE WHEN ngram_doc_length = 0 THEN COALESCE(doc_length, 0) ELSE ngram_doc_length END`);
    }
    return;
  }
  if (migration.id === "015_repair_invalid_card_timestamps") {
    const names = columns(db, "cards");
    if (names.size === 0) return;
    const rows = db.prepare("SELECT id, created_at, updated_at FROM cards").all() as Array<{ id: string; created_at: string; updated_at: string }>;
    const update = db.prepare("UPDATE cards SET created_at = ?, updated_at = ? WHERE id = ?");
    const isValidTimestamp = (value: string | null | undefined): boolean => Boolean(value && !Number.isNaN(Date.parse(value)));
    for (const row of rows) {
      if (isValidTimestamp(row.created_at) && isValidTimestamp(row.updated_at)) continue;
      const idTimestamp = /^card_(\d+)_/.exec(row.id)?.[1];
      const recoveredCreated = idTimestamp ? new Date(Number(idTimestamp)).toISOString() : new Date().toISOString();
      const createdAt = isValidTimestamp(row.created_at) ? row.created_at : recoveredCreated;
      const updatedAt = isValidTimestamp(row.updated_at) ? row.updated_at : createdAt;
      update.run(createdAt, updatedAt, row.id);
    }
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

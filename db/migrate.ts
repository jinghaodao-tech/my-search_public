import type Database from "better-sqlite3";

type Migration = {
  id: string;
  sql: string;
};

const migrations: Migration[] = [
  {
    id: "001_create_migrations_table",
    sql: "",
  },
  {
    id: "002_add_search_token_columns",
    sql: `
      ALTER TABLE cards ADD COLUMN tokens_json TEXT NOT NULL DEFAULT '[]';
      ALTER TABLE cards ADD COLUMN doc_length INTEGER NOT NULL DEFAULT 0;
    `,
  },
  {
    id: "003_create_kj_groups",
    sql: `
      CREATE TABLE IF NOT EXISTS kj_groups (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        color TEXT,
        description TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_cards_kj_group_id ON cards(kj_group_id);
      CREATE INDEX IF NOT EXISTS idx_kj_groups_created_at ON kj_groups(created_at);
    `,
  },
  {
    id: "004_create_card_relation_tables",
    sql: `
      CREATE TABLE IF NOT EXISTS card_tags (
        card_id TEXT NOT NULL,
        tag TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (card_id, tag),
        FOREIGN KEY (card_id) REFERENCES cards(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_card_tags_tag ON card_tags(tag);
      CREATE INDEX IF NOT EXISTS idx_card_tags_card_id ON card_tags(card_id);

      CREATE TABLE IF NOT EXISTS card_links (
        source_card_id TEXT NOT NULL,
        target_card_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (source_card_id, target_card_id),
        FOREIGN KEY (source_card_id) REFERENCES cards(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_card_links_source ON card_links(source_card_id);
      CREATE INDEX IF NOT EXISTS idx_card_links_target ON card_links(target_card_id);

      INSERT OR IGNORE INTO card_tags (card_id, tag, created_at)
      SELECT cards.id, json_each.value, cards.created_at
      FROM cards, json_each(COALESCE(cards.tags_json, '[]'))
      WHERE json_each.value IS NOT NULL AND TRIM(json_each.value) <> '';

      INSERT OR IGNORE INTO card_links (source_card_id, target_card_id, created_at)
      SELECT cards.id, json_each.value, cards.created_at
      FROM cards, json_each(COALESCE(cards.links_json, '[]'))
      WHERE json_each.value IS NOT NULL AND TRIM(json_each.value) <> '';
    `,
  },
];

export function runMigrations(db: Database.Database): string[] {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `);

  const applied = new Set(
    db.prepare("SELECT id FROM schema_migrations").all().map((row) => (row as { id: string }).id),
  );
  const appliedNow: string[] = [];

  for (const migration of migrations) {
    if (applied.has(migration.id)) continue;

    if (migration.sql.trim()) {
      try {
        db.exec(migration.sql);
      } catch (err) {
        const message = String(err);
        if (!message.includes("duplicate column name")) {
          throw err;
        }
      }
    }

    db.prepare("INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)")
      .run(migration.id, new Date().toISOString());
    appliedNow.push(migration.id);
  }

  return appliedNow;
}

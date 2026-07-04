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

import fs from "fs";
import path from "path";
import Database from "better-sqlite3";
import { migrationStatus, runMigrations } from "./migrate.js";

const dbPath = process.env.DB_PATH ?? "data/cards.db";
const dbDir = path.dirname(dbPath);

if (dbDir && dbDir !== ".") {
  fs.mkdirSync(dbDir, { recursive: true });
}

export const db = new Database(dbPath);
db.pragma('foreign_keys = ON');

/**
 * Before changing an existing database, keep a consistent copy (VACUUM INTO works while the DB is open,
 * also in WAL mode). The newest three copies are kept in <db folder>/backups/.
 */
function backupBeforeMigration(pending: string[]): string | null {
  if (dbPath === ":memory:") return null;
  const dir = path.join(dbDir || ".", "backups");
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const file = path.join(dir, `before-migration-${stamp}-${pending[0].split("_")[0]}.db`);
  db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
  const old = fs.readdirSync(dir).filter(name => name.startsWith("before-migration-") && name.endsWith(".db")).sort().reverse().slice(3);
  for (const name of old) fs.rmSync(path.join(dir, name), { force: true });
  return file;
}

const status = migrationStatus(db);
let migrationBackup: string | null = null;
if (status.pending.length && status.applied > 0) {
  try {
    migrationBackup = backupBeforeMigration(status.pending);
  } catch (error) {
    // Do not touch the database without a copy.
    console.error(`\nデータベースを更新する前のコピーを作れませんでした（${(error as Error).message}）。\n空き容量と、${path.join(dbDir || ".", "backups")} に書き込めるかを確認してから、もう一度起動してください。\nデータベースは変更していません。\n`);
    throw error;
  }
}
try {
  runMigrations(db);
} catch (error) {
  console.error([
    "",
    `データベースの更新（マイグレーション）に失敗しました: ${(error as Error).message}`,
    "更新は段階ごとに保存されるため、失敗した段階の変更は取り消され、それより前の段階までは保存されています。",
    migrationBackup
      ? `更新前のコピー: ${migrationBackup}\n元に戻すには、アプリを止めてから ${dbPath} をこのコピーで置き換えてください（${dbPath}-wal と ${dbPath}-shm があれば一緒に削除）。`
      : "",
    "",
  ].filter(line => line !== undefined).join("\n"));
  throw error;
}

db.exec(`
CREATE INDEX IF NOT EXISTS idx_articles_candidate_status ON articles(candidate_status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_articles_saved_card_unique ON articles(saved_card_id) WHERE saved_card_id IS NOT NULL;
`);

db.exec(`
INSERT OR IGNORE INTO card_tags (card_id, tag, created_at)
SELECT cards.id, json_each.value, cards.created_at
FROM cards, json_each(COALESCE(cards.tags_json, '[]'))
WHERE json_each.value IS NOT NULL AND TRIM(json_each.value) <> '';

INSERT OR IGNORE INTO card_links (source_card_id, target_card_id, created_at)
SELECT cards.id, json_each.value, cards.created_at
FROM cards, json_each(COALESCE(cards.links_json, '[]'))
WHERE json_each.value IS NOT NULL AND TRIM(json_each.value) <> '' AND EXISTS (SELECT 1 FROM cards target WHERE target.id = json_each.value);
`);

// Reader copies survive feed refreshes; search checkpoints are explicit.
db.exec(`
CREATE TABLE IF NOT EXISTS article_reader_content (
 article_id TEXT PRIMARY KEY REFERENCES articles(id) ON DELETE CASCADE,
 body TEXT NOT NULL, fetched_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS search_checkpoints (
 search_id TEXT PRIMARY KEY REFERENCES saved_searches(id) ON DELETE CASCADE,
 checked_at TEXT NOT NULL
);
`);

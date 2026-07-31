import fs from "fs";
import path from "path";
import Database from "better-sqlite3";
import { runMigrations } from "./migrate.js";

const dbPath = process.env.DB_PATH ?? "data/cards.db";
const dbDir = path.dirname(dbPath);

if (dbDir && dbDir !== ".") {
  fs.mkdirSync(dbDir, { recursive: true });
}

export const db = new Database(dbPath);
db.pragma('foreign_keys = ON');

runMigrations(db);

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

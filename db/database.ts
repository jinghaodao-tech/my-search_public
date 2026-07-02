import fs from "fs";
import path from "path";
import Database from "better-sqlite3";

const dbPath = process.env.DB_PATH ?? "data/cards.db";
const dbDir = path.dirname(dbPath);

if (dbDir && dbDir !== ".") {
  fs.mkdirSync(dbDir, { recursive: true });
}

export const db = new Database(dbPath);

db.exec(`
CREATE TABLE IF NOT EXISTS cards (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  summary TEXT,
  url TEXT,
  type TEXT NOT NULL DEFAULT 'memo',
  color TEXT,
  tags_json TEXT NOT NULL DEFAULT '[]',
  links_json TEXT NOT NULL DEFAULT '[]',
  kj_group_id TEXT,
  archived INTEGER NOT NULL DEFAULT 0,
  archived_at TEXT,
  tokens_json TEXT NOT NULL DEFAULT '[]',
  doc_length INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_cards_title ON cards(title);
CREATE INDEX IF NOT EXISTS idx_cards_type ON cards(type);
CREATE INDEX IF NOT EXISTS idx_cards_created_at ON cards(created_at);
`);

const cardColumns = db.prepare(`PRAGMA table_info(cards)`).all() as Array<{ name: string }>;
const cardColumnNames = new Set(cardColumns.map((column) => column.name));

if (!cardColumnNames.has("tokens_json")) {
  db.exec(`ALTER TABLE cards ADD COLUMN tokens_json TEXT NOT NULL DEFAULT '[]'`);
}

if (!cardColumnNames.has("doc_length")) {
  db.exec(`ALTER TABLE cards ADD COLUMN doc_length INTEGER NOT NULL DEFAULT 0`);
}
